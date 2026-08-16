/* 单元测试：WebSocket 帧解析状态机（ws_parser） */
#include "../src/ws_parser.h"

#include <stdio.h>
#include <stdlib.h>
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

static const uint8_t g_mask[4] = {0x11, 0x22, 0x33, 0x44};

/* 构造单帧（支持 126/127 长度编码与客户端掩码） */
static size_t make_frame(uint8_t *out, int opcode, int fin,
                         const uint8_t *payload, size_t len, int masked)
{
    size_t o = 0;
    out[o++] = (uint8_t)((fin ? 0x80 : 0) | opcode);
    if (len < 126)
        out[o++] = (uint8_t)(len | (masked ? 0x80 : 0));
    else if (len <= 0xffff)
    {
        out[o++] = (uint8_t)(126 | (masked ? 0x80 : 0));
        out[o++] = (uint8_t)(len >> 8);
        out[o++] = (uint8_t)(len & 0xff);
    }
    else
    {
        out[o++] = (uint8_t)(127 | (masked ? 0x80 : 0));
        for (int i = 0; i < 8; i++)
            out[o++] = (uint8_t)((uint64_t)len >> (8 * (7 - i)));
    }
    if (masked)
    {
        memcpy(out + o, g_mask, 4);
        o += 4;
    }
    for (size_t i = 0; i < len; i++)
    {
        uint8_t b = payload ? payload[i] : 0;
        out[o++] = masked ? (uint8_t)(b ^ g_mask[i & 3]) : b;
    }
    return o;
}

/* 反复 feed 直到输入耗尽；返回最后一次事件 */
static int feed_all(ws_parser *p, const uint8_t *buf, size_t len,
                    int *ev, const uint8_t **payload, size_t *plen)
{
    int n = 0;
    do
    {
        n = ws_parser_feed(p, buf, len, ev, payload, plen);
        if (n <= 0)
            break;
        buf += (size_t)n;
        len -= (size_t)n;
    } while (len > 0);
    return n;
}

static void test_simple_binary(void)
{
    ws_parser p;
    ws_parser_init(&p, 1024);
    uint8_t frame[64];
    const char *msg = "hello";
    size_t n = make_frame(frame, 0x2, 1, (const uint8_t *)msg, 5, 0);

    int ev;
    const uint8_t *payload;
    size_t plen;
    CHECK(feed_all(&p, frame, n, &ev, &payload, &plen) > 0);
    CHECK(ev == WS_EV_BINARY);
    CHECK(plen == 5 && memcmp(payload, msg, 5) == 0);

    ws_parser_destroy(&p);
}

static void test_masked_binary(void)
{
    ws_parser p;
    ws_parser_init(&p, 1024);
    uint8_t frame[64];
    const char *msg = "masked!";
    size_t n = make_frame(frame, 0x2, 1, (const uint8_t *)msg, 7, 1);

    int ev;
    const uint8_t *payload;
    size_t plen;
    CHECK(feed_all(&p, frame, n, &ev, &payload, &plen) > 0);
    CHECK(ev == WS_EV_BINARY);
    CHECK(plen == 7 && memcmp(payload, msg, 7) == 0);

    ws_parser_destroy(&p);
}

static void test_fragmented(void)
{
    ws_parser p;
    ws_parser_init(&p, 1024);
    uint8_t f1[32], f2[32];
    size_t n1 = make_frame(f1, 0x2, 0, (const uint8_t *)"Hel", 3, 0);
    size_t n2 = make_frame(f2, 0x0, 1, (const uint8_t *)"lo!", 3, 0);

    int ev;
    const uint8_t *payload;
    size_t plen;
    uint8_t buf[64];
    memcpy(buf, f1, n1);
    memcpy(buf + n1, f2, n2);
    CHECK(feed_all(&p, buf, n1 + n2, &ev, &payload, &plen) > 0);
    CHECK(ev == WS_EV_BINARY);
    CHECK(plen == 6 && memcmp(payload, "Hello!", 6) == 0);

    ws_parser_destroy(&p);
}

