/* session.c —— 会话生命周期：
 *   runtime 引用计数、teardown / 异步销毁、连接↔会话绑定入口。
 *   消息分发与登录/接管/重建工作线程见 session_msg.c。 */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#include "session.h"
#include "sessproc.h"
#include "audio.h"
#include "encoder.h"
#include "config.h"
#include "util.h"

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <sys/wait.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <X11/Xutil.h>
#include <stdio.h>

void runtime_ref(runtime *rt) { __sync_add_and_fetch(&rt->refs, 1); }

/* 停抓帧线程并释放 X/编码/进程资源；幂等，可在会话未完全启动时调用 */
void runtime_teardown(runtime *rt)
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
    int x_alive = pid_alive(rt->proc.xvfb_pid);

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

/* ---------------- 会话入口（net.c 调用） ---------------- */
void session_on_open(conn *c)
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
    c->sess = rt;
}

void session_on_close(conn *c)
{
    runtime *rt = c->sess;
    c->sess = NULL;
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
