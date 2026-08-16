/* http.c —— 极简 HTTP/1.1：静态文件服务 + WebSocket 握手。
 * 静态文件响应通过发送缓冲异步冲刷（非阻塞事件循环），
 * WS 握手因浏览器同步等待，使用短暂阻塞发送完成 101 应答。
 */
#define _GNU_SOURCE
#include "net.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>

#define WS_GUID "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

static const char *mime_for(const char *path)
{
    const char *ext = strrchr(path, '.');
    if (!ext)
        return "application/octet-stream";
    if (!strcmp(ext, ".html"))
        return "text/html; charset=utf-8";
    if (!strcmp(ext, ".js"))
        return "text/javascript";
    if (!strcmp(ext, ".mjs"))
        return "text/javascript";
    if (!strcmp(ext, ".css"))
        return "text/css";
    if (!strcmp(ext, ".svg"))
        return "image/svg+xml";
    if (!strcmp(ext, ".png"))
        return "image/png";
    if (!strcmp(ext, ".ico"))
        return "image/x-icon";
    if (!strcmp(ext, ".json"))
        return "application/json";
    if (!strcmp(ext, ".woff2"))
        return "font/woff2";
    if (!strcmp(ext, ".map"))
        return "application/json";
    return "application/octet-stream";
}

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

/* 路径穿越检查：按 '/' 拆分成组件，任何组件为 ".." 即拒绝。
 * 相比 strstr(uri, "..")，不会误伤 "foo..bar" 之类的合法文件名，
 * 且按路径语义检查（服务器不做百分号解码，%2e%2e 只是普通文件名）。 */
static int path_safe(const char *uri)
{
    const char *p = uri;
    while (*p)
    {
        const char *seg = p;
        while (*p && *p != '/')
            p++;
        size_t n = (size_t)(p - seg);
        if (n == 2 && seg[0] == '.' && seg[1] == '.')
            return 0;
        if (*p == '/')
            p++;
    }
    return 1;
}

static void serve_file(conn *c, const char *uri)
{
    /* 路径安全 */
    if (!path_safe(uri))
    {
        http_error(c, 400, "Bad Request");
        return;
    }
    char path[2048];
    if (!strcmp(uri, "/") || !uri[0])
        snprintf(path, sizeof path, "%s/index.html", net_www_root);
    else
        snprintf(path, sizeof path, "%s%s", net_www_root, uri);

    struct stat st;
    if (stat(path, &st) != 0 || !S_ISREG(st.st_mode))
    {
        http_error(c, 404, "Not Found");
        return;
    }
    FILE *f = fopen(path, "rb");
    if (!f)
    {
        http_error(c, 404, "Not Found");
        return;
    }
    size_t sz = st.st_size > 0 ? (size_t)st.st_size : 0;
    uint8_t *body = malloc(sz + 1);
    size_t rd = fread(body, 1, sz, f);
    fclose(f);

    char hdr[512];
    int hn = snprintf(hdr, sizeof hdr,
                      "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %zu\r\n"
                      "Cache-Control: no-cache\r\nConnection: close\r\n\r\n",
                      mime_for(path), rd);
    int ok = conn_queue_raw(c, (const uint8_t *)hdr, (size_t)hn);
    if (ok && rd > 0)
        ok = conn_queue_raw(c, body, rd);
    free(body);
    if (ok)
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

    char *line_end = memmem(req, len, "\r\n", 2);
    if (!line_end)
    {
        http_error(c, 400, "Bad Request");
        return;
    }
    *line_end = 0;
    char method[16] = "", path[1024] = "", ver[16] = "";
    if (sscanf(req, "%15s %1023s %15s", method, path, ver) != 3)
    {
        http_error(c, 400, "Bad Request");
        return;
    }
    *line_end = '\r';

    /* 解析请求头 */
    char sec_key[128] = "";
    int upgrade = 0;
    char *hp = line_end + 2;
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
            if (!strcasecmp(name, "Sec-WebSocket-Key") && vl > 0 && vl < sizeof sec_key)
            {
                memcpy(sec_key, val, vl);
                sec_key[vl] = 0;
            }
            if (!strcasecmp(name, "Upgrade") && vl >= 9 && !strncasecmp(val, "websocket", 9))
                upgrade = 1;
        }
        hp = nl + 2;
    }

    size_t consumed = (size_t)((he + 4) - req);
    if (upgrade && sec_key[0])
    {
        do_ws_upgrade(c, sec_key, consumed);
        return;
    }

    /* 普通请求：响应缓冲化，事件循环冲刷后关闭 */
    serve_file(c, path);
    c->http_done = 1;
}
