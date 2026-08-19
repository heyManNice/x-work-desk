/* session_msg.c —— 会话消息分发与异步工作线程：
 *   登录 / 接管 / Xvfb 分辨率重建均在事件循环外执行，
 *   避免 X 启动、systemd、gsettings 等慢操作阻塞所有用户连接。 */
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
#include "input.h"
#include "util.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>

static int runtime_restart(runtime *rt, int w, int h);

/* Xvfb 模式的异步分辨率重建任务（避免阻塞事件循环） */
typedef struct
{
    runtime *rt;
    int w, h;
} restart_job;
static void *restart_worker(void *arg);

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

static void push_session_exists(conn *c, const char *user)
{
    size_t ul = strlen(user);
    uint8_t *buf = malloc(1 + ul);
    buf[0] = MSG_SESSION_EXISTS;
    memcpy(buf + 1, user, ul);
    net_push(c, buf, 1 + ul, 0);
}

/* 下发文件传输 token：浏览器 HTTP 鉴权用（与扩展环境变量 XWORKD_TOKEN 同源） */
static void push_transfer_token(conn *c, const char *token)
{
    if (!c || !token || !token[0])
        return;
    size_t tl = strlen(token);
    uint8_t *buf = malloc(1 + tl);
    buf[0] = MSG_TRANSFER_TOKEN;
    memcpy(buf + 1, token, tl);
    net_push(c, buf, 1 + tl, 0);
    free(buf);
}

/* 向连接推送扩展触发的传输请求（下载/上传目录） */
void session_push_transfer(conn *c, int action, const char *text)
{
    if (!c || atomic_load(&c->closing) || !text)
        return;
    size_t tl = strlen(text);
    uint8_t *buf = malloc(2 + tl);
    buf[0] = MSG_TRANSFER_REQUEST;
    buf[1] = (uint8_t)action;
    memcpy(buf + 2, text, tl);
    net_push(c, buf, 2 + tl, 0);
    free(buf);
}

/* 推送传输错误通知（前端右下角提醒，如路径权限不足） */
void session_push_transfer_error(conn *c, const char *text)
{
    if (!c || atomic_load(&c->closing) || !text)
        return;
    size_t tl = strlen(text);
    uint8_t *buf = malloc(1 + tl);
    buf[0] = MSG_TRANSFER_ERROR;
    memcpy(buf + 1, text, tl);
    net_push(c, buf, 1 + tl, 0);
    free(buf);
}

/* 把空闲会话（无连接）绑定到新连接上，推送配置并请求关键帧 */
static void takeover_session(runtime *sess, conn *c)
{
    runtime_ref(sess); /* 新连接持有会话引用 */
    atomic_store(&sess->conn, c);
    c->sess = sess;
    /* 会话已有 SPS/PPS，capture 线程不会再自动发 CONFIG；
     * 置 need_config 让抓帧线程下一帧补发，并强制请求关键帧 */
    atomic_store(&sess->cap.need_config, 1);
    atomic_store(&sess->cap.req_keyframe, 1);
}

/* ---------------- 登录工作线程 ---------------- */
typedef struct login_job
{
    runtime *rt;
    conn *c; /* 发起登录的连接（事件循环线程已持有引用） */
    char user[64];
    char pass[256];
    int width;
    int height;
} login_job;

