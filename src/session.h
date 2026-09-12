#pragma once
#include "net.h"
#include "clip.h"
#include "capture.h"
#include "encoder.h"
#include "sessproc.h"
#include <X11/Xlib.h>
#include <X11/extensions/XShm.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <sys/types.h>

enum session_state
{
    S_LOGIN = 0,
    S_AUTHING = 1,
    S_CONFIRM = 2, /* 已有活跃会话，等待前端确认接管 */
    S_RUNNING = 3,
    S_CLOSED = 4,
    S_RESTARTING = 5 /* 运行中但 Xvfb 整体重建进行中（事件循环对其绕行） */
};

/* 单个用户的会话：连接状态机 + Xvfb/抓帧/编码等子系统 */
typedef struct runtime runtime;
struct runtime
{
    int refs; /* 连接持有 1 份，登录/重建工作线程持有 1 份 */
    pthread_mutex_t lock;
    _Atomic int state;  /* S_LOGIN / S_AUTHING / S_RUNNING / S_CLOSED */
    conn *_Atomic conn; /* 当前绑定的活动连接（可换绑；NULL=无人连接） */
    char user[64];
    char pass[256];           /* 登录密码：解锁会话 GNOME Keyring；Xvfb 重建会复用，真正销毁时擦除 */
    int _Atomic fps;          /* 最大抓帧帧率（前端可调） */
    int _Atomic static_skip;  /* 静态帧优化开关（画面无变化跳过编码） */
    int _Atomic bitrate_kbps; /* 目标码率上限（0=自动/CRF 质量模式） */
    int _Atomic crf;          /* CRF 质量档（码率为自动时生效） */
    int _Atomic anim_pending; /* 动画开关待应用：-1=关 0=无 1=开（capture 线程异步执行 gsettings） */
    _Atomic int resize_w;     /* 待应用的新分辨率（>0 时 capture 线程执行） */
    _Atomic int resize_h;
    _Atomic int desired_w; /* 期望分辨率（登录/MSG_RESIZE 设定；外部重置时重新应用） */
    _Atomic int desired_h;
    _Atomic int resize_retries;   /* 外部重置后的重新应用计数（防止与 mutter 无限互搏） */
    _Atomic int restarting;       /* 1=重建工作线程运行中（避免重复触发） */
    _Atomic int64_t cap_start_ms; /* 抓帧线程启动时间（单调毫秒） */
    _Atomic int settle_pending;   /* 登录早期分辨率请求：等 GNOME 稳定后补一次 */

    /* ---- 音频传输（Opus，libopus 直编，前端开关控制） ---- */
    _Atomic int audio_running;
    pthread_t audio_thread;
    pid_t audio_pid; /* pw-record 采集子进程 */

    /* ---- 剪贴板共享（每会话独立状态） ---- */
    int _Atomic clip_enabled;
    clip_ctx clip;
    int _Atomic clip_pending_own;  /* 前端内容就绪，capture 线程执行 XSetSelectionOwner */
    int _Atomic clip_pending_read; /* 剪贴板变化，capture 线程锁外读取并推送 */

    video_buf video;
    proc_ctx proc;
    capture_ctx cap;
    encoder_ctx enc;
    _Atomic int kick_local; /* 实体机占用提示后用户确认踢出（login worker 等待此标志） */
};

/* 由 net.c 调用（session.c / session_msg.c 实现） */
void session_on_open(conn *c);
void session_on_message(conn *c, const uint8_t *data, size_t len);
void session_on_close(conn *c);
void session_sweep(void);                                           /* 事件循环周期调用：清理已结束的会话 */
void session_shutdown_all(void);                                    /* 服务退出前清理所有会话（优雅停机） */
int session_user_remote_active(const char *user);                   /* 本地接口：该用户是否正有活跃远程连接 */
void session_end_user_remote(const char *user, const char *reason); /* 本地接口：结束该用户远程会话(注销销毁) */
void runtime_wait_destroyed(void);                                  /* 停机前等待异步销毁完成 */

/* runtime 引用计数（sess_table.c 等模块使用） */
void runtime_ref(runtime *rt);
void runtime_unref(runtime *rt);
void runtime_teardown(runtime *rt); /* 停抓帧线程并释放 X/编码/进程资源（幂等） */
