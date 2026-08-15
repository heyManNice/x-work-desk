#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#include "session.h"
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
#include <pwd.h>
#include <grp.h>
#include <stdio.h>
#include <errno.h>

/* ---------------- vdi 会话 ---------------- */
typedef struct vdi_session
{
    int refs;
    pthread_mutex_t lock;
    volatile int state; /* S_LOGIN / S_AUTHING / S_RUNNING / S_CLOSED */
    conn *c;
    char user[64];
    runtime *rt;
} vdi_session;

enum
{
    S_LOGIN = 0,
    S_AUTHING = 1,
    S_RUNNING = 3,
    S_CLOSED = 4
};

typedef struct login_job
{
    vdi_session *s;
    char user[64];
    char pass[256];
    int width;
    int height;
} login_job;

static pthread_mutex_t g_xenv_lock = PTHREAD_MUTEX_INITIALIZER;

static void vdi_session_ref(vdi_session *s) { __sync_add_and_fetch(&s->refs, 1); }
static void vdi_session_unref(vdi_session *s)
{
    if (__sync_sub_and_fetch(&s->refs, 1) == 0)
    {
        pthread_mutex_destroy(&s->lock);
        free(s);
    }
}

void vdi_on_open(conn *c)
{
    vdi_session *s = calloc(1, sizeof *s);
    s->refs = 1;
    s->c = c;
    s->state = S_LOGIN;
    pthread_mutex_init(&s->lock, NULL);
    c->vdi = s;
}

void vdi_on_close(conn *c)
{
    vdi_session *s = c->vdi;
    c->vdi = NULL;
    if (!s)
        return;
    pthread_mutex_lock(&s->lock);
    s->state = S_CLOSED;
    runtime *rt = s->rt;
    s->rt = NULL;
    pthread_mutex_unlock(&s->lock);
    if (rt)
        runtime_stop(rt);
    vdi_session_unref(s);
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

static void push_config(conn *c, runtime *rt)
{
    size_t len = 9 + rt->sps_len + rt->pps_len;
    uint8_t *buf = malloc(len);
    uint8_t *p = buf;
    *p++ = MSG_CONFIG;
    *p++ = (uint8_t)(rt->width & 0xff);
    *p++ = (uint8_t)((rt->width >> 8) & 0xff);
    *p++ = (uint8_t)(rt->height & 0xff);
    *p++ = (uint8_t)((rt->height >> 8) & 0xff);
    *p++ = (uint8_t)(rt->sps_len & 0xff);
    *p++ = (uint8_t)((rt->sps_len >> 8) & 0xff);
    memcpy(p, rt->sps, rt->sps_len);
    p += rt->sps_len;
    *p++ = (uint8_t)(rt->pps_len & 0xff);
    *p++ = (uint8_t)((rt->pps_len >> 8) & 0xff);
    memcpy(p, rt->pps, rt->pps_len);
    net_push(c, buf, len, 0);
    free(buf);
}

/* ---------------- 登录工作线程 ---------------- */
static void *login_worker(void *arg)
{
    login_job *j = arg;
    vdi_session *s = j->s;
    conn *c = s->c;
    conn_ref(c);

    if (auth_check(j->user, j->pass) != 0)
    {
        push_login_result(c, 0, "登录失败：用户名或密码错误");
        conn_unref(c);
        vdi_session_unref(s);
        free(j);
        return NULL;
    }

    runtime *rt = runtime_start(c, j->user, j->width, j->height);
    if (!rt)
    {
        push_login_result(c, 0, "无法启动桌面会话");
        conn_unref(c);
        vdi_session_unref(s);
        free(j);
        return NULL;
    }

    pthread_mutex_lock(&s->lock);
    int closed = (s->state == S_CLOSED);
    if (!closed)
    {
        s->rt = rt;
        s->state = S_RUNNING;
        rt = NULL;
    }
    pthread_mutex_unlock(&s->lock);

    if (rt)
    {
        runtime_stop(rt); /* 会话在启动期间被关闭 */
    }
    else
    {
        push_login_result(c, 1, "ok");
        push_config(c, s->rt);
        log_info("登录完成: %s -> %s", j->user, s->rt->display_str);
    }

    conn_unref(c);
    vdi_session_unref(s);
    free(j);
    return NULL;
}

/* ---------------- 消息分发 ---------------- */
static int runtime_restart(runtime *rt, int w, int h);

void vdi_on_message(conn *c, const uint8_t *data, size_t len)
{
    vdi_session *s = c->vdi;
    if (!s || len < 1)
        return;
    uint8_t t = data[0];

    if (t == MSG_LOGIN)
    {
        if (len < 5)
            return;
        size_t ul = data[1] | ((size_t)data[2] << 8);
        /* 格式: [type][userLen(2)][user][passLen(2)][pass][w(2)][h(2)] */
        size_t pl = data[3 + ul] | ((size_t)data[4 + ul] << 8);
        if (len < 9 + ul + pl)
            return;
        if (ul > 63)
            ul = 63;
        if (pl > 255)
            pl = 255;
        pthread_mutex_lock(&s->lock);
        if (s->state != S_LOGIN)
        {
            pthread_mutex_unlock(&s->lock);
            return;
        }
        s->state = S_AUTHING;
        pthread_mutex_unlock(&s->lock);

        login_job *j = calloc(1, sizeof *j);
        j->s = s;
        memcpy(j->user, data + 3, ul);
        j->user[ul] = 0;
        memcpy(j->pass, data + 5 + ul, pl);
        j->pass[pl] = 0;
        size_t o = 5 + ul + pl;
        j->width = data[o] | (data[o + 1] << 8);
        j->height = data[o + 2] | (data[o + 3] << 8);
        snprintf(s->user, sizeof s->user, "%s", j->user);
        vdi_session_ref(s);
        pthread_t th;
        pthread_create(&th, NULL, login_worker, j);
        pthread_detach(th);
        return;
    }

    if (t == MSG_RESIZE)
    {
        if (len < 5)
            return;
        int w = data[1] | (data[2] << 8);
        int h = data[3] | (data[4] << 8);
        runtime *rt = NULL;
        pthread_mutex_lock(&s->lock);
        if (s->state == S_RUNNING)
            rt = s->rt;
        pthread_mutex_unlock(&s->lock);
        if (rt)
            runtime_restart(rt, w, h);
        return;
    }

    if (t == MSG_MOUSE || t == MSG_KEY || t == MSG_KEYFRAME)
    {
        runtime *rt = NULL;
        pthread_mutex_lock(&s->lock);
        if (s->state == S_RUNNING)
            rt = s->rt;
        pthread_mutex_unlock(&s->lock);
        if (!rt)
            return;
        if (t == MSG_MOUSE)
            input_handle_mouse(rt, data, len);
        else if (t == MSG_KEY)
            input_handle_key(rt, data, len);
        else
            rt->req_keyframe = 1;
    }
}

/* ---------------- 运行时：Xvfb + 会话 ---------------- */
static int find_free_display(void)
{
    for (int d = 10; d < 200; d++)
    {
        char p[64];
        snprintf(p, sizeof p, "/tmp/.X11-unix/X%d", d);
        struct stat st;
        if (stat(p, &st) != 0)
            return d;
    }
    return -1;
}

static int gen_cookie_hex(char *out, size_t outsz)
{
    uint8_t bytes[16];
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f)
        return -1;
    if (fread(bytes, 1, 16, f) != 16)
    {
        fclose(f);
        return -1;
    }
    fclose(f);
    hex_encode(bytes, 16, out, outsz);
    return 0;
}

