#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <signal.h>
#include <X11/Xlib.h>

#include "config.h"
#include "auth.h"
#include "net.h"
#include "util.h"
#include "protocol.h"

config g_cfg;

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
            "  --www-root DIR      前端静态文件目录 (默认 ./frontend/dist)\n"
            "  --auth none|shadow  认证模式 (默认 shadow；开发用 none)\n"
            "  --app CMD           在桌面上启动的会话命令 (默认 gnome-shell)\n"
            "  --width W --height H  虚拟屏幕尺寸 (默认 1280x720)\n"
            "  --fps N             抓帧帧率 (默认 30)\n",
            prog);
}

int main(int argc, char **argv)
{
    g_cfg.port = 5268;
    snprintf(g_cfg.www_root, sizeof g_cfg.www_root, "%s", "./frontend/dist");
    g_cfg.auth_mode = AUTH_SHADOW;
    g_cfg.session_cmd[0] = 0;
    g_cfg.width = DEFAULT_WIDTH;
    g_cfg.height = DEFAULT_HEIGHT;
    g_cfg.fps = 30;

    for (int i = 1; i < argc; i++)
    {
        if (!strcmp(argv[i], "--port") && i + 1 < argc)
            g_cfg.port = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--www-root") && i + 1 < argc)
            snprintf(g_cfg.www_root, sizeof g_cfg.www_root, "%s", argv[++i]);
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
    XInitThreads();
    XSetIOErrorHandler(x_io_error_handler);
    XSetErrorHandler(x_error_handler);
    auth_init(g_cfg.auth_mode);

    log_info("XWorkDesk 服务启动: 端口=%d www-root=%s auth=%s",
             g_cfg.port, g_cfg.www_root, g_cfg.auth_mode == AUTH_NONE ? "none(dev)" : "shadow");
    if (net_init(g_cfg.port, g_cfg.www_root) != 0)
    {
        log_err("网络初始化失败");
        return 1;
    }
    log_info("开始服务...");
    net_run();
    return 0;
}
