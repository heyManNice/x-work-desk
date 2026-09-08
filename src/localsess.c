/* localsess.c —— 实体机（seat0 物理屏幕）登录会话检测与踢出。
 *
 * 服务端 root 模式下，通过 logind 的 loginctl 命令判定：目标用户是否在
 * seat0 上有 class=user 的图形会话（实体机 GDM 登录）。远程会话由
 * xworkd 在 Xvfb/Xorg 上自行拉起，不注册 logind session，因此 seat0 上的
 * class=user 会话即代表“人正坐在实体机前使用该账号”。
 *
 * 踢出用 loginctl terminate-session 精准终止对应会话（只影响实体机
 * 会话，不影响 xworkd 自己拉起的远程桌面进程），随后轮询等待其退出。 */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#include "localsess.h"
#include "util.h"

#include <errno.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define SEAT "seat0"

/* 测试钩子：强制“占用 / 踢成功” */
static int guard_forced(void)
{
    const char *f = getenv("XWORKD_LOCAL_GUARD_FORCE");
    return f && f[0] == '1';
}

/* 运行 argv 并捕获 stdout（至多 outn-1 字节，NUL 结尾）。
 * 返回子进程退出码；exec 失败返回 -1。 */
static int run_capture(const char *const av[], char *out, size_t outn)
{
    int p[2];
    if (pipe(p) != 0)
        return -1;
    pid_t pid = fork();
    if (pid < 0)
    {
        close(p[0]);
        close(p[1]);
        return -1;
    }
    if (pid == 0)
    {
        dup2(p[1], 1);
        close(p[0]);
        close(p[1]);
        execvp(av[0], (char *const *)av);
        _exit(127);
    }
    close(p[1]);
    size_t have = 0;
    if (out && outn)
    {
        ssize_t n;
        while (have + 1 < outn &&
               (n = read(p[0], out + have, outn - 1 - have)) > 0)
            have += (size_t)n;
        out[have] = 0;
    }
    else
    {
        char sink[128];
        while (read(p[0], sink, sizeof sink) > 0)
            ;
    }
    close(p[0]);
    int st = 0;
    while (waitpid(pid, &st, 0) < 0 && errno == EINTR)
        ;
    if (!WIFEXITED(st))
        return -1;
    return WEXITSTATUS(st);
}

/* 收集所有 logind session id（首列）。返回 0=成功（可能为空列表），-1=失败 */
static int collect_session_ids(char ids[][32], int max)
{
    char buf[16384];
    int rc = run_capture((const char *const[]){"loginctl", "list-sessions",
                                               "--no-legend", NULL},
                         buf, sizeof buf);
    if (rc != 0)
        return -1; /* loginctl 不可用/权限不足 */
    int n = 0;
    char *save = NULL;
    for (char *line = strtok_r(buf, "\n", &save); line && n < max;
         line = strtok_r(NULL, "\n", &save))
    {
        char *sp = line;
        while (*sp == ' ')
            sp++;
        if (!*sp)
            continue;
        char *end = sp;
        while (*end && *end != ' ')
            end++;
        size_t l = (size_t)(end - sp);
        if (l == 0 || l >= 32)
            continue;
        memcpy(ids[n], sp, l);
        ids[n][l] = 0;
        n++;
    }
    return n; /* 返回解析到的会话数量（0=无） */
}

/* 解析 show-session 的 key=value 输出 */
static const char *prop_get(const char *out, const char *key, char *val, size_t n)
{
    size_t kl = strlen(key);
    const char *p = out;
    while (p && *p)
    {
        const char *nl = strchr(p, '\n');
        size_t l = nl ? (size_t)(nl - p) : strlen(p);
        if (l > kl && !strncmp(p, key, kl) && p[kl] == '=')
        {
            size_t vl = l - kl - 1;
            if (vl >= n)
                vl = n - 1;
            memcpy(val, p + kl + 1, vl);
            val[vl] = 0;
            return val;
        }
        p = nl ? nl + 1 : NULL;
    }
    return NULL;
}

