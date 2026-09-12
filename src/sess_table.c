/* sess_table.c —— 会话表：按用户名管理桌面会话。
 * 会话与 WebSocket 连接解耦（断开连接桌面保留），
 * 会话只在用户系统注销（gnome-session 退出）或 Xvfb 崩溃时结束。 */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#include "session.h"
#include "sess_table.h"
#include "util.h"

#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <stdio.h>

#define MAX_SESSIONS 64
typedef struct
{
    char user[64];
    runtime *rt;
} session_entry;
static session_entry g_sessions[MAX_SESSIONS];
static pthread_mutex_t g_sess_lock = PTHREAD_MUTEX_INITIALIZER;

runtime *session_lookup(const char *user)
{
    runtime *rt = NULL;
    pthread_mutex_lock(&g_sess_lock);
    for (int i = 0; i < MAX_SESSIONS; i++)
        if (g_sessions[i].rt && !strcmp(g_sessions[i].user, user))
        {
            rt = g_sessions[i].rt;
            runtime_ref(rt); /* 调用方负责 unref：防 lookup 与使用之间被 sweep 释放 */
            break;
        }
    pthread_mutex_unlock(&g_sess_lock);
    return rt;
}

void session_register(runtime *rt, const char *user)
{
    pthread_mutex_lock(&g_sess_lock);
    for (int i = 0; i < MAX_SESSIONS; i++)
    {
        if (!g_sessions[i].rt)
        {
            snprintf(g_sessions[i].user, sizeof g_sessions[i].user, "%s", user);
            g_sessions[i].rt = rt;
            runtime_ref(rt); /* 会话表持有 1 份引用 */
            pthread_mutex_unlock(&g_sess_lock);
            return;
        }
    }
    pthread_mutex_unlock(&g_sess_lock);
    log_err("会话表已满，无法注册 %s", user);
}

void session_unregister(runtime *rt)
{
    pthread_mutex_lock(&g_sess_lock);
    for (int i = 0; i < MAX_SESSIONS; i++)
    {
        if (g_sessions[i].rt == rt)
        {
            g_sessions[i].rt = NULL;
            g_sessions[i].user[0] = 0;
            pthread_mutex_unlock(&g_sess_lock);
            runtime_unref(rt); /* 释放会话表引用 */
            return;
        }
    }
    pthread_mutex_unlock(&g_sess_lock);
}

/* 判断会话是否已结束：gnome-session（wrapper）或 Xvfb 已退出 */
int session_gone(runtime *rt)
{
    /* Xvfb 整体重建中会先杀旧 X 进程再起新的：此窗口内不得判定会话已
     * 结束，否则 session_sweep 会把刚重建好的会话误杀（teardown 杀 Xvfb
     * 与 bring_up 起新 X 之间 xvfb_pid 短暂指向已死进程） */
    if (atomic_load(&rt->restarting))
        return 0;
    if (rt->proc.xvfb_pid > 0 && !pid_alive(rt->proc.xvfb_pid))
        return 1;
    for (int i = 0; i < rt->proc.nchildren; i++)
        if (rt->proc.children[i] > 0 && !pid_alive(rt->proc.children[i]))
            return 1;
    return 0;
}

/* 事件循环周期调用：清理已结束的会话（系统注销/Xvfb 崩溃），
 * 关闭其绑定的连接，让前端回到登录页 */
void session_sweep(void)
{
    runtime *to_close[MAX_SESSIONS];
    int n = 0;
    pthread_mutex_lock(&g_sess_lock);
    for (int i = 0; i < MAX_SESSIONS; i++)
    {
        if (g_sessions[i].rt && session_gone(g_sessions[i].rt))
        {
            to_close[n++] = g_sessions[i].rt;
            g_sessions[i].rt = NULL;
            g_sessions[i].user[0] = 0;
        }
    }
    pthread_mutex_unlock(&g_sess_lock);

    for (int i = 0; i < n; i++)
    {
        runtime *rt = to_close[i];
        pthread_mutex_lock(&rt->lock);
        if (rt->state != S_CLOSED)
            rt->state = S_CLOSED;
        pthread_mutex_unlock(&rt->lock);
        conn *c = atomic_exchange(&rt->conn, NULL);
        if (c)
            net_close_conn(c); /* 触发 session_on_close → unref */
        runtime_unref(rt);     /* 释放会话表引用，最终销毁 */
    }
}

/* 服务退出前（SIGTERM/SIGINT）清理所有会话：关闭连接、释放 Xvfb/进程，
 * 避免 pkill 后旧会话成为孤儿继续占用总线与 display */
void session_shutdown_all(void)
{
    runtime *all[MAX_SESSIONS];
    int n = 0;
    pthread_mutex_lock(&g_sess_lock);
    for (int i = 0; i < MAX_SESSIONS; i++)
        if (g_sessions[i].rt)
            all[n++] = g_sessions[i].rt;
    pthread_mutex_unlock(&g_sess_lock);

    for (int i = 0; i < n; i++)
    {
        runtime *rt = all[i];
        conn *c = atomic_exchange(&rt->conn, NULL);
        if (c)
            net_close_conn(c);
        session_unregister(rt);
        /* 若 refs 尚未归零（如登录线程在跑），teardown 由最后一次 unref 触发 */
    }
}
