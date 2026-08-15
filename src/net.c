#define _GNU_SOURCE
#include "net.h"
#include "util.h"
#include "protocol.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <stdarg.h>

#define WS_GUID "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

void net_close_conn(conn *c);
void ws_parse(conn *c);

static int listen_fd = -1;
static char www_root[1024];
static int wake_fds[2] = {-1, -1};
static conn *conns = NULL;
static int nconns = 0;

/* ---------------- 基础 ---------------- */
void conn_ref(conn *c) { __sync_add_and_fetch(&c->refs, 1); }

static void conn_free(conn *c)
{
    free(c->msg);
    free(c->snd);
    msgq_destroy(&c->outq);
    free(c);
}

void conn_unref(conn *c)
{
    if (__sync_sub_and_fetch(&c->refs, 1) == 0)
        conn_free(c);
}

void net_wake(void)
{
    if (wake_fds[1] >= 0)
    {
        uint8_t b = 1;
        (void)!write(wake_fds[1], &b, 1);
    }
}

int net_init(int port, const char *root)
{
    snprintf(www_root, sizeof www_root, "%s", root);
    listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0)
    {
        log_err("socket: %s", strerror(errno));
        return -1;
    }
    int one = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in sa;
    memset(&sa, 0, sizeof sa);
    sa.sin_family = AF_INET;
    sa.sin_addr.s_addr = INADDR_ANY;
    sa.sin_port = htons((uint16_t)port);
    if (bind(listen_fd, (struct sockaddr *)&sa, sizeof sa) < 0)
    {
        log_err("bind %d: %s", port, strerror(errno));
        return -1;
    }
    if (listen(listen_fd, 32) < 0)
    {
        log_err("listen: %s", strerror(errno));
        return -1;
    }
    /* 监听 socket 必须非阻塞，否则 accept 排空循环会阻塞卡死 */
    int fl = fcntl(listen_fd, F_GETFL, 0);
    fcntl(listen_fd, F_SETFL, fl | O_NONBLOCK);
    fcntl(listen_fd, F_SETFD, FD_CLOEXEC);
    if (pipe(wake_fds) != 0)
    {
        log_err("pipe: %s", strerror(errno));
        return -1;
    }
    fcntl(wake_fds[0], F_SETFL, O_NONBLOCK);
    fcntl(wake_fds[1], F_SETFL, O_NONBLOCK);
    return 0;
}

/* ---------------- HTTP ---------------- */
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

/* 阻塞发送（HTTP 阶段，fd 仍为阻塞模式） */
static int send_all_blocking(int fd, const void *data, size_t len)
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
            poll(&p, 1, 1000);
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
    (void)send_all_blocking(c->fd, resp, (size_t)n);
}

static void serve_file(conn *c, const char *uri)
{
    /* 路径安全 */
    if (strstr(uri, ".."))
    {
        http_error(c, 400, "Bad Request");
        return;
    }
    char path[2048];
    if (!strcmp(uri, "/") || !uri[0])
    {
        snprintf(path, sizeof path, "%s/index.html", www_root);
    }
    else
    {
        snprintf(path, sizeof path, "%s%s", www_root, uri);
    }
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
    if (send_all_blocking(c->fd, hdr, (size_t)hn) == 0)
        send_all_blocking(c->fd, body, rd);
    free(body);
}

/* ---------------- WebSocket 握手 ---------------- */
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
    if (send_all_blocking(c->fd, resp, (size_t)n) != 0)
    {
        net_close_conn(c);
        return;
    }

    c->is_ws = 1;
    c->ws_hdr = 1;
    vdi_on_open(c);

    /* 剩余字节可能是 WS 帧 */
    if (consumed < c->rlen)
    {
        memmove(c->rbuf, c->rbuf + consumed, c->rlen - consumed);
        c->rlen -= consumed;
        ws_parse(c);
    }
    else
    {
        c->rlen = 0;
    }
}

