/* 单元测试：SHA-1 / Base64 / hex / 协议 u16 编解码 */
#include "../src/util.h"

#include <stdio.h>
#include <string.h>

static int g_failures = 0;
#define CHECK(cond)                                                        \
    do                                                                     \
    {                                                                      \
        if (!(cond))                                                       \
        {                                                                  \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            g_failures++;                                                  \
        }                                                                  \
    } while (0)

static void test_sha1(void)
{
    uint8_t out[20], out2[20];
    sha1_ctx c;

    sha1_init(&c);
    sha1_update(&c, "abc", 3);
    sha1_final(&c, out);
    static const uint8_t abc[20] = {
        0xa9, 0x99, 0x3e, 0x36, 0x47, 0x06, 0x81, 0x6a, 0xba, 0x3e,
        0x25, 0x71, 0x78, 0x50, 0xc2, 0x6c, 0x9c, 0xd0, 0xd8, 0x9d};
    CHECK(memcmp(out, abc, 20) == 0);

    sha1_init(&c);
    sha1_update(&c, "The quick brown fox jumps over the lazy dog", 43);
    sha1_final(&c, out);
    static const uint8_t fox[20] = {
        0x2f, 0xd4, 0xe1, 0xc6, 0x7a, 0x2d, 0x28, 0xfc, 0xed, 0x84,
        0x9e, 0xe1, 0xbb, 0x76, 0xe7, 0x39, 0x1b, 0x93, 0xeb, 0x12};
    CHECK(memcmp(out, fox, 20) == 0);

    /* 逐字节 update 与整块 update 结果一致（跨 64 字节块边界） */
    char big[1000];
    memset(big, 'a', sizeof big);
    sha1_init(&c);
    for (size_t i = 0; i < sizeof big; i++)
        sha1_update(&c, big + i, 1);
    sha1_final(&c, out);
    sha1_init(&c);
    sha1_update(&c, big, sizeof big);
    sha1_final(&c, out2);
    CHECK(memcmp(out, out2, 20) == 0);
}

static void test_b64(void)
{
    char out[64];

    b64_encode((const uint8_t *)"", 0, out, sizeof out);
    CHECK(out[0] == 0);
    b64_encode((const uint8_t *)"abc", 3, out, sizeof out);
    CHECK(strcmp(out, "YWJj") == 0);
    b64_encode((const uint8_t *)"abcd", 4, out, sizeof out);
    CHECK(strcmp(out, "YWJjZA==") == 0);
    b64_encode((const uint8_t *)"Hello, World!", 13, out, sizeof out);
    CHECK(strcmp(out, "SGVsbG8sIFdvcmxkIQ==") == 0);
}

static void test_hex(void)
{
    const uint8_t in[] = {0xde, 0xad, 0xbe, 0xef, 0x01};
    char out[32];
    hex_encode(in, sizeof in, out, sizeof out);
    CHECK(strcmp(out, "deadbeef01") == 0);
}

static void test_u16(void)
{
    uint8_t b[2];
    wr_u16(b, 0x1234);
    CHECK(b[0] == 0x34 && b[1] == 0x12);
    CHECK(rd_u16(b) == 0x1234);
    wr_u16(b, 0);
    CHECK(rd_u16(b) == 0);
    wr_u16(b, 0xffff);
    CHECK(rd_u16(b) == 0xffff);
}

int main(void)
{
    test_sha1();
    test_b64();
    test_hex();
    test_u16();
    if (g_failures)
    {
        fprintf(stderr, "test_util: %d failure(s)\n", g_failures);
        return 1;
    }
    printf("test_util: ok\n");
    return 0;
}
