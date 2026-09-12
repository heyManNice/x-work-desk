/* im.c —— 每会话的「输入法中继通道」（xworkd ↔ 会话内的 xworkd-im 引擎）
 *
 * 为什么通道在 xworkd 而不是客户端直连引擎：客户端在**另一台机器**上（这是远程桌面），
 * 只能走已有的 WS 连接；鉴权/网络边界由 xworkd 负责（设计稿 §3/§7）。
 *
 * 为什么不让 xworkd fork 引擎：引擎必须连它所在会话的 ibus-daemon，也就是必须活在
 * 会话的 dbus 会话里（会话桌面是 dbus-run-session 起的）。所以引擎由 ibus 按组件
 * 声明激活，xworkd 只把 socket 路径用 XWORKD_IM_SOCK 交给会话（见 sessproc.c）。
 *
 * 线程模型：本模块只在事件循环线程里被调用（poll 数组装配与事件处理都在那里），
 * 因此不加锁；唯一跨线程的入口是 im_send()——它也都在事件循环线程里调（WS 消息分发）。
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include "im.h"
#include "im_proto.h"
#include "util.h"

#include <errno.h>
#include <fcntl.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

/* socket 目录：优先 /run/xworkd（安装脚本会创建），开发/非 root 场景退回 /tmp */
static const char *im_dir(void)
{
    if (access("/run/xworkd", W_OK) == 0)
        return "/run/xworkd";
    return "/tmp";
}

/* 显示号 ":10" → "10"（只取数字，保证路径里没有特殊字符） */
static void im_disp_token(const char *display_str, char *out, size_t cap)
{
    size_t n = 0;

    if (display_str != NULL)
    {
        for (const char *p = display_str; *p != '\0' && n + 1 < cap; p++)
        {
            if (*p >= '0' && *p <= '9')
                out[n++] = *p;
        }
    }
    if (n == 0 && cap > 1)
        out[n++] = '0';
    out[n] = '\0';
}

/* 路径带上 display：同一用户可能同时开多个会话，只按 uid 命名会互相踩 */
static int im_make_path(const char *user, const char *display_str, char *out, size_t cap)
{
    char disp[16];
    uid_t uid = getuid();
    struct passwd *pw = (user != NULL && user[0] != '\0') ? getpwnam(user) : NULL;
    int n;

    if (pw != NULL)
        uid = pw->pw_uid;
    im_disp_token(display_str, disp, sizeof disp);
    n = snprintf(out, cap, "%s/xworkd-im-%u-%s.sock", im_dir(), (unsigned)uid, disp);
    return (n > 0 && (size_t)n < cap) ? 0 : -1;
}

static int im_set_nonblock_cloexec(int fd)
{
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl < 0 || fcntl(fd, F_SETFL, fl | O_NONBLOCK) < 0)
        return -1;
    if (fcntl(fd, F_SETFD, FD_CLOEXEC) < 0)
        return -1;
    return 0;
}

int im_open(im_ctx *im, const char *user, const char *display_str)
{
    struct sockaddr_un sa;
    struct passwd *pw;
    int fd;

    if (im->lfd >= 0)
        return 0; /* 幂等：会话重建时会先 im_close 再 im_open */
    if (im_make_path(user, display_str, im->path, sizeof im->path) != 0)
    {
        log_err("IM：socket 路径过长，通道不可用");
        return -1;
    }

    fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0)
    {
        log_err("IM：socket(): %s", strerror(errno));
        return -1;
    }
    if (im_set_nonblock_cloexec(fd) != 0)
    {
        log_err("IM：设置非阻塞失败: %s", strerror(errno));
        close(fd);
        return -1;
    }

    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    /* sun_path 只有 108 字节，超长会静默截断成另一个路径——宁可显式失败 */
    if (strlen(im->path) >= sizeof sa.sun_path)
    {
        log_err("IM：socket 路径过长（%zu ≥ %zu）：%s", strlen(im->path), sizeof sa.sun_path,
                im->path);
        close(fd);
        return -1;
    }
    memcpy(sa.sun_path, im->path, strlen(im->path) + 1);
    /* 清掉可能残留的同名 socket（上次会话异常退出/同名 display 复用） */
    unlink(im->path);
    if (bind(fd, (struct sockaddr *)&sa, sizeof sa) != 0)
    {
        log_err("IM：bind %s: %s", im->path, strerror(errno));
        close(fd);
        return -1;
    }
    /* 只让会话用户自己的引擎连：0600 + 属主=会话用户（root 运行时需 chown） */
    if (chmod(im->path, 0600) != 0)
        log_info("IM：chmod %s: %s", im->path, strerror(errno));
    pw = (user != NULL && user[0] != '\0') ? getpwnam(user) : NULL;
    if (geteuid() == 0 && pw != NULL)
    {
        if (chown(im->path, pw->pw_uid, pw->pw_gid) != 0)
            log_info("IM：chown %s: %s", im->path, strerror(errno));
    }
    if (listen(fd, 4) != 0)
    {
        log_err("IM：listen %s: %s", im->path, strerror(errno));
        close(fd);
        unlink(im->path);
        return -1;
    }
    im->lfd = fd;
    im->last_state = -1; /* 尚未通知过任何状态（不能靠 calloc 的 0：那正是 READY） */
    log_info("IM 通道就绪：%s（等会话内的引擎接入）", im->path);
    return 0;
}

