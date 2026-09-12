#pragma once
#include <stddef.h>
#include <stdint.h>

void log_info(const char *fmt, ...);
void log_err(const char *fmt, ...);

/* 单调时钟毫秒（CLOCK_MONOTONIC，不受系统时间调整影响） */
int64_t monotonic_ms(void);

void hex_encode(const uint8_t *in, size_t inlen, char *out, size_t outsz);

/* 协议小端 u16 打包/解包 */
static inline void wr_u16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v & 0xff);
    p[1] = (uint8_t)((v >> 8) & 0xff);
}

static inline uint16_t rd_u16(const uint8_t *p)
{
    return (uint16_t)(p[0] | ((uint16_t)p[1] << 8));
}

/* SHA-1 (RFC 3174) —— 用于 WebSocket 握手 */
typedef struct
{
    uint32_t h[5];
    uint64_t len;
    uint8_t buf[64];
    size_t buflen;
} sha1_ctx;

void sha1_init(sha1_ctx *c);
void sha1_update(sha1_ctx *c, const void *data, size_t len);
void sha1_final(sha1_ctx *c, uint8_t out[20]);

/* Base64 */
size_t b64_encode(const uint8_t *in, size_t inlen, char *out, size_t outsz);

/* URL 解码（%xx -> 字节，+ -> 空格）；有内容成功返回 1 */
int util_url_decode(const char *in, char *out, size_t outn);

/* 从 query string 提取参数：q="a=1&b=2"。命中返回 1。 */
int util_query_get(const char *q, const char *key, char *out, size_t outn);

/* 生成 32 字符十六进制随机 token（/api/local/ 鉴权用），写入 out（需 ≥33 字节） */
void util_gen_token(char *out, size_t n);
