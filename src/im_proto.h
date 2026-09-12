#pragma once

/* im_proto.h —— xworkd ↔ 输入法中继引擎 的会话内通道协议（AF_UNIX）
 *
 * 为什么单独一个头：这条通道的两端在两个进程里（xworkd 与 xworkd-im），
 * 但它们在同一次构建中，用同一份定义可以避免两端各写一套常量而错位。
 *
 * 帧格式：type(1) + len(2, LE) + payload(len)
 *   · len 是 payload 长度，不含 3 字节头；单帧 payload ≤ IM_PAYLOAD_MAX
 *   · 文本一律 UTF-8，且两端都必须校验（不可信输入：客户端 → xworkd → 引擎）
 *
 * 方向约定：
 *   引擎 → xworkd   CARET / FOCUS / STATE   （状态上报，丢了不影响正确性）
 *   xworkd → 引擎   PREEDIT / COMMIT / RESET（用户输入，不能丢）
 *
 * 设计文档见 docs/input-method-local.md §5.1。
 */

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define IM_HEADER_LEN 3
#define IM_PAYLOAD_MAX 1024

/* ---- 引擎 → xworkd ---- */

/* CARET：应用上报的插入点矩形（屏幕坐标），i16 × 4（x, y, w, h） */
#define IM_MSG_CARET 0x01
/* FOCUS：远端输入焦点变化，u8（1 = 有焦点） */
#define IM_MSG_FOCUS 0x02
/* STATE：引擎自身状态，u8（IM_STATE_*） */
#define IM_MSG_STATE 0x03

/* STATE 取值 */
#define IM_STATE_READY 0    /* 引擎已就绪/成为当前引擎 */
#define IM_STATE_DISABLED 1 /* 引擎被用户或系统切走（客户端应提示并考虑切回） */
#define IM_STATE_ABSENT 2   /* 通道上没有引擎（未安装/未激活/已退出）——xworkd 自己产生 */

/* 仅供 xworkd 内部回调使用（**不是**通道上的帧类型）：引擎接入/断开。
 * 放在这里是为了让上层用同一个回调入口拿到"引擎生命周期"，不必再拉一个钩子。 */
#define IM_EV_ENGINE_UP 0x80
#define IM_EV_ENGINE_DOWN 0x81
/* ---- xworkd → 引擎 ---- */

/* PREEDIT：u16(LE) preedit 内光标位置 + UTF-8 文本；文本为空 = 收起 preedit */
#define IM_MSG_PREEDIT 0x11
/* COMMIT：UTF-8 文本（直接交给应用） */
#define IM_MSG_COMMIT 0x12
/* RESET：无 payload，丢弃当前组合 */
#define IM_MSG_RESET 0x13

/* ---- 编解码小工具 ---- */

static inline void im_put_u16le(unsigned char *p, unsigned v)
{
    p[0] = (unsigned char)(v & 0xff);
    p[1] = (unsigned char)((v >> 8) & 0xff);
}

static inline unsigned im_get_u16le(const unsigned char *p)
{
    return (unsigned)p[0] | ((unsigned)p[1] << 8);
}

/* i16 钳制：坐标可能为负（多显示器左侧），也可能超出抓取区域 */
static inline int im_clampi16(int v)
{
    if (v < -32768L)
    {
        return -32768;
    }
    if (v > 32767L)
    {
        return 32767;
    }
    return v;
}

/* 把一帧编码进 out（cap 至少 IM_HEADER_LEN + IM_PAYLOAD_MAX）。
 * 返回帧长；payload 超限或缓冲不足时返回 0（调用方负责决定丢弃还是截断）。 */
static inline size_t im_frame_encode(unsigned char *out, size_t cap, unsigned char type,
                                     const void *payload, size_t len)
{
    if (len > IM_PAYLOAD_MAX || cap < IM_HEADER_LEN + len)
    {
        return 0;
    }
    out[0] = type;
    im_put_u16le(out + 1, (unsigned)len);
    if (len > 0)
    {
        memcpy(out + IM_HEADER_LEN, payload, len);
    }
    return IM_HEADER_LEN + len;
}

static inline size_t im_frame_encode_u8(unsigned char *out, size_t cap, unsigned char type,
                                        unsigned char value)
{
    return im_frame_encode(out, cap, type, &value, 1);
}

static inline size_t im_frame_encode_caret(unsigned char *out, size_t cap, int x, int y, int w,
                                           int h)
{
    unsigned char p[8];
    im_put_u16le(p + 0, (unsigned)im_clampi16(x));
    im_put_u16le(p + 2, (unsigned)im_clampi16(y));
    im_put_u16le(p + 4, (unsigned)im_clampi16(w));
    im_put_u16le(p + 6, (unsigned)im_clampi16(h));
    return im_frame_encode(out, cap, IM_MSG_CARET, p, sizeof p);
}
/* UTF-8 合法性校验（客户端送来的文本**不可信**，转发前必须验）。
 * 与 _validator 的差别：这里拒绝过长编码、逾界码点与代理对。 */