static void show_session(const char *sid, char *out, size_t n)
{
    const char *av[] = {"loginctl", "show-session", sid, "-p", "UID",
                        "-p", "Seat", "-p", "Type",
                        "-p", "Class", "-p", "User",
                        "-p", "Name", NULL};
    (void)run_capture(av, out, n);
}

/* 判定一个 sid 是否属于 user 的实体机图形会话（seat0 + class=user） */
static int session_is_local_for(const char *sid, const char *user, uid_t uid)
{
    char out[2048];
    show_session(sid, out, sizeof out);
    if (!out[0])
        return 0;
    char v[256];
    if (!prop_get(out, "Seat", v, sizeof v) || strcmp(v, SEAT))
        return 0; /* 非 seat0（远程/容器内等） */
    if (!prop_get(out, "Class", v, sizeof v) || strcmp(v, "user"))
        return 0; /* greeter 等非用户会话不算 */
    /* 图形或本地 tty 都视为实体机登录；仅匹配目标 uid 防同名误判 */
    if (prop_get(out, "UID", v, sizeof v) && atol(v) == (long)uid)
        return 1;
    if (user && *user)
    {
        if (prop_get(out, "Name", v, sizeof v) && !strcmp(v, user))
            return 1;
        if (prop_get(out, "User", v, sizeof v) && !strcmp(v, user))
            return 1;
    }
    return 0;
}

/* 收集 user 在实体机的会话 id 列表，返回数量（0=无），-1=无法判定 */
static int collect_local_sids(const char *user, char sids[][32], int max)
{
    if (guard_forced())
        return 1; /* 测试钩子：视为占用（sid 占位，不用于真实 terminate） */
    struct passwd *pw = getpwnam(user);
    if (!pw)
        return -1;
    char all[64][32];
    int n = collect_session_ids(all, 64);
    if (n < 0)
        return -1;
    int m = 0;
    for (int i = 0; i < n && m < max; i++)
        if (session_is_local_for(all[i], user, pw->pw_uid))
        {
            snprintf(sids[m], 32, "%s", all[i]);
            m++;
        }
    return m;
}

int localsess_user_on_seat(const char *user)
{
    if (!user || !user[0])
        return 0;
    if (guard_forced())
        return 1;
    char sids[8][32];
    int n = collect_local_sids(user, sids, 8);
    if (n < 0)
        return -1; /* loginctl 不可用/无法判定：调用方决定是否跳过 */
    return n > 0 ? 1 : 0;
}

int localsess_kick_user(const char *user)
{
    if (guard_forced())
        return 0; /* 测试钩子：模拟已踢出 */
    if (geteuid() != 0)
        return -1; /* 仅 root 可终止他人会话 */
    char sids[8][32];
    int n = collect_local_sids(user, sids, 8);
    if (n < 0)
        return -1;
    if (n == 0)
        return 0; /* 已无实体机会话 */
    log_info("[guard] 踢出实体机会话: %s (%d 个)", user, n);
    for (int i = 0; i < n; i++)
    {
        char cmd[80];
        snprintf(cmd, sizeof cmd, "loginctl terminate-session %s 2>&1", sids[i]);
        char err[1024];
        int rc = run_capture((const char *const[]){"sh", "-c", cmd, NULL},
                             err, sizeof err);
        if (rc != 0)
            log_err("[guard] 结束实体机会话失败(rc=%d): session %s out=[%s]",
                    rc, sids[i], err);
    }
    /* 轮询等待实体机会话真正退出（terminate 后 GNOME 会话回落 greeter） */
    int64_t deadline = monotonic_ms() + 20000;
    for (;;)
    {
        char check[8][32];
        int left = collect_local_sids(user, check, 8);
        if (left <= 0)
            return left == 0 ? 0 : -1; /* 已清空 / 判定失败按成功处理不再重试 */
        if (monotonic_ms() > deadline)
        {
            log_err("[guard] 等待实体机会话退出超时: %s", user);
            return -1;
        }
        usleep(200000);
    }
}
