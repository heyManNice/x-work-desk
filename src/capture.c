#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#include "capture.h"
#include "net.h"
#include "protocol.h"
#include "config.h"
#include "encoder.h"
#include "util.h"
#include "clip.h"

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <time.h>
#include <X11/Xlib.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/Xfixes.h>
#include <sys/shm.h>

int init_shm(capture_ctx *cap, int width, int height)
{
    int scr = DefaultScreen(cap->dpy);
    cap->img = XShmCreateImage(cap->dpy, DefaultVisual(cap->dpy, scr),
                               DefaultDepth(cap->dpy, scr), ZPixmap, NULL,
                               &cap->shminfo, width, height);
    if (!cap->img)
    {
        log_err("XShmCreateImage 失败");
        return -1;
    }

    cap->shminfo.shmid = shmget(IPC_PRIVATE,
                                (size_t)cap->img->bytes_per_line * (size_t)cap->img->height,
                                IPC_CREAT | 0600);
    if (cap->shminfo.shmid < 0)
    {
        log_err("shmget: %s", strerror(errno));
        return -1;
    }

    cap->shminfo.shmaddr = cap->img->data = shmat(cap->shminfo.shmid, NULL, 0);
    cap->shminfo.readOnly = False;
    if (cap->shminfo.shmaddr == (char *)-1)
    {
        log_err("shmat: %s", strerror(errno));
        return -1;
    }

    if (!XShmAttach(cap->dpy, &cap->shminfo))
    {
        log_err("XShmAttach 失败");
        return -1;
    }
    XSync(cap->dpy, False);
    return 0;
}

