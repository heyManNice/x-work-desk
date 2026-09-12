#pragma once

/* im.h —— 每会话的「输入法中继通道」（xworkd ↔ 会话内的 xworkd-im 引擎）
 *
 * 分工（见 docs/input-method-local.md §3/§4）：
 *   · 本模块只负责这条 AF_UNIX 通道本身：建 socket、收引擎连接、收发帧。
 *   · 引擎由 ibus 正常激活（组件 XML 声明 exec），xworkd **不** fork 它——
 *     因为引擎必须活在会话自己的 dbus 会话里（否则连不上那个会话的 ibus-daemon）。
 *     xworkd 只把 socket 路径通过环境变量 XWORKD_IM_SOCK 交给会话（见 sessproc.c）。
 *   · 引擎上报的帧经 on_event 回调交给上层转成 MSG_IM_* 发给客户端；
 *     客户端来的 MSG_IM_* 由上层调 im_send() 发进通道。
 *
 * 权限：socket 0600 且属主=会话用户——只有该会话内的引擎能连，客户端永远走 WS。
 * 路径：<dir>/xworkd-im-<uid>-<display>.sock（dir = /run/xworkd，开发环境退回 /tmp）
 */

#include <stddef.h>
#include <stdint.h>
#include <poll.h>

typedef struct im_ctx im_ctx;

/* 引擎上报事件（在事件循环线程里回调）：type/payload 即 src/im_proto.h 的帧内容 */
typedef void (*im_event_fn)(void *ud, uint8_t type, const uint8_t *payload, size_t len);

struct im_ctx
{
    int lfd; /* 监听 fd（-1=未建） */
    int efd; /* 引擎连接 fd（-1=无引擎） */
    int pidx_l;
    int pidx_e;
    char path[160];

    im_event_fn on_event;
    void *ud;

    /* 收：引擎发来的帧可能分片到达，攒够一帧才交给上层 */
    uint8_t *in;
    size_t in_len, in_cap;

    /* 发：客户端输入（commit 不能丢）在 EAGAIN 时先攒着，POLLOUT 时续发 */
    uint8_t *out;
    size_t out_len, out_off, out_cap;

    int ever_connected;    /* 是否曾连上过引擎（用于只报一次断连日志） */
    int last_state;        /* 已通知客户端的引擎状态（-1=还没通知过，用于去重） */
    int enabled_by_client; /* 客户端是否开了本机输入法（用于日志与状态推送判据） */

    /* 开启本机输入法前的 GNOME 输入源（关闭/断开时恢复用）。
     * 只在内存里：会话销毁就不需要恢复了，所以不必持久化。 */
    char saved_sources[512];
    char saved_current[32];
    int saved_valid;
    /* 原值是"空"（用户从未设过输入源、读到的是 schema 默认值）时要单独记住：
     * 恢复时用 `gsettings reset` 而不是写回空数组——**显式的空数组会让 GNOME 的
     * 输入源列表真的变空**（本机中文输入法会消失，踩过）。 */
    int saved_was_empty;
};

/* 建 socket 并 listen（幂等：已建则直接返回 0）。
 * user = 会话用户名（决定 socket 属主），display_str = ":10" 这种显示号（用于路径唯一）。
 * 返回 0 成功 / -1 失败（失败只记日志，不影响会话本身）。 */
int im_open(im_ctx *im, const char *user, const char *display_str);

/* 关闭通道：断连、关 fd、删 socket 文件（幂等） */
void im_close(im_ctx *im);

/* 注册上报回调（在 im_open 之前或之后都行） */
void im_set_handler(im_ctx *im, im_event_fn fn, void *ud);

/* xworkd → 引擎：发一帧（客户端输入）。无引擎时返回 -1（调用方可据此提示用户） */
int im_send(im_ctx *im, uint8_t type, const void *payload, size_t len);

/* 便利包装（内部拼 payload） */
int im_send_preedit(im_ctx *im, const char *text, unsigned pos);
int im_send_commit(im_ctx *im, const char *text);
int im_send_reset(im_ctx *im);

/* 引擎是否已连上（客户端要据此判断"本机输入法是否真的可用"） */
int im_engine_ready(const im_ctx *im);

/* 事件循环接入（eventloop.c 调用）：
 *   im_fdcount() → 需要几个 poll 槽位；im_poll() → 追加 fd 并记下标；
 *   im_events()  → 按 poll 结果处理（accept / 收帧 / 续发） */
int im_fdcount(const im_ctx *im);
int im_poll(im_ctx *im, struct pollfd *fds, int nfds);
void im_events(im_ctx *im, const struct pollfd *fds);
