/* transfer.c —— 文件传输（HTTP 数据面）。
 * 架构：控制面走 WS（扩展触发 -> 服务端 -> 浏览器），数据面走 HTTP。
 *   GET  /api/transfer/download  -> 浏览器下载文件（sendfile 异步流式 + Range 可选）
 *   POST /api/transfer/upload    -> 浏览器分片上传（pwrite 追加到目标目录）
 *   POST /api/transfer/request   -> Nautilus 扩展通知（X-Workd-Token 鉴权）
 * 安全：token 绑定会话用户；所有路径经 realpath 校验必须位于该用户 home 内，
 *      防止越权读写其他用户或系统文件。
 */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#include "transfer.h"
#include "session.h"
#include "sess_table.h"
#include "protocol.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <pwd.h>
#include <sys/stat.h>
#include <sys/sendfile.h>

/* ---------------- 小工具 ---------------- */

/* 简单文本响应（冲刷后关闭） */
static void http_resp(conn *c, int code, const char *msg,
                      const uint8_t *body, size_t body_len)
{
    char hdr[512];
    int hn = snprintf(hdr, sizeof hdr,
                      "HTTP/1.1 %d %s\r\nContent-Length: %zu\r\n"
                      "Content-Type: text/plain\r\n"
                      "Access-Control-Allow-Origin: *\r\n"
                      "Connection: close\r\n\r\n",
                      code, msg, body_len);
    if (conn_queue_raw(c, (const uint8_t *)hdr, (size_t)hn))
    {
        if (body_len && body)
            conn_queue_raw(c, body, body_len);
        c->close_after_flush = 1;
    }
    else
        net_close_conn(c);
}

/* 路径权限校验见 util_path_in_user_home（util.c） */

/* ---------------- 处理函数 ---------------- */

/* POST /api/transfer/request：Nautilus 扩展通知。
 * Header: X-Workd-Token。Body: "download\n/path1\n/path2" 或 "uploaddir\n/dir" */
static int handle_request(conn *c, const char *q, const char *xw_token,
                          const uint8_t *body, size_t body_len)
{
    (void)q;
    if (!xw_token || !xw_token[0] || !body || body_len == 0)
    {
        http_resp(c, 400, "Bad Request", NULL, 0);
        return 1;
    }
    runtime *rt = session_by_token(xw_token);
    if (!rt)
    {
        http_resp(c, 403, "Forbidden", NULL, 0);
        return 1;
    }

    /* 第一行 action */
    const char *nl = memchr(body, '\n', body_len);
    size_t al = nl ? (size_t)(nl - (const char *)body) : body_len;
    if (al == 0 || al >= 16)
    {
        runtime_unref(rt);
        http_resp(c, 400, "Bad Request", NULL, 0);
        return 1;
    }
    char act[16];
    memcpy(act, body, al);
    act[al] = 0;
    int action;
    if (!strcmp(act, "download"))
        action = TRANSFER_ACT_DOWNLOAD;
    else if (!strcmp(act, "uploaddir"))
        action = TRANSFER_ACT_UPLOADDIR;
    else
    {
        runtime_unref(rt);
        http_resp(c, 400, "Bad Request", NULL, 0);
        return 1;
    }

    /* 其余行 = 路径列表（换行分隔），逐行校验并重建为 realpath 文本 */
    const char *p = nl ? (const char *)nl + 1 : "";
    const char *end = (const char *)body + body_len;
    char paths[4096] = "";
    int any = 0;
    while (p < end && *p)
    {
        const char *nl2 = memchr(p, '\n', (size_t)(end - p));
        size_t ln = nl2 ? (size_t)(nl2 - p) : (size_t)(end - p);
        char line[2048];
        size_t cl = ln < sizeof line - 1 ? ln : sizeof line - 1;
        memcpy(line, p, cl);
        line[cl] = 0;
        while (cl && (line[cl - 1] == '\r' || line[cl - 1] == ' ' || line[cl - 1] == '\t'))
            line[--cl] = 0;
        if (cl > 0)
        {
            char real[4096];
            if (util_path_in_user_home(rt->user, line, real, sizeof real))
            {
                size_t rl = strlen(real);
                if (strlen(paths) + rl + 1 < sizeof paths)
                {
                    if (any)
                        strcat(paths, "\n");
                    strcat(paths, real);
                    any = 1;
                }
            }
        }
        if (!nl2)
            break;
        p = nl2 + 1;
    }
    if (!any)
    {
        /* 所有路径都不在用户 home 内（如 /etc 系统目录）：拒绝并推送
         * 错误通知给浏览器，避免前端"没有响应"（扩展的 request 只回 403） */
        conn *browser = atomic_load(&rt->conn);
        if (browser && !atomic_load(&browser->closing))
            session_push_transfer_error(browser,
                                        "无法访问该路径：文件不在你的用户目录内或不存在");
        runtime_unref(rt);
        http_resp(c, 403, "Forbidden", NULL, 0);
        return 1;
    }

    /* 推送给浏览器（该会话当前连接） */
    conn *browser = atomic_load(&rt->conn);
    if (browser && !atomic_load(&browser->closing))
        session_push_transfer(browser, action, paths);
    runtime_unref(rt);
    http_resp(c, 200, "OK", NULL, 0);
    return 1;
}

