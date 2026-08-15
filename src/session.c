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
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <pwd.h>
#include <grp.h>
#include <dirent.h>
#include <stdio.h>
#include <errno.h>

static pthread_mutex_t g_xenv_lock = PTHREAD_MUTEX_INITIALIZER;

/* ---------------- 会话表：按用户名管理桌面会话 ----------------
 * 会话（runtime）与 WebSocket 连接解耦：
 *   - 登录成功建立会话后注册到表，即使连接断开也保留（桌面后台运行）；
 *   - 新连接登录同一账户时：有人连接→询问是否注销接管；无人连接→直接接管；
 *   - 会话只在用户系统内注销（gnome-session 退出）或 Xvfb 崩溃时结束。 */
#define MAX_SESSIONS 64
typedef struct
{
    char user[64];
    runtime *rt;
} session_entry;
static session_entry g_sessions[MAX_SESSIONS];
static pthread_mutex_t g_sess_lock = PTHREAD_MUTEX_INITIALIZER;

static runtime *session_lookup(const char *user);
static void session_register(runtime *rt, const char *user);
static void session_unregister(runtime *rt);

static void cleanup_rt_dir(runtime *rt);
static int session_bring_up(runtime *rt, const char *user, int w, int h);
static int runtime_restart(runtime *rt, int w, int h);
static int kill_session_procs_by_display(const char *user, const char *display_str, int use_kill);
static int session_gone(runtime *rt);
static void set_user_gsettings(const char *user, const char *schema,
                               const char *key, const char *value);

static void runtime_ref(runtime *rt) { __sync_add_and_fetch(&rt->refs, 1); }

/* 停抓帧线程并释放 X/编码/进程资源；幂等，可在会话未完全启动时调用 */
static void runtime_teardown(runtime *rt)
{
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
    if (rt->enc.enc)
    {
        x264_encoder_close(rt->enc.enc);
        rt->enc.enc = NULL;
    }
    free(rt->video.yuv);
    rt->video.yuv = NULL;
    free(rt->enc.sps);
    rt->enc.sps = NULL;
    rt->enc.sps_len = 0;
    free(rt->enc.pps);
    rt->enc.pps = NULL;
    rt->enc.pps_len = 0;

    /* 再杀掉 Xvfb 与会话进程（按进程组整体清理） */
    if (rt->proc.xvfb_pid > 0)
    {
        kill(-rt->proc.xvfb_pid, SIGTERM);
        kill(rt->proc.xvfb_pid, SIGTERM);
    }
    /* systemd 用户实例接管了 gnome-session/gnome-shell 等（不在我们的进程组），
     * 按「DISPLAY=:N + 用户」扫描 /proc 兜底清理，避免旧会话残留占用总线 */
    if (rt->proc.user[0])
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
        if (rt->proc.user[0])
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

static void runtime_unref(runtime *rt)
{
    if (__sync_sub_and_fetch(&rt->refs, 1) == 0)
        runtime_destroy(rt);
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

static void push_config(conn *c, runtime *rt)
{
    size_t len = 9 + rt->enc.sps_len + rt->enc.pps_len;
    uint8_t *buf = malloc(len);
    uint8_t *p = buf;
    *p++ = MSG_CONFIG;
    wr_u16(p, (uint16_t)rt->video.width);
    p += 2;
    wr_u16(p, (uint16_t)rt->video.height);
    p += 2;
    wr_u16(p, (uint16_t)rt->enc.sps_len);
    p += 2;
    memcpy(p, rt->enc.sps, rt->enc.sps_len);
    p += rt->enc.sps_len;
    wr_u16(p, (uint16_t)rt->enc.pps_len);
    p += 2;
    memcpy(p, rt->enc.pps, rt->enc.pps_len);
    net_push(c, buf, len, 0);
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
    push_config(c, sess);
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
    /* 与 runtime_restart 互斥，避免读取到被替换的 SPS/PPS */
    pthread_mutex_lock(&rt->lock);
    push_config(c, rt);
    log_info("登录完成: %s -> %s", j->user, rt->proc.display_str);
    pthread_mutex_unlock(&rt->lock);

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
        runtime_restart(rt, w, h);
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
    push_config(c, rt);
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
    default:
        break;
    }
}

/* ---------------- 进程生命周期 ---------------- */
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

/* 检查用户 systemd 实例的会话总线是否可连接（/run/user/<uid>/bus） */
static int user_bus_ok(uid_t uid)
{
    char path[96];
    snprintf(path, sizeof path, "/run/user/%u/bus", uid);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0)
        return 0;
    struct sockaddr_un sa;
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    strncpy(sa.sun_path, path, sizeof sa.sun_path - 1);
    int ok = connect(fd, (struct sockaddr *)&sa, sizeof sa) == 0;
    close(fd);
    return ok;
}

