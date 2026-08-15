#pragma once
#include <stddef.h>
#include <stdint.h>
#include <pthread.h>
#include "msgqueue.h"

/* 连接结构（net.c 拥有并管理，session.c 通过 c->vdi 使用） */
typedef struct conn
{
    int fd;
    int refs; /* 引用计数（事件循环 + worker/运行时） */
    volatile int closing;
    int is_ws;
    int pindex; /* poll 数组中的下标 */

    /* 读缓冲 */
    uint8_t rbuf[65536];
    size_t rlen;

    /* WS 消息拼装 */
    uint8_t *msg;
    size_t msglen, msgcap;

    /* WS 帧解析状态 */
    int ws_hdr; /* 1=等待帧头 */
    int ws_final;
    int ws_opcode;
    int ws_msg_opcode;
    int ws_masked;
    uint64_t ws_payload_len;
    uint64_t ws_have;
    uint8_t ws_mask[4];

    /* 出站队列 + 半发送帧 */
    msg_queue outq;
    uint8_t *snd;
    size_t snd_len, snd_off;

    struct vdi_session *vdi;
    struct conn *next;
} conn;

int net_init(int port, const char *www_root);
int net_run(void);
void net_wake(void);
void net_push(conn *c, const uint8_t *data, size_t len, int droppable);
void conn_ref(conn *c);
void conn_unref(conn *c);

/* 由 session.c 实现 */
void vdi_on_open(conn *c);
void vdi_on_message(conn *c, const uint8_t *data, size_t len);
void vdi_on_close(conn *c);