static int run_cmd_wait(char *const argv[])
{
    pid_t pid = fork();
    if (pid < 0)
        return -1;
    if (pid == 0)
    {
        execvp(argv[0], argv);
        _exit(127);
    }
    int st;
    waitpid(pid, &st, 0);
    return WIFEXITED(st) ? WEXITSTATUS(st) : -1;
}

/* 清理非 root 模式的会话运行时目录。root 用系统 /run/user 目录，不删除 */
static void cleanup_rt_dir(runtime *rt)
{
    if (!rt || getuid() == 0)
        return;
    char rt_dir[160];
    snprintf(rt_dir, sizeof rt_dir, "/tmp/xdg-runtime-%u-%d", getuid(), rt->display);
    char *rm[] = {"rm", "-rf", rt_dir, NULL};
    run_cmd_wait(rm);
}

static pid_t run_cmd_bg(char *const argv[])
{
    pid_t pid = fork();
    if (pid < 0)
        return -1;
    if (pid == 0)
    {
        setsid();
        execvp(argv[0], argv);
        _exit(127);
    }
    return pid;
}

static void spawn_session_app(runtime *rt, const char *user)
{
    struct passwd *pw = getpwnam(user);
    int is_root = getuid() == 0;

    /* 会话实际运行身份：root 可 setuid 到目标用户；否则以当前进程用户运行 */
    const char *run_home = pw ? pw->pw_dir : "/";
    const char *run_name = user;
    const char *run_shell = pw ? pw->pw_shell : "/bin/sh";
    if (!(pw && is_root))
    {
        struct passwd *me = getpwuid(getuid());
        if (me)
        {
            run_home = me->pw_dir;
            run_name = me->pw_name;
            run_shell = me->pw_shell;
        }
    }

    /* 准备 XDG_RUNTIME_DIR（fork 前创建；root 时 chown 给目标用户）
     * 非 root 时每个会话用独立目录（含 display），避免并发会话共享
     * XDG_RUNTIME_DIR 导致 GNOME Shell 状态冲突（桌面无法加载） */
    char rt_dir[160];
    if (pw && is_root)
        snprintf(rt_dir, sizeof rt_dir, "/run/user/%u", pw->pw_uid);
    else
        snprintf(rt_dir, sizeof rt_dir, "/tmp/xdg-runtime-%u-%d", getuid(), rt->display);
    if (mkdir(rt_dir, 0700) != 0 && errno != EEXIST)
        log_info("mkdir %s: %s", rt_dir, strerror(errno));
    if (is_root && pw)
    {
        if (chown(rt_dir, pw->pw_uid, pw->pw_gid) != 0)
        { /* 忽略 */
        }
    }
    chmod(rt_dir, 0700);

    pid_t pid = fork();
    if (pid < 0)
        return;
    if (pid == 0)
    {
        setsid(); /* 独立进程组，便于整体清理 */
        if (pw && is_root)
        {
            if (initgroups(pw->pw_name, pw->pw_gid) != 0)
            { /* 忽略 */
            }
            if (setgid(pw->pw_gid) != 0)
            { /* 忽略 */
            }
            if (setuid(pw->pw_uid) != 0)
            { /* 忽略 */
            }
        }
        setenv("DISPLAY", rt->display_str, 1);
        setenv("XAUTHORITY", rt->authfile, 1);
        setenv("HOME", run_home, 1);
        setenv("USER", run_name, 1);
        setenv("LOGNAME", run_name, 1);
        setenv("SHELL", run_shell, 1);
        setenv("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", 1);
        setenv("XDG_RUNTIME_DIR", rt_dir, 1);
        setenv("XDG_CURRENT_DESKTOP", "ubuntu:GNOME", 1);
        setenv("XDG_SESSION_TYPE", "x11", 1);
        setenv("XDG_SESSION_CLASS", "user", 1);
        if (g_cfg.session_cmd[0])
        {
            execl("/bin/sh", "sh", "-c", g_cfg.session_cmd, (char *)NULL);
        }
        else if (access("/usr/bin/gnome-session", X_OK) == 0)
        {
            /* 完整 GNOME/Ubuntu 会话：gnome-session 会启动 gnome-shell 与
             * gnome-settings-daemon，从而正确继承用户的主题/扩展/输入法等配置。
             * mutter 48+ 默认以 Wayland 原生后端启动，在 Xvfb 上需走 X11 会话 */
            if (access("/usr/share/gnome-session/sessions/ubuntu.session", R_OK) == 0)
            {
                setenv("GNOME_SHELL_SESSION_MODE", "ubuntu", 1);
                execl("/usr/bin/dbus-run-session", "dbus-run-session", "--",
                      "/usr/bin/gnome-session", "--session=ubuntu", (char *)NULL);
            }
            execl("/usr/bin/dbus-run-session", "dbus-run-session", "--",
                  "/usr/bin/gnome-session", (char *)NULL);
        }
        else if (access("/usr/bin/gnome-shell", X_OK) == 0)
        {
            /* 退路：无 gnome-session 时裸启动 GNOME Shell（X11 模式） */
            execl("/usr/bin/dbus-run-session", "dbus-run-session", "--",
                  "/usr/bin/gnome-shell", "--x11", (char *)NULL);
        }
        else if (access("/usr/bin/openbox", X_OK) == 0)
        {
            execl("/usr/bin/openbox", "openbox", (char *)NULL);
        }
        else if (access("/usr/bin/xterm", X_OK) == 0)
        {
            execl("/usr/bin/xterm", "xterm", (char *)NULL);
        }
        else
        {
            execl("/bin/sh", "sh", "-c", "sleep infinity", (char *)NULL);
        }
        _exit(127);
    }
    rt->children = realloc(rt->children, (rt->nchildren + 1) * sizeof(pid_t));
    rt->children[rt->nchildren++] = pid;
}

