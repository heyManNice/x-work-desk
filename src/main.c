#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <signal.h>
#include <errno.h>
#include <sys/stat.h>
#include <X11/Xlib.h>

#include "config.h"
#include "auth.h"
#include "net.h"
#include "session.h"
#include "util.h"
#include "protocol.h"

config g_cfg;
char g_local_token[64];
volatile int g_server_shutdown = 0;

/* 生成本地会话控制接口令牌并写入 /run/xworkd/local.token（0600 root），
 * 供 PAM 守卫(xworkd-gdm-guard)等本机调用方经 127.0.0.1 调用 /api/local/ 鉴权 */
static void init_local_api_token(void)
{
    util_gen_token(g_local_token, sizeof g_local_token);
    /* 目录权限必须是 0711（可穿越、不可列目录）：
     *   · token 文件与 IM socket 各自 0600，拿到文件名也没用；
     *   · 但**会话用户**要能 connect() 到自己的 IM socket —— 目录不可穿越时
     *     引擎会直接 EACCES/ENOENT（踩过：输入法引擎在跑却永远连不上）。 */
    if (mkdir("/run/xworkd", 0711) != 0 && errno != EEXIST)
        return; /* /run 异常时忽略（接口校验会因 token 文件缺失而拒绍调用） */
    /* 已存在时也修一次权限（旧版本建的是 0700，升级后不重启也自愈） */
    if (chmod("/run/xworkd", 0711) != 0)
    { /* 忽略 */
    }
    FILE *f = fopen("/run/xworkd/local.token", "w");
    if (!f)
    {
        log_err("无法写入本地接口令牌文件");
        return;
    }
    fprintf(f, "%s", g_local_token);
    fclose(f);
    chmod("/run/xworkd/local.token", 0600);
}

static void on_signal(int sig)
{
    (void)sig;
    g_server_shutdown = 1;
}

/* 防止单个会话的 X 故障（如 Xvfb 异常退出）导致整个多用户进程崩溃 */
static int x_io_error_handler(Display *d)
{
    log_err("X I/O 错误 (display 已断开)");
    return 0;
}

static int x_error_handler(Display *d, XErrorEvent *e)
{
    log_err("X 协议错误 code=%d", e->error_code);
    return 0;
}

static void usage(const char *prog)
{
    fprintf(stderr,
            "用法: %s [选项]\n"
            "  --port N            监听端口 (默认 5268)\n"
            "  --auth none|shadow  认证模式 (默认 shadow；开发用 none)\n"
            "  --app CMD           在桌面上启动的会话命令 (默认 gnome-shell)\n"
            "  --server xorg|xvfb  虚拟显示服务器 (默认 xorg；xorg 支持运行时改分辨率)\n"
            "  --width W --height H  虚拟屏幕尺寸 (默认 1280x720)\n"
            "  --fps N             抓帧帧率 (默认 30)\n",
            prog);
}

int main(int argc, char **argv)
{
    g_cfg.port = 5268;
    g_cfg.auth_mode = AUTH_SHADOW;
    g_cfg.session_cmd[0] = 0;
    g_cfg.server = SERVER_XORG;
    g_cfg.width = DEFAULT_WIDTH;
    g_cfg.height = DEFAULT_HEIGHT;
    g_cfg.fps = 30;

    for (int i = 1; i < argc; i++)
    {
        if (!strcmp(argv[i], "--port") && i + 1 < argc)
            g_cfg.port = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--auth") && i + 1 < argc)
        {
            i++;
            if (!strcmp(argv[i], "none"))
                g_cfg.auth_mode = AUTH_NONE;
            else if (!strcmp(argv[i], "shadow"))
                g_cfg.auth_mode = AUTH_SHADOW;
            else
            {
                usage(argv[0]);
                return 1;
            }
        }
        else if (!strcmp(argv[i], "--app") && i + 1 < argc)
            snprintf(g_cfg.session_cmd, sizeof g_cfg.session_cmd, "%s", argv[++i]);
        else if (!strcmp(argv[i], "--server") && i + 1 < argc)
        {
            i++;
            if (!strcmp(argv[i], "xorg"))
                g_cfg.server = SERVER_XORG;
            else if (!strcmp(argv[i], "xvfb"))
                g_cfg.server = SERVER_XVFB;
            else
            {
                usage(argv[0]);
                return 1;
            }
        }
        else if (!strcmp(argv[i], "--width") && i + 1 < argc)
            g_cfg.width = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--height") && i + 1 < argc)
            g_cfg.height = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--fps") && i + 1 < argc)
            g_cfg.fps = atoi(argv[++i]);
        else if (!strcmp(argv[i], "-h") || !strcmp(argv[i], "--help"))
        {
            usage(argv[0]);
            return 0;
        }
        else
        {
            usage(argv[0]);
            return 1;
        }
    }

    signal(SIGPIPE, SIG_IGN);
    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);
    XInitThreads();
    XSetIOErrorHandler(x_io_error_handler);
    XSetErrorHandler(x_error_handler);
    auth_init(g_cfg.auth_mode);

    log_info("XWorkDesk 服务启动: 端口=%d auth=%s",
             g_cfg.port, g_cfg.auth_mode == AUTH_NONE ? "none(dev)" : "shadow");
    init_local_api_token();
    if (net_init(g_cfg.port) != 0)
    {
        log_err("网络初始化失败");
        return 1;
    }
    log_info("开始服务...");
    net_run();
    runtime_wait_destroyed(); /* 等待异步会话销毁收尾，避免孤儿 X/进程 */
    return 0;
}
