/* sessproc.c —— 会话进程生命周期与环境：
 *   display/xauth/Xvfb 分配、桌面会话（GNOME/keyring）拉起、
 *   按 DISPLAY 清理会话进程、用户 systemd 实例与 gsettings 集成。 */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#include "sessproc.h"
#include "protocol.h"
#include "config.h"
#include "auth.h"
#include "capture.h"
#include "encoder.h"
#include "util.h"
#include <X11/Xlib.h>

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <pwd.h>
#include <grp.h>
#include <dirent.h>
#include <stdio.h>

static pthread_mutex_t g_xenv_lock = PTHREAD_MUTEX_INITIALIZER;

int find_free_display(void)
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

int gen_cookie_hex(char *out, size_t outsz)
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
int user_bus_ok(uid_t uid)
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
void set_user_gsettings(const char *user, const char *schema,
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

int run_cmd_wait(char *const argv[])
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
void cleanup_rt_dir(runtime *rt)
{
    if (!rt || getuid() == 0)
        return;
    char rt_dir[160];
    snprintf(rt_dir, sizeof rt_dir, "/tmp/xdg-runtime-%u-%d", getuid(), rt->proc.display);
    char *rm[] = {"rm", "-rf", rt_dir, NULL};
    run_cmd_wait(rm);
}

pid_t run_cmd_bg(char *const argv[])
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
 * 只能靠 DISPLAY 特征兜底。
 * use_kill=0 时用 SIGTERM，=1 时用 SIGKILL（等待阶段升级）。
 * 返回 1 表示仍存在匹配的会话进程（等待循环据此继续） */
int kill_session_procs_by_display(const char *user, const char *display_str, int use_kill)
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
int session_bring_up(runtime *rt, const char *user, int w, int h)
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
    if (init_encoder(rt) != 0)
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
