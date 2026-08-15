/* 查询指定 X display 的指针位置（验证输入注入） */
#include <X11/Xlib.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv)
{
    const char *dname = argc > 1 ? argv[1] : ":10";
    Display *d = XOpenDisplay(dname);
    if (!d)
    {
        fprintf(stderr, "无法打开 %s\n", dname);
        return 1;
    }
    Window root = DefaultRootWindow(d), child, rr, cc;
    int rx = -1, ry = -1, wx = -1, wy = -1;
    unsigned int mask = 0;
    if (XQueryPointer(d, root, &rr, &child, &rx, &ry, &wx, &wy, &mask))
        printf("POINTER %d %d mask=0x%x\n", rx, ry, mask);
    else
        printf("QUERY FAILED\n");
    XCloseDisplay(d);
    return 0;
}