/* GET /api/transfer/download?token=..&path=..：浏览器下载文件（sendfile 异步流式） */
static int handle_download(conn *c, const char *q)
{
    char token[64], path[2048];
    if (!util_query_get(q, "token", token, sizeof token) ||
        !util_query_get(q, "path", path, sizeof path))
    {
        http_resp(c, 400, "Bad Request", NULL, 0);
        return 1;
    }
    runtime *rt = session_by_token(token);
    if (!rt)
    {
        http_resp(c, 403, "Forbidden", NULL, 0);
        return 1;
    }
    char real[4096];
    if (!util_path_in_user_home(rt->user, path, real, sizeof real))
    {
        runtime_unref(rt);
        http_resp(c, 403, "Forbidden", NULL, 0);
        return 1;
    }
    runtime_unref(rt);

    struct stat st;
    if (stat(real, &st) != 0 || !S_ISREG(st.st_mode))
    {
        http_resp(c, 404, "Not Found", NULL, 0);
        return 1;
    }
    int fd = open(real, O_RDONLY);
    if (fd < 0)
    {
        http_resp(c, 403, "Forbidden", NULL, 0);
        return 1;
    }
    /* 响应头 + 挂流式发送状态（ws_flush 用 sendfile 逐块发） */
    const char *bn = strrchr(real, '/');
    bn = bn ? bn + 1 : real;
    char hdr[512];
    int hn = snprintf(hdr, sizeof hdr,
                      "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n"
                      "Content-Length: %lld\r\nContent-Disposition: attachment; filename=\"%s\"\r\n"
                      "Access-Control-Allow-Origin: *\r\n"
                      "Cache-Control: no-cache\r\nConnection: close\r\n\r\n",
                      (long long)st.st_size, bn);
    if (!conn_queue_raw(c, (const uint8_t *)hdr, (size_t)hn))
    {
        close(fd);
        return 1;
    }
    c->send_fd = fd;
    c->send_off = 0;
    c->send_left = (uint64_t)st.st_size;
    return 1;
}