static void test_long_lengths(void)
{
    ws_parser p;
    ws_parser_init(&p, 4096);
    uint8_t *frame = malloc(400 + 16);
    size_t len = make_frame(frame, 0x2, 1, NULL, 300, 0); /* 126 编码 */

    int ev;
    const uint8_t *payload;
    size_t plen;
    CHECK(feed_all(&p, frame, len, &ev, &payload, &plen) > 0);
    CHECK(ev == WS_EV_BINARY && plen == 300);
    ws_parser_destroy(&p);

    ws_parser_init(&p, 200000);
    frame = realloc(frame, 70000 + 16);
    len = make_frame(frame, 0x2, 1, NULL, 70000, 0); /* 127 编码 */
    CHECK(feed_all(&p, frame, len, &ev, &payload, &plen) > 0);
    CHECK(ev == WS_EV_BINARY && plen == 70000);
    ws_parser_destroy(&p);
    free(frame);
}

static void test_control_and_close(void)
{
    ws_parser p;
    ws_parser_init(&p, 1024);
    uint8_t frame[32];
    size_t n = make_frame(frame, 0x9, 1, NULL, 0, 0);

    int ev;
    const uint8_t *payload;
    size_t plen;
    CHECK(feed_all(&p, frame, n, &ev, &payload, &plen) > 0);
    CHECK(ev == WS_EV_PING);

    n = make_frame(frame, 0x8, 1, NULL, 0, 0);
    CHECK(feed_all(&p, frame, n, &ev, &payload, &plen) > 0);
    CHECK(ev == WS_EV_CLOSE);

    ws_parser_destroy(&p);
}

static void test_incremental(void)
{
    ws_parser p;
    ws_parser_init(&p, 1024);
    uint8_t frame[64];
    const char *msg = "slow";
    size_t n = make_frame(frame, 0x2, 1, (const uint8_t *)msg, 4, 0);

    int ev = WS_EV_NONE;
    const uint8_t *payload = NULL;
    size_t plen = 0;
    for (size_t i = 0; i < n; i++)
    {
        CHECK(ws_parser_feed(&p, frame + i, 1, &ev, &payload, &plen) >= 0);
        if (i + 1 < n)
            CHECK(ev == WS_EV_NONE); /* 未到最后一字节不应出事件 */
    }
    CHECK(ev == WS_EV_BINARY && plen == 4);

    ws_parser_destroy(&p);
}

static void test_oversize(void)
{
    ws_parser p;
    ws_parser_init(&p, 16);
    uint8_t frame[64];
    size_t n = make_frame(frame, 0x2, 1, NULL, 17, 0);

    int ev;
    const uint8_t *payload;
    size_t plen;
    CHECK(ws_parser_feed(&p, frame, n, &ev, &payload, &plen) == -1);

    ws_parser_destroy(&p);
}

static void test_two_messages(void)
{
    ws_parser p;
    ws_parser_init(&p, 1024);
    uint8_t f1[32], f2[32];
    size_t n1 = make_frame(f1, 0x2, 1, (const uint8_t *)"one", 3, 0);
    size_t n2 = make_frame(f2, 0x2, 1, (const uint8_t *)"two", 3, 0);
    uint8_t buf[64];
    memcpy(buf, f1, n1);
    memcpy(buf + n1, f2, n2);

    int ev;
    const uint8_t *payload;
    size_t plen;
    size_t off = 0;
    CHECK(ws_parser_feed(&p, buf, n1 + n2, &ev, &payload, &plen) == (int)n1);
    CHECK(ev == WS_EV_BINARY && plen == 3 && memcmp(payload, "one", 3) == 0);
    off += n1;
    CHECK(ws_parser_feed(&p, buf + off, n2, &ev, &payload, &plen) == (int)n2);
    CHECK(ev == WS_EV_BINARY && plen == 3 && memcmp(payload, "two", 3) == 0);

    ws_parser_destroy(&p);
}

int main(void)
{
    test_simple_binary();
    test_masked_binary();
    test_fragmented();
    test_long_lengths();
    test_control_and_close();
    test_incremental();
    test_oversize();
    test_two_messages();
    if (g_failures)
    {
        fprintf(stderr, "test_ws: %d failure(s)\n", g_failures);
        return 1;
    }
    printf("test_ws: ok\n");
    return 0;
}
