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

int init_shm(runtime *rt)
{
    int scr = DefaultScreen(rt->dpy);
    rt->img = XShmCreateImage(rt->dpy, DefaultVisual(rt->dpy, scr),
                              DefaultDepth(rt->dpy, scr), ZPixmap, NULL,
                              &rt->shminfo, rt->width, rt->height);
    if (!rt->img)
    {
        log_err("XShmCreateImage 失败");
        return -1;
    }

    rt->shminfo.shmid = shmget(IPC_PRIVATE,
                               (size_t)rt->img->bytes_per_line * (size_t)rt->img->height,
                               IPC_CREAT | 0600);
    if (rt->shminfo.shmid < 0)
    {
        log_err("shmget: %s", strerror(errno));
        return -1;
    }

    rt->shminfo.shmaddr = rt->img->data = shmat(rt->shminfo.shmid, NULL, 0);
    rt->shminfo.readOnly = False;
    if (rt->shminfo.shmaddr == (char *)-1)
    {
        log_err("shmat: %s", strerror(errno));
        return -1;
    }

    if (!XShmAttach(rt->dpy, &rt->shminfo))
    {
        log_err("XShmAttach 失败");
        return -1;
    }
    XSync(rt->dpy, False);
    return 0;
}

/* ---------------- BGRA(32bpp) -> I420 ---------------- */
static inline uint8_t rgb2y(int r, int g, int b) { return (uint8_t)((66 * r + 129 * g + 25 * b + 128) >> 8) + 16; }
static inline uint8_t rgb2u(int r, int g, int b) { return (uint8_t)((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128; }
static inline uint8_t rgb2v(int r, int g, int b) { return (uint8_t)((112 * r - 94 * g - 18 * b + 128) >> 8) + 128; }

static void bgra_to_i420(const uint8_t *bgra, uint8_t *yuv, int w, int h)
{
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

void *capture_thread(void *arg)
{
    runtime *rt = arg;
    uint64_t interval_ns = 1000000000ull / (uint64_t)(g_cfg.fps > 0 ? g_cfg.fps : 30);

    struct timespec next;
    clock_gettime(CLOCK_MONOTONIC, &next);

    while (rt->running)
    {
        pthread_mutex_lock(&rt->xlock);
        int ok = XShmGetImage(rt->dpy, rt->root, rt->img, 0, 0, AllPlanes);
        pthread_mutex_unlock(&rt->xlock);

        if (ok)
        {
            bgra_to_i420((const uint8_t *)rt->img->data, rt->yuv, rt->width, rt->height);
            encode_frame(rt);
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
