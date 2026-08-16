#pragma once
#include "net.h"
#include <X11/Xlib.h>
#include <X11/extensions/XShm.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <sys/types.h>

/* FFmpeg 编码器上下文（仅前向声明，具体实现在 encoder.c） */
struct AVCodecContext;
struct AVFrame;
struct AVPacket;

/* 剪贴板共享状态（每会话独立，避免多用户内容串扰） */
typedef struct clip_ctx
{
    int event_base;          /* XFixes 事件基号 */
    unsigned long last_hash; /* 上次推送内容的哈希 */
    Window owner_win;        /* 剪贴板 owner 窗口 */
    Atom clip_atom, primary_atom, utf8_atom, text_atom, targets_atom;
    uint8_t *own_text;       /* 我们作为 owner 提供的内容 */
    size_t own_len;
    pthread_mutex_t lock;
} clip_ctx;

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
    char xorg_conf[512]; /* Xorg 模式下的配置文件（Xvfb 模式为空） */
    char user[64]; /* 会话进程的运行用户（清理时按 uid+DISPLAY 匹配） */
    pid_t xvfb_pid; /* X 服务器进程 pid（Xvfb 或 Xorg） */
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

/* 编码器子系统的自有状态 */
typedef struct encoder_ctx
{
    struct AVCodecContext *ctx; /* FFmpeg 编码上下文 */
    struct AVFrame *frame;      /* 输入帧（NV12） */
    struct AVPacket *pkt;       /* 输出包 */
    int kind;                   /* 0=libx264 1=nvenc 2=vaapi */
    int cur_kbps;               /* 当前生效码率（0=质量模式） */
    int cur_crf;                /* 当前生效质量档 */
    uint8_t *sps;
    size_t sps_len;
    uint8_t *pps;
    size_t pps_len;
} encoder_ctx;

enum session_state
{
    S_LOGIN = 0,
    S_AUTHING = 1,
    S_CONFIRM = 2, /* 已有活跃会话，等待前端确认接管 */
    S_RUNNING = 3,
    S_CLOSED = 4
};

/* 单个用户的会话：连接状态机 + Xvfb/抓帧/编码等子系统 */
typedef struct runtime runtime;
struct runtime
{
    int refs; /* 连接持有 1 份，登录/重建工作线程持有 1 份 */
    pthread_mutex_t lock;
    _Atomic int state; /* S_LOGIN / S_AUTHING / S_RUNNING / S_CLOSED */
    conn *_Atomic conn; /* 当前绑定的活动连接（可换绑；NULL=无人连接） */
    char user[64];
    char pass[256]; /* 登录密码：用于解锁会话 GNOME Keyring，teardown 时清零 */
    int req_w, req_h; /* 登录请求的分辨率（接管确认后重建会话用） */
    int _Atomic fps;  /* 最大抓帧帧率（前端可调） */
    int _Atomic static_skip;   /* 静态帧优化开关（画面无变化跳过编码） */
    int _Atomic bitrate_kbps;  /* 目标码率上限（0=自动/CRF 质量模式） */
    int _Atomic crf;           /* CRF 质量档（码率为自动时生效） */
    _Atomic int resize_w;      /* 待应用的新分辨率（>0 时 capture 线程执行） */
    _Atomic int resize_h;
    _Atomic int desired_w;     /* 期望分辨率（登录/MSG_RESIZE 设定；外部重置时重新应用） */
    _Atomic int desired_h;
    _Atomic int resize_retries; /* 外部重置后的重新应用计数（防止与 mutter 无限互搏） */
    _Atomic int restarting;    /* 1=重建工作线程运行中（避免重复触发） */

    /* ---- 音频传输（Opus，前端开关控制） ---- */
    int _Atomic audio_enabled;
    _Atomic int audio_running;
    pthread_t audio_thread;
    pid_t audio_pid; /* pw-record 采集子进程 */
    struct AVCodecContext *audio_ctx; /* Opus 编码器 */

    /* ---- 剪贴板共享（每会话独立状态） ---- */
    int _Atomic clip_enabled;
    clip_ctx clip;
    int _Atomic clip_pending_own;  /* 前端内容就绪，capture 线程执行 XSetSelectionOwner */
    int _Atomic clip_pending_read; /* 剪贴板变化，capture 线程锁外读取并推送 */

    video_buf video;
    proc_ctx proc;
    capture_ctx cap;
    encoder_ctx enc;
};

/* 由 net.c 调用（实现于本文件） */
void vdi_on_open(conn *c);
void vdi_on_message(conn *c, const uint8_t *data, size_t len);
void vdi_on_close(conn *c);
void session_sweep(void); /* 事件循环周期调用：清理已结束的会话 */
void session_shutdown_all(void); /* 服务退出前清理所有会话（优雅停机） */
void runtime_wait_destroyed(void); /* 停机前等待异步销毁完成 */

/* runtime 引用计数（sess_table.c 等模块使用） */
void runtime_ref(runtime *rt);
void runtime_unref(runtime *rt);