/* 启动 Xvfb + 会话 + 抓帧/编码管线（rt->width/height、display_str、authfile 需已设置） */
static int session_bring_up(runtime *rt, const char *user)
{
    char cookie[64];
    if (gen_cookie_hex(cookie, sizeof cookie) != 0)
        return -1;

    char *xa[] = {"xauth", "-f", rt->authfile, "add", rt->display_str, ".", cookie, NULL};
    if (run_cmd_wait(xa) != 0)
    {
        log_err("xauth 失败");
        return -1;
    }

    char geom[32];
    snprintf(geom, sizeof geom, "%dx%dx24", rt->width, rt->height);
    char *xv[] = {"Xvfb", rt->display_str, "-screen", "0", geom,
                  "-nolisten", "tcp", "-auth", rt->authfile, NULL};
    rt->xvfb_pid = run_cmd_bg(xv);
    if (rt->xvfb_pid < 0)
        return -1;

    int up = 0;
    for (int i = 0; i < 100; i++)
    {
        char sock[64];
        snprintf(sock, sizeof sock, "/tmp/.X11-unix/X%d", rt->display);
        struct stat st;
        if (stat(sock, &st) == 0)
        {
            up = 1;
            break;
        }
        int ws;
        if (waitpid(rt->xvfb_pid, &ws, WNOHANG) == rt->xvfb_pid)
            break; /* 已退出 */
        usleep(100000);
    }
    if (!up)
    {
        log_err("Xvfb 未启动 %s", rt->display_str);
        return -1;
    }

    /* 在正确的 env 下打开 Display */
    pthread_mutex_lock(&g_xenv_lock);
    char *od = getenv("DISPLAY"), *oa = getenv("XAUTHORITY");
    setenv("DISPLAY", rt->display_str, 1);
    setenv("XAUTHORITY", rt->authfile, 1);
    rt->dpy = XOpenDisplay(rt->display_str);
    if (od)
        setenv("DISPLAY", od, 1);
    else
        unsetenv("DISPLAY");
    if (oa)
        setenv("XAUTHORITY", oa, 1);
    else
        unsetenv("XAUTHORITY");
    pthread_mutex_unlock(&g_xenv_lock);
    if (!rt->dpy)
    {
        log_err("XOpenDisplay(%s) 失败", rt->display_str);
        return -1;
    }
    rt->root = DefaultRootWindow(rt->dpy);

    if (init_shm(rt) != 0)
        return -1;
    if (init_encoder(rt) != 0)
        return -1;
    spawn_session_app(rt, user);

    rt->running = 1;
    if (pthread_create(&rt->cap_thread, NULL, capture_thread, rt) != 0)
    {
        log_err("创建抓帧线程失败");
        return -1;
    }
    return 0;
}