/* 以目标用户身份执行 gsettings（控制 GNOME 动画等运行期设置） */
static void set_user_gsettings(const char *user, const char *schema,
                               const char *key, const char *value)
{
    struct passwd *pw = getpwnam(user);
    if (!pw)
        return;
    pid_t pid = fork();
    if (pid == 0)
    {
        if (getuid() == 0)
        {
            initgroups(pw->pw_name, pw->pw_gid);
            setgid(pw->pw_gid);
            setuid(pw->pw_uid);
        }
        setenv("HOME", pw->pw_dir, 1);
        setenv("USER", pw->pw_name, 1);
        setenv("LOGNAME", pw->pw_name, 1);
        char rt[64];
        snprintf(rt, sizeof rt, "/run/user/%u", pw->pw_uid);
        setenv("XDG_RUNTIME_DIR", rt, 1);
        char bus[96];
        snprintf(bus, sizeof bus, "unix:path=/run/user/%u/bus", pw->pw_uid);
        setenv("DBUS_SESSION_BUS_ADDRESS", bus, 1);
        execlp("gsettings", "gsettings", "set", schema, key, value, (char *)NULL);
        _exit(127);
    }
    if (pid > 0)
        waitpid(pid, NULL, 0);
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
    snprintf(rt_dir, sizeof rt_dir, "/tmp/xdg-runtime-%u-%d", getuid(), rt->proc.display);
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

/* 按「进程环境里的 DISPLAY=:N + 用户 UID」清理会话进程。
 * gnome-session 被 systemd 用户实例接管后不在我们的进程组里，
 * 只能靠 DISPLAY 特征兜底；keyring 守护进程无 DISPLAY，单独用 pid 文件。
 * use_kill=0 时用 SIGTERM，=1 时用 SIGKILL（等待阶段升级）。 */
/* 返回 1 表示仍存在匹配的会话进程（等待循环据此继续） */
static int kill_session_procs_by_display(const char *user, const char *display_str, int use_kill)
{
    struct passwd *pw = getpwnam(user);
    if (!pw)
        return 0;
    uid_t uid = pw->pw_uid;
    char want[32];
    snprintf(want, sizeof want, "DISPLAY=%s", display_str);

    DIR *dir = opendir("/proc");
    if (!dir)
        return 0;
    int any = 0;
    struct dirent *de;
    while ((de = readdir(dir)))
    {
        if (de->d_name[0] < '0' || de->d_name[0] > '9')
            continue;
        pid_t pid = (pid_t)atoi(de->d_name);
        if (pid <= 1)
            continue;

        char statusp[64];
        snprintf(statusp, sizeof statusp, "/proc/%d/status", pid);
        FILE *fs = fopen(statusp, "rb");
        if (!fs)
            continue;
        uid_t p_uid = (uid_t)-1;
        char line[256];
        while (fgets(line, sizeof line, fs))
        {
            if (!strncmp(line, "Uid:", 4))
            {
                unsigned long u0 = 0;
                sscanf(line + 4, "%lu", &u0);
                p_uid = (uid_t)u0;
                break;
            }
        }
        fclose(fs);
        if (p_uid != uid)
            continue;

        char envp[64];
        snprintf(envp, sizeof envp, "/proc/%d/environ", pid);
        FILE *fe = fopen(envp, "rb");
        if (!fe)
            continue;
        int match = 0;
        char ebuf[4096];
        size_t elen = fread(ebuf, 1, sizeof ebuf - 1, fe);
        fclose(fe);
        ebuf[elen] = 0;
        size_t pos = 0;
        while (pos < elen)
        {
            const char *var = ebuf + pos;
            size_t vlen = strnlen(var, elen - pos);
            if (vlen > 0)
            {
                if (!strncmp(var, want, strlen(want)))
                {
                    match = 1;
                    break;
                }
            }
            pos += vlen + 1;
            if (vlen == 0)
                break;
        }
        if (match)
        {
            kill(pid, use_kill ? SIGKILL : SIGTERM);
            any = 1;
        }
    }
    closedir(dir);
    return any;
}

/* ---------------- 会话表 ---------------- */
static runtime *session_lookup(const char *user)
{
    runtime *rt = NULL;
    pthread_mutex_lock(&g_sess_lock);
    for (int i = 0; i < MAX_SESSIONS; i++)
        if (g_sessions[i].rt && !strcmp(g_sessions[i].user, user))
        {
            rt = g_sessions[i].rt;
            break;
        }
    pthread_mutex_unlock(&g_sess_lock);
    return rt;
}

static void session_register(runtime *rt, const char *user)
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

static void session_unregister(runtime *rt)
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

/* 进程是否存活：/proc 检查（对僵尸返回 0=已结束），
 * 避免 waitpid 在多线程（sweep + 登录线程）下互相收割的竞态 */
static int pid_alive(pid_t pid)
{
    char path[64];
    snprintf(path, sizeof path, "/proc/%d/stat", pid);
    FILE *f = fopen(path, "rb");
    if (!f)
        return 0;
    char state = 0;
    /* 格式: pid (comm) state ...  comm 可能含空格/括号，用 rfind 定位最后一个 ')' */
    char buf[512];
    size_t n = fread(buf, 1, sizeof buf - 1, f);
    fclose(f);
    buf[n] = 0;
    char *rp = strrchr(buf, ')');
    if (rp && rp[1] == ' ')
        state = rp[2];
    return state != 0 && state != 'Z';
}

/* 判断会话是否已结束：gnome-session（wrapper）或 Xvfb 已退出 */
static int session_gone(runtime *rt)
{
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
            net_close_conn(c); /* 触发 vdi_on_close → unref */
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

/* 在 dbus 会话总线内先解锁 GNOME Keyring，再 exec 目标会话命令。
 * 默认桌面由 dbus-run-session 提供会话总线，keyring 守护进程必须在该总线
 * 上下文中启动并接收登录密码，否则应用会提示 "The login keyring did not
 * get unlocked when you logged into your computer." */
static void exec_keyring_session(const char *inner_cmd, int do_unlock)
{
    char wrap[4096];
    /* snap 等桌面应用依赖 systemd 用户总线来创建自己的 cgroup scope：
     * 优先使用 /run/user/<uid>/bus（正常 GNOME 会话即如此），
     * 无 systemd 实例时退回 dbus-run-session 的私有总线 */
    const char *bus_setup =
        "if [ -S \"$XDG_RUNTIME_DIR/bus\" ]; then "
        "export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus; fi; ";
    /* 会话结束后进程链自然退出：gnome-session（或 gnome-shell）退出 →
     * wait 返回 → 清理 keyring 守护进程 → 本 shell 退出 → dbus-run-session
     * 退出。服务端据此可靠检测会话结束（注销），无需依赖总线状态。 */
    const char *wait_teardown =
        "trap 'pkill -u \"$UID\" -x gnome-keyring-daemon 2>/dev/null; "
        "sleep 1; pkill -9 -u \"$UID\" -x gnome-keyring-daemon 2>/dev/null' EXIT; "
        "%s & GS=$!; wait $GS; rc=$?; exit $rc";
    if (do_unlock)
    {
        snprintf(wrap, sizeof wrap,
                 "%s"
                 /* --login 是 pam_gnome_keyring 使用的标准入口：把登录密码
                  * 交给 keyring 守护进程；随后 --start 完成初始化并自动解锁
                  * login keyring（等价于正常桌面登录的 PAM 流程） */
                 "printf '%%s' \"$XWD_KEYRING_PASS\" | gnome-keyring-daemon --login --components=secrets 2>/dev/null & "
                 "sleep 1; "
                 "eval \"$(gnome-keyring-daemon --start --components=secrets 2>/dev/null)\"; "
                 "unset XWD_KEYRING_PASS; ",
                 bus_setup);
        snprintf(wrap + strlen(wrap), sizeof wrap - strlen(wrap),
                 wait_teardown, inner_cmd);
    }
    else
    {
        snprintf(wrap, sizeof wrap, "%s", bus_setup);
        snprintf(wrap + strlen(wrap), sizeof wrap - strlen(wrap),
                 wait_teardown, inner_cmd);
    }
    execl("/usr/bin/dbus-run-session", "dbus-run-session", "--",
          "/bin/sh", "-c", wrap, (char *)NULL);
    _exit(127);
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
        snprintf(rt_dir, sizeof rt_dir, "/tmp/xdg-runtime-%u-%d", getuid(), rt->proc.display);
    if (mkdir(rt_dir, 0700) != 0 && errno != EEXIST)
        log_info("mkdir %s: %s", rt_dir, strerror(errno));
    if (is_root && pw)
    {
        if (chown(rt_dir, pw->pw_uid, pw->pw_gid) != 0)
        { /* 忽略 */
        }
    }
    chmod(rt_dir, 0700);
    snprintf(rt->proc.user, sizeof rt->proc.user, "%s", run_name);

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
        setenv("DISPLAY", rt->proc.display_str, 1);
        setenv("XAUTHORITY", rt->proc.authfile, 1);
        setenv("HOME", run_home, 1);
        setenv("USER", run_name, 1);
        setenv("LOGNAME", run_name, 1);
        setenv("SHELL", run_shell, 1);
        setenv("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin", 1);
        /* snap 应用的桌面图标位于 /var/lib/snapd/desktop，必须加入 XDG_DATA_DIRS */
        setenv("XDG_DATA_DIRS", "/usr/share/gnome:/usr/local/share:/usr/share:/var/lib/snapd/desktop", 1);
        setenv("XDG_RUNTIME_DIR", rt_dir, 1);
        setenv("XDG_CURRENT_DESKTOP", "ubuntu:GNOME", 1);
        setenv("XDG_SESSION_TYPE", "x11", 1);
        setenv("XDG_SESSION_CLASS", "user", 1);
        /* keyring 解锁策略：shadow 模式密码已验证，可解锁或创建 login keyring；
         * none 模式密码未验证，仅当已存在 login keyring 时才尝试（避免用任意
         * 密码误创建密钥环），且不传密码时保持原行为 */
        int do_keyring = 0;
        if (rt->pass[0])
        {
            if (g_cfg.auth_mode == AUTH_SHADOW)
                do_keyring = 1;
            else
            {
                char kf[512];
                snprintf(kf, sizeof kf, "%s/.local/share/keyrings/login.keyring", run_home);
                do_keyring = access(kf, R_OK) == 0;
            }
        }
        if (do_keyring)
            setenv("XWD_KEYRING_PASS", rt->pass, 1);

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
                exec_keyring_session("/usr/bin/gnome-session --session=ubuntu", do_keyring);
            }
            exec_keyring_session("/usr/bin/gnome-session", do_keyring);
        }
        else if (access("/usr/bin/gnome-shell", X_OK) == 0)
        {
            /* 退路：无 gnome-session 时裸启动 GNOME Shell（X11 模式） */
            exec_keyring_session("/usr/bin/gnome-shell --x11", do_keyring);
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
    rt->proc.children = realloc(rt->proc.children,
                                (rt->proc.nchildren + 1) * sizeof(pid_t));
    rt->proc.children[rt->proc.nchildren++] = pid;
}

/* 启动 Xvfb + 会话 + 抓帧/编码管线（proc/video 字段需已设置） */
static int session_bring_up(runtime *rt, const char *user, int w, int h)
{
    rt->video.width = (w > 0 && w <= 8192) ? w : g_cfg.width;
    rt->video.height = (h > 0 && h <= 8192) ? h : g_cfg.height;

    /* 出站队列预算按分辨率/帧率估算：低码率场景小内存，高清场景够缓冲。
     * 经验估算 ~40KB/百万像素/帧 × 2 帧缓冲，1MB~16MB 区间。 */
    conn *outc = atomic_load(&rt->conn);
    if (outc)
    {
        uint64_t px = (uint64_t)rt->video.width * (uint64_t)rt->video.height;
        uint64_t budget = px * 2 * 40 + 512 * 1024;
        if (budget < 1024 * 1024)
            budget = 1024 * 1024;
        if (budget > 16 * 1024 * 1024)
            budget = 16 * 1024 * 1024;
        msgq_set_budget(&outc->outq, (size_t)budget);
    }

    if (rt->proc.display < 0)
    {
        rt->proc.display = find_free_display();
        if (rt->proc.display < 0)
        {
            log_err("没有可用 display");
            return -1;
        }
        snprintf(rt->proc.display_str, sizeof rt->proc.display_str, ":%d", rt->proc.display);
        snprintf(rt->proc.authfile, sizeof rt->proc.authfile, "/tmp/xworkd_auth_%d", rt->proc.display);
    }

    char cookie[64];
    if (gen_cookie_hex(cookie, sizeof cookie) != 0)
        return -1;

    char *xa[] = {"xauth", "-f", rt->proc.authfile, "add", rt->proc.display_str, ".", cookie, NULL};
    if (run_cmd_wait(xa) != 0)
    {
        log_err("xauth 失败");
        return -1;
    }
    /* xauth 由服务进程创建（默认 0600）。root 模式下会话子进程会 setuid 到
     * 目标用户，必须把 cookie 文件交给该用户，否则桌面进程无法连接 X，
     * gnome-session 的加速检查会失败并整体退出（表现为黑屏）。 */
    if (geteuid() == 0)
    {
        struct passwd *pw = getpwnam(user);
        if (pw)
        {
            if (chown(rt->proc.authfile, pw->pw_uid, pw->pw_gid) != 0)
            { /* 忽略：非关键路径，失败时桌面会话仍可尝试连接 */
            }
        }
    }

    char geom[32];
    snprintf(geom, sizeof geom, "%dx%dx24", rt->video.width, rt->video.height);
    char *xv[] = {"Xvfb", rt->proc.display_str, "-screen", "0", geom,
                  "-nolisten", "tcp", "-auth", rt->proc.authfile, NULL};
    rt->proc.xvfb_pid = run_cmd_bg(xv);
    if (rt->proc.xvfb_pid < 0)
        return -1;

    int up = 0;
    for (int i = 0; i < 100; i++)
    {
        char sock[64];
        snprintf(sock, sizeof sock, "/tmp/.X11-unix/X%d", rt->proc.display);
        struct stat st;
        if (stat(sock, &st) == 0)
        {
            up = 1;
            break;
        }
        int ws;
        if (waitpid(rt->proc.xvfb_pid, &ws, WNOHANG) == rt->proc.xvfb_pid)
            break; /* 已退出 */
        usleep(100000);
    }
    if (!up)
    {
        log_err("Xvfb 未启动 %s", rt->proc.display_str);
        return -1;
    }

    /* 在正确的 env 下打开 Display */
    pthread_mutex_lock(&g_xenv_lock);
    char *od = getenv("DISPLAY"), *oa = getenv("XAUTHORITY");
    setenv("DISPLAY", rt->proc.display_str, 1);
    setenv("XAUTHORITY", rt->proc.authfile, 1);
    rt->cap.dpy = XOpenDisplay(rt->proc.display_str);
    if (od)
        setenv("DISPLAY", od, 1);
    else
        unsetenv("DISPLAY");
    if (oa)
        setenv("XAUTHORITY", oa, 1);
    else
        unsetenv("XAUTHORITY");
    pthread_mutex_unlock(&g_xenv_lock);
    if (!rt->cap.dpy)
    {
        log_err("XOpenDisplay(%s) 失败", rt->proc.display_str);
        return -1;
    }
    rt->cap.root = DefaultRootWindow(rt->cap.dpy);

    if (init_shm(&rt->cap, rt->video.width, rt->video.height) != 0)
        return -1;
    if (init_encoder(&rt->enc, &rt->video, g_cfg.fps) != 0)
        return -1;
    /* 确保目标用户的 systemd 实例在运行，提供 /run/user/<uid>/bus
     * （snap 等应用依赖；启动失败时桌面仍可用 dbus-run-session 兜底） */
    if (geteuid() == 0)
    {
        struct passwd *pw = getpwnam(user);
        if (pw)
        {
            char unit[64];
            snprintf(unit, sizeof unit, "user@%u.service", pw->pw_uid);
            char *args[] = {"systemctl", "start", unit, NULL};
            run_cmd_wait(args);
            /* 兜底：用户实例的 dbus 可能已停止（VM 上偶发），
             * 导致 /run/user/<uid>/bus 拒绝连接、gnome-session 起不来。
             * 检测到总线不可用则重启用户实例恢复。 */
            if (!user_bus_ok(pw->pw_uid))
            {
                log_info("用户 %s 的总线不可用，重启 %s", user, unit);
                char *restart[] = {"systemctl", "restart", unit, NULL};
                run_cmd_wait(restart);
                sleep(1);
                char *start2[] = {"systemctl", "start", unit, NULL};
                run_cmd_wait(start2);
            }
        }
    }
    spawn_session_app(rt, user);

    atomic_store(&rt->cap.running, 1);
    if (pthread_create(&rt->cap.cap_thread, NULL, capture_thread, rt) != 0)
    {
        atomic_store(&rt->cap.running, 0);
        log_err("创建抓帧线程失败");
        return -1;
    }
    return 0;
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

    /* 通知前端新分辨率与新参数集 */
    conn *c = atomic_load(&rt->conn);
    if (c)
        push_config(c, rt);
    atomic_store(&rt->cap.req_keyframe, 1);
    log_info("会话重建完成: %s (%dx%d)", rt->user, rt->video.width, rt->video.height);
    pthread_mutex_unlock(&rt->lock);
    return 0;
}