/* ---------------- BGRA(32bpp) -> NV12 ---------------- */
static inline uint8_t rgb2y(int r, int g, int b) { return (uint8_t)((66 * r + 129 * g + 25 * b + 128) >> 8) + 16; }
static inline uint8_t rgb2u(int r, int g, int b) { return (uint8_t)((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128; }
static inline uint8_t rgb2v(int r, int g, int b) { return (uint8_t)((112 * r - 94 * g - 18 * b + 128) >> 8) + 128; }

/* NV12：Y 平面 + 交错 UV 平面（硬件编码器 NVENC/VAAPI 的通用输入格式） */
static void bgra_to_nv12(const uint8_t *bgra, video_buf *vb)
{
    int w = vb->width, h = vb->height;
    uint8_t *yuv = vb->yuv;
    uint8_t *Y = yuv;
    uint8_t *UV = yuv + (size_t)w * h;
    for (int j = 0; j < h; j++)
    {
        const uint8_t *row = bgra + (size_t)j * w * 4;
        uint8_t *yrow = Y + (size_t)j * w;
        if ((j & 1) == 0)
        {
            uint8_t *uvrow = UV + (size_t)(j / 2) * w;
            for (int i = 0; i < w; i += 2)
            {
                int b = row[i * 4], g = row[i * 4 + 1], r = row[i * 4 + 2];
                int b2 = row[i * 4 + 4], g2 = row[i * 4 + 5], r2 = row[i * 4 + 6];
                yrow[i] = rgb2y(r, g, b);
                yrow[i + 1] = rgb2y(r2, g2, b2);
                int rr = (r + r2) >> 1, gg = (g + g2) >> 1, bb = (b + b2) >> 1;
                uvrow[i] = rgb2u(rr, gg, bb);
                uvrow[i + 1] = rgb2v(rr, gg, bb);
            }
        }
        else
        {
            for (int i = 0; i < w; i++)
                yrow[i] = rgb2y(row[i * 4 + 2], row[i * 4 + 1], row[i * 4]);
        }
    }
}

/* 折叠 64 位混合，两个独立累加器，碰撞可忽略 */
static inline uint64_t mix64(uint64_t h, uint64_t v)
{
    h ^= v;
    h *= 0xff51afd7ed558ccdull;
    h ^= h >> 32;
    return h;
}

/* 对 BGRA 帧做快速签名；返回 1 表示内容发生变化（或首次抓取） */
static int frame_changed(capture_ctx *cap, video_buf *vb)
{
    const uint8_t *p = (const uint8_t *)cap->img->data;
    size_t stride = (size_t)cap->img->bytes_per_line;
    size_t row_bytes = (size_t)vb->width * 4;
    uint64_t h0 = 1469598103934665603ull; /* FNV offset basis ×2 */
    uint64_t h1 = 0xcbf29ce484222325ull;

    for (int y = 0; y < vb->height; y++)
    {
        const uint8_t *row = p + (size_t)y * stride;
        size_t i = 0;
        for (; i + 8 <= row_bytes; i += 8)
        {
            uint64_t v;
            memcpy(&v, row + i, 8);
            h0 = mix64(h0, v);
            h1 = mix64(h1, ~v);
        }
        for (; i < row_bytes; i++)
        {
            h0 = mix64(h0, row[i]);
            h1 = mix64(h1, row[i] ^ 0xa5);
        }
    }

    if (cap->have_sig && cap->sig[0] == h0 && cap->sig[1] == h1)
        return 0;
    cap->sig[0] = h0;
    cap->sig[1] = h1;
    cap->have_sig = 1;
    return 1;
}

/* 订阅并同步远程光标：XFixesCursorNotify 事件携带光标 serial，
 * serial 变化时取光标图像（XRender ARGB，premultiplied）转为直通 RGBA
 * 推送前端，前端据此设置 CSS cursor（手型/文本/调整大小等） */
static void cursor_check(runtime *rt)
{
    capture_ctx *cap = &rt->cap;
    if (!cap->cursor_event_base)
        return;
    XPending(cap->dpy); /* 读 socket，事件入队列 */
    XEvent ev;
    while (XCheckTypedEvent(cap->dpy, cap->cursor_event_base + XFixesCursorNotify,
                            &ev))
    {
        XFixesCursorNotifyEvent *ce = (XFixesCursorNotifyEvent *)&ev;
        cap->cursor_serial = ce->cursor_serial;
    }
    if (cap->cursor_serial == 0 || cap->cursor_serial == cap->cursor_sent)
        return;
    cap->cursor_sent = cap->cursor_serial;

    XFixesCursorImage *ci = XFixesGetCursorImage(cap->dpy);
    if (!ci)
        return;
    if (ci->width <= 0 || ci->height <= 0 ||
        ci->width > 256 || ci->height > 256)
    {
        XFree(ci);
        return;
    }
    size_t px = (size_t)ci->width * ci->height;
    uint8_t *buf = malloc(9 + px * 4);
    if (!buf)
    {
        XFree(ci);
        return;
    }
    uint8_t *p = buf;
    *p++ = MSG_CURSOR;
    wr_u16(p, (uint16_t)ci->width); p += 2;
    wr_u16(p, (uint16_t)ci->height); p += 2;
    wr_u16(p, (uint16_t)ci->xhot); p += 2;
    wr_u16(p, (uint16_t)ci->yhot); p += 2;
    /* XRender ARGB32（premultiplied alpha）→ 直通 RGBA */
    for (size_t i = 0; i < px; i++)
    {
        unsigned long v = ci->pixels[i];
        unsigned a = (v >> 24) & 0xff;
        unsigned r = (v >> 16) & 0xff;
        unsigned g = (v >> 8) & 0xff;
        unsigned b = v & 0xff;
        if (a && a != 255)
        {
            r = r * 255 / a;
            g = g * 255 / a;
            b = b * 255 / a;
        }
        *p++ = (uint8_t)r;
        *p++ = (uint8_t)g;
        *p++ = (uint8_t)b;
        *p++ = (uint8_t)a;
    }
    XFree(ci);
    conn *c = atomic_load(&rt->conn);
    if (c)
        net_push_take(c, buf, 9 + px * 4, 0);
    else
        free(buf);
}

void *capture_thread(void *arg)
{
    runtime *rt = arg;
    capture_ctx *cap = &rt->cap;

    struct timespec next;
    clock_gettime(CLOCK_MONOTONIC, &next);

    /* 订阅远程光标变化（XFixes） */
    int cev = 0, cerr = 0;
    if (XFixesQueryExtension(cap->dpy, &cev, &cerr))
    {
        cap->cursor_event_base = cev;
        XFixesSelectCursorInput(cap->dpy, cap->root, XFixesDisplayCursorNotifyMask);
        clip_init(rt, cev); /* 订阅 CLIPBOARD owner 变化 */
    }

    while (atomic_load(&cap->running))
    {
        /* 帧率可在运行期调整（MSG_SET_FPS），每次循环读取 */
        uint64_t interval_ns = 1000000000ull / (uint64_t)(atomic_load(&rt->fps) > 0 ? atomic_load(&rt->fps) : 30);
        pthread_mutex_lock(&cap->xlock);
        int ok = XShmGetImage(cap->dpy, cap->root, cap->img, 0, 0, AllPlanes);
        cursor_check(rt); /* 光标变化检查（同一 X 连接，xlock 内） */
        clip_check(rt);   /* 剪贴板 X 事件与 owner 设置（xlock 内） */
        pthread_mutex_unlock(&cap->xlock);
        clip_read_push(rt); /* 剪贴板读取（可能阻塞，锁外） */

        if (ok)
        {
            /* 静止帧跳过转换与编码；有 keyframe 请求时强制编码一帧 */
            int need_key = atomic_load(&cap->req_keyframe) != 0;
            int skip_static = atomic_load(&rt->static_skip) != 0;
            if (need_key || !skip_static || frame_changed(cap, &rt->video))
            {
                bgra_to_nv12((const uint8_t *)cap->img->data, &rt->video);
                encode_frame(rt);
            }
        }

        /* 节流到目标帧率 */
        next.tv_nsec += (long)interval_ns;
        while (next.tv_nsec >= 1000000000L)
        {
            next.tv_sec++;
            next.tv_nsec -= 1000000000L;
        }
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next, NULL);
    }
    return NULL;
}
