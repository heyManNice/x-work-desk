#pragma once
#include "session.h"

/* 剪贴板共享（clip.c）：XFixes 监听 + xclip 桥接 */
void clip_init(runtime *rt, int event_base); /* capture 线程初始化 */
void clip_check(runtime *rt);                /* capture 线程轮询变化 */
void clip_read_push(runtime *rt);            /* 锁外读取剪贴板并推送 */
void clip_set(runtime *rt, const uint8_t *text, size_t len); /* 前端→X11 */
