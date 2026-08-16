#pragma once

/* 会话表：按用户名管理桌面会话（sess_table.c） */

struct runtime;

/* 按用户名查找会话并返回一个已持有的引用（调用方必须 runtime_unref）；
 * 未找到返回 NULL。持有引用可防止 session_sweep 并发释放。 */
struct runtime *session_lookup(const char *user);
void session_register(struct runtime *rt, const char *user);
void session_unregister(struct runtime *rt);
void session_sweep(void);
void session_shutdown_all(void);
int session_gone(struct runtime *rt); /* 会话桌面进程是否已退出（登录前清理用） */
