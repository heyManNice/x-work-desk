/* ws.c —— WebSocket 帧解析 / 发送。
 * 帧头 + 载荷优先 writev 一次发出；套接字满时整帧缓存到 c->snd，
 * 由事件循环在 POLLOUT 时继续冲刷（见 ws_flush）。
 */
#define _GNU_SOURCE
#include "net.h"

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/uio.h>
#include <sys/socket.h>
#include <sys/sendfile.h>

/* 构造一帧并发送：优先 writev 零拷贝，失败则整帧缓存 */
static int ws_write_frame(conn *c, int opcode, const uint8_t *payload, size_t len)
{
    uint8_t h[10];
    h[0] = (uint8_t)(0x80 | opcode);
    size_t hdr;
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

    struct iovec iov[2] = {{h, hdr}, {(void *)payload, len}};
    ssize_t n = writev(c->fd, iov, 2);
    if (n < 0)
    {
        if (errno == EAGAIN || errno == EWOULDBLOCK)
        {
            /* 套接字已满：整帧缓存，等待 POLLOUT（而非断开连接） */
            uint8_t *buf = malloc(hdr + len);
            if (!buf)
                return -1;
            memcpy(buf, h, hdr);
            memcpy(buf + hdr, payload, len);
            free(c->snd);
            c->snd = buf;
            c->snd_len = hdr + len;
            c->snd_off = 0;
            return 0;
        }
        return -1;
    }
    if ((size_t)n == hdr + len)
        return 0;

    /* 部分发送：缓存剩余部分 */
    size_t sent = (size_t)n;
    uint8_t *rest = malloc(hdr + len - sent);
    if (!rest)
        return -1;
    if (sent < hdr)
    {
        memcpy(rest, h + sent, hdr - sent);
        memcpy(rest + (hdr - sent), payload, len);
    }
    else
    {
        memcpy(rest, payload + (sent - hdr), hdr + len - sent);
    }
    free(c->snd);
    c->snd = rest;
    c->snd_len = hdr + len - sent;
    c->snd_off = 0;
    return 0;
}

static void ws_send_pong(conn *c, const uint8_t *payload, size_t len)
{
    (void)ws_write_frame(c, 0xA, payload, len);
}

/* 冲刷发送缓冲 + 出站消息队列；HTTP 响应（close_after_flush）冲刷完即关闭 */
void ws_flush(conn *c)
{
    if (atomic_load(&c->closing))
        return;

    if (c->snd)
    {
        while (c->snd_off < c->snd_len)
        {
            ssize_t n = send(c->fd, c->snd + c->snd_off, c->snd_len - c->snd_off,
                             MSG_NOSIGNAL);
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

    /* HTTP 流式文件下载：响应头（snd）已发，逐块 sendfile 文件体 */
    if (c->send_fd >= 0)
    {
        while (c->send_left > 0)
        {
            size_t want = c->send_left > (1u << 20) ? (1u << 20) : (size_t)c->send_left;
            ssize_t n = sendfile(c->fd, c->send_fd, &c->send_off, want);
            if (n < 0)
            {
                if (errno == EAGAIN || errno == EWOULDBLOCK)
                    return;
                close(c->send_fd);
                c->send_fd = -1;
                net_close_conn(c);
                return;
            }
            if (n == 0)
                break; /* EOF 提前（文件被截断） */
            c->send_left -= (uint64_t)n;
        }
        close(c->send_fd);
        c->send_fd = -1;
        if (c->send_left == 0)
            c->close_after_flush = 1;
    }

    if (c->close_after_flush)
    {
        net_close_conn(c);
        return;
    }

    while (!atomic_load(&c->closing))
    {
        msg_node *n = msgq_pop(&c->outq);
        if (!n)
            break;
        int r = ws_write_frame(c, 0x2, n->data, n->len);
        free(n->data);
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

/* 解析缓冲中尽可能多的完整帧；剩余部分留在缓冲头部。
 * 帧级解析由 ws_parser（无 I/O）完成，这里只做事件分发。 */
void ws_on_data(conn *c)
{
    size_t off = 0;
    while (off < c->rlen)
    {
        int ev;
        const uint8_t *payload = NULL;
        size_t plen = 0;
        int n = ws_parser_feed(&c->ws, c->rbuf + off, c->rlen - off,
                               &ev, &payload, &plen);
        if (n < 0)
        {
            net_close_conn(c);
            return;
        }
        if (n == 0)
            break;
        off += (size_t)n;

        switch (ev)
        {
        case WS_EV_BINARY:
            session_on_message(c, payload, plen);
            break;
        case WS_EV_PING:
            ws_send_pong(c, payload, plen);
            break;
        case WS_EV_PONG:
            break;
        case WS_EV_CLOSE:
            net_close_conn(c);
            return;
        default:
            break;
        }
    }
    if (off > 0)
        conn_consume(c, off);
}
