/* ws_parser.h —— 无 I/O 的 WebSocket 帧/消息解析状态机。
 * 与 socket 完全解耦，由 ws.c 驱动；可独立单元测试。
 * 支持分片二进制消息、ping/pong/close 控制帧与客户端掩码。 */
#pragma once
#include <stddef.h>
#include <stdint.h>

enum
{
    WS_EV_NONE = 0, /* 没有完整事件 */
    WS_EV_BINARY,   /* 完整二进制消息 */
    WS_EV_PING,
    WS_EV_PONG,
    WS_EV_CLOSE,
};

typedef struct
{
    int hdr;          /* 1=等待帧头 */
    uint8_t hdrbuf[14]; /* 帧头收集缓冲（2 基础 + 8 扩展 + 4 掩码） */
    size_t hdrlen;    /* 已收集的帧头字节数 */
    int final;        /* 当前帧 FIN */
    int opcode;       /* 当前帧 opcode */
    int msg_opcode;   /* 消息 opcode（continuation 帧沿用首个非控制帧） */
    int masked;       /* 客户端掩码标志 */
    uint64_t payload_len;
    uint64_t have;
    uint8_t mask[4];
    uint8_t *msg;     /* 二进制消息拼装缓冲 */
    size_t msglen, msgcap;
    size_t max_msg;   /* 二进制消息字节上限（超出视为协议错误） */
} ws_parser;

void ws_parser_init(ws_parser *p, size_t max_msg);
void ws_parser_destroy(ws_parser *p);

/* 解析 buf 中尽可能多的数据，返回消费的字节数：
 *   0  = 数据不足，等待更多输入；
 *   -1 = 协议错误（非法分片/超限）；
 *   >0 = 消费的字节数。
 * 有完整事件时通过 *ev 返回（无事件为 WS_EV_NONE），*payload 与 *plen
 * 指向事件数据：WS_EV_BINARY 时指向解析器内部缓冲，在下一次
 * ws_parser_feed 调用之前必须使用完毕。 */
int ws_parser_feed(ws_parser *p, const uint8_t *buf, size_t len,
                   int *ev, const uint8_t **payload, size_t *plen);
