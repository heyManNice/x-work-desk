/* 单元测试：HTTP 查询串工具（URL 解码 / query 解析）——供 /api/local/ 接口使用 */
#include "../src/util.h"

#include <stdio.h>
#include <string.h>

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

int main(void)
{
    test_url_decode();
    test_query_get();
    if (g_failures)
    {
        fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    printf("http query util tests OK\n");
    return 0;
}
