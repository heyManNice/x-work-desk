/* clip.c —— 剪贴板共享（每会话独立）。
 * 读取方向：XFixes 订阅 CLIPBOARD owner 变化，XConvertSelection 直接
 * 请求 UTF8_STRING 内容推送前端（避免 fork xclip 的启动延迟，抢在
 * 剪贴板管理器接管前读到内容）。
 * 写入方向：作为 CLIPBOARD/PRIMARY owner 响应粘贴请求（自实现 X11
 * selection），被外部清空后自动恢复。
 * 状态全部挂在 runtime->clip，多用户会话互不串扰。
 * 仅支持文本；内容哈希去重避免重复推送。 */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#include "session.h"
#include "protocol.h"
#include "util.h"

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <X11/Xatom.h>
#include <X11/extensions/Xfixes.h>

#define CLIP_MAX 1048576 /* 1MB 文本上限 */

static uint64_t hash_text(const uint8_t *s, size_t n)
{
    uint64_t h = 1469598103934665603ull;
    for (size_t i = 0; i < n; i++)
    {
        h ^= s[i];
        h *= 1099511628211ull;
    }
    return h;
}

/* 响应 SelectionRequest：把内容写进请求方 property 并回发通知 */
static void clip_serve_selection(runtime *rt, XSelectionRequestEvent *req)
{
    clip_ctx *cl = &rt->clip;
    Display *dpy = rt->cap.dpy;
    XSelectionEvent se;
    memset(&se, 0, sizeof se);
    se.type = SelectionNotify;
    se.display = dpy;
    se.requestor = req->requestor;
    se.selection = req->selection;
    se.target = req->target;
    se.time = req->time;
    se.property = None;

    pthread_mutex_lock(&cl->lock);
    if (cl->own_text && cl->own_len > 0)
    {
        if (req->target == cl->targets_atom)
        {
            Atom atoms[6];
            int n = 0;
            atoms[n++] = cl->utf8_atom;
            atoms[n++] = XA_STRING;
            atoms[n++] = cl->text_atom;
            atoms[n++] = cl->plain_atom;
            atoms[n++] = cl->plain_utf8_atom;
            atoms[n++] = cl->targets_atom;
            XChangeProperty(dpy, req->requestor, req->property, XA_ATOM, 32,
                            PropModeReplace, (unsigned char *)atoms, n);
            se.property = req->property;
        }
        else if (req->target == cl->utf8_atom || req->target == XA_STRING ||
                 req->target == cl->text_atom ||
                 req->target == cl->plain_atom ||
                 req->target == cl->plain_utf8_atom)
        {
            XChangeProperty(dpy, req->requestor, req->property, req->target, 8,
                            PropModeReplace, cl->own_text, (int)cl->own_len);
            se.property = req->property;
        }
    }
    pthread_mutex_unlock(&cl->lock);
    XSendEvent(dpy, req->requestor, False, 0, (XEvent *)&se);
    XFlush(dpy);
}

/* 直接请求 selection 内容（XConvertSelection），避免 fork xclip 的启动延迟，
 * 抢在剪贴板管理器接管前读到内容。带 500ms 超时（owner 无响应时返回 NULL）。 */
static uint8_t *clip_read(runtime *rt, Atom sel, Atom target, size_t *len)
{
    clip_ctx *cl = &rt->clip;
    Display *dpy = rt->cap.dpy;
    Atom prop = cl->read_prop_atom;

    XDeleteProperty(dpy, cl->read_win, prop);
    XConvertSelection(dpy, sel, target, prop, cl->read_win, CurrentTime);
    XFlush(dpy);

    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_nsec += 500 * 1000000L;
    if (deadline.tv_nsec >= 1000000000L)
    {
        deadline.tv_sec++;
        deadline.tv_nsec -= 1000000000L;
    }

    for (;;)
    {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        if (now.tv_sec > deadline.tv_sec ||
            (now.tv_sec == deadline.tv_sec && now.tv_nsec > deadline.tv_nsec))
            break;

        XEvent ev;
        while (XCheckTypedWindowEvent(dpy, cl->read_win, SelectionNotify, &ev))
        {
            XSelectionEvent *se = &ev.xselection;
            if (se->property == None)
                return NULL; /* owner 无 UTF8_STRING */
            Atom type;
            int fmt;
            unsigned long n, after;
            unsigned char *data = NULL;
            if (XGetWindowProperty(dpy, cl->read_win, prop, 0, CLIP_MAX,
                                   True, AnyPropertyType, &type, &fmt, &n,
                                   &after, &data) == Success &&
                data && n > 0)
            {
                uint8_t *out = malloc(n);
                memcpy(out, data, n);
                XFree(data);
                *len = n;
                return out;
            }
            if (data)
                XFree(data);
            return NULL;
        }
        /* 顺手响应粘贴请求，避免事件堆积（也处理读取自身 owner 的情况） */
        while (XCheckTypedEvent(dpy, SelectionRequest, &ev))
            clip_serve_selection(rt, &ev.xselectionrequest);
        usleep(2000);
    }
    return NULL;
}

