/* net.c —— 网络栈协调层：
 *   - 监听 socket / 唤醒管道 / 连接表等全局状态
 *   - 连接引用计数与内存管理
 *   - 出站消息入队（供抓帧/登录等线程调用）
 *   HTTP 解析在 http.c，WebSocket 帧解析在 ws.c，事件循环在 eventloop.c。
 */
#define _GNU_SOURCE
#include "net.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <netinet/in.h>

int net_listen_fd = -1;
int net_wake_fds[2] = {-1, -1};
conn *net_conns = NULL;
int net_nconns = 0;
char net_www_root[1024];

void conn_ref(conn *c)
{
    __sync_add_and_fetch(&c->refs, 1);
}

static void conn_free(conn *c)
{
    free(c->rbuf);
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
    if (net_wake_fds[1] >= 0)
    {
        uint8_t b = 1;
        (void)!write(net_wake_fds[1], &b, 1);
    }
}

int net_init(int port, const char *root)
{
    snprintf(net_www_root, sizeof net_www_root, "%s", root);
    net_listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (net_listen_fd < 0)
    {
        log_err("socket: %s", strerror(errno));
        return -1;
    }
    int one = 1;
    setsockopt(net_listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in sa;
    memset(&sa, 0, sizeof sa);
    sa.sin_family = AF_INET;
    sa.sin_addr.s_addr = INADDR_ANY;
    sa.sin_port = htons((uint16_t)port);
    if (bind(net_listen_fd, (struct sockaddr *)&sa, sizeof sa) < 0)
    {
        log_err("bind %d: %s", port, strerror(errno));
        return -1;
    }
    if (listen(net_listen_fd, 32) < 0)
    {
        log_err("listen: %s", strerror(errno));
        return -1;
    }
    /* 监听 socket 必须非阻塞，否则 accept 排空循环会阻塞卡死 */
    int fl = fcntl(net_listen_fd, F_GETFL, 0);
    fcntl(net_listen_fd, F_SETFL, fl | O_NONBLOCK);
    fcntl(net_listen_fd, F_SETFD, FD_CLOEXEC);
    if (pipe(net_wake_fds) != 0)
    {
        log_err("pipe: %s", strerror(errno));
        return -1;
    }
    fcntl(net_wake_fds[0], F_SETFL, O_NONBLOCK);
    fcntl(net_wake_fds[1], F_SETFL, O_NONBLOCK);
    return 0;
}

/* ---------------- 出站消息 ---------------- */
void net_push(conn *c, const uint8_t *data, size_t len, int droppable)
{
    if (!c || atomic_load(&c->closing))
        return;
    msgq_push(&c->outq, data, len, droppable);
    net_wake();
}

/* 零拷贝热路径：接管 data 所有权（失败或连接已关闭时释放） */
void net_push_take(conn *c, uint8_t *data, size_t len, int droppable)
{
    if (!c || atomic_load(&c->closing))
    {
        free(data);
        return;
    }
    if (!msgq_push_take(&c->outq, data, len, droppable))
        free(data);
    net_wake();
}

/* 直接把字节追加到发送缓冲（HTTP 响应 / WS 帧通用）。
 * 返回 1 成功；失败时关闭连接。 */
int conn_queue_raw(conn *c, const uint8_t *data, size_t len)
{
    if (atomic_load(&c->closing))
        return 0;
    if (len > 0)
    {
        uint8_t *nb = realloc(c->snd, c->snd_len + len);
        if (!nb)
        {
            net_close_conn(c);
            return 0;
        }
        c->snd = nb;
        memcpy(c->snd + c->snd_len, data, len);
        c->snd_len += len;
    }
    net_wake();
    return 1;
}

/* ---------------- 读缓冲 ---------------- */
int conn_reserve(conn *c, size_t extra)
{
    if (c->rlen + extra <= c->rcap)
        return 1;
    size_t cap = c->rcap ? c->rcap : 4096;
    while (cap < c->rlen + extra)
        cap *= 2;
    uint8_t *nb = realloc(c->rbuf, cap);
    if (!nb)
        return 0;
    c->rbuf = nb;
    c->rcap = cap;
    return 1;
}

/* 由解析器调用：消费 consumed 字节，把剩余数据移到缓冲头部 */
void conn_consume(conn *c, size_t consumed)
{
    if (consumed >= c->rlen)
    {
        c->rlen = 0;
        return;
    }
    memmove(c->rbuf, c->rbuf + consumed, c->rlen - consumed);
    c->rlen -= consumed;
}
