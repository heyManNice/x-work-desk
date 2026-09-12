#pragma once
#include <sys/types.h>

struct runtime;

/* Xvfb + 会话进程的生命周期 */
typedef struct proc_ctx
{
    int display; /* -1 表示尚未分配 */
    char display_str[16];
    char authfile[512];
    char xorg_conf[512]; /* Xorg 模式下的配置文件（Xvfb 模式为空） */
    char user[64];       /* 会话进程的运行用户（清理时按 uid+DISPLAY 匹配） */
    pid_t xvfb_pid;      /* X 服务器进程 pid（Xvfb 或 Xorg） */
    pid_t *children;
    int nchildren;
} proc_ctx;

/* 会话进程生命周期与环境（sessproc.c）
 * display/xauth/Xvfb 分配、桌面会话进程拉起、按 DISPLAY 清理、
 * 用户 systemd 实例与 gsettings 集成。 */

int find_free_display(void);
int gen_cookie_hex(char *out, size_t outsz);
int user_bus_ok(uid_t uid);
void set_user_gsettings(const char *user, const char *schema,
                        const char *key, const char *value);
/* /proc 存活检查（对僵尸进程返回 0=已结束） */
int pid_alive(pid_t pid);

/* 用 xrandr 把 X 服务器屏幕改到 w×h（Xorg+dummy 支持任意分辨率运行期切换）。
 * display 形如 ":11"，authfile 为 X 授权 cookie 文件。 */
int xrandr_set_resolution(const char *display, const char *authfile,
                          int w, int h);
int run_cmd_wait(char *const argv[]);
pid_t run_cmd_bg(char *const argv[]);
/* 在会话内把输入法中继引擎挂成当前 GNOME 输入源（enable=1）或恢复原样（enable=0）。
 * 见 src/im.h：引擎由 ibus 按输入源激活，不像面板那样可以直接手动拉进程。 */
int im_session_switch(struct runtime *rt, int enable);
void cleanup_rt_dir(struct runtime *rt);
int kill_session_procs_by_display(const char *user, const char *display_str,
                                  int use_kill);
int session_bring_up(struct runtime *rt, const char *user, int w, int h);