/* capture 线程初始化：订阅 PRIMARY 与 CLIPBOARD owner 变化 */
void clip_init(runtime *rt, int event_base)
{
    clip_ctx *cl = &rt->clip;
    cl->event_base = event_base;
    if (!event_base || !rt->cap.dpy)
        return;
    cl->clip_atom = XInternAtom(rt->cap.dpy, "CLIPBOARD", False);
    cl->primary_atom = XInternAtom(rt->cap.dpy, "PRIMARY", False);
    cl->utf8_atom = XInternAtom(rt->cap.dpy, "UTF8_STRING", False);
    cl->text_atom = XInternAtom(rt->cap.dpy, "TEXT", False);
    cl->targets_atom = XInternAtom(rt->cap.dpy, "TARGETS", False);
    cl->plain_atom = XInternAtom(rt->cap.dpy, "text/plain", False);
    cl->plain_utf8_atom = XInternAtom(rt->cap.dpy, "text/plain;charset=utf-8", False);
    cl->uri_list_atom = XInternAtom(rt->cap.dpy, "text/uri-list", False);
    cl->read_prop_atom = XInternAtom(rt->cap.dpy, "XWD_CLIP_DATA", False);
    /* 辅助窗口不映射：剪贴板 selection 的 owner/requestor 窗口无需显示，
     * 未映射也能接收 SelectionRequest/SelectionNotify 事件；映射后会被
     * GNOME 托盘/任务栏当作"unknown"应用窗口显示（1x1 无名窗口） */
    cl->owner_win = XCreateSimpleWindow(rt->cap.dpy, rt->cap.root,
                                        0, 0, 1, 1, 0, 0, 0);
    cl->read_win = XCreateSimpleWindow(rt->cap.dpy, rt->cap.root,
                                       0, 0, 1, 1, 0, 0, 0);
    XFixesSelectSelectionInput(rt->cap.dpy, rt->cap.root, cl->clip_atom,
                               XFixesSetSelectionOwnerNotifyMask);
    pthread_mutex_init(&cl->lock, NULL);
    XSync(rt->cap.dpy, False);
}

/* 保证前端内容仍是 CLIPBOARD/PRIMARY owner：被外部清空（owner 变 None）后
 * 自动恢复（300ms 限流，避免与剪贴板管理器互搏造成事件风暴/高 CPU）。
 * 注意：桌面应用成为 owner 时（owner 非 None）不抢回，保证能读到应用内容。 */
static void clip_ensure_owner(runtime *rt)
{
    clip_ctx *cl = &rt->clip;
    pthread_mutex_lock(&cl->lock);
    int has = (cl->own_text && cl->own_len > 0);
    pthread_mutex_unlock(&cl->lock);
    if (!has)
        return;
    int64_t now = monotonic_ms();
    if (now - cl->last_own_attempt_ms < 300)
        return;
    cl->last_own_attempt_ms = now;
    if (XGetSelectionOwner(rt->cap.dpy, cl->clip_atom) == None)
    {
        /* 同时接管 PRIMARY 与 CLIPBOARD：Ctrl+V 走 CLIPBOARD，中键粘贴走
         * PRIMARY；接管 PRIMARY 会覆盖其当前内容，属预期设计 */
        XSetSelectionOwner(rt->cap.dpy, cl->primary_atom, cl->owner_win, CurrentTime);
        XSetSelectionOwner(rt->cap.dpy, cl->clip_atom, cl->owner_win, CurrentTime);
        XFlush(rt->cap.dpy);
    }
}

