#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#include "session.h"
#include "sessproc.h"
#include "sess_table.h"
#include "audio.h"
#include "clip.h"
#include "protocol.h"
#include "config.h"
#include "auth.h"
#include "capture.h"
#include "encoder.h"
#include "input.h"
#include "util.h"
#include <X11/Xutil.h>

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <stdio.h>
#include <errno.h>

static int runtime_restart(runtime *rt, int w, int h);

/* Xvfb 模式的异步分辨率重建任务（避免阻塞事件循环） */
typedef struct
{
    runtime *rt;
    int w, h;
} restart_job;
static void *restart_worker(void *arg);

/* 简单进程存活检查（非僵尸） */
static int proc_alive(pid_t pid)
{
    if (pid <= 0)
        return 0;
    char p[64];
    snprintf(p, sizeof p, "/proc/%d/stat", pid);
    FILE *f = fopen(p, "rb");
    if (!f)
        return 0;
    char buf[256];
    size_t n = fread(buf, 1, sizeof buf - 1, f);
    fclose(f);
    buf[n] = 0;
    char *rp = strrchr(buf, ')');
    if (!rp || rp[1] != ' ')
        return 0;
    return rp[2] != 0 && rp[2] != 'Z';
}

void runtime_ref(runtime *rt) { __sync_add_and_fetch(&rt->refs, 1); }

/* 停抓帧线程并释放 X/编码/进程资源；幂等，可在会话未完全启动时调用 */
static void runtime_teardown(runtime *rt)
{
    audio_stop(rt);
    if (atomic_load(&rt->cap.running))
    {
        atomic_store(&rt->cap.running, 0);
        pthread_join(rt->cap.cap_thread, NULL);
    }

    /* 先在 Xvfb 仍存活时优雅清理 X 资源 */
    if (rt->cap.img)
    {
        XShmDetach(rt->cap.dpy, &rt->cap.shminfo);
        XDestroyImage(rt->cap.img);
        shmctl(rt->cap.shminfo.shmid, IPC_RMID, NULL);
        rt->cap.img = NULL;
    }
    if (rt->cap.dpy)
    {
        XCloseDisplay(rt->cap.dpy);
        rt->cap.dpy = NULL;
    }
    encoder_destroy(&rt->enc);
    free(rt->video.yuv);
    rt->video.yuv = NULL;
    free(rt->enc.sps);
    rt->enc.sps = NULL;
    rt->enc.sps_len = 0;
    free(rt->enc.pps);
    rt->enc.pps = NULL;
    rt->enc.pps_len = 0;

    /* 会话进程清理策略：X 服务器若仍存活（用户系统注销、gnome-session 先退出），
     * 说明 systemd 用户实例正在正常收尾，跳过按 DISPLAY 扫描的 SIGKILL——
     * 否则会误杀 systemd 刚重启的 dbus/wireplumber 等常驻服务（它们环境里
     * 带 DISPLAY=:N），触发重启风暴并卡死用户管理器约 90s。
     * 只有 X 服务器已死（崩溃）时才兜底清理孤儿进程。 */
    int x_alive = proc_alive(rt->proc.xvfb_pid);

    /* 再杀掉 Xvfb 与会话进程（按进程组整体清理） */
    if (rt->proc.xvfb_pid > 0)
    {
        kill(-rt->proc.xvfb_pid, SIGTERM);
        kill(rt->proc.xvfb_pid, SIGTERM);
    }
    /* systemd 用户实例接管了 gnome-session/gnome-shell 等（不在我们的进程组），
     * 按「DISPLAY=:N + 用户」扫描 /proc 兜底清理，避免旧会话残留占用总线 */
    if (rt->proc.user[0] && !x_alive)
        kill_session_procs_by_display(rt->proc.user, rt->proc.display_str, 0);
    for (int i = 0; i < rt->proc.nchildren; i++)
        if (rt->proc.children[i] > 0)
        {
            kill(-rt->proc.children[i], SIGTERM);
            kill(rt->proc.children[i], SIGTERM);
        }

    for (int i = 0; i < 20; i++)
    {
        int any = 0;
        int st;
        if (rt->proc.user[0] && !x_alive)
            any |= kill_session_procs_by_display(rt->proc.user, rt->proc.display_str, 1);
        if (rt->proc.xvfb_pid > 0)
        {
            if (waitpid(rt->proc.xvfb_pid, &st, WNOHANG) == rt->proc.xvfb_pid)
                rt->proc.xvfb_pid = 0;
            else
                any = 1;
        }
        for (int i2 = 0; i2 < rt->proc.nchildren; i2++)
        {
            if (rt->proc.children[i2] > 0)
            {
                if (waitpid(rt->proc.children[i2], &st, WNOHANG) == rt->proc.children[i2])
                    rt->proc.children[i2] = 0;
                else
                    any = 1;
            }
        }
        if (!any)
            break;
        usleep(100000);
    }
    free(rt->proc.children);
    rt->proc.children = NULL;
    rt->proc.nchildren = 0;

    if (rt->proc.display >= 0)
    {
        unlink(rt->proc.authfile);
        if (rt->proc.xorg_conf[0])
        {
            unlink(rt->proc.xorg_conf);
            rt->proc.xorg_conf[0] = 0;
        }
        cleanup_rt_dir(rt);
        rt->proc.display = -1; /* 下一次 bring_up 重新分配 */
    }
    rt->cap.have_sig = 0;
    memset(rt->pass, 0, sizeof rt->pass);
}

