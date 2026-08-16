#pragma once
#include <X11/Xlib.h>
#include <X11/extensions/XShm.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>

struct runtime;

/* I420 帧缓冲 + 几何信息：capture 填充、encoder 消费 */
typedef struct video_buf
{
    int width, height;
    uint8_t *yuv;
} video_buf;

/* 抓帧子系统的自有状态 */
typedef struct capture_ctx
{
    Display *dpy;
    Window root;
    XShmSegmentInfo shminfo;
    XImage *img;
    int cursor_event_base;   /* XFixes 光标事件基号（0=不可用） */
    unsigned long cursor_serial;   /* 最近一次收到事件的光标 serial */
    unsigned long cursor_sent;     /* 已推送给前端的光标 serial */
    pthread_mutex_t xlock; /* 保护 X 调用（抓帧线程 + 输入注入） */
    pthread_t cap_thread;
    _Atomic int running;
    _Atomic int req_keyframe;
    uint64_t frame_index;
    uint64_t sig[2]; /* 上一帧内容签名（静止帧检测） */
    int have_sig;
    int _Atomic need_config; /* 接管/重建后要求重发 CONFIG */
    int rr_event_base;       /* RandR 屏幕变更事件基号（0=不可用） */
} capture_ctx;

int init_shm(capture_ctx *cap, int width, int height);
void *capture_thread(void *arg); /* arg = struct runtime*（pthread 线程入口） */
