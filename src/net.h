#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <pthread.h>
#include "msgqueue.h"
#include "ws_parser.h"

/* 连接结构（net.c/eventloop.c 拥有并管理生命周期，session.c 通过 c->sess 使用） */
typedef struct conn
{
    int fd;
    int refs; /* 引用计数（事件循环 + worker/运行时） */
    _Atomic bool closing;
    int pindex; /* poll 数组中的下标 */

    /* ---- 读缓冲（动态增长：初始小块，按需扩容） ---- */
    uint8_t *rbuf;
    size_t rlen;
    size_t rcap;

    /* ---- HTTP 阶段状态（升级为 WS 后不再使用） ---- */
    int http_done; /* 1=已解析请求（升级或已响应） */
    int close_after_flush; /* 响应冲刷完毕后关闭连接 */

    /* ---- WS 帧解析状态（ws_parser 独立于 I/O，可单测） ---- */
    int is_ws;
    ws_parser ws;

    /* ---- 出站：消息队列 + 半发送帧/HTTP 响应 ---- */
    msg_queue outq;
    uint8_t *snd;
    size_t snd_len, snd_off;

    struct runtime *sess; /* 会话（session.c / session_msg.c 管理） */
    struct conn *next;
} conn;

/* net.c：监听 socket、唤醒管道、连接表（eventloop.c 使用） */
extern int net_listen_fd;
extern int net_wake_fds[2];
extern conn *net_conns;
extern int net_nconns;
extern char net_www_root[1024];
extern volatile int g_server_shutdown; /* SIGTERM/SIGINT 时置位（main.c） */

/* net.c 公共 API */
int net_init(int port, const char *www_root);
int net_run(void);
void net_wake(void);
void net_push(conn *c, const uint8_t *data, size_t len, int droppable);
void net_push_take(conn *c, uint8_t *data, size_t len, int droppable);
int conn_queue_raw(conn *c, const uint8_t *data, size_t len); /* 追加发送缓冲 */
void conn_ref(conn *c);
void conn_unref(conn *c);

/* 连接生命周期（eventloop.c 实现，net.c 声明供其他模块使用） */
conn *conn_alloc(int fd);
void net_close_conn(conn *c);

/* 读缓冲辅助 */
int conn_reserve(conn *c, size_t extra); /* 确保可追加 extra 字节，返回 1/0 */
void conn_consume(conn *c, size_t consumed); /* 消费前 consumed 字节，剩余移到头部 */

/* 协议处理（http.c / ws.c 实现，eventloop.c 调用） */
void http_on_data(conn *c); /* 有新的读数据，尝试解析 HTTP 请求 */
void ws_on_data(conn *c);   /* 有新的读数据，解析尽可能多的 WS 帧 */
void ws_flush(conn *c);     /* 冲刷出站队列与半发送帧（POLLOUT/唤醒时调用） */

/* 由 session.c / session_msg.c 实现 */
void session_on_open(conn *c);
void session_on_message(conn *c, const uint8_t *data, size_t len);
void session_on_close(conn *c);