static void runtime_destroy(runtime *rt)
{
    runtime_teardown(rt);
    pthread_mutex_destroy(&rt->lock);
    free(rt);
}

/* ---- 异步销毁：teardown 含音频/抓帧线程 join，可能阻塞（如采集链路
 * 无数据时音频线程卡在 read）。若在事件循环里同步执行，单会话注销就会
 * 冻结整个服务器（所有用户 + HTTP）。这里把销毁挪到独立工作线程，
 * 事件循环永不阻塞；停机时用 runtime_wait_destroyed() 等待收尾。 ---- */
static pthread_mutex_t g_destroy_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_destroy_cond = PTHREAD_COND_INITIALIZER;
static int g_destroy_pending = 0;

static void *destroy_worker(void *arg)
{
    runtime *rt = arg;
    runtime_teardown(rt);
    pthread_mutex_destroy(&rt->lock);
    free(rt);
    pthread_mutex_lock(&g_destroy_lock);
    g_destroy_pending--;
    pthread_cond_broadcast(&g_destroy_cond);
    pthread_mutex_unlock(&g_destroy_lock);
    return NULL;
}

void runtime_wait_destroyed(void)
{
    pthread_mutex_lock(&g_destroy_lock);
    while (g_destroy_pending > 0)
        pthread_cond_wait(&g_destroy_cond, &g_destroy_lock);
    pthread_mutex_unlock(&g_destroy_lock);
}

void runtime_unref(runtime *rt)
{
    if (__sync_sub_and_fetch(&rt->refs, 1) == 0)
    {
        pthread_mutex_lock(&g_destroy_lock);
        g_destroy_pending++;
        pthread_mutex_unlock(&g_destroy_lock);
        pthread_t th;
        if (pthread_create(&th, NULL, destroy_worker, rt) == 0)
            pthread_detach(th);
        else
        {
            /* 线程创建失败：回滚计数并同步销毁（阻塞总比泄漏好） */
            pthread_mutex_lock(&g_destroy_lock);
            g_destroy_pending--;
            pthread_mutex_unlock(&g_destroy_lock);
            runtime_destroy(rt);
        }
    }
}

