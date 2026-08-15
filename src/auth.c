#include "auth.h"
#include "util.h"
#include <shadow.h>
#include <crypt.h>
#include <string.h>
#include <stdio.h>
#include <pwd.h>

static int g_mode = AUTH_SHADOW;

void auth_init(int mode)
{
    g_mode = mode;
}

/* 返回 0 = 成功 */
int auth_check(const char *user, const char *pass)
{
    if (!user || !pass || !user[0] || !pass[0])
        return -1;

    if (g_mode == AUTH_NONE)
    {
        /* 开发模式：接受任意凭据（供无 root 环境测试） */
        log_info("[auth:none] 接受登录 %s", user);
        return 0;
    }

    /* shadow 模式：需要以 root 运行才能读取 /etc/shadow */
    struct spwd *sp = getspnam(user);
    if (!sp)
    {
        log_info("无 shadow 条目: %s", user);
        return -1;
    }
    if (!sp->sp_pwdp || !sp->sp_pwdp[0] || sp->sp_pwdp[0] == '!' || sp->sp_pwdp[0] == '*')
    {
        log_info("账户已锁定: %s", user);
        return -1;
    }
    char *cr = crypt(pass, sp->sp_pwdp);
    if (!cr)
    {
        log_err("crypt() 失败");
        return -1;
    }
    int ok = strcmp(cr, sp->sp_pwdp) == 0;
    if (ok)
        log_info("认证成功: %s", user);
    else
        log_info("认证失败: %s", user);
    return ok ? 0 : -1;
}