void im_close(im_ctx *im)
{
    if (im->efd >= 0)
    {
        close(im->efd);
        im->efd = -1;
    }
    if (im->lfd >= 0)
    {
        close(im->lfd);
        im->lfd = -1;
    }
    if (im->path[0] != '\0')
    {
        unlink(im->path);
        im->path[0] = '\0';
    }
    free(im->in);
    free(im->out);
    im->in = im->out = NULL;
    im->in_len = im->in_cap = 0;
    im->out_len = im->out_off = im->out_cap = 0;
    im->pidx_l = im->pidx_e = -1;
    im->ever_connected = 0;
}

void im_set_handler(im_ctx *im, im_event_fn fn, void *ud)
{
    im->on_event = fn;
    im->ud = ud;
}

int im_engine_ready(const im_ctx *im) { return im->efd >= 0; }

/* ---------------------------- 发：xworkd → 引擎 ---------------------------- */

static int im_out_append(im_ctx *im, const void *data, size_t len)
{
    if (im->out_len + len > im->out_cap)
    {
        size_t cap = im->out_cap ? im->out_cap : 256;
        uint8_t *nb;
        while (cap < im->out_len + len)
            cap *= 2;
        /* 先把已发掉的前缀移掉，避免缓冲区无限增长 */
        if (im->out_off > 0)
        {
            memmove(im->out, im->out + im->out_off, im->out_len - im->out_off);
            im->out_len -= im->out_off;
            im->out_off = 0;
        }
        nb = realloc(im->out, cap);
        if (nb == NULL)
        {
            log_err("IM：出站缓冲分配失败（%zu 字节），丢弃一帧", len);
            return -1;
        }
        im->out = nb;
        im->out_cap = cap;
    }
    memcpy(im->out + im->out_len, data, len);
    im->out_len += len;
    return 0;
}

/* 返回 0=已全部发出（或无需发） / -1=连接已断（调用方可当发送失败） */
static int im_out_flush(im_ctx *im)
{
    while (im->efd >= 0 && im->out_len > im->out_off)
    {
        ssize_t n = write(im->efd, im->out + im->out_off, im->out_len - im->out_off);
        if (n > 0)
        {
            im->out_off += (size_t)n;
            continue;
        }
        if (n < 0 && errno == EINTR)
            continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
            return 0; /* 等 POLLOUT */
        log_info("IM：写引擎失败: %s", strerror(errno));
        return -1;
    }
    /* 发完就回收（下一次发送从头部开始写） */
    if (im->out_len == im->out_off)
        im->out_len = im->out_off = 0;
    return 0;
}

int im_send(im_ctx *im, uint8_t type, const void *payload, size_t len)
{
    uint8_t frame[IM_HEADER_LEN + IM_PAYLOAD_MAX];
    size_t n;

    if (im->efd < 0)
        return -1; /* 引擎不在：上层据此提示"本机输入法不可用" */
    n = im_frame_encode(frame, sizeof frame, type, payload, len);
    if (n == 0)
    {
        log_err("IM：帧过长（type=0x%02x len=%zu），丢弃", type, len);
        return -1;
    }
    if (im_out_append(im, frame, n) != 0)
        return -1;
    return im_out_flush(im);
}

int im_send_preedit(im_ctx *im, const char *text, unsigned pos)
{
    uint8_t payload[IM_PAYLOAD_MAX];
    size_t len = im_utf8_clip(text, IM_PAYLOAD_MAX - 2);

    im_put_u16le(payload, pos);
    if (len > 0)
        memcpy(payload + 2, text, len);
    return im_send(im, IM_MSG_PREEDIT, payload, len + 2);
}

int im_send_commit(im_ctx *im, const char *text)
{
    size_t len = text ? strlen(text) : 0;
    return im_send(im, IM_MSG_COMMIT, text, len);
}

int im_send_reset(im_ctx *im) { return im_send(im, IM_MSG_RESET, NULL, 0); }

/* ---------------------------- 收：引擎 → xworkd ---------------------------- */