/* ---------------- vdi 会话入口（net.c 调用） ---------------- */
void vdi_on_open(conn *c)
{
    runtime *rt = calloc(1, sizeof *rt);
    rt->refs = 1; /* 由连接持有 */
    atomic_store(&rt->conn, c);
    atomic_init(&rt->state, S_LOGIN);
    atomic_init(&rt->fps, g_cfg.fps > 0 ? g_cfg.fps : 30);
    atomic_init(&rt->static_skip, 1);
    atomic_init(&rt->bitrate_kbps, 0);
    atomic_init(&rt->crf, 23);
    rt->proc.display = -1;
    pthread_mutex_init(&rt->lock, NULL);
    c->vdi = rt;
}

void vdi_on_close(conn *c)
{
    runtime *rt = c->vdi;
    c->vdi = NULL;
    if (!rt)
        return;
    pthread_mutex_lock(&rt->lock);
    if (rt->state == S_RUNNING)
    {
        /* 桌面会话与连接解耦：断开连接只解绑，会话继续在后台运行。
         * 若 conn 已被接管顶掉（rt->conn 指向别的连接），无需处理。 */
        if (atomic_load(&rt->conn) == c)
            atomic_store(&rt->conn, NULL);
    }
    else if (rt->state == S_LOGIN || rt->state == S_AUTHING || rt->state == S_CONFIRM)
    {
        /* 会话尚未建立：连接关闭即销毁 */
        rt->state = S_CLOSED;
    }
    pthread_mutex_unlock(&rt->lock);
    runtime_unref(rt);
}

/* ---------------- 消息构造 ---------------- */
static void push_login_result(conn *c, int ok, const char *txt)
{
    size_t tl = strlen(txt);
    uint8_t *buf = malloc(2 + tl);
    buf[0] = MSG_LOGIN_RESULT;
    buf[1] = ok ? 1 : 0;
    memcpy(buf + 2, txt, tl);
    net_push(c, buf, 2 + tl, 0);
    free(buf);
}

/* ---------------- 登录工作线程 ---------------- */
typedef struct login_job
{
    runtime *rt;
    char user[64];
    char pass[256];
    int width;
    int height;
} login_job;

static void push_session_exists(conn *c, const char *user)
{
    size_t ul = strlen(user);
    uint8_t *buf = malloc(1 + ul);
    buf[0] = MSG_SESSION_EXISTS;
    memcpy(buf + 1, user, ul);
    net_push(c, buf, 1 + ul, 0);
}

/* 把空闲会话（无连接）绑定到新连接上，推送配置并请求关键帧 */
static void takeover_session(runtime *sess, conn *c)
{
    runtime_ref(sess); /* 新连接持有会话引用 */
    atomic_store(&sess->conn, c);
    c->vdi = sess;
    /* 会话已有 SPS/PPS，capture 线程不会再自动发 CONFIG；
     * 置 need_config 让抓帧线程下一帧补发，并强制请求关键帧 */
    atomic_store(&sess->cap.need_config, 1);
    atomic_store(&sess->cap.req_keyframe, 1);
}

