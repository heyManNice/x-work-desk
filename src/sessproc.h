#pragma once
#include "session.h"

/* 会话进程生命周期与环境（sessproc.c）
 * display/xauth/Xvfb 分配、桌面会话进程拉起、按 DISPLAY 清理、
 * 用户 systemd 实例与 gsettings 集成。 */

int find_free_display(void);
int gen_cookie_hex(char *out, size_t outsz);
int user_bus_ok(uid_t uid);
void set_user_gsettings(const char *user, const char *schema,
                        const char *key, const char *value);

/* 用 xrandr 把 X 服务器屏幕改到 w×h（Xorg+dummy 支持任意分辨率运行期切换）。
 * display 形如 ":11"，authfile 为 X 授权 cookie 文件。 */
int xrandr_set_resolution(const char *display, const char *authfile,
                          int w, int h);
int run_cmd_wait(char *const argv[]);
pid_t run_cmd_bg(char *const argv[]);
void cleanup_rt_dir(runtime *rt);
int kill_session_procs_by_display(const char *user, const char *display_str,
                                  int use_kill);
int session_bring_up(runtime *rt, const char *user, int w, int h);