runtime *runtime_start(conn *c, const char *user, int w, int h)
{
    runtime *rt = calloc(1, sizeof *rt);
    rt->conn = c;
    conn_ref(c);
    rt->width = (w > 0 && w <= 8192) ? w : g_cfg.width;
    rt->height = (h > 0 && h <= 8192) ? h : g_cfg.height;
    snprintf(rt->user, sizeof rt->user, "%s", user);
    pthread_mutex_init(&rt->xlock, NULL);

    rt->display = find_free_display();
    if (rt->display < 0)
    {
        log_err("没有可用 display");
        runtime_stop(rt);
        return NULL;
    }
    snprintf(rt->display_str, sizeof rt->display_str, ":%d", rt->display);
    snprintf(rt->authfile, sizeof rt->authfile, "/tmp/xworkd_auth_%d", rt->display);

    if (session_bring_up(rt, user) != 0)
    {
        runtime_stop(rt);
        return NULL;
    }
    log_info("会话启动: %s @ %s (%dx%d)", user, rt->display_str, rt->width, rt->height);
    return rt;
}

void runtime_stop(runtime *rt)
{
    if (!rt)
        return;
    if (rt->running)
    {
        rt->running = 0;
        pthread_join(rt->cap_thread, NULL);
    }

    /* 先在 Xvfb 仍存活时优雅清理 X 资源 */
    if (rt->img)
    {
        XShmDetach(rt->dpy, &rt->shminfo);
        XDestroyImage(rt->img);
        shmctl(rt->shminfo.shmid, IPC_RMID, NULL);
        rt->img = NULL;
    }
    if (rt->dpy)
    {
        XCloseDisplay(rt->dpy);
        rt->dpy = NULL;
    }
    if (rt->enc)
    {
        x264_encoder_close(rt->enc);
        rt->enc = NULL;
    }
    free(rt->yuv);
    rt->yuv = NULL;
    free(rt->sps);
    free(rt->pps);

    /* 再杀掉 Xvfb 与会话进程（按进程组整体清理） */
    if (rt->xvfb_pid > 0)
    {
        kill(-rt->xvfb_pid, SIGTERM);
        kill(rt->xvfb_pid, SIGTERM);
    }
    for (int i = 0; i < rt->nchildren; i++)
        if (rt->children[i] > 0)
        {
            kill(-rt->children[i], SIGTERM);
            kill(rt->children[i], SIGTERM);
        }

    for (int i = 0; i < 20; i++)
    {
        int any = 0;
        int st;
        if (rt->xvfb_pid > 0)
        {
            if (waitpid(rt->xvfb_pid, &st, WNOHANG) == rt->xvfb_pid)
                rt->xvfb_pid = -1;
            else
                any = 1;
        }
        for (int i2 = 0; i2 < rt->nchildren; i2++)
        {
            if (rt->children[i2] > 0)
            {
                if (waitpid(rt->children[i2], &st, WNOHANG) == rt->children[i2])
                    rt->children[i2] = -1;
                else
                    any = 1;
            }
        }
        if (!any)
            break;
        usleep(100000);
    }
    free(rt->children);
    unlink(rt->authfile);
    cleanup_rt_dir(rt);
    log_info("会话结束: %s", rt->user);
    conn_unref(rt->conn);
    free(rt);
}