static void *login_worker(void *arg)
{
    login_job *j = arg;
    runtime *rt = j->rt;
    conn *c = atomic_load(&rt->conn);
    conn_ref(c);

    if (auth_check(j->user, j->pass) != 0)
    {
        push_login_result(c, 0, "登录失败：用户名或密码错误");
        memset(j->pass, 0, sizeof j->pass);
        pthread_mutex_lock(&rt->lock);
        if (rt->state == S_AUTHING)
            rt->state = S_LOGIN; /* 允许客户端重试 */
        pthread_mutex_unlock(&rt->lock);
        conn_unref(c);
        runtime_unref(rt);
        free(j);
        return NULL;
    }

    /* 会话密钥环解锁需要登录密码（resize 重建会话时还会再用） */
    memcpy(rt->pass, j->pass, sizeof rt->pass);
    memset(j->pass, 0, sizeof j->pass); /* 密码不再需要 */

    runtime *sess = session_lookup(j->user);
    if (sess && session_gone(sess))
    {
        /* 旧会话的桌面已退出（如刚在系统内注销）：不等每秒的 sweep，
         * 立即清理，避免新登录撞上"假活跃"会话 */
        conn *old = atomic_exchange(&sess->conn, NULL);
        pthread_mutex_lock(&sess->lock);
        sess->state = S_CLOSED;
        pthread_mutex_unlock(&sess->lock);
        if (old)
            net_close_conn(old);
        session_unregister(sess);
        sess = NULL;
        log_info("清理已结束的旧会话: %s", j->user);
    }
    if (sess && atomic_load(&sess->conn) != NULL)
    {
        /* 该账户已有活跃会话且正被使用：询问是否注销接管 */
        rt->req_w = j->width;
        rt->req_h = j->height;
        snprintf(rt->user, sizeof rt->user, "%s", j->user);
        pthread_mutex_lock(&rt->lock);
        rt->state = S_CONFIRM;
        pthread_mutex_unlock(&rt->lock);
        push_session_exists(c, j->user);
        log_info("账户 %s 已有活跃会话，等待接管确认", j->user);
        conn_unref(c);
        runtime_unref(rt);
        free(j);
        return NULL;
    }
    if (sess)
    {
        /* 桌面空闲（无连接）：直接接管，不打扰 */
        push_login_result(c, 1, "ok");
        takeover_session(sess, c);
        log_info("接管空闲会话: %s", j->user);
        conn_unref(c);
        runtime_unref(rt);
        free(j);
        return NULL;
    }

    int ok = session_bring_up(rt, j->user, j->width, j->height);
    pthread_mutex_lock(&rt->lock);
    int closed = (rt->state == S_CLOSED);
    if (ok != 0 && !closed)
        rt->state = S_LOGIN; /* 启动失败，允许重试 */
    else if (ok == 0 && !closed)
        rt->state = S_RUNNING;
    pthread_mutex_unlock(&rt->lock);

    if (ok != 0)
    {
        if (!closed)
            push_login_result(c, 0, "无法启动桌面会话");
        conn_unref(c);
        runtime_unref(rt);
        free(j);
        return NULL;
    }
    if (closed)
    {
        /* 启动期间客户端已断开：资源由最后一次 unref 统一清理 */
        conn_unref(c);
        runtime_unref(rt);
        free(j);
        return NULL;
    }

    push_login_result(c, 1, "ok");
    session_register(rt, j->user);
    log_info("登录完成: %s -> %s", j->user, rt->proc.display_str);

    conn_unref(c);
    runtime_unref(rt);
    free(j);
    return NULL;
}

/* ---------------- 消息分发 ---------------- */
/* 在 rt->lock 保护下读取状态（state 是 _Atomic，但登录流程需要与
 * S_AUTHING 的写入互斥，统一走锁避免竞态） */
static int rt_state_is(runtime *rt, enum session_state want)
{
    int yes;
    pthread_mutex_lock(&rt->lock);
    yes = (rt->state == want);
    pthread_mutex_unlock(&rt->lock);
    return yes;
}

static void handle_login_msg(conn *c, runtime *rt, const uint8_t *data, size_t len)
{
    /* 格式: [type][userLen(2)][user][passLen(2)][pass][w(2)][h(2)] */
    if (len < 5)
        return;
    size_t ul = rd_u16(data + 1);
    if (len < 5 + ul + 2) /* passLen 字段越界则丢弃 */
        return;
    size_t pl = rd_u16(data + 3 + ul);
    if (len < 9 + ul + pl)
        return;
    if (ul >= 64 || pl >= 256)
        return;

    if (!rt_state_is(rt, S_LOGIN))
        return;
    pthread_mutex_lock(&rt->lock);
    rt->state = S_AUTHING;
    pthread_mutex_unlock(&rt->lock);

    login_job *j = calloc(1, sizeof *j);
    if (!j)
        return;
    j->rt = rt;
    memcpy(j->user, data + 3, ul);
    j->user[ul] = 0;
    memcpy(j->pass, data + 5 + ul, pl);
    j->pass[pl] = 0;
    size_t o = 5 + ul + pl;
    j->width = rd_u16(data + o);
    j->height = rd_u16(data + o + 2);
    snprintf(rt->user, sizeof rt->user, "%s", j->user);
    runtime_ref(rt);
    pthread_t th;
    pthread_create(&th, NULL, login_worker, j);
    pthread_detach(th);
}

