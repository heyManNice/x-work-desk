#include "util.h"
#include <time.h>
#include <pwd.h>
#include <unistd.h>

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

/* ---------------- URL/查询/路径工具（文件传输用，纯逻辑可单测） ---------------- */
static int util_hexv(int ch)
{
    if (ch >= '0' && ch <= '9')
        return ch - '0';
    if (ch >= 'a' && ch <= 'f')
        return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F')
        return ch - 'A' + 10;
    return -1;
}

int util_url_decode(const char *in, char *out, size_t outn)
{
    size_t o = 0;
    for (const char *p = in; *p && o + 1 < outn; p++)
    {
        if (*p == '%' && util_hexv(p[1]) >= 0 && util_hexv(p[2]) >= 0)
        {
            out[o++] = (char)((util_hexv(p[1]) << 4) | util_hexv(p[2]));
            p += 2;
        }
        else if (*p == '+')
            out[o++] = ' ';
        else
            out[o++] = *p;
    }
    out[o] = 0;
    return o > 0;
}

int util_query_get(const char *q, const char *key, char *out, size_t outn)
{
    const char *p = q;
    size_t kl = strlen(key);
    while (*p)
    {
        const char *amp = strchr(p, '&');
        size_t seg = amp ? (size_t)(amp - p) : strlen(p);
        if (seg > kl && !strncmp(p, key, kl) && p[kl] == '=')
        {
            size_t vl = seg - kl - 1;
            char tmp[2048];
            size_t tl = vl < sizeof tmp - 1 ? vl : sizeof tmp - 1;
            memcpy(tmp, p + kl + 1, tl);
            tmp[tl] = 0;
            return util_url_decode(tmp, out, outn);
        }
        if (!amp)
            break;
        p = amp + 1;
    }
    return 0;
}

int util_path_in_user_home(const char *user, const char *path,
                           char *resolved, size_t resolved_n)
{
    if (!user || !user[0] || !path || path[0] != '/')
        return 0;
    struct passwd *pw = getpwnam(user);
    if (!pw)
        return 0;
    size_t hl = strlen(pw->pw_dir);
    if (strncmp(path, pw->pw_dir, hl) != 0)
        return 0;
    if (path[hl] != '/' && path[hl] != 0)
        return 0; /* 前缀边界（/home/test2 不算 /home/test 内） */

    if (!realpath(path, resolved))
        return 0;
    if (strncmp(resolved, pw->pw_dir, hl) != 0)
        return 0;
    if (resolved[hl] != '/' && resolved[hl] != 0)
        return 0;
    return 1;
}

void util_gen_token(char *out, size_t n)
{
    unsigned char r[16];
    size_t rd = 0;
    FILE *f = fopen("/dev/urandom", "rb");
    if (f)
    {
        rd = fread(r, 1, sizeof r, f);
        fclose(f);
    }
    if (rd != sizeof r)
    {
        /* 降级：时间 + pid 混合 */
        uint64_t t = (uint64_t)time(NULL) ^ ((uint64_t)getpid() << 32) ^ (uint64_t)monotonic_ms();
        for (int i = 0; i < 16; i++)
            r[i] = (unsigned char)(t >> (8 * (i % 8)));
    }
    if (n < 33)
        return;
    static const char hex[] = "0123456789abcdef";
    for (int i = 0; i < 16; i++)
    {
        out[i * 2] = hex[r[i] >> 4];
        out[i * 2 + 1] = hex[r[i] & 15];
    }
    out[32] = 0;
}
