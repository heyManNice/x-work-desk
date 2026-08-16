#pragma once
#include "session.h"

/* 会话表：按用户名管理桌面会话（sess_table.c） */

runtime *session_lookup(const char *user);
void session_register(runtime *rt, const char *user);
void session_unregister(runtime *rt);
void session_sweep(void);
void session_shutdown_all(void);
int session_gone(runtime *rt); /* 会话桌面进程是否已退出（登录前清理用） */