static void handle_resize_msg(runtime *rt, const uint8_t *data, size_t len)
{
    if (len < 5)
        return;
    int w = rd_u16(data + 1);
    int h = rd_u16(data + 3);
    if (rt_state_is(rt, S_RUNNING))
    {
        if (g_cfg.server == SERVER_XORG)
        {
            /* Xorg+dummy 支持运行期改分辨率：capture 线程检测到新尺寸后
             * xrandr 切换 + 重建采集/编码，桌面不重启 */
            atomic_store(&rt->resize_w, w);
            atomic_store(&rt->resize_h, h);
            atomic_store(&rt->desired_w, w);
            atomic_store(&rt->desired_h, h);
            atomic_store(&rt->resize_retries, 0);
        }
        else if (!atomic_exchange(&rt->restarting, 1))
        {
            /* Xvfb 不支持运行期改分辨率：异步整体重建，避免阻塞事件循环 */
            restart_job *job = malloc(sizeof *job);
            pthread_t th;
            if (job)
            {
                runtime_ref(rt); /* 工作线程持有引用，防止连接关闭时被释放 */
                job->rt = rt;
                job->w = w;
                job->h = h;
                if (pthread_create(&th, NULL, restart_worker, job) == 0)
                    pthread_detach(th);
                else
                {
                    free(job);
                    atomic_store(&rt->restarting, 0);
                }
            }
            else
            {
                atomic_store(&rt->restarting, 0);
            }
        }
    }
}

/* Xvfb 模式的分辨率重建工作线程：在事件循环外执行 teardown+bring_up */
static void *restart_worker(void *arg)
{
    restart_job *job = arg;
    runtime_restart(job->rt, job->w, job->h);
    atomic_store(&job->rt->restarting, 0);
    runtime_unref(job->rt);
    free(job);
    return NULL;
}

static void handle_input_msg(runtime *rt, uint8_t t, const uint8_t *data, size_t len)
{
    if (!rt_state_is(rt, S_RUNNING))
        return;
    if (t == MSG_MOUSE)
        input_handle_mouse(rt, data, len);
    else if (t == MSG_KEY)
        input_handle_key(rt, data, len);
    else
        atomic_store(&rt->cap.req_keyframe, 1);
}

/* 确认接管：注销并清理旧会话资源，用当前连接新建会话 */
static void handle_takeover_msg(conn *c, runtime *rt)
{
    if (!rt_state_is(rt, S_CONFIRM))
        return;
    runtime *sess = session_lookup(rt->user);
    if (sess)
    {
        conn *old = atomic_exchange(&sess->conn, NULL);
        pthread_mutex_lock(&sess->lock);
        sess->state = S_CLOSED;
        pthread_mutex_unlock(&sess->lock);
        if (old)
            net_close_conn(old); /* 旧连接前端回到登录页 */
        session_unregister(sess); /* 释放表引用，最终销毁并清理资源 */
    }

    int w = rt->req_w > 0 ? rt->req_w : g_cfg.width;
    int h = rt->req_h > 0 ? rt->req_h : g_cfg.height;
    int ok = session_bring_up(rt, rt->user, w, h);
    pthread_mutex_lock(&rt->lock);
    if (ok != 0)
        rt->state = S_LOGIN; /* 启动失败，允许重试 */
    else
        rt->state = S_RUNNING;
    pthread_mutex_unlock(&rt->lock);
    if (ok != 0)
    {
        push_login_result(c, 0, "无法启动桌面会话");
        return;
    }
    session_register(rt, rt->user);
    push_login_result(c, 1, "ok");
    atomic_store(&rt->cap.req_keyframe, 1);
    log_info("接管并重建会话: %s -> %s", rt->user, rt->proc.display_str);
}

