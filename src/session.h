#pragma once
#include "net.h"
#include <X11/Xlib.h>
#include <X11/extensions/XShm.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <sys/types.h>
#include <x264.h>

/* I420 帧缓冲 + 几何信息：capture 填充、encoder 消费 */
typedef struct video_buf
{
    int width, height;
    uint8_t *yuv;
} video_buf;

/* Xvfb + 会话进程的生命周期 */
typedef struct proc_ctx
{
    int display; /* -1 表示尚未分配 */
    char display_str[16];
    char authfile[512];
    pid_t xvfb_pid;
    pid_t *children;
    int nchildren;
} proc_ctx;

/* 抓帧子系统的自有状态 */
typedef struct capture_ctx
{
    Display *dpy;
    Window root;
    XShmSegmentInfo shminfo;
    XImage *img;
    pthread_mutex_t xlock; /* 保护 X 调用（抓帧线程 + 输入注入） */
    pthread_t cap_thread;
    _Atomic int running;
    _Atomic int req_keyframe;
    uint64_t frame_index;
    uint64_t sig[2]; /* 上一帧内容签名（静止帧检测） */
    int have_sig;
} capture_ctx;

/* 编码器子系统的自有状态 */
typedef struct encoder_ctx
{
    x264_t *enc;
    uint8_t *sps;
    size_t sps_len;
    uint8_t *pps;
    size_t pps_len;
} encoder_ctx;

enum session_state
{
    S_LOGIN = 0,
    S_AUTHING = 1,
    S_RUNNING = 2,
    S_CLOSED = 3
};

/* 单个用户的会话：连接状态机 + Xvfb/抓帧/编码等子系统 */
typedef struct runtime runtime;
struct runtime
{
    int refs; /* 连接持有 1 份，登录/重建工作线程持有 1 份 */
    pthread_mutex_t lock;
    _Atomic int state; /* S_LOGIN / S_AUTHING / S_RUNNING / S_CLOSED */
    conn *conn;
    char user[64];

    video_buf video;
    proc_ctx proc;
    capture_ctx cap;
    encoder_ctx enc;
};

/* 由 net.c 调用（实现于本文件） */
void vdi_on_open(conn *c);
void vdi_on_message(conn *c, const uint8_t *data, size_t len);
void vdi_on_close(conn *c);
