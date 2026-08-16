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
    atomic_init(&c->closing, false);
    ws_parser_init(&c->ws, 1u << 20);
    /* 初始小预算；会话确定分辨率后由 session.c 按帧率/分辨率调整 */
    msgq_init(&c->outq, 512 * 1024);
    if (!conn_reserve(c, 4096))
    {
        free(c);
        return NULL;
    }
    return c;
}

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
        shutdown(c->fd, SHUT_RDWR);
        close(c->fd);
        c->fd = -1;
    }
    if (c->is_ws && c->sess)
        session_on_close(c);
    conn_unref(c);
}

int net_run(void)
{
    struct pollfd *fds = NULL;
    size_t fds_cap = 0;
    while (1)
    {
        size_t need = 2; /* listen + wake */
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
            if (c->snd)
                fds[nfds].events |= POLLOUT;
            fds[nfds].revents = 0;
            c->pindex = nfds;
            nfds++;
        }

        /* 1 秒周期：兼顾即时性并允许周期性清理已结束的会话 */
        if (poll(fds, (nfds_t)nfds, 1000) < 0)
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
                ws_flush(c);
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
