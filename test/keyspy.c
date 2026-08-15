/* 在指定 display 上监听 KeyPress 事件（验证键盘注入） */
#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

int main(int argc, char **argv)
{
    const char *dname = argc > 1 ? argv[1] : ":12";
    Display *d = XOpenDisplay(dname);
    if (!d)
    {
        fprintf(stderr, "无法打开 %s\n", dname);
        return 1;
    }
    Window root = DefaultRootWindow(d);
    XSelectInput(d, root, KeyPressMask | KeyReleaseMask);
    printf("LISTENING %s (10 秒) ...\n", dname);
    int got = 0;
    for (int i = 0; i < 1000; i++)
    {
        while (XPending(d))
        {
            XEvent ev;
            XNextEvent(d, &ev);
            if (ev.type == KeyPress)
            {
                char buf[32];
                KeySym ks = XLookupKeysym(&ev.xkey, 0);
                const char *name = XKeysymToString(ks);
                snprintf(buf, sizeof buf, "%s", name ? name : "?");
                printf("KEYPRESS keysym=0x%lx name=%s keycode=%u\n",
                       (unsigned long)ks, buf, ev.xkey.keycode);
                got++;
            }
            else if (ev.type == KeyRelease)
            {
                printf("KEYRELEASE keycode=%u\n", ev.xkey.keycode);
            }
        }
        struct timespec ts = {0, 10000000L};
        nanosleep(&ts, NULL);
    }
    printf("DONE got=%d\n", got);
    XCloseDisplay(d);
    return got > 0 ? 0 : 1;
}