static void handle_http(conn *c)
{
    char *req = (char *)c->rbuf;
    size_t len = c->rlen;
    char *he = memmem(req, len, "\r\n\r\n", 4);
    if (!he)
    {
        if (len >= sizeof(c->rbuf) - 1)
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

    serve_file(c, path);
    net_close_conn(c);
}

/* ---------------- WebSocket 帧 ---------------- */
static int ws_write_frame(conn *c, int opcode, const uint8_t *payload, size_t len)
{
    size_t hdr;
    uint8_t h[10];
    h[0] = (uint8_t)(0x80 | opcode);
    if (len < 126)
    {
        h[1] = (uint8_t)len;
        hdr = 2;
    }
    else if (len <= 0xFFFF)
    {
        h[1] = 126;
        h[2] = (uint8_t)(len >> 8);
        h[3] = (uint8_t)(len & 0xff);
        hdr = 4;
    }
    else
    {
        h[1] = 127;
        for (int i = 0; i < 8; i++)
            h[2 + i] = (uint8_t)((uint64_t)len >> (8 * (7 - i)));
        hdr = 10;
    }
    uint8_t *buf = malloc(hdr + len);
    memcpy(buf, h, hdr);
    memcpy(buf + hdr, payload, len);

    ssize_t n = send(c->fd, buf, hdr + len, MSG_NOSIGNAL);
    if (n < 0)
    {
        free(buf);
        return -1;
    }
    if ((size_t)n == hdr + len)
    {
        free(buf);
        return 0;
    }
    /* 部分发送：保留待发 */
    free(c->snd);
    c->snd = buf;
    c->snd_len = hdr + len;
    c->snd_off = (size_t)n;
    return 0;
}

static void ws_send_pong(conn *c, const uint8_t *payload, size_t len)
{
    (void)ws_write_frame(c, 0xA, payload, len);
}

static void flush_conn(conn *c)
{
    if (c->closing)
        return;
    /* 先完成半发送帧 */
    if (c->snd)
    {
        while (c->snd_off < c->snd_len)
        {
            ssize_t n = send(c->fd, c->snd + c->snd_off, c->snd_len - c->snd_off, MSG_NOSIGNAL);
            if (n < 0)
            {
                if (errno == EAGAIN || errno == EWOULDBLOCK)
                    return;
                net_close_conn(c);
                return;
            }
            c->snd_off += (size_t)n;
        }
        free(c->snd);
        c->snd = NULL;
        c->snd_len = c->snd_off = 0;
    }
    /* 发送排队的逻辑消息 */
    while (!c->closing)
    {
        msg_node *n = msgq_pop(&c->outq);
        if (!n)
            break;
        int r = ws_write_frame(c, 0x2, n->data, n->len);
        free(n);
        if (r < 0)
        {
            net_close_conn(c);
            return;
        }
        if (c->snd)
            return; /* 半发送，等 POLLOUT */
    }
}

void net_push(conn *c, const uint8_t *data, size_t len, int droppable)
{
    if (!c || c->closing)
        return;
    msgq_push(&c->outq, data, len, droppable);
    net_wake();
}

/* WS 解析：处理缓冲中尽可能多的完整帧 */
void ws_parse(conn *c)
{
    size_t len = c->rlen;
    size_t off = 0;
    while (off < len)
    {
        if (c->ws_hdr)
        {
            if (len - off < 2)
                break;
            uint8_t b0 = c->rbuf[off], b1 = c->rbuf[off + 1];
            off += 2;
            c->ws_final = (b0 & 0x80) != 0;
            c->ws_opcode = b0 & 0x0f;
            c->ws_masked = (b1 & 0x80) != 0;
            uint64_t plen = b1 & 0x7f;
            if (plen == 126)
            {
                if (len - off < 2)
                    break;
                plen = ((uint64_t)c->rbuf[off] << 8) | c->rbuf[off + 1];
                off += 2;
            }
            else if (plen == 127)
            {
                if (len - off < 8)
                    break;
                plen = 0;
                for (int i = 0; i < 8; i++)
                    plen = (plen << 8) | c->rbuf[off + i];
                off += 8;
            }
            if (c->ws_masked)
            {
                if (len - off < 4)
                    break;
                memcpy(c->ws_mask, c->rbuf + off, 4);
                off += 4;
            }
            c->ws_payload_len = plen;
            c->ws_have = 0;
            c->ws_hdr = 0;
            if (c->ws_opcode == 0x8)
            {
                net_close_conn(c);
                return;
            } /* close */
            else if (c->ws_opcode == 0x9)
                c->ws_msg_opcode = 0x9; /* ping */
            else if (c->ws_opcode == 0xA)
                c->ws_msg_opcode = 0xA; /* pong */
            else if (c->ws_opcode == 0x0)
            { /* continuation: 沿用 msg_opcode */
            }
            else
                c->ws_msg_opcode = c->ws_opcode;
        }
        if (!c->ws_hdr)
        {
            uint64_t want = c->ws_payload_len - c->ws_have;
            uint64_t avail = (uint64_t)(len - off);
            uint64_t take = want < avail ? want : avail;
            if (take > 0)
            {
                if (c->ws_msg_opcode == 0x2)
                {
                    if (c->ws_payload_len > (1u << 20))
                    {
                        net_close_conn(c);
                        return;
                    }
                    if (!c->msg)
                    {
                        c->msgcap = (size_t)c->ws_payload_len + 1;
                        c->msg = malloc(c->msgcap);
                        c->msglen = 0;
                    }
                    for (uint64_t k = 0; k < take; k++)
                    {
                        uint8_t b = c->rbuf[off + k];
                        if (c->ws_masked)
                            b ^= c->ws_mask[(c->ws_have + k) & 3];
                        c->msg[c->msglen++] = b;
                    }
                }
                off += (size_t)take;
                c->ws_have += take;
            }
            if (c->ws_have == c->ws_payload_len)
            {
                if (c->ws_msg_opcode == 0x2 && c->ws_final)
                {
                    vdi_on_message(c, c->msg, c->msglen);
                }
                else if (c->ws_msg_opcode == 0x9)
                {
                    ws_send_pong(c, c->msg, c->msglen);
                }
                free(c->msg);
                c->msg = NULL;
                c->msglen = c->msgcap = 0;
                c->ws_hdr = 1;
            }
        }
        if (off >= len)
            break;
    }
    if (off > 0)
    {
        memmove(c->rbuf, c->rbuf + off, len - off);
        c->rlen = len - off;
    }
}

/* ---------------- 连接关闭 ---------------- */
void net_close_conn(conn *c)
{
    if (c->closing)
        return;
    c->closing = 1;
    conn **pp = &conns;
    while (*pp && *pp != c)
        pp = &(*pp)->next;
    if (*pp)
        *pp = c->next;
    nconns--;
    if (c->fd >= 0)
    {
        shutdown(c->fd, SHUT_RDWR);
        close(c->fd);
        c->fd = -1;
    }
    if (c->is_ws && c->vdi)
        vdi_on_close(c);
    conn_unref(c);
}

/* ---------------- 事件循环 ---------------- */
int net_run(void)
{
    struct pollfd fds[128];
    while (1)
    {
        int nfds = 0;
        fds[nfds].fd = listen_fd;
        fds[nfds].events = POLLIN;
        fds[nfds].revents = 0;
        nfds++;
        fds[nfds].fd = wake_fds[0];
        fds[nfds].events = POLLIN;
        fds[nfds].revents = 0;
        nfds++;

        for (conn *c = conns; c; c = c->next)
        {
            if (c->closing)
                continue;
            if (nfds >= 128)
                break;
            fds[nfds].fd = c->fd;
            fds[nfds].events = POLLIN;
            if (c->snd)
                fds[nfds].events |= POLLOUT;
            fds[nfds].revents = 0;
            c->pindex = nfds;
            nfds++;
        }

        if (poll(fds, (nfds_t)nfds, -1) < 0)
        {
            if (errno == EINTR)
                continue;
            log_err("poll: %s", strerror(errno));
            break;
        }

        /* 唤醒：刷新所有连接出站队列 */
        if (fds[1].revents & POLLIN)
        {
            uint8_t tmp[256];
            while (read(wake_fds[0], tmp, sizeof tmp) > 0)
            {
            }
            conn *c = conns;
            while (c)
            {
                conn *nx = c->next;
                if (c->is_ws && !c->closing)
                    flush_conn(c);
                if (c->closing)
                { /* flush 可能已关闭 */
                }
                c = nx;
            }
        }

        /* 新连接 */
        if (fds[0].revents & POLLIN)
        {
            for (;;)
            {
                int fd = accept(listen_fd, NULL, NULL);
                if (fd < 0)
                    break;
                /* 一律非阻塞：避免对新连接 read 时阻塞整个事件循环 */
                int afl = fcntl(fd, F_GETFL, 0);
                fcntl(fd, F_SETFL, afl | O_NONBLOCK);
                fcntl(fd, F_SETFD, FD_CLOEXEC);
                conn *c = calloc(1, sizeof *c);
                c->fd = fd;
                c->refs = 1;
                c->is_ws = 0;
                c->ws_hdr = 1;
                c->snd = NULL;
                msgq_init(&c->outq, 4 * 1024 * 1024);
                c->next = conns;
                conns = c;
                nconns++;
            }
        }

        /* 处理各连接 */
        conn *c = conns;
        while (c)
        {
            conn *nx = c->next;
            if (c->closing)
            {
                c = nx;
                continue;
            }
            short rev = fds[c->pindex].revents;
            if (rev & (POLLERR | POLLHUP | POLLNVAL))
            {
                net_close_conn(c);
                c = nx;
                continue;
            }
            if (rev & POLLOUT)
                flush_conn(c);
            if (c->closing)
            {
                c = nx;
                continue;
            }
            if (rev & POLLIN)
            {
                ssize_t n = read(c->fd, c->rbuf + c->rlen, sizeof(c->rbuf) - c->rlen);
                if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
                {
                    /* 忽略 */
                }
                else if (n <= 0)
                {
                    net_close_conn(c);
                }
                else
                {
                    c->rlen += (size_t)n;
                    if (!c->is_ws)
                        handle_http(c);
                    else
                        ws_parse(c);
                }
            }
            c = nx;
        }
    }
    return 0;
}
