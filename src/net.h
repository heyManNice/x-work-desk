#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <sys/types.h>
#include <pthread.h>
#include "msgqueue.h"
#include "ws_parser.h"

/* 本地会话控制接口令牌（http /api/local/* 用；main 启动时生成并写入
 * /run/xworkd/local.token 供 PAM 守卫等本机调用方读取） */
extern char g_local_token[64];

/* WS 单帧载荷上限 / 文件下载 sendfile 单块大小（1MB） */
#define WS_MAX_FRAME_SIZE (1u << 20)
#define TRANSFER_SEND_CHUNK (1u << 20)

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
    int http_done;         /* 1=已解析请求（升级或已响应） */
    int close_after_flush; /* 响应冲刷完毕后关闭连接 */

    /* ---- HTTP POST body 累积（transfer 上传分片） ---- */
    size_t http_clen;     /* Content-Length */
    int http_await_body;  /* 1=正在等待 body 收满 */

    /* ---- HTTP 流式文件下载（sendfile） ---- */
    int send_fd;        /* 下载中的文件描述符；-1=无 */
    off_t send_off;     /* 已发送偏移 */
    uint64_t send_left; /* 剩余待发字节 */

    /* ---- WS 帧解析状态（ws_parser 独立于 I/O，可单测） ---- */
    int is_ws;
    ws_parser ws;

    /* ---- 出站：消息队列 + 半发送帧/HTTP 响应 ---- */
    msg_queue outq;
    uint8_t *snd;
    size_t snd_len, snd_off;

    struct runtime *_Atomic sess; /* 会话（session.c / session_msg.c 管理；跨线程原子访问） */
    struct conn *next;      /* 活跃连接链（net_conns） */
    struct conn *dead_next; /* 已关闭待回收链（net_close_conn 挂入，事件循环清扫） */
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
int conn_reserve(conn *c, size_t extra);     /* 确保可追加 extra 字节，返回 1/0 */
void conn_consume(conn *c, size_t consumed); /* 消费前 consumed 字节，剩余移到头部 */

/* 协议处理（http.c / ws.c 实现，eventloop.c 调用） */
void http_on_data(conn *c); /* 有新的读数据，尝试解析 HTTP 请求 */
void ws_on_data(conn *c);   /* 有新的读数据，解析尽可能多的 WS 帧 */
int ws_flush(conn *c);      /* 冲刷出站队列与半发送帧（POLLOUT/唤醒时调用）；返回 1=连接仍有效，0=已关闭（不可再访问 c） */

/* 由 session.c / session_msg.c 实现 */
void session_on_open(conn *c);
void session_on_message(conn *c, const uint8_t *data, size_t len);
void session_on_close(conn *c);

/* 文件传输（transfer.c）：按 token 查找会话并推送传输请求 */
struct runtime *session_by_token(const char *token);
void session_push_transfer(conn *c, int action, const char *text);
void session_push_transfer_error(conn *c, const char *text);
