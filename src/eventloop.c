/* eventloop.c —— poll 事件循环与连接生命周期。
 * 单线程模型：poll 监听 listen/wake/各连接 fd；
 * 唤醒管道用于把"抓帧/登录线程入队"快速反映到出站冲刷。
 */
#define _GNU_SOURCE
#include "net.h"
#include "util.h"
#include "session.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>

#define MAX_HTTP_REQ 65536

static int set_nonblock(int fd)
{
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl < 0)
        return -1;
    return fcntl(fd, F_SETFL, fl | O_NONBLOCK);
}

conn *conn_alloc(int fd)
{
    conn *c = calloc(1, sizeof *c);
    if (!c)
        return NULL;
    c->fd = fd;
    c->refs = 1;
    c->send_fd = -1; /* 无文件下载；0 会被 ws_flush 误判为 stdin */
    atomic_init(&c->closing, false);
    ws_parser_init(&c->ws, WS_MAX_FRAME_SIZE);
    /* 初始小预算；会话确定分辨率后由 session.c 按帧率/分辨率调整 */
    msgq_init(&c->outq, 512 * 1024);
    if (!conn_reserve(c, 4096))
    {
        free(c);
        return NULL;
    }
    return c;
}

/* 已关闭、等待事件循环在安全点统一回收的连接（net_close_conn 挂入） */
static conn *net_dead = NULL;

void net_close_conn(conn *c)
{
    if (atomic_load(&c->closing))
        return;
    atomic_store(&c->closing, 1);
    conn **pp = &net_conns;
    while (*pp && *pp != c)
        pp = &(*pp)->next;
    if (*pp)
        *pp = c->next;
    net_nconns--;
    if (c->fd >= 0)
    {
        /* 用 SHUT_WR 而非 SHUT_RDWR：半关闭先发 FIN，确保内核发送缓冲中
         * 的响应数据送达对端；SHUT_RDWR 会丢弃未发数据，触发 RST，
         * 导致浏览器 fetch/XHR 报 ERR_ABORTED（文件传输响应尤其敏感） */
        shutdown(c->fd, SHUT_WR);
        close(c->fd);
        c->fd = -1;
    }
    if (c->is_ws && c->sess)
        session_on_close(c);
    /* 不能立即 conn_unref 释放：事件循环/其他连接的处理中可能仍持有指向
     * 本连接的指针（如 nx=c->next 预存、PAM end 在处理 A 时关闭 B）。
     * 挂入 net_dead，由 net_run 每轮在安全点统一回收基础引用，彻底避免 UAF。 */
    c->dead_next = net_dead;
    net_dead = c;
}

/* 回收 net_dead：释放已关闭连接的基础引用（须在事件循环安全点调用） */
static void net_sweep_dead(void)
{
    conn *d = net_dead;
    net_dead = NULL;
    while (d)
    {
        conn *nx = d->dead_next;
        conn_unref(d); /* 归零则 conn_free；worker 仍持引用则推迟到其最后 unref */
        d = nx;
    }
}

int net_run(void)
{
    struct pollfd *fds = NULL;
    size_t fds_cap = 0;
    while (1)
    {
        net_sweep_dead(); /* 回收上一轮已关闭的连接（安全点） */
        size_t need = 2;  /* listen + wake */
        for (conn *c = net_conns; c; c = c->next)
            if (!atomic_load(&c->closing))
                need++;
        if (need > fds_cap)
        {
            fds_cap = need + 16;
            struct pollfd *nf = realloc(fds, fds_cap * sizeof *fds);
            if (!nf)
            {
                log_err("realloc poll 数组失败");
                break;
            }
            fds = nf;
        }

        int nfds = 0;
        fds[nfds].fd = net_listen_fd;
        fds[nfds].events = POLLIN;
        fds[nfds].revents = 0;
        nfds++;
        fds[nfds].fd = net_wake_fds[0];
        fds[nfds].events = POLLIN;
        fds[nfds].revents = 0;
        nfds++;

        for (conn *c = net_conns; c; c = c->next)
        {
            if (atomic_load(&c->closing))
                continue;
            fds[nfds].fd = c->fd;
            fds[nfds].events = POLLIN;
            /* send_fd>=0 表示 HTTP 流式文件下载中：socket 缓冲满（sendfile
             * EAGAIN）时必须持续注册 POLLOUT，否则连接永远不会被唤醒，
             * 大文件下载会卡住（小文件一次发完不暴露） */
            if (c->snd || c->send_fd >= 0)
                fds[nfds].events |= POLLOUT;
            fds[nfds].revents = 0;
            c->pindex = nfds;
            nfds++;
        }

        /* 250ms 周期：及时检测连接断开（缩小刷新重连的竞态窗口），
         * 并周期性清理已结束的会话 */
        if (poll(fds, (nfds_t)nfds, 250) < 0)
        {
            if (errno == EINTR)
                continue;
            log_err("poll: %s", strerror(errno));
            break;
        }

        /* 会话看护：系统注销（gnome-session 退出）或 Xvfb 崩溃时清理会话 */
        session_sweep();
        if (g_server_shutdown)
        {
            log_info("收到退出信号，清理所有会话...");
            session_shutdown_all();
            break;
        }

        /* 唤醒：刷新所有连接出站队列 */
        if (fds[1].revents & POLLIN)
        {
            uint8_t tmp[256];
            while (read(net_wake_fds[0], tmp, sizeof tmp) > 0)
            {
            }
            conn *c = net_conns;
            while (c)
            {
                conn *nx = c->next;
                if (c->is_ws && !atomic_load(&c->closing))
                    ws_flush(c);
                c = nx;
            }
        }

        /* 新连接 */
        if (fds[0].revents & POLLIN)
        {
            for (;;)
            {
                int fd = accept(net_listen_fd, NULL, NULL);
                if (fd < 0)
                    break;
                if (set_nonblock(fd) < 0 || fcntl(fd, F_SETFD, FD_CLOEXEC) < 0)
                {
                    close(fd);
                    continue;
                }
                conn *c = conn_alloc(fd);
                if (!c)
                {
                    close(fd);
                    continue;
                }
                c->next = net_conns;
                net_conns = c;
                net_nconns++;
            }
        }

        /* 处理各连接 */
        conn *c = net_conns;
        while (c)
        {
            conn *nx = c->next;
            if (atomic_load(&c->closing))
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
            {
                if (!ws_flush(c))
                {
                    c = nx;
                    continue;
                }
            }
            if (atomic_load(&c->closing))
            {
                c = nx;
                continue;
            }
            if (rev & POLLIN)
            {
                if (!conn_reserve(c, 8192))
                {
                    net_close_conn(c);
                    c = nx;
                    continue;
                }
                ssize_t n = read(c->fd, c->rbuf + c->rlen, c->rcap - c->rlen);
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
                    if (c->is_ws)
                        ws_on_data(c);
                    else
                        http_on_data(c);
                }
            }
            c = nx;
        }
    }
    free(fds);
    return 0;
}
