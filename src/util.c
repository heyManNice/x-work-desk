#include "util.h"
#include <time.h>

int64_t monotonic_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <time.h>

void log_info(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    time_t t = time(NULL);
    struct tm tm;
    localtime_r(&t, &tm);
    char ts[32];
    strftime(ts, sizeof ts, "%H:%M:%S", &tm);
    fprintf(stdout, "[%s] ", ts);
    vfprintf(stdout, fmt, ap);
    fprintf(stdout, "\n");
    fflush(stdout);
    va_end(ap);
}

void log_err(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    time_t t = time(NULL);
    struct tm tm;
    localtime_r(&t, &tm);
    char ts[32];
    strftime(ts, sizeof ts, "%H:%M:%S", &tm);
    fprintf(stderr, "[%s] ", ts);
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    fflush(stderr);
    va_end(ap);
}

void hex_encode(const uint8_t *in, size_t inlen, char *out, size_t outsz)
{
    static const char hc[] = "0123456789abcdef";
    size_t o = 0;
    for (size_t i = 0; i < inlen; i++)
    {
        if (o + 2 >= outsz)
            break;
        out[o++] = hc[in[i] >> 4];
        out[o++] = hc[in[i] & 15];
    }
    out[o] = 0;
}

/* ---------------- SHA-1 ---------------- */
static void sha1_transform(uint32_t state[5], const uint8_t block[64])
{
    uint32_t w[80];
    for (int i = 0; i < 16; i++)
        w[i] = ((uint32_t)block[i * 4] << 24) | ((uint32_t)block[i * 4 + 1] << 16) |
               ((uint32_t)block[i * 4 + 2] << 8) | block[i * 4 + 3];
    for (int i = 16; i < 80; i++)
    {
        uint32_t v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = (v << 1) | (v >> 31);
    }
    uint32_t a = state[0], b = state[1], c = state[2], d = state[3], e = state[4];
    for (int i = 0; i < 80; i++)
    {
        uint32_t f, k;
        if (i < 20)
        {
            f = (b & c) | ((~b) & d);
            k = 0x5A827999u;
        }
        else if (i < 40)
        {
            f = b ^ c ^ d;
            k = 0x6ED9EBA1u;
        }
        else if (i < 60)
        {
            f = (b & c) | (b & d) | (c & d);
            k = 0x8F1BBCDCu;
        }
        else
        {
            f = b ^ c ^ d;
            k = 0xCA62C1D6u;
        }
        uint32_t tmp = ((a << 5) | (a >> 27)) + f + e + k + w[i];
        e = d;
        d = c;
        c = (b << 30) | (b >> 2);
        b = a;
        a = tmp;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
}

void sha1_init(sha1_ctx *c)
{
    c->h[0] = 0x67452301u;
    c->h[1] = 0xEFCDAB89u;
    c->h[2] = 0x98BADCFEu;
    c->h[3] = 0x10325476u;
    c->h[4] = 0xC3D2E1F0u;
    c->len = 0;
    c->buflen = 0;
}

void sha1_update(sha1_ctx *c, const void *data, size_t len)
{
    const uint8_t *p = data;
    c->len += len;
    while (len)
    {
        size_t take = 64 - c->buflen;
        if (take > len)
            take = len;
        memcpy(c->buf + c->buflen, p, take);
        c->buflen += take;
        p += take;
        len -= take;
        if (c->buflen == 64)
        {
            sha1_transform(c->h, c->buf);
            c->buflen = 0;
        }
    }
}

void sha1_final(sha1_ctx *c, uint8_t out[20])
{
    uint64_t bits = c->len * 8;
    uint8_t pad = 0x80;
    sha1_update(c, &pad, 1);
    uint8_t zero = 0;
    while (c->buflen != 56)
        sha1_update(c, &zero, 1);
    uint8_t blen[8];
    for (int i = 0; i < 8; i++)
        blen[i] = (uint8_t)(bits >> (8 * (7 - i)));
    sha1_update(c, blen, 8);
    for (int i = 0; i < 5; i++)
    {
        out[i * 4] = (c->h[i] >> 24) & 0xff;
        out[i * 4 + 1] = (c->h[i] >> 16) & 0xff;
        out[i * 4 + 2] = (c->h[i] >> 8) & 0xff;
        out[i * 4 + 3] = c->h[i] & 0xff;
    }
}

/* ---------------- Base64 ---------------- */
size_t b64_encode(const uint8_t *in, size_t inlen, char *out, size_t outsz)
{
    static const char b64c[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t o = 0;
    for (size_t i = 0; i < inlen; i += 3)
    {
        uint32_t v = (uint32_t)in[i] << 16;
        if (i + 1 < inlen)
            v |= (uint32_t)in[i + 1] << 8;
        if (i + 2 < inlen)
            v |= in[i + 2];
        if (o + 4 >= outsz)
            break;
        out[o++] = b64c[(v >> 18) & 63];
        out[o++] = b64c[(v >> 12) & 63];
        out[o++] = (i + 1 < inlen) ? b64c[(v >> 6) & 63] : '=';
        out[o++] = (i + 2 < inlen) ? b64c[v & 63] : '=';
    }
    out[o] = 0;
    return o;
}
