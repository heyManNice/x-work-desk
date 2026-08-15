#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#include "capture.h"
#include "net.h"
#include "protocol.h"
#include "config.h"
#include "encoder.h"
#include "util.h"

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <time.h>
#include <X11/Xlib.h>
#include <X11/extensions/XShm.h>
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

/* ---------------- BGRA(32bpp) -> I420 ---------------- */
static inline uint8_t rgb2y(int r, int g, int b) { return (uint8_t)((66 * r + 129 * g + 25 * b + 128) >> 8) + 16; }
static inline uint8_t rgb2u(int r, int g, int b) { return (uint8_t)((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128; }
static inline uint8_t rgb2v(int r, int g, int b) { return (uint8_t)((112 * r - 94 * g - 18 * b + 128) >> 8) + 128; }

static void bgra_to_i420(const uint8_t *bgra, video_buf *vb)
{
    int w = vb->width, h = vb->height;
    uint8_t *yuv = vb->yuv;
    uint8_t *Y = yuv;
    uint8_t *U = yuv + (size_t)w * h;
    uint8_t *V = yuv + (size_t)w * h + (size_t)(w / 2) * (h / 2);
    for (int j = 0; j < h; j++)
    {
        const uint8_t *row = bgra + (size_t)j * w * 4;
        uint8_t *yrow = Y + (size_t)j * w;
        if ((j & 1) == 0)
        {
            uint8_t *urow = U + (size_t)(j / 2) * (w / 2);
            uint8_t *vrow = V + (size_t)(j / 2) * (w / 2);
            for (int i = 0; i < w; i += 2)
            {
                int b = row[i * 4], g = row[i * 4 + 1], r = row[i * 4 + 2];
                int b2 = row[i * 4 + 4], g2 = row[i * 4 + 5], r2 = row[i * 4 + 6];
                yrow[i] = rgb2y(r, g, b);
                yrow[i + 1] = rgb2y(r2, g2, b2);
                int rr = (r + r2) >> 1, gg = (g + g2) >> 1, bb = (b + b2) >> 1;
                urow[i / 2] = rgb2u(rr, gg, bb);
                vrow[i / 2] = rgb2v(rr, gg, bb);
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

void *capture_thread(void *arg)
{
    runtime *rt = arg;
    uint64_t interval_ns = 1000000000ull / (uint64_t)(g_cfg.fps > 0 ? g_cfg.fps : 30);
    capture_ctx *cap = &rt->cap;

    struct timespec next;
    clock_gettime(CLOCK_MONOTONIC, &next);

    while (atomic_load(&cap->running))
    {
        pthread_mutex_lock(&cap->xlock);
        int ok = XShmGetImage(cap->dpy, cap->root, cap->img, 0, 0, AllPlanes);
        pthread_mutex_unlock(&cap->xlock);

        if (ok)
        {
            /* 静止帧跳过转换与编码；有 keyframe 请求时强制编码一帧 */
            int need_key = atomic_load(&cap->req_keyframe) != 0;
            if (need_key || frame_changed(cap, &rt->video))
            {
                bgra_to_i420((const uint8_t *)cap->img->data, &rt->video);
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