static void im_drop_engine(im_ctx *im, const char *why)
{
    if (im->efd < 0)
        return;
    close(im->efd);
    im->efd = -1;
    im->in_len = 0;
    im->out_len = im->out_off = 0;
    log_info("IM：引擎断开（%s）", why != NULL ? why : "未知");
    if (im->on_event != NULL)
        im->on_event(im->ud, IM_EV_ENGINE_DOWN, NULL, 0);
}

static void im_accept(im_ctx *im)
{
    for (;;)
    {
        int fd = accept(im->lfd, NULL, NULL);
        if (fd < 0)
            return;
        if (im_set_nonblock_cloexec(fd) != 0)
        {
            close(fd);
            continue;
        }
        if (im->efd >= 0)
        {
            /* 每会话只服务一个引擎实例；多出来的（重复激活）直接拒绝 */
            log_info("IM：已有引擎接入，拒绝多余连接");
            close(fd);
            continue;
        }
        im->efd = fd;
        im->in_len = 0;
        im->out_len = im->out_off = 0;
        im->ever_connected = 1;
        log_info("IM：引擎已接入");
        if (im->on_event != NULL)
            im->on_event(im->ud, IM_EV_ENGINE_UP, NULL, 0);
    }
}

/* 把 in 缓冲里的完整帧全部交给上层 */
static void im_dispatch(im_ctx *im)
{
    size_t off = 0;

    while (off < im->in_len)
    {
        unsigned char type = 0;
        const unsigned char *payload = NULL;
        size_t plen = 0, used = 0;
        int r = im_frame_decode(im->in + off, im->in_len - off, &type, &payload, &plen, &used);

        if (r == 0)
            break; /* 半包，等下次可读 */
        if (r < 0)
        {
            /* 协议错乱：断开重连比继续解析安全（否则会一直错位） */
            im_drop_engine(im, "帧长度非法");
            return;
        }
        if (im->on_event != NULL)
            im->on_event(im->ud, type, payload, plen);
        off += used;
    }
    if (off > 0)
    {
        memmove(im->in, im->in + off, im->in_len - off);
        im->in_len -= off;
    }
}

static void im_read_engine(im_ctx *im)
{
    for (;;)
    {
        ssize_t n;

        if (im->in_len == im->in_cap)
        {
            size_t cap = im->in_cap ? im->in_cap * 2 : 1024;
            uint8_t *nb = realloc(im->in, cap);
            if (nb == NULL)
            {
                log_err("IM：收缓冲分配失败，断开引擎");
                im_drop_engine(im, "内存不足");
                return;
            }
            im->in = nb;
            im->in_cap = cap;
        }
        n = read(im->efd, im->in + im->in_len, im->in_cap - im->in_len);
        if (n > 0)
        {
            im->in_len += (size_t)n;
            continue;
        }
        if (n == 0)
        {
            im_drop_engine(im, "引擎关闭了连接");
            return;
        }
        if (errno == EINTR)
            continue;
        if (errno != EAGAIN && errno != EWOULDBLOCK)
            im_drop_engine(im, strerror(errno));
        break;
    }
    if (im->efd >= 0)
        im_dispatch(im);
}

/* ---------------------------- 事件循环接入 ---------------------------- */

int im_fdcount(const im_ctx *im)
{
    int n = 0;
    if (im->lfd >= 0)
        n++;
    if (im->efd >= 0)
        n++;
    return n;
}

int im_poll(im_ctx *im, struct pollfd *fds, int nfds)
{
    im->pidx_l = -1;
    im->pidx_e = -1;
    if (im->lfd >= 0)
    {
        fds[nfds].fd = im->lfd;
        fds[nfds].events = POLLIN;
        fds[nfds].revents = 0;
        im->pidx_l = nfds++;
    }
    if (im->efd >= 0)
    {
        fds[nfds].fd = im->efd;
        fds[nfds].events = POLLIN;
        if (im->out_len > im->out_off)
            fds[nfds].events |= POLLOUT;
        fds[nfds].revents = 0;
        im->pidx_e = nfds++;
    }
    return nfds;
}

void im_events(im_ctx *im, const struct pollfd *fds)
{
    if (im->pidx_l >= 0 && fds[im->pidx_l].revents != 0)
        im_accept(im);

    if (im->pidx_e < 0 || im->efd < 0)
        return;

    short re = fds[im->pidx_e].revents;
    if (re & (POLLERR | POLLNVAL))
    {
        im_drop_engine(im, "fd 错误");
        return;
    }
    if (re & POLLIN)
        im_read_engine(im);
    if (im->efd >= 0 && (re & POLLOUT))
        im_out_flush(im);
    /* POLLHUP 时上面的 read 会读到 0（EOF）并已断开，无需重复处理 */
}
