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

/* 解析缓冲中尽可能多的完整帧；剩余部分留在缓冲头部 */
void ws_on_data(conn *c)
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
            }
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
        conn_consume(c, off);
}