/* 以新分辨率重建会话（Xvfb 不支持运行时改分辨率，只能整体重建） */
static int runtime_restart(runtime *rt, int w, int h)
{
    if (!rt || w <= 0 || h <= 0 || w > 8192 || h > 8192)
        return -1;
    if (w == rt->width && h == rt->height)
        return 0;

    log_info("重建会话到 %dx%d (原 %dx%d)", w, h, rt->width, rt->height);

    /* 停抓帧线程 */
    if (rt->running)
    {
        rt->running = 0;
        pthread_join(rt->cap_thread, NULL);
    }
    /* 先在 Xvfb 仍存活时优雅清理 X 资源。若先杀 Xvfb 再调用 X 函数，
     * 会在已断开的连接上触发 X I/O 错误，导致整个进程退出 */
    if (rt->img)
    {
        XShmDetach(rt->dpy, &rt->shminfo);
        XDestroyImage(rt->img);
        shmctl(rt->shminfo.shmid, IPC_RMID, NULL);
        rt->img = NULL;
    }
    if (rt->dpy)
    {
        XCloseDisplay(rt->dpy);
        rt->dpy = NULL;
    }
    /* 再杀 Xvfb 与会话进程（进程组） */
    if (rt->xvfb_pid > 0)
    {
        kill(-rt->xvfb_pid, SIGTERM);
        kill(rt->xvfb_pid, SIGTERM);
    }
    for (int i = 0; i < rt->nchildren; i++)
        if (rt->children[i] > 0)
        {
            kill(-rt->children[i], SIGTERM);
            kill(rt->children[i], SIGTERM);
        }
    for (int i = 0; i < 20; i++)
    {
        int any = 0, st;
        if (rt->xvfb_pid > 0)
        {
            if (waitpid(rt->xvfb_pid, &st, WNOHANG) == rt->xvfb_pid)
                rt->xvfb_pid = -1;
            else
                any = 1;
        }
        for (int i2 = 0; i2 < rt->nchildren; i2++)
        {
            if (rt->children[i2] > 0)
            {
                if (waitpid(rt->children[i2], &st, WNOHANG) == rt->children[i2])
                    rt->children[i2] = -1;
                else
                    any = 1;
            }
        }
        if (!any)
            break;
        usleep(100000);
    }
    free(rt->children);
    rt->children = NULL;
    rt->nchildren = 0;

    if (rt->enc)
    {
        x264_encoder_close(rt->enc);
        rt->enc = NULL;
    }
    free(rt->yuv);
    rt->yuv = NULL;
    free(rt->sps);
    free(rt->pps);
    unlink(rt->authfile);
    cleanup_rt_dir(rt); /* 清理旧会话的运行时目录 */

    /* 换新 display 号，避免旧 socket 残留冲突 */
    rt->display = find_free_display();
    if (rt->display < 0)
        return -1;
    snprintf(rt->display_str, sizeof rt->display_str, ":%d", rt->display);
    snprintf(rt->authfile, sizeof rt->authfile, "/tmp/xworkd_auth_%d", rt->display);
    rt->width = w;
    rt->height = h;

    if (session_bring_up(rt, rt->user) != 0)
        return -1;

    /* 通知前端新分辨率与新参数集 */
    push_config(rt->conn, rt);
    rt->req_keyframe = 1;
    log_info("会话重建完成: %s (%dx%d)", rt->user, rt->width, rt->height);
    return 0;
}