static inline int im_utf8_valid(const char *s, size_t len)
{
    const unsigned char *p = (const unsigned char *)s;
    size_t i = 0;

    while (i < len)
    {
        unsigned c = p[i];
        size_t need;
        unsigned cp;

        if (c < 0x80)
        {
            i++;
            continue;
        }
        if ((c & 0xe0) == 0xc0)
        {
            need = 1;
            cp = c & 0x1f;
            if (cp < 2)
                return 0; /* 过长编码 */
        }
        else if ((c & 0xf0) == 0xe0)
        {
            need = 2;
            cp = c & 0x0f;
        }
        else if ((c & 0xf8) == 0xf0)
        {
            need = 3;
            cp = c & 0x07;
            if (cp > 4)
                return 0; /* 超出 Unicode 范围 */
        }
        else
        {
            return 0; /* 非法首字节 */
        }
        if (i + need >= len)
            return 0; /* 截断的序列 */
        for (size_t k = 1; k <= need; k++)
        {
            if ((p[i + k] & 0xc0) != 0x80)
                return 0;
            cp = (cp << 6) | (p[i + k] & 0x3f);
        }
        if ((need == 2 && cp < 0x800) || (need == 3 && cp < 0x10000))
            return 0; /* 过长编码 */
        if (cp > 0x10ffff)
            return 0; /* 超出 Unicode 范围（如 f4 90 80 80） */
        if (cp >= 0xd800 && cp <= 0xdfff)
            return 0; /* 代理对不能出现在 UTF-8 里 */
        i += need + 1;
    }
    return 1;
}
/* 按 UTF-8 边界截断到 ≤ limit 字节（绝不产生半个字符），返回可用长度 */
static inline size_t im_utf8_clip(const char *text, size_t limit)
{
    size_t len = text ? strlen(text) : 0;

    if (len <= limit)
    {
        return len;
    }
    len = limit;
    while (len > 0 && ((unsigned char)text[len] & 0xc0) == 0x80)
    {
        len--;
    }
    return len;
}

/* 文本帧（COMMIT）。过长时按 UTF-8 边界截断，绝不产生半个字符。 */
static inline size_t im_frame_encode_text(unsigned char *out, size_t cap, unsigned char type,
                                          const char *text)
{
    size_t len = im_utf8_clip(text, IM_PAYLOAD_MAX);
    return im_frame_encode(out, cap, type, text, len);
}

/* 从缓冲里解出一帧（引擎 → xworkd 方向；xworkd 侧用它做解析）。
 * 返回 1 = 解出一帧（已填 type/payload/plen/consumed）；
 * 返回 0 = 数据还不够（等下次可读）；
 * 返回 -1 = 协议非法（声明长度超限），调用方应断开重连而不是继续解析。 */
static inline int im_frame_decode(const unsigned char *buf, size_t len, unsigned char *type,
                                  const unsigned char **payload, size_t *plen, size_t *consumed)
{
    unsigned n;

    if (len < IM_HEADER_LEN)
    {
        return 0;
    }
    n = im_get_u16le(buf + 1);
    if (n > IM_PAYLOAD_MAX)
    {
        return -1;
    }
    if (len < IM_HEADER_LEN + (size_t)n)
    {
        return 0;
    }
    if (type != NULL)
    {
        *type = buf[0];
    }
    if (payload != NULL)
    {
        *payload = buf + IM_HEADER_LEN;
    }
    if (plen != NULL)
    {
        *plen = n;
    }
    if (consumed != NULL)
    {
        *consumed = IM_HEADER_LEN + (size_t)n;
    }
    return 1;
}

/* PREEDIT 帧：u16 pos + 文本 */
static inline size_t im_frame_encode_preedit(unsigned char *out, size_t cap, unsigned pos,
                                             const char *text)
{
    size_t len;

    if (cap < IM_HEADER_LEN + IM_PAYLOAD_MAX)
    {
        return 0;
    }
    len = im_utf8_clip(text, IM_PAYLOAD_MAX - 2);
    im_put_u16le(out + IM_HEADER_LEN, pos);
    if (len > 0)
    {
        memcpy(out + IM_HEADER_LEN + 2, text, len);
    }
    out[0] = IM_MSG_PREEDIT;
    im_put_u16le(out + 1, (unsigned)(len + 2));
    return IM_HEADER_LEN + 2 + len;
}
