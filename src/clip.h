#pragma once
#include <X11/Xlib.h>
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>

struct runtime;

/* 剪贴板共享状态（每会话独立，避免多用户内容串扰） */
typedef struct clip_ctx
{
    int event_base;          /* XFixes 事件基号 */
    unsigned long last_hash; /* 上次推送内容的哈希 */
    Window owner_win;        /* 剪贴板 owner 窗口 */
    Window read_win;         /* 读取剪贴板的请求窗口（XConvertSelection） */
    Atom read_prop_atom;     /* 读取用 property（XWD_CLIP_DATA，缓存） */
    Atom clip_atom, primary_atom, utf8_atom, text_atom, targets_atom,
        plain_atom, plain_utf8_atom; /* text/plain 系 target（GNOME/GTK 兼容） */
    uint8_t *own_text;               /* 我们作为 owner 提供的内容 */
    size_t own_len;
    int64_t last_own_attempt_ms; /* owner 自动恢复限流（毫秒） */
    int64_t last_read_ms;        /* 剪贴板读取限流（毫秒） */
    pthread_mutex_t lock;
} clip_ctx;

/* 剪贴板共享（clip.c）：XFixes 监听 + XConvertSelection 读取 / owner 响应 */
void clip_init(struct runtime *rt, int event_base);                 /* capture 线程初始化 */
void clip_check(struct runtime *rt);                                /* capture 线程轮询变化 */
void clip_read_push(struct runtime *rt);                            /* 锁外读取剪贴板并推送 */
void clip_set(struct runtime *rt, const uint8_t *text, size_t len); /* 前端→X11 */