static void *login_worker(void *arg)
{
    login_job *j = arg;
    runtime *rt = j->rt;
    conn *c = j->c; /* 引用由 handle_login_msg 持有，worker 负责释放 */

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
        runtime_unref(sess); /* 释放 lookup 引用 */
        sess = NULL;
        log_info("清理已结束的旧会话: %s", j->user);
    }
    if (sess && atomic_load(&sess->conn) != NULL)
    {
        /* 旧连接可能刚断开但事件循环（poll 周期）尚未清理——属刷新重连的
         * 时序竞态。唤醒事件循环并短暂等待，若 conn 已清空则直接接管空闲
         * 会话（复用原桌面，不注销重建）；仍非空才视为确有活跃连接。 */
        net_wake();
        int waited = 0;
        while (atomic_load(&sess->conn) != NULL && waited < 500000)
        {
            usleep(10000);
            waited += 10000;
            if (waited % 100000 == 0)
                net_wake(); /* 周期性唤醒，确保事件循环观察到连接 EOF */
        }
        if (atomic_load(&sess->conn) == NULL)
        {
            /* 旧连接已关闭：无缝接管原会话（复用桌面，不重建） */
            push_login_result(c, 1, "ok");
            push_transfer_token(c, sess->token);
            takeover_session(sess, c);
            log_info("接管空闲会话(刷新重连): %s", j->user);
            runtime_unref(sess); /* 释放 lookup 引用 */
            conn_unref(c);
            runtime_unref(rt);
            free(j);
            return NULL;
        }
        /* 该账户确有活跃连接：询问是否注销接管 */
        rt->req_w = j->width;
        rt->req_h = j->height;
        snprintf(rt->user, sizeof rt->user, "%s", j->user);
        pthread_mutex_lock(&rt->lock);
        rt->state = S_CONFIRM;
        pthread_mutex_unlock(&rt->lock);
        push_session_exists(c, j->user);
        log_info("账户 %s 已有活跃会话，等待接管确认", j->user);
        runtime_unref(sess); /* 释放 lookup 引用 */
        conn_unref(c);
        runtime_unref(rt);
        free(j);
        return NULL;
    }
    if (sess)
    {
        /* 桌面空闲（无连接）：直接接管，不打扰 */
        push_login_result(c, 1, "ok");
        push_transfer_token(c, sess->token);
        takeover_session(sess, c);
        log_info("接管空闲会话: %s", j->user);
        runtime_unref(sess); /* takeover_session 已为新连接持有引用 */
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
    push_transfer_token(c, rt->token);
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

    /* 事件循环线程持有连接引用：worker 可能在连接已关闭后仍要 push
     * 结果（net_push 会因 closing 丢弃），引用保证 c 不会被提前释放 */
    conn_ref(c);
    login_job *j = calloc(1, sizeof *j);
    if (!j)
    {
        conn_unref(c);
        pthread_mutex_lock(&rt->lock);
        if (rt->state == S_AUTHING)
            rt->state = S_LOGIN;
        pthread_mutex_unlock(&rt->lock);
        return;
    }
    j->rt = rt;
    j->c = c;
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
    if (pthread_create(&th, NULL, login_worker, j) != 0)
    {
        conn_unref(c);
        runtime_unref(rt);
        free(j);
        pthread_mutex_lock(&rt->lock);
        if (rt->state == S_AUTHING)
            rt->state = S_LOGIN;
        pthread_mutex_unlock(&rt->lock);
        return;
    }
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
            /* 启动早期（GNOME 未稳定）的请求会被 mutter 覆盖，标记等稳定后补一次 */
            int64_t start = atomic_load(&rt->cap_start_ms);
            if (start == 0 || monotonic_ms() - start < 12000)
                atomic_store(&rt->settle_pending, 1);
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

static void handle_takeover_msg(conn *c, runtime *rt)
{
    if (!rt_state_is(rt, S_CONFIRM))
        return;

    runtime *sess = session_lookup(rt->user);
    if (!sess)
    {
        /* 旧会话已消失（极罕见）：恢复登录态，让前端重新登录 */
        pthread_mutex_lock(&rt->lock);
        if (rt->state == S_CONFIRM)
            rt->state = S_LOGIN;
        pthread_mutex_unlock(&rt->lock);
        return;
    }

    /* 继承接管：断开前一人连接，新连接复用原会话（桌面不重建）。
     * 断开连接只解绑不注销——只有 GNOME 桌面内注销才会销毁会话。 */
    conn *old = atomic_exchange(&sess->conn, NULL);
    if (old)
        net_close_conn(old); /* 前一人前端回到登录页 */

    push_login_result(c, 1, "ok");
    push_transfer_token(c, sess->token);
    takeover_session(sess, c);
    log_info("接管并继承会话(第二人登录): %s -> %s", rt->user,
             sess->proc.display_str);

    /* 释放临时登录 runtime（连接已改挂到 sess）与 lookup 引用 */
    pthread_mutex_lock(&rt->lock);
    rt->state = S_CLOSED;
    pthread_mutex_unlock(&rt->lock);
    runtime_unref(rt);   /* 释放连接持有的 rt 引用（c->sess 已改挂） */
    runtime_unref(sess); /* 释放 lookup 引用 */
}

void session_on_message(conn *c, const uint8_t *data, size_t len)
{
    runtime *rt = c->sess;
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
        if (!rt_state_is(rt, S_RUNNING))
            break;
        if (len >= 2 && data[1] >= 1 && data[1] <= 120)
            atomic_store(&rt->fps, data[1]);
        break;
    case MSG_SET_CODEC:
        if (!rt_state_is(rt, S_RUNNING))
            break;
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
        /* 未认证连接也能伪造登录尝试里的用户名，这里必须校验已登录，
         * 否则未鉴权即可给任意账户改 gsettings */
        if (!rt_state_is(rt, S_RUNNING))
            break;
        /* gsettings 是 fork+wait 的慢操作：只置标志，由 capture 线程
         * 在循环里异步执行，避免阻塞事件循环（冻结所有用户连接） */
        if (len >= 2)
            atomic_store(&rt->anim_pending, data[1] ? 1 : -1);
        break;
    case MSG_SET_AUDIO:
        if (!rt_state_is(rt, S_RUNNING))
            break;
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
        if (!rt_state_is(rt, S_RUNNING))
            break;
        /* 剪贴板共享：Xorg+dummy 虚拟显示下 GNOME 剪贴板管理器未接管，
         * 自实现的常驻 CLIPBOARD owner 实测不会被夺走，双向同步可行
         * （早期 Xvfb 环境曾因 owner 被破坏/事件死循环而禁用）。 */
        if (len >= 2)
            atomic_store(&rt->clip_enabled, data[1] ? 1 : 0);
        break;
    case MSG_CLIPBOARD:
        if (!rt_state_is(rt, S_RUNNING))
            break;
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
