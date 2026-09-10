/* http.c —— 极简 HTTP/1.1：WebSocket 握手 + 少量 JSON/传输接口。
 * 不提供前端静态文件服务（客户端自带 dist 离线加载）。
 * WS 握手因浏览器同步等待，使用短暂阻塞发送完成 101 应答。
 */
#define _GNU_SOURCE
#include "net.h"
#include "util.h"
#include "transfer.h"
#include "session.h"
#include "config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <poll.h>
#include <sys/socket.h>

#define WS_GUID "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
/* POST body 上限（上传按分片，单片远小于此）：防止未认证连接用可控的
 * Content-Length 无限灌内存。超限直接 413 拒绝，不等 body 收满。 */
#define HTTP_MAX_BODY (64u << 20)

/* 短暂阻塞发送（仅用于 WS 握手应答：帧很小，浏览器同步等待） */
static int send_brief(int fd, const void *data, size_t len)
{
    size_t off = 0;
    while (off < len)
    {
        ssize_t n = send(fd, (const char *)data + off, len - off, MSG_NOSIGNAL);
        if (n > 0)
        {
            off += (size_t)n;
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
        {
            struct pollfd p = {fd, POLLOUT, 0};
            if (poll(&p, 1, 2000) <= 0)
                return -1;
            continue;
        }
        return -1;
    }
    return 0;
}

static void http_error(conn *c, int code, const char *text)
{
    char resp[512];
    int n = snprintf(resp, sizeof resp,
                     "HTTP/1.1 %d %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                     code, text);
    if (conn_queue_raw(c, (const uint8_t *)resp, (size_t)n))
        c->close_after_flush = 1;
    else
    {
        net_close_conn(c);
    }
}

static void do_ws_upgrade(conn *c, const char *sec_key, size_t consumed)
{
    char src[256];
    snprintf(src, sizeof src, "%s%s", sec_key, WS_GUID);
    sha1_ctx ctx;
    sha1_init(&ctx);
    sha1_update(&ctx, src, strlen(src));
    uint8_t digest[20];
    sha1_final(&ctx, digest);
    char accept[64];
    b64_encode(digest, 20, accept, sizeof accept);

    char resp[512];
    int n = snprintf(resp, sizeof resp,
                     "HTTP/1.1 101 Switching Protocols\r\n"
                     "Upgrade: websocket\r\n"
                     "Connection: Upgrade\r\n"
                     "Sec-WebSocket-Accept: %s\r\n\r\n",
                     accept);
    if (send_brief(c->fd, resp, (size_t)n) != 0)
    {
        net_close_conn(c);
        return;
    }

    c->is_ws = 1;
    ws_parser_init(&c->ws, 1u << 20);
    c->http_done = 1;
    session_on_open(c);

    /* 剩余字节可能是 WS 帧 */
    if (consumed < c->rlen)
    {
        conn_consume(c, consumed);
        ws_on_data(c);
    }
    else
    {
        c->rlen = 0;
    }
}

/* ---------------- HTTP 解析 helper ---------------- */

/* 解析后的请求头字段（http_parse_headers 填充） */
typedef struct
{
    char sec_key[128];
    char xw_token[128];
    long clen;
    int upgrade;
} http_req_hdr;

/* 解析请求行："METHOD PATH VER"（method[16]/path[1024]）。成功返回 0，
 * *header_start 指向请求头起始。 */
static int http_parse_request_line(char *req, size_t len, char *method,
                                   char *path, char **header_start)
{
    char *line_end = memmem(req, len, "\r\n", 2);
    if (!line_end)
        return -1;
    *line_end = 0;
    char ver[16] = "";
    int r = sscanf(req, "%15s %1023s %15s", method, path, ver);
    *line_end = '\r';
    if (r != 3)
        return -1;
    *header_start = line_end + 2;
    return 0;
}

/* 解析请求头（hp..he），填充 sec_key/xw_token/clen/upgrade */
static void http_parse_headers(char *hp, char *he, http_req_hdr *h)
{
    memset(h, 0, sizeof *h);
    h->clen = -1;
    while (hp < he)
    {
        char *nl = memmem(hp, (size_t)(he - hp), "\r\n", 2);
        if (!nl)
            break;
        char *colon = memchr(hp, ':', (size_t)(nl - hp));
        if (colon)
        {
            char name[64];
            size_t nl2 = (size_t)(colon - hp);
            if (nl2 > 63)
                nl2 = 63;
            memcpy(name, hp, nl2);
            name[nl2] = 0;
            char *val = colon + 1;
            while (val < nl && (*val == ' ' || *val == '\t'))
                val++;
            size_t vl = (size_t)(nl - val);
            if (!strcasecmp(name, "Sec-WebSocket-Key") && vl > 0 && vl < sizeof h->sec_key)
            {
                memcpy(h->sec_key, val, vl);
                h->sec_key[vl] = 0;
            }
            if (!strcasecmp(name, "Upgrade") && vl >= 9 && !strncasecmp(val, "websocket", 9))
                h->upgrade = 1;
            if (!strcasecmp(name, "Content-Length") && vl > 0)
            {
                h->clen = strtol(val, NULL, 10);
                if (h->clen < 0)
                    h->clen = -1;
            }
            if (!strcasecmp(name, "X-Workd-Token") && vl > 0 && vl < sizeof h->xw_token)
            {
                memcpy(h->xw_token, val, vl);
                h->xw_token[vl] = 0;
            }
        }
        hp = nl + 2;
    }
}

/* 本地会话控制接口（/api/local/*）：PAM 守卫 xworkd-gdm-guard 在实体机登录
 * 时经 127.0.0.1 调用。令牌 = g_local_token（写入 /run/xworkd/local.token）。
 *   GET /api/local/session?user=<u>        → {"active":0|1}
 *   GET /api/local/session/end?user=<u>    → 结束该用户远程会话 → {"ok":true}
 * 返回 1=已处理。 */
static void http_json_reply(conn *c, const char *body)
{
    char hdr[256];
    int hn = snprintf(hdr, sizeof hdr,
                      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                      "Content-Length: %zu\r\nConnection: close\r\n\r\n",
                      strlen(body));
    if (conn_queue_raw(c, (const uint8_t *)hdr, (size_t)hn) &&
        conn_queue_raw(c, (const uint8_t *)body, strlen(body)))
        c->close_after_flush = 1;
    else
        net_close_conn(c);
}

static int http_route_local(conn *c, const char *path, const char *xw_token)
{
    if (strncmp(path, "/api/local/", 11) != 0)
        return 0;
    const char *q = strchr(path, '?');
    if (!q)
    {
        http_error(c, 400, "Bad Request");
        return 1;
    }
    char user[64], tok[160];
    int has_tok = util_query_get(q + 1, "token", tok, sizeof tok);
    if (!has_tok && xw_token[0])
    {
        snprintf(tok, sizeof tok, "%s", xw_token); /* 兼容 X-Workd-Token 头 */
        has_tok = 1;
    }
    if (!has_tok || !g_local_token[0] || strcmp(tok, g_local_token) != 0)
    {
        http_error(c, 403, "Forbidden");
        return 1;
    }
    if (!util_query_get(q + 1, "user", user, sizeof user))
    {
        http_error(c, 400, "Bad Request");
        return 1;
    }
    if (strstr(path, "/session/end") != NULL)
    {
        session_end_user_remote(user, "该账号已在实体机登录，远程会话已结束");
        http_json_reply(c, "{\"ok\":true}");
    }
    else
    {
        char body[96];
        int act = session_user_remote_active(user);
        snprintf(body, sizeof body, "{\"active\":%d}", act ? 1 : 0);
        http_json_reply(c, body);
    }
    return 1;
}

/* /api 路由（文件传输 + 本地会话控制）。返回 1=已处理，0=非 /api 路径。 */
static int http_route_api(conn *c, const char *method, const char *path,
                          const char *xw_token, size_t body_start, size_t len,
                          long clen)
{
    if (http_route_local(c, path, xw_token))
    {
        c->http_done = 1;
        return 1;
    }
    if (strncmp(path, "/api/", 5) != 0)
        return 0;
    if (!strcmp(method, "POST"))
    {
        if (clen <= 0)
        {
            http_error(c, 411, "Length Required");
            c->http_done = 1;
            return 1;
        }
        if ((uint64_t)clen > HTTP_MAX_BODY)
        {
            http_error(c, 413, "Payload Too Large");
            c->http_done = 1;
            return 1;
        }
        size_t got = len - body_start;
        if (got < (size_t)clen)
        {
            c->http_await_body = 1; /* 等 body 收满，下次 http_on_data 续收 */
            c->http_clen = (size_t)clen;
            return 1;
        }
        const uint8_t *body = (const uint8_t *)c->rbuf + body_start;
        transfer_handle_http(c, method, path, xw_token, body, (size_t)clen);
    }
    else if (!strcmp(method, "GET") && !strcmp(path, "/api/info"))
    {
        /* 服务端版本（编译期固定）暴露给客户端“关于”面板 */
        char body[128];
        snprintf(body, sizeof body, "{\"version\":\"%s\"}", XWORKD_VERSION);
        http_json_reply(c, body);
    }
    else
    {
        if (!transfer_handle_http(c, method, path, xw_token, NULL, 0))
            http_error(c, 404, "Not Found");
    }
    c->http_done = 1;
    return 1;
}

void http_on_data(conn *c)
{
    if (c->http_done || c->close_after_flush)
        return;

    char *req = (char *)c->rbuf;
    size_t len = c->rlen;
    char *he = memmem(req, len, "\r\n\r\n", 4);
    if (!he)
    {
        if (len >= 65536)
            http_error(c, 400, "Bad Request");
        return; /* 等待更多数据 */
    }

    char method[16] = "", path[1024] = "";
    char *hp = NULL;
    if (http_parse_request_line(req, len, method, path, &hp) != 0)
    {
        http_error(c, 400, "Bad Request");
        return;
    }

    http_req_hdr h;
    http_parse_headers(hp, he, &h);
    size_t body_start = (size_t)((he + 4) - req);

    /* 状态 2：等待 POST body 收满 */
    if (c->http_await_body)
    {
        size_t got = len - body_start;
        if (got < c->http_clen)
            return; /* 继续等更多数据 */
        transfer_handle_http(c, method, path, h.xw_token,
                             (const uint8_t *)req + body_start, c->http_clen);
        c->http_done = 1;
        return;
    }

    if (h.upgrade && h.sec_key[0])
    {
        do_ws_upgrade(c, h.sec_key, body_start);
        return;
    }

    if (http_route_api(c, method, path, h.xw_token, body_start, len, h.clen))
        return;

    /* 其余路径：本服务不再提供静态资源（客户端自带页面），一律 404 */
    http_error(c, 404, "Not Found");
    c->http_done = 1;
}
