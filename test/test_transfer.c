/* 单元测试：文件传输工具函数（URL 解码 / query 解析 / home 路径权限） */
#include "../src/util.h"

#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <pwd.h>

static int g_failures = 0;
#define CHECK(cond)                                                         \
    do                                                                      \
    {                                                                       \
        if (!(cond))                                                        \
        {                                                                   \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            g_failures++;                                                   \
        }                                                                   \
    } while (0)

static void test_url_decode(void)
{
    char out[128];
    CHECK(util_url_decode("a%20b", out, sizeof out) == 1);
    CHECK(strcmp(out, "a b") == 0);
    CHECK(util_url_decode("a+b", out, sizeof out) == 1);
    CHECK(strcmp(out, "a b") == 0);
    /* 中文 UTF-8（%E4%B8%AD = 中） */
    CHECK(util_url_decode("%E4%B8%AD%E6%96%87", out, sizeof out) == 1);
    CHECK(strcmp(out, "中文") == 0);
    CHECK(util_url_decode("plain", out, sizeof out) == 1);
    CHECK(strcmp(out, "plain") == 0);
    /* 非法 %zz：原样保留 */
    CHECK(util_url_decode("a%zz", out, sizeof out) == 1);
    CHECK(strcmp(out, "a%zz") == 0);
    /* 空输入 */
    CHECK(util_url_decode("", out, sizeof out) == 0);
}

static void test_query_get(void)
{
    char out[128];
    /* 多参数 + URL 编码值 */
    CHECK(util_query_get("token=abc&path=%2Fhome%2Ftest%2Fa%20b.txt&offset=0",
                         "token", out, sizeof out) == 1);
    CHECK(strcmp(out, "abc") == 0);
    CHECK(util_query_get("token=abc&path=%2Fhome%2Ftest%2Fa%20b.txt&offset=0",
                         "path", out, sizeof out) == 1);
    CHECK(strcmp(out, "/home/test/a b.txt") == 0);
    CHECK(util_query_get("token=abc&path=x&offset=0",
                         "offset", out, sizeof out) == 1);
    CHECK(strcmp(out, "0") == 0);
    /* 缺失键 */
    CHECK(util_query_get("token=abc", "path", out, sizeof out) == 0);
    /* 空 query */
    CHECK(util_query_get("", "a", out, sizeof out) == 0);
    /* 键前缀不应误匹配（tokenx=1 不是 token，应取后面的 token=2） */
    CHECK(util_query_get("tokenx=1&token=2", "token", out, sizeof out) == 1);
    CHECK(strcmp(out, "2") == 0);
}

static void test_path_in_user_home(void)
{
    struct passwd *pw = getpwuid(getuid());
    if (!pw)
        return; /* 无 passwd 条目则跳过 */
    char resolved[4096];
    char buf[4096];

    /* 合法：home 本身（真实存在）应通过 */
    snprintf(buf, sizeof buf, "%s", pw->pw_dir);
    CHECK(util_path_in_user_home(pw->pw_name, buf, resolved, sizeof resolved) == 1);

    /* 前缀边界：/home/test2 不算 /home/test 内 */
    snprintf(buf, sizeof buf, "%s2/x", pw->pw_dir);
    CHECK(util_path_in_user_home(pw->pw_name, buf, resolved, sizeof resolved) == 0);

    /* 不在 home 内 */
    CHECK(util_path_in_user_home(pw->pw_name, "/etc/passwd", resolved, sizeof resolved) == 0);

    /* 符号链接/穿越逃逸：home/../etc/passwd realpath 后不在 home 内 */
    snprintf(buf, sizeof buf, "%s/../etc/passwd", pw->pw_dir);
    CHECK(util_path_in_user_home(pw->pw_name, buf, resolved, sizeof resolved) == 0);

    /* 相对路径拒绝 */
    CHECK(util_path_in_user_home(pw->pw_name, "relative/path", resolved, sizeof resolved) == 0);

    /* 空用户 / 空路径 */
    CHECK(util_path_in_user_home("", pw->pw_dir, resolved, sizeof resolved) == 0);
    CHECK(util_path_in_user_home(pw->pw_name, "", resolved, sizeof resolved) == 0);
    CHECK(util_path_in_user_home(NULL, pw->pw_dir, resolved, sizeof resolved) == 0);
}

int main(void)
{
    test_url_decode();
    test_query_get();
    test_path_in_user_home();
    if (g_failures)
    {
        fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    printf("transfer util tests OK\n");
    return 0;
}