/* capture 线程（xlock 内）：X 事件处理 + owner 设置 */
void clip_check(runtime *rt)
{
    if (!atomic_load(&rt->clip_enabled) || !rt->clip.event_base)
        return;
    XPending(rt->cap.dpy); /* 读 socket，事件入队列 */
    XEvent ev;
    while (XCheckTypedEvent(rt->cap.dpy, SelectionRequest, &ev))
        clip_serve_selection(rt, (XSelectionRequestEvent *)&ev);

    /* 前端内容就绪：成为 PRIMARY + CLIPBOARD owner */
    if (atomic_exchange(&rt->clip_pending_own, 0))
    {
        clip_ctx *cl = &rt->clip;
        pthread_mutex_lock(&cl->lock);
        if (cl->owner_win && cl->own_text)
        {
            XSetSelectionOwner(rt->cap.dpy, cl->primary_atom, cl->owner_win, CurrentTime);
            XSetSelectionOwner(rt->cap.dpy, cl->clip_atom, cl->owner_win, CurrentTime);
            XFlush(rt->cap.dpy);
        }
        pthread_mutex_unlock(&cl->lock);
    }
    /* 被外部接管后自动恢复（限流），尽量让前端内容常驻剪贴板 */
    clip_ensure_owner(rt);

    /* CLIPBOARD owner 变化（用户显式复制）→ 锁外读取并推送。
     * 注意：不监听 PRIMARY 自动读取——读取 PRIMARY 会让应用取消选中 */
    while (XCheckTypedEvent(rt->cap.dpy, rt->clip.event_base + XFixesSelectionNotify,
                            &ev))
    {
        XFixesSelectionNotifyEvent *se = (XFixesSelectionNotifyEvent *)&ev;
        if (se->subtype != XFixesSetSelectionOwnerNotify)
            continue;
        if (se->selection == rt->clip.clip_atom)
            atomic_store(&rt->clip_pending_read, 1);
    }
}

/* ---------- 文件剪贴板（text/uri-list）识别 ---------- */

static int hexval(char c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}

/* 把 file:// URI 的路径部分（s 为去掉 "file://" 后的串）解码为本地路径 */
static int fileuri_to_path(const char *s, char *out, size_t outsz)
{
    if (!s || outsz < 2)
        return 0;
    if (strncmp(s, "//", 2) == 0)
        s += 2; /* file://host/... -> host/... */
    /* 跳过 host 段（若有），从首个 '/' 开始才是本地路径 */
    if (s[0] != '/')
    {
        const char *hp = strchr(s, '/');
        if (!hp)
            return 0; /* 无路径：不是可落地的文件 */
        s = hp;
    }
    size_t oi = 0;
    while (*s && oi < outsz - 1)
    {
        if (*s == '%' && s[1] && s[2])
        {
            int a = hexval(s[1]), b = hexval(s[2]);
            if (a >= 0 && b >= 0)
            {
                out[oi++] = (char)((a << 4) | b);
                s += 3;
                continue;
            }
        }
        if (*s == '+')
            out[oi++] = ' ';
        else
            out[oi++] = *s;
        s++;
    }
    out[oi] = 0;
    return oi > 0;
}

/* 解析 text/uri-list 内容。返回值：
 *   >0 复制了文件且可推送 → out 填入每行一个 realpath 的列表
 *    0 内容非文件复制（如普通文本应用填的 uri-list）→ 调用方回退文本分支
 *   -1 是文件复制但路径均不在会话用户 home 内（越权）→ 不推送 */
