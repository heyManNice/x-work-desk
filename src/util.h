#pragma once
#include <stddef.h>
#include <stdint.h>

void log_info(const char *fmt, ...);
void log_err(const char *fmt, ...);

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
