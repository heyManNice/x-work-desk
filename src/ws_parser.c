/* ws_parser.c —— WebSocket 帧解析状态机（纯逻辑，无 I/O）。
 * 帧头先收集进 hdrbuf 再统一解析，因此帧头跨多次 feed（TCP 分包）
 * 也能正确处理；二进制消息支持分片，续帧超出首帧缓冲时按需扩容。 */
#include "ws_parser.h"

#include <stdlib.h>
#include <string.h>

void ws_parser_init(ws_parser *p, size_t max_msg)
{
    memset(p, 0, sizeof *p);
    p->hdr = 1;
    p->max_msg = max_msg;
}

void ws_parser_destroy(ws_parser *p)
{
    free(p->msg);
    memset(p, 0, sizeof *p);
}

int ws_parser_feed(ws_parser *p, const uint8_t *buf, size_t len,
                   int *ev, const uint8_t **payload, size_t *plen)
{
    size_t off = 0;
    *ev = WS_EV_NONE;
    *payload = NULL;
    *plen = 0;

    while (off < len)
    {
        if (p->hdr)
        {
            /* 收集基础 2 字节头 */
            while (p->hdrlen < 2 && off < len)
                p->hdrbuf[p->hdrlen++] = buf[off++];
            if (p->hdrlen < 2)
                break;

            uint8_t b0 = p->hdrbuf[0], b1 = p->hdrbuf[1];
            /* 扩展长度位：126=2 字节，127=8 字节；客户端帧另有 4 字节掩码 */
            size_t ext = 0;
            if ((b1 & 0x7f) == 126)
                ext = 2;
            else if ((b1 & 0x7f) == 127)
                ext = 8;
            size_t need_total = 2 + ext + ((b1 & 0x80) ? 4 : 0);
            while (p->hdrlen < need_total && off < len)
                p->hdrbuf[p->hdrlen++] = buf[off++];
            if (p->hdrlen < need_total)
                break;

            p->final = (b0 & 0x80) != 0;
            p->opcode = b0 & 0x0f;
            p->masked = (b1 & 0x80) != 0;
            uint64_t plen_hdr = b1 & 0x7f;
            size_t o2 = 2;
            if (plen_hdr == 126)
            {
                plen_hdr = ((uint64_t)p->hdrbuf[o2] << 8) | p->hdrbuf[o2 + 1];
                o2 += 2;
            }
            else if (plen_hdr == 127)
            {
                plen_hdr = 0;
                for (int i = 0; i < 8; i++)
                    plen_hdr = (plen_hdr << 8) | p->hdrbuf[o2 + i];
                o2 += 8;
            }
            if (p->masked)
                memcpy(p->mask, p->hdrbuf + o2, 4);
            p->payload_len = plen_hdr;
            p->have = 0;
            p->hdrlen = 0;
            p->hdr = 0;

            if (p->opcode == 0x8)
            {
                /* close：解析到帧头即可上报事件 */
                *ev = WS_EV_CLOSE;
                return (int)off;
            }
            if (p->opcode == 0x9)
                p->msg_opcode = 0x9; /* ping */
            else if (p->opcode == 0xA)
                p->msg_opcode = 0xA; /* pong */
            else if (p->opcode == 0x0)
            { /* continuation：沿用 msg_opcode */ }
            else
                p->msg_opcode = p->opcode;

            if (p->msg_opcode == 0x2)
            {
                if (p->payload_len > p->max_msg)
                    return -1; /* 单帧即超过消息上限 */
                if (!p->msg)
                {
                    p->msg = malloc((size_t)p->payload_len + 1);
                    if (!p->msg)
                        return -1;
                    p->msgcap = (size_t)p->payload_len + 1;
                    p->msglen = 0;
                }
            }
            else if (p->msg_opcode == 0x9 || p->msg_opcode == 0xA)
            {
                /* 控制帧载荷上限 125（RFC 6455 §5.5）；载荷不回显，跳过即可 */
                if (p->payload_len > 125)
                    return -1;
            }
        }

        if (!p->hdr)
        {
            uint64_t want = p->payload_len - p->have;
            uint64_t avail = (uint64_t)(len - off);
            uint64_t take = want < avail ? want : avail;
            if (take > 0)
            {
                if (p->msg_opcode == 0x2)
                {
                    /* 分片续帧可能超出首帧分配的大小：按需扩容；
                     * 累计消息长度始终受 max_msg 约束 */
                    if (p->msglen + take > p->max_msg)
                        return -1;
                    if (p->msglen + take > p->msgcap)
                    {
                        size_t ncap = p->msgcap ? p->msgcap * 2
                                                : (size_t)p->payload_len + 1;
                        while (ncap < p->msglen + take)
                            ncap *= 2;
                        uint8_t *nb = realloc(p->msg, ncap);
                        if (!nb)
                            return -1;
                        p->msg = nb;
                        p->msgcap = ncap;
                    }
                    for (uint64_t k = 0; k < take; k++)
                    {
                        uint8_t b = buf[off + k];
                        if (p->masked)
                            b ^= p->mask[(p->have + k) & 3];
                        p->msg[p->msglen++] = b;
                    }
                }
                off += (size_t)take;
                p->have += take;
            }
            if (p->have == p->payload_len)
            {
                int done = p->final || p->msg_opcode != 0x2;
                if (done)
                {
                    if (p->msg_opcode == 0x2)
                    {
                        *ev = WS_EV_BINARY;
                        *payload = p->msg;
                        *plen = p->msglen;
                        p->msglen = 0; /* 缓冲保留复用，下次 feed 前须消费 */
                    }
                    else if (p->msg_opcode == 0x9)
                        *ev = WS_EV_PING;
                    else if (p->msg_opcode == 0xA)
                        *ev = WS_EV_PONG;
                    p->hdr = 1;
                    return (int)off;
                }
                p->hdr = 1; /* 二进制分片未完：读下一帧 */
            }
        }
    }
    return (int)off;
}