/* POST /api/transfer/upload?token=..&dir=..&name=..&offset=..：浏览器分片上传 */
static int handle_upload(conn *c, const char *q,
                         const uint8_t *body, size_t body_len)
{
    char token[64], dir[2048], name[1024], offs[32];
    if (!util_query_get(q, "token", token, sizeof token) ||
        !util_query_get(q, "name", name, sizeof name) ||
        !util_query_get(q, "offset", offs, sizeof offs))
    {
        http_resp(c, 400, "Bad Request", NULL, 0);
        return 1;
    }
    if (!util_query_get(q, "dir", dir, sizeof dir))
        dir[0] = 0;
    runtime *rt = session_by_token(token);
    if (!rt)
    {
        http_resp(c, 403, "Forbidden", NULL, 0);
        return 1;
    }
    /* 目录缺省时落到该用户桌面（登录时服务端已确保 ~/Desktop 存在） */
    if (!dir[0])
    {
        struct passwd *pw = getpwnam(rt->user);
        if (!pw || !pw->pw_dir || !pw->pw_dir[0])
        {
            runtime_unref(rt);
            http_resp(c, 403, "Forbidden", NULL, 0);
            return 1;
        }
        snprintf(dir, sizeof dir, "%s/Desktop", pw->pw_dir);
    }
    char real_dir[4096];
    if (!util_path_in_user_home(rt->user, dir, real_dir, sizeof real_dir))
    {
        runtime_unref(rt);
        http_resp(c, 403, "Forbidden", NULL, 0);
        return 1;
    }
    /* 文件名防路径穿越：只取 basename */
    const char *bn = strrchr(name, '/');
    bn = bn ? bn + 1 : name;
    if (!bn[0] || !strcmp(bn, ".") || !strcmp(bn, ".."))
    {
        runtime_unref(rt);
        http_resp(c, 400, "Bad Request", NULL, 0);
        return 1;
    }
    char full[4096];
    int fl = snprintf(full, sizeof full, "%s/%s", real_dir, bn);
    if (fl < 0 || (size_t)fl >= sizeof full)
    {
        /* 路径过长被截断会写错文件，直接拒绝 */
        runtime_unref(rt);
        http_resp(c, 400, "Name Too Long", NULL, 0);
        return 1;
    }
    long long offset = atoll(offs);
    if (offset < 0)
    {
        runtime_unref(rt);
        http_resp(c, 400, "Bad Request", NULL, 0);
        return 1;
    }

    int fd = open(full, O_CREAT | O_WRONLY, 0644);
    if (fd < 0)
    {
        runtime_unref(rt);
        http_resp(c, 403, "Forbidden", NULL, 0);
        return 1;
    }
    /* 服务端以 root 运行，创建的文件属主是 root；chown 给会话用户，
     * 否则用户在桌面里无法读写上传的文件 */
    struct passwd *upw = getpwnam(rt->user);
    if (upw)
    {
        int rc = fchown(fd, upw->pw_uid, upw->pw_gid);
        (void)rc;
    }
    ssize_t w = pwrite(fd, body, body_len, (off_t)offset);
    close(fd);
    runtime_unref(rt);
    if (w != (ssize_t)body_len)
    {
        http_resp(c, 500, "Write Failed", NULL, 0);
        return 1;
    }
    http_resp(c, 200, "OK", NULL, 0);
    return 1;
}

/* ---------------- 入口 ---------------- */
int transfer_handle_http(conn *c, const char *method, const char *path_q,
                         const char *xworkd_token,
                         const uint8_t *body, size_t body_len)
{
    /* 分离 path 与 query */
    char path[1024];
    const char *qm = strchr(path_q, '?');
    size_t pl = qm ? (size_t)(qm - path_q) : strlen(path_q);
    if (pl >= sizeof path)
        return 0;
    memcpy(path, path_q, pl);
    path[pl] = 0;
    const char *q = qm ? qm + 1 : "";

    /* CORS 预检（Tauri/跨源 WebView 的 XHR/fetch 上传需要） */
    if (!strcmp(method, "OPTIONS"))
    {
        static const char h[] =
            "HTTP/1.1 204 No Content\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
            "Access-Control-Allow-Headers: *\r\n"
            "Access-Control-Max-Age: 86400\r\n"
            "Content-Length: 0\r\nConnection: close\r\n\r\n";
        if (conn_queue_raw(c, (const uint8_t *)h, sizeof h - 1))
            c->close_after_flush = 1;
        else
            net_close_conn(c);
        return 1;
    }

    if (!strcmp(method, "POST") && !strcmp(path, "/api/transfer/request"))
        return handle_request(c, q, xworkd_token, body, body_len);
    if (!strcmp(method, "GET") && !strcmp(path, "/api/transfer/download"))
        return handle_download(c, q);
    if (!strcmp(method, "POST") && !strcmp(path, "/api/transfer/upload"))
        return handle_upload(c, q, body, body_len);
    return 0; /* 未匹配：http.c 继续（404） */
}
