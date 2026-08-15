#pragma once
#define AUTH_SHADOW 0
#define AUTH_NONE 1

void auth_init(int mode);
/* 返回 0 表示认证成功 */
int auth_check(const char *user, const char *pass);