void vdi_on_message(conn *c, const uint8_t *data, size_t len)
{
    runtime *rt = c->vdi;
    if (!rt || len < 1)
        return;
    uint8_t t = data[0];

    switch (t)
    {
    case MSG_LOGIN:
        handle_login_msg(c, rt, data, len);
        break;
    case MSG_RESIZE:
        handle_resize_msg(rt, data, len);
        break;
    case MSG_MOUSE:
    case MSG_KEY:
    case MSG_KEYFRAME:
        handle_input_msg(rt, t, data, len);
        break;
    case MSG_TAKEOVER:
        handle_takeover_msg(c, rt);
        break;
    case MSG_TAKEOVER_CANCEL:
        net_close_conn(c); /* 取消接管：断开连接，前端回到登录页 */
        break;
    case MSG_SET_FPS:
        if (len >= 2 && data[1] >= 1 && data[1] <= 120)
            atomic_store(&rt->fps, data[1]);
        break;
    case MSG_SET_CODEC:
        /* 格式: [type][staticSkip(1)][bitrateKbps(2)][crf(1)]
         * 仅更新原子参数，编码器在抓帧线程里按需 reconfig，避免跨线程调用 */
        if (len >= 5)
        {
            atomic_store(&rt->static_skip, data[1] ? 1 : 0);
            int kbps = data[2] | (data[3] << 8);
            atomic_store(&rt->bitrate_kbps, kbps);
            int crf = data[4];
            if (crf > 51)
                crf = 51;
            atomic_store(&rt->crf, crf);
        }
        break;
    case MSG_SET_ANIMATIONS:
        if (len >= 2 && rt->user[0])
            set_user_gsettings(rt->user, "org.gnome.desktop.interface",
                               "enable-animations", data[1] ? "true" : "false");
        break;
    case MSG_SET_AUDIO:
        if (len >= 2)
        {
            atomic_store(&rt->audio_enabled, data[1] ? 1 : 0);
            if (data[1])
                audio_start(rt);
            else
                audio_stop(rt);
        }
        break;
    case MSG_SET_CLIPBOARD:
        /* 剪贴板共享在当前 Xvfb+GNOME 环境不可用（GNOME 剪贴板管理
         * 会破坏 CLIPBOARD owner 并造成事件死循环），暂时禁用 */
        break;
    case MSG_CLIPBOARD:
        /* 前端剪贴板内容 → 注入 X11 剪贴板 */
        clip_set(rt, data + 1, len - 1);
        break;
    default:
        break;
    }
}

/* 以新分辨率重建会话（Xvfb 不支持运行时改分辨率，只能整体重建） */
static int runtime_restart(runtime *rt, int w, int h)
{
    if (!rt || w <= 0 || h <= 0 || w > 8192 || h > 8192)
        return -1;

    pthread_mutex_lock(&rt->lock);
    if (rt->state != S_RUNNING)
    {
        pthread_mutex_unlock(&rt->lock);
        return -1;
    }
    if (w == rt->video.width && h == rt->video.height)
    {
        pthread_mutex_unlock(&rt->lock);
        return 0;
    }

    log_info("重建会话到 %dx%d (原 %dx%d)", w, h, rt->video.width, rt->video.height);
    runtime_teardown(rt);

    if (session_bring_up(rt, rt->user, w, h) != 0)
    {
        pthread_mutex_unlock(&rt->lock);
        return -1;
    }

    /* CONFIG 由抓帧线程在重建后的首个关键帧发送 */
    atomic_store(&rt->cap.req_keyframe, 1);
    log_info("会话重建完成: %s (%dx%d)", rt->user, rt->video.width, rt->video.height);
    pthread_mutex_unlock(&rt->lock);
    return 0;
}