static int parse_uri_files(runtime *rt, const uint8_t *data, size_t len,
                           char *out, size_t outsz)
{
    out[0] = 0;
    if (len == 0 || outsz < 2)
        return 0;
    char *copy = malloc(len + 1);
    if (!copy)
        return 0;
    memcpy(copy, data, len);
    copy[len] = 0;
    int saw_uri = 0, any = 0;
    size_t used = 0;
    char *save = NULL;
    for (char *line = strtok_r(copy, "\n", &save); line;
         line = strtok_r(NULL, "\n", &save))
    {
        size_t ll = strlen(line);
        while (ll && (line[ll - 1] == '\r' || line[ll - 1] == ' ' ||
                      line[ll - 1] == '\t'))
            line[--ll] = 0;
        if (!ll)
            continue;
        if (strncmp(line, "file://", 7) != 0)
        {
            free(copy);
            return 0; /* 出现非 file URI 行：判定为普通文本 */
        }
        saw_uri = 1;
        char dec[4096];
        if (!fileuri_to_path(line + 7, dec, sizeof dec))
            continue;
        char real[4096];
        if (util_path_in_user_home(rt->user, dec, real, sizeof real))
        {
            size_t rl = strlen(real);
            if (used + rl + 2 < outsz)
            {
                if (any)
                    out[used++] = '\n';
                memcpy(out + used, real, rl);
                used += rl;
                out[used] = 0;
                any++;
            }
        }
    }
    free(copy);
    if (!saw_uri)
        return 0;
    return any > 0 ? any : -1;
}

/* 锁外调用：读取 CLIPBOARD 并推送前端 */
void clip_read_push(runtime *rt)
{
    if (!atomic_exchange(&rt->clip_pending_read, 0))
        return;
    /* 剪贴板管理器可能触发事件风暴：限流读取（每次 XConvertSelection
     * 都有请求开销，风暴下反复读只会读到空） */
    int64_t now = monotonic_ms();
    if (now - rt->clip.last_read_ms < 300)
        return;
    rt->clip.last_read_ms = now;
    clip_ctx *cl = &rt->clip;

    /* ① 优先识别文件复制（text/uri-list）：Nautilus/GTK 复制文件时提供 */
    size_t ulen = 0;
    uint8_t *uri = clip_read(rt, cl->clip_atom, cl->uri_list_atom, &ulen);
    char flist[65536];
    if (uri && ulen > 0)
    {
        int fr = parse_uri_files(rt, uri, ulen, flist, sizeof flist);
        free(uri);
        if (fr > 0)
        {
            size_t bl = strlen(flist);
            uint64_t h = hash_text((const uint8_t *)flist, bl);
            if (h == rt->clip.last_hash)
                return;
            rt->clip.last_hash = h;
            uint8_t *out = malloc(1 + bl);
            if (!out)
                return;
            out[0] = MSG_CLIPBOARD_FILES;
            memcpy(out + 1, flist, bl);
            conn *c = atomic_load(&rt->conn);
            if (c)
                net_push_take(c, out, 1 + bl, 0);
            else
                free(out);
            return;
        }
        if (fr < 0)
            return; /* 复制了文件但路径越权：不推送文本 */
        /* fr == 0：内容非文件复制，落到文本分支继续 */
    }

    /* ② 文本剪贴板（UTF8_STRING） */
    size_t len = 0;
    uint8_t *text = clip_read(rt, cl->clip_atom, cl->utf8_atom, &len);
    if (!text)
        return;
    uint64_t h = hash_text(text, len);
    if (h == rt->clip.last_hash)
    {
        free(text);
        return;
    }
    rt->clip.last_hash = h;
    uint8_t *out = malloc(1 + len);
    if (!out)
    {
        free(text);
        return;
    }
    out[0] = MSG_CLIPBOARD;
    memcpy(out + 1, text, len);
    free(text);
    conn *c = atomic_load(&rt->conn);
    if (c)
        net_push_take(c, out, 1 + len, 0);
    else
        free(out);
}

/* 前端推来的文本 → 写入 X11 剪贴板（仅保存内容置标志，X 操作在 capture 线程） */
void clip_set(runtime *rt, const uint8_t *text, size_t len)
{
    if (!atomic_load(&rt->clip_enabled))
        return;
    if (len > CLIP_MAX)
        len = CLIP_MAX;
    if (len == 0)
        return;
    clip_ctx *cl = &rt->clip;
    pthread_mutex_lock(&cl->lock);
    free(cl->own_text);
    cl->own_text = malloc(len);
    memcpy(cl->own_text, text, len);
    cl->own_len = len;
    pthread_mutex_unlock(&cl->lock);
    atomic_store(&rt->clip_pending_own, 1);
    rt->clip.last_hash = hash_text(text, len);
}
