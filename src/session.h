#pragma once
#include "net.h"
#include <X11/Xlib.h>
#include <X11/extensions/XShm.h>
#include <pthread.h>
#include <stdint.h>
#include <sys/types.h>
#include <x264.h>

/* 单个用户的运行时会话：Xvfb + 编码器 + 抓帧线程 */
typedef struct runtime runtime;
struct runtime
{
    conn *conn; /* 持有引用，保证流期间连接存活 */
    int display;
    char display_str[16];
    char authfile[512];
    pid_t xvfb_pid;
    pid_t *children;
    int nchildren;
    char user[64];

    Display *dpy;
    Window root;
    int width, height;

    XShmSegmentInfo shminfo;
    XImage *img;
    uint8_t *yuv; /* I420 缓冲 */

    x264_t *enc;
    uint8_t *sps;
    size_t sps_len;
    uint8_t *pps;
    size_t pps_len;

    volatile int running;
    volatile int req_keyframe;
    pthread_mutex_t xlock; /* 保护 X 调用 */
    pthread_t cap_thread;
    uint64_t frame_index;
};

/* 由 net.c 调用（实现于本文件） */
void vdi_on_open(conn *c);
void vdi_on_message(conn *c, const uint8_t *data, size_t len);
void vdi_on_close(conn *c);

runtime *runtime_start(conn *c, const char *user, int w, int h);
void runtime_stop(runtime *rt);
