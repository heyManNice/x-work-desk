/* im/xworkd-im.c —— xworkd 输入法中继引擎（远端一侧，ibus 引擎）
 *
 * 它**不组词**：组词发生在本机（客户端）的用户输入法里。本引擎只做三件事：
 *   1. 把 xworkd 送来的 preedit 用 update_preedit_text() 交给远端应用**自己显示**；
 *   2. 把 xworkd 送来的 commit 用 commit_text() 交给远端应用**自己插入**（无需按键注入）；
 *   3. 把应用上报的插入点矩形（set_cursor_location）回传给客户端，用于对齐本机候选窗。
 *
 * 对应设计文档 docs/input-method-local.md 的形态①。形态②（不支持 IM 的应用）不在这里。
 *
 * ── 三条硬要求（都是 PoC 上踩出来的，改动时别丢）────────────────────────────
 *   · 必须显式调用 ibus_bus_register_component()。只靠组件 XML + request_name 时，
 *     daemon 会把工厂代理挂到一条未导出 /org/freedesktop/IBus/Factory 的连接上，
 *     切引擎时报 `UnknownMethod: Object does not exist at path ...Factory`（瞬时失败）。
 *   · 组件 XML 必须有 <homepage>（可为空元素），否则 ibus 序列化会断言失败并写坏组件缓存。
 *   · GNOME 下引擎调度者是 gnome-shell，它按 org.gnome.desktop.input-sources 行事，
 *     单方面 `ibus engine <名>` 会被覆盖 → 必须把引擎挂成"输入源"。
 *
 * ── 与 xworkd 的通道（见 src/im_proto.h）────────────────────────────────────
 *   本进程是**客户端**：连 xworkd 提供的 AF_UNIX socket（路径由 XWORKD_IM_SOCK 给出）。
 *   xworkd 未就绪时每秒重连——引擎很可能是先起来的那个。
 *   通道断了不影响本机输入英文，只是"本机输入法"失效，所以这里绝不阻塞主循环。
 *
 * 构建：meson 可选目标（需要 libibus-1.0-dev），见 meson.build 的 "xworkd-im"。
 */

#include <errno.h>
#include <fcntl.h>
#include <glib-unix.h>
#include <glib.h>
#include <ibus.h>
#include <locale.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "config.h"   /* XWORKD_VERSION：组件与引擎描述里的版本号 */
#include "im_proto.h" /* 通道帧格式（与 xworkd 共用） */

/* ---- 身份 ---- */

/* D-Bus 服务名，必须与 im/xworkd-im.xml 的 <name> 一致 */
#define IM_COMPONENT_NAME "org.freedesktop.IBus.XWorkdIM"
/* 引擎名，必须与 XML 里 <engines>/<engine>/<name> 一致 */
#define IM_ENGINE_NAME "xworkd-im"
#define IM_ENGINE_LONGNAME "XWorkDesk 输入法中继"
#define IM_ENGINE_DESCRIPTION "由本机输入法驱动：预编辑与提交由本机产生，远端应用负责显示"
#define IM_ENGINE_LANGUAGE "zh_CN"
#define IM_ENGINE_LAYOUT "us"

static gboolean im_debug = FALSE;

static void im_log(const char *fmt, ...) G_GNUC_PRINTF(1, 2);

static void im_log(const char *fmt, ...)
{
    va_list ap;
    char msg[512];

    va_start(ap, fmt);
    g_vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    g_printerr("xworkd-im: %s\n", msg);
    fflush(stderr);
}

#define im_debugf(...)           \
    do                           \
    {                            \
        if (im_debug)            \
        {                        \
            im_log(__VA_ARGS__); \
        }                        \
    } while (0)

/* ============================ 与 xworkd 的通道 ============================ */

/* 通道是"尽力而为"的：未连接时发送直接丢弃。
 * 丢弃是安全的——PREEDIT/COMMIT 的方向是 xworkd → 引擎，本文件只负责发 CARET/FOCUS/STATE，
 * 这三个丢了只是在客户端少一次校正/提示，下次上报会补上。 */
static struct
{
    gchar *path;
    int fd;
    GByteArray *in;
    GByteArray *out;
    guint io_id;    /* socket 上的 GSource（读写共用） */
    guint out_id;   /* 仅当有积压待发时才存在 */
    guint retry_id; /* 重连定时器 */
    gboolean notified_down;
} chan = {NULL, -1, NULL, NULL, 0, 0, 0, FALSE};

/* 候选 socket 路径（见 chan_init 的说明）。实际使用那一个存在者。 */
#define IM_PATH_MAX 4
static gchar *chan_paths[IM_PATH_MAX];
static guint chan_npaths;

/* 从 DISPLAY 取出数字部分（":10" → "10"）；拿不到就用 "0" */
static gchar *display_token(void)
{
    const gchar *d = g_getenv("DISPLAY");
    GString *s = g_string_new(NULL);
    gchar *out;

    if (d != NULL)
    {
        for (const gchar *p = d; *p != '\0'; p++)
        {
            if (g_ascii_isdigit(*p))
                g_string_append_c(s, *p);
        }
    }
    if (s->len == 0)
        g_string_append_c(s, '0');
    out = g_string_free(s, FALSE);
    return out;
}

/* 选一个候选：优先取已存在的（xworkd 建好 socket 后它一定存在）；
 * 都不存在时用第一个非 env 候选，等下次重试。 */
static const gchar *chan_pick(void)
{
    for (guint i = 0; i < chan_npaths; i++)
    {
        if (access(chan_paths[i], F_OK) == 0)
            return chan_paths[i];
    }
    return chan_paths[chan_npaths > 1 ? 1 : 0];
}

static void chan_retry(void);

/* 关闭连接（保留重连定时器逻辑：由调用方决定是否 chan_retry()） */
static void chan_shutdown(void)
{
    if (chan.io_id != 0)
    {
        g_source_remove(chan.io_id);
        chan.io_id = 0;
    }
    if (chan.out_id != 0)
    {
        g_source_remove(chan.out_id);
        chan.out_id = 0;
    }
    if (chan.fd >= 0)
    {
        close(chan.fd);
        chan.fd = -1;
    }
    if (chan.in != NULL)
    {
        g_byte_array_set_size(chan.in, 0);
    }
    if (chan.out != NULL)
    {
        g_byte_array_set_size(chan.out, 0);
    }
}

static void chan_flush(void);

static gboolean chan_on_writable(gint fd, GIOCondition cond, gpointer data)
{
    (void)fd;
    (void)cond;
    (void)data;
    chan_flush(); /* 发完会自己移除本 source */
    return G_SOURCE_CONTINUE;
}

/* 把 out 缓冲尽量写出去；EAGAIN 时挂一个"可写"source 等下次机会 */
static void chan_flush(void)
{
    while (chan.out->len > 0 && chan.fd >= 0)
    {
        ssize_t n = write(chan.fd, chan.out->data, chan.out->len);
        if (n > 0)
        {
            g_byte_array_remove_range(chan.out, 0, (guint)n);
            continue;
        }
        if (n < 0 && errno == EINTR)
        {
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
        {
            break;
        }
        im_debugf("写通道失败：%s", g_strerror(errno));
        chan_shutdown();
        chan_retry();
        return;
    }

    if (chan.out->len == 0)
    {
        if (chan.out_id != 0)
        {
            g_source_remove(chan.out_id);
            chan.out_id = 0;
        }
        return;
    }
    if (chan.out_id == 0 && chan.fd >= 0)
    {
        chan.out_id = g_unix_fd_add(chan.fd, G_IO_OUT, chan_on_writable, NULL);
    }
}

/* 发送一帧（未连接/超长则丢弃） */
static void chan_send(unsigned char type, const void *payload, size_t len)
{
    unsigned char frame[IM_HEADER_LEN + IM_PAYLOAD_MAX];
    size_t n;

    if (chan.fd < 0)
    {
        return;
    }
    n = im_frame_encode(frame, sizeof frame, type, payload, len);
    if (n == 0)
    {
        im_log("帧过长，已丢弃（type=0x%02x len=%zu）", type, len);
        return;
    }
    g_byte_array_append(chan.out, frame, (guint)n);
    chan_flush();
}

static void chan_send_u8(unsigned char type, unsigned char value)
{
    chan_send(type, &value, 1);
}

static void chan_send_caret(int x, int y, int w, int h)
{
    unsigned char p[8];
    im_put_u16le(p + 0, (unsigned)im_clampi16(x));
    im_put_u16le(p + 2, (unsigned)im_clampi16(y));
    im_put_u16le(p + 4, (unsigned)im_clampi16(w));
    im_put_u16le(p + 6, (unsigned)im_clampi16(h));
    chan_send(IM_MSG_CARET, p, sizeof p);
}

static void im_handle_frame(unsigned char type, const unsigned char *payload, size_t len);

/* 从 in 缓冲里尽量取出完整帧 */
static void chan_dispatch(void)
{
    while (chan.in->len >= IM_HEADER_LEN)
    {
        unsigned plen = im_get_u16le(chan.in->data + 1);
        if (plen > IM_PAYLOAD_MAX)
        {
            /* 协议错乱：断开重连比继续解析安全（否则会一直错位） */
            im_log("通道帧长度异常（%u），重置连接", plen);
            chan_shutdown();
            chan_retry();
            return;
        }
        if (chan.in->len < IM_HEADER_LEN + plen)
        {
            break; /* 半包，等下一次可读 */
        }
        im_handle_frame(chan.in->data[0], chan.in->data + IM_HEADER_LEN, plen);
        g_byte_array_remove_range(chan.in, 0, IM_HEADER_LEN + plen);
    }
}

static gboolean chan_on_io(gint fd, GIOCondition cond, gpointer data)
{
    (void)data;

    if (cond & (G_IO_HUP | G_IO_ERR | G_IO_NVAL))
    {
        im_debugf("通道对端关闭");
        chan_shutdown();
        chan_retry();
        return G_SOURCE_CONTINUE; /* source 已在 chan_shutdown 里移除 */
    }

    for (;;)
    {
        unsigned char buf[4096];
        ssize_t n = read(fd, buf, sizeof buf);
        if (n > 0)
        {
            g_byte_array_append(chan.in, buf, (guint)n);
            continue;
        }
        if (n == 0)
        {
            im_debugf("通道对端已断开");
            chan_shutdown();
            chan_retry();
            return G_SOURCE_CONTINUE;
        }
        if (errno == EINTR)
        {
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK)
        {
            break;
        }
        im_debugf("读通道失败：%s", g_strerror(errno));
        chan_shutdown();
        chan_retry();
        return G_SOURCE_CONTINUE;
    }

    chan_dispatch();
    return G_SOURCE_CONTINUE;
}

static gboolean chan_try_connect(gpointer data)
{
    struct sockaddr_un sa;
    int fd;
    const gchar *path;

    (void)data;
    chan.retry_id = 0;
    if (chan.fd >= 0)
    {
        return G_SOURCE_REMOVE;
    }

    path = chan_pick();
    if (g_strcmp0(chan.path, path) != 0)
    {
        g_free(chan.path);
        chan.path = g_strdup(path);
        chan.notified_down = FALSE; /* 换了路径就重新报一次，否则换路径后无日志 */
    }

    fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0)
    {
        im_log("socket() 失败：%s", g_strerror(errno));
        chan_retry();
        return G_SOURCE_REMOVE;
    }
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    g_strlcpy(sa.sun_path, chan.path, sizeof sa.sun_path);
    if (connect(fd, (struct sockaddr *)&sa, sizeof sa) != 0)
    {
        int err = errno;
        close(fd);
        /* 只在第一次失败时报一次，避免每秒刷一行 */
        if (!chan.notified_down)
        {
            chan.notified_down = TRUE;
            im_log("通道 %s 未就绪（%s），每秒重试（xworkd 还没起来？）", chan.path,
                   g_strerror(err));
        }
        chan_retry();
        return G_SOURCE_REMOVE;
    }
    if (fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK) != 0)
    {
        im_log("设置非阻塞失败：%s", g_strerror(errno));
        close(fd);
        chan_retry();
        return G_SOURCE_REMOVE;
    }

    chan.fd = fd;
    chan.notified_down = FALSE;
    chan.io_id = g_unix_fd_add(fd, G_IO_IN | G_IO_HUP | G_IO_ERR | G_IO_NVAL, chan_on_io, NULL);
    im_log("通道已连接：%s", chan.path);
    return G_SOURCE_REMOVE;
}

static void chan_retry(void)
{
    if (chan.retry_id == 0)
    {
        chan.retry_id = g_timeout_add(1000, chan_try_connect, NULL);
    }
}

static void chan_init(void)
{
    const gchar *env = g_getenv("XWORKD_IM_SOCK");
    gchar *disp = display_token();
    guint n = 0;

    /* 候选路径，按优先级。为什么要多个：引擎通常由**会话内的** ibus-daemon 拉起，
     * 这时 XWORKD_IM_SOCK 能继承到；但若 daemon 是 systemd --user 拉起的（本机桌面
     * 就是这种情况），会话环境不会传下来 —— 那时必须能用 DISPLAY 把同一个路径推出来。 */
    if (env != NULL && *env != '\0')
        chan_paths[n++] = g_strdup(env);
    chan_paths[n++] = g_strdup_printf("/run/xworkd/xworkd-im-%u-%s.sock", (unsigned)getuid(), disp);
    chan_paths[n++] = g_strdup_printf("/tmp/xworkd-im-%u-%s.sock", (unsigned)getuid(), disp);
    chan_paths[n++] = g_strdup_printf("/run/xworkd/xworkd-im-%u.sock", (unsigned)getuid());
    chan_npaths = n;
    g_free(disp);

    chan.in = g_byte_array_new();
    chan.out = g_byte_array_new();
    chan_try_connect(NULL);
}

/* ============================== ibus 引擎 ============================== */

typedef struct _XWorkdImEngine XWorkdImEngine;
typedef struct _XWorkdImEngineClass XWorkdImEngineClass;

struct _XWorkdImEngine
{
    IBusEngine parent;

    /* 没有焦点时收到的 preedit 先攒着，focus_in 时再交给应用。
     * 为什么需要：客户端可能在远端应用拿到焦点**之前**就开始组词（例如刚点开输入框）。 */
    gchar *pending_text;
    guint pending_pos;
    gboolean has_pending;
};

struct _XWorkdImEngineClass
{
    IBusEngineClass parent;
};

GType xworkd_im_engine_get_type(void);
#define XWORKD_TYPE_IM_ENGINE (xworkd_im_engine_get_type())
#define XWORKD_IM_ENGINE(obj) (G_TYPE_CHECK_INSTANCE_CAST((obj), XWORKD_TYPE_IM_ENGINE, XWorkdImEngine))
#define XWORKD_IM_ENGINE_CLASS(klass) \
    (G_TYPE_CHECK_CLASS_CAST((klass), XWORKD_TYPE_IM_ENGINE, XWorkdImEngineClass))
#define XWORKD_IS_IM_ENGINE(obj) (G_TYPE_CHECK_INSTANCE_TYPE((obj), XWORKD_TYPE_IM_ENGINE))

G_DEFINE_TYPE(XWorkdImEngine, xworkd_im_engine, IBUS_TYPE_ENGINE)

/* 当前"该收键盘输入"的引擎实例。多个应用各有一个实例，取**最后获得焦点**的那个。
 * 用弱引用：实例销毁后自动变 NULL，不会拿着野指针。 */
static GWeakRef current_engine;

static void engine_set_pending(XWorkdImEngine *self, const gchar *text, guint pos)
{
    g_free(self->pending_text);
    self->pending_text = g_strdup(text);
    self->pending_pos = pos;
    self->has_pending = TRUE;
}

static void engine_clear_pending(XWorkdImEngine *self)
{
    g_clear_pointer(&self->pending_text, g_free);
    self->pending_pos = 0;
    self->has_pending = FALSE;
}

/* 把文本作为 preedit 交给应用显示；空串等于收起 */
static void engine_show_preedit(XWorkdImEngine *self, const gchar *text, guint pos)
{
    IBusEngine *engine = IBUS_ENGINE(self);
    glong nchars;

    if (text == NULL || *text == '\0')
    {
        ibus_engine_hide_preedit_text(engine);
        im_debugf("hide_preedit_text()");
        return;
    }
    nchars = (glong)g_utf8_strlen(text, -1);
    if ((glong)pos > nchars)
    {
        pos = (guint)nchars; /* 越界就退化为末尾 */
    }
    ibus_engine_update_preedit_text(engine, ibus_text_new_from_string(text), pos, TRUE);
    im_debugf("update_preedit_text(%s, cursor=%u)", text, pos);
}

/* 来自 xworkd 的帧 */
static void im_handle_frame(unsigned char type, const unsigned char *payload, size_t len)
{
    XWorkdImEngine *self = g_weak_ref_get(&current_engine); /* full ref，可能为 NULL */

    switch (type)
    {
    case IM_MSG_PREEDIT:
    {
        unsigned pos;
        gchar *text;

        if (len < 2)
        {
            im_log("PREEDIT 帧过短（%zu），丢弃", len);
            break;
        }
        pos = im_get_u16le(payload);
        text = g_strndup((const gchar *)payload + 2, len - 2);
        if (!g_utf8_validate(text, -1, NULL))
        {
            im_log("PREEDIT 不是合法 UTF-8，丢弃");
            g_free(text);
            break;
        }
        if (self == NULL)
        {
            im_log("收到 PREEDIT 但没有引擎实例，丢弃");
            g_free(text);
            break;
        }
        if (self->pending_pos == pos && self->has_pending && g_strcmp0(self->pending_text, text) == 0)
        {
            g_free(text); /* 同一帧里的重复更新，省一次 D-Bus 往返 */
            break;
        }
        if (IBUS_ENGINE(self)->has_focus)
        {
            engine_show_preedit(self, text, pos);
            engine_clear_pending(self);
        }
        else
        {
            /* 应用还没拿到焦点：攒着，focus_in 时补上 */
            engine_set_pending(self, text, pos);
            im_debugf("无焦点，暂存 preedit（%s）", text);
        }
        g_free(text);
        break;
    }
    case IM_MSG_COMMIT:
    {
        gchar *text = g_strndup((const gchar *)payload, len);

        if (!g_utf8_validate(text, -1, NULL))
        {
            im_log("COMMIT 不是合法 UTF-8，丢弃");
            g_free(text);
            break;
        }
        if (self == NULL || *text == '\0')
        {
            g_free(text);
            break;
        }
        if (!IBUS_ENGINE(self)->has_focus)
        {
            /* 没焦点就提交等于投毒到别的窗口，宁可丢弃 */
            im_log("无焦点，丢弃 COMMIT（%s）", text);
            g_free(text);
            break;
        }
        ibus_engine_commit_text(IBUS_ENGINE(self), ibus_text_new_from_string(text));
        ibus_engine_hide_preedit_text(IBUS_ENGINE(self));
        engine_clear_pending(self);
        im_log("commit(%s)", text);
        g_free(text);
        break;
    }
    case IM_MSG_RESET:
        if (self != NULL)
        {
            ibus_engine_hide_preedit_text(IBUS_ENGINE(self));
            engine_clear_pending(self);
        }
        im_debugf("reset → 收起 preedit");
        break;
    default:
        im_log("未知帧类型 0x%02x（%zu 字节），忽略", type, len);
        break;
    }

    if (self != NULL)
    {
        g_object_unref(self);
    }
}

/* ---- IBusEngine 回调 ---- */

/* 普通按键一律不消费：透传给应用（本引擎只处理"已经是文本"的输入） */
static gboolean xworkd_im_engine_process_key_event(IBusEngine *engine, guint keyval, guint keycode,
                                                   guint state)
{
    (void)engine;
    (void)keyval;
    (void)keycode;
    (void)state;
    return FALSE;
}

static void xworkd_im_engine_focus_in(IBusEngine *engine)
{
    XWorkdImEngine *self = XWORKD_IM_ENGINE(engine);
    IBusEngineClass *parent = IBUS_ENGINE_CLASS(xworkd_im_engine_parent_class);

    engine->has_focus = TRUE;
    g_weak_ref_set(&current_engine, engine);
    chan_send_u8(IM_MSG_FOCUS, 1);
    im_debugf("focus_in");

    /* 组词早于焦点到达时在这里补交 */
    if (self->has_pending)
    {
        engine_show_preedit(self, self->pending_text, self->pending_pos);
    }
    if (parent->focus_in != NULL)
    {
        parent->focus_in(engine);
    }
}

static void xworkd_im_engine_focus_out(IBusEngine *engine)
{
    IBusEngineClass *parent = IBUS_ENGINE_CLASS(xworkd_im_engine_parent_class);

    engine->has_focus = FALSE;
    chan_send_u8(IM_MSG_FOCUS, 0);
    im_debugf("focus_out");
    if (parent->focus_out != NULL)
    {
        parent->focus_out(engine);
    }
}

static void xworkd_im_engine_reset(IBusEngine *engine)
{
    XWorkdImEngine *self = XWORKD_IM_ENGINE(engine);
    IBusEngineClass *parent = IBUS_ENGINE_CLASS(xworkd_im_engine_parent_class);

    ibus_engine_hide_preedit_text(engine);
    engine_clear_pending(self);
    im_debugf("reset");
    if (parent->reset != NULL)
    {
        parent->reset(engine);
    }
}

static void xworkd_im_engine_enable(IBusEngine *engine)
{
    IBusEngineClass *parent = IBUS_ENGINE_CLASS(xworkd_im_engine_parent_class);

    engine->enabled = TRUE;
    g_weak_ref_set(&current_engine, engine);
    chan_send_u8(IM_MSG_STATE, IM_STATE_READY);
    im_debugf("enable（成为当前引擎）");
    if (parent->enable != NULL)
    {
        parent->enable(engine);
    }
}

static void xworkd_im_engine_disable(IBusEngine *engine)
{
    IBusEngineClass *parent = IBUS_ENGINE_CLASS(xworkd_im_engine_parent_class);

    engine->enabled = FALSE;
    /* 被用户/系统切走：告诉客户端，让它提示（并决定要不要切回来） */
    chan_send_u8(IM_MSG_STATE, IM_STATE_DISABLED);
    im_log("disable（被切走）");
    if (parent->disable != NULL)
    {
        parent->disable(engine);
    }
}

static void xworkd_im_engine_set_cursor_location(IBusEngine *engine, gint x, gint y, gint w,
                                                 gint h)
{
    IBusEngineClass *parent = IBUS_ENGINE_CLASS(xworkd_im_engine_parent_class);

    engine->cursor_area.x = x;
    engine->cursor_area.y = y;
    engine->cursor_area.width = w;
    engine->cursor_area.height = h;
    /* 这是"候选窗对齐"的唯一依据：应用告诉我们它把插入点画在哪（屏幕坐标） */
    chan_send_caret(x, y, w, h);
    im_debugf("cursor_location x=%d y=%d w=%d h=%d", x, y, w, h);
    if (parent->set_cursor_location != NULL)
    {
        parent->set_cursor_location(engine, x, y, w, h);
    }
}

/* 1.5.29+ 的 focus-in-id / focus-out-id：daemon 可能走这条路，行为与上面一致 */
static void xworkd_im_engine_focus_in_id(IBusEngine *engine, const gchar *object_path,
                                         const gchar *client)
{
    (void)object_path;
    (void)client;
    xworkd_im_engine_focus_in(engine);
}

static void xworkd_im_engine_focus_out_id(IBusEngine *engine, const gchar *object_path)
{
    (void)object_path;
    xworkd_im_engine_focus_out(engine);
}

static void xworkd_im_engine_finalize(GObject *object)
{
    XWorkdImEngine *self = XWORKD_IM_ENGINE(object);

    g_clear_pointer(&self->pending_text, g_free);
    G_OBJECT_CLASS(xworkd_im_engine_parent_class)->finalize(object);
}

static void xworkd_im_engine_class_init(XWorkdImEngineClass *klass)
{
    GObjectClass *gobject_class = G_OBJECT_CLASS(klass);
    IBusEngineClass *engine_class = IBUS_ENGINE_CLASS(klass);

    gobject_class->finalize = xworkd_im_engine_finalize;

    engine_class->process_key_event = xworkd_im_engine_process_key_event;
    engine_class->focus_in = xworkd_im_engine_focus_in;
    engine_class->focus_out = xworkd_im_engine_focus_out;
    engine_class->focus_in_id = xworkd_im_engine_focus_in_id;
    engine_class->focus_out_id = xworkd_im_engine_focus_out_id;
    engine_class->reset = xworkd_im_engine_reset;
    engine_class->enable = xworkd_im_engine_enable;
    engine_class->disable = xworkd_im_engine_disable;
    engine_class->set_cursor_location = xworkd_im_engine_set_cursor_location;
}

static void xworkd_im_engine_init(XWorkdImEngine *self)
{
    (void)self;
}

/* ================================ 入口 ================================ */

static void on_bus_disconnected(IBusBus *bus, gpointer data)
{
    (void)bus;
    (void)data;
    im_log("ibus 连接断开，退出");
    ibus_quit();
}

static gboolean im_started = FALSE;

/* 总线可用后的初始化：工厂 → 服务名 → 运行时注册组件。
 * 只做一次（connected 信号可能多次触发）。 */
static void im_start(IBusBus *bus)
{
    IBusComponent *component;
    IBusEngineDesc *engine_desc;

    if (im_started)
    {
        return;
    }
    im_started = TRUE;

    /* 1) 先把工厂导出在 /org/freedesktop/IBus/Factory（daemon 按这个路径找它） */
    IBusFactory *factory = ibus_factory_new(ibus_bus_get_connection(bus));
    g_object_ref_sink(factory);
    ibus_factory_add_engine(factory, IM_ENGINE_NAME, XWORKD_TYPE_IM_ENGINE);

    /* 2) 申领组件服务名（与组件 XML 的 <name> 一致） */
    ibus_bus_request_name(bus, IM_COMPONENT_NAME, 0);

    /* 3) 运行时注册组件。硬要求，见文件头注释（不做则永远切不进来）。 */
    component = ibus_component_new(IM_COMPONENT_NAME, IM_ENGINE_LONGNAME, XWORKD_VERSION,
                                   "GPL-3.0-or-later", "XWorkDesk", "", /* homepage: 不能为 NULL */
                                   "/usr/libexec/xworkd/xworkd-im", "xworkd-im");
    engine_desc = ibus_engine_desc_new(IM_ENGINE_NAME, IM_ENGINE_LONGNAME,
                                       IM_ENGINE_DESCRIPTION, IM_ENGINE_LANGUAGE,
                                       "GPL-3.0-or-later", "XWorkDesk", "", IM_ENGINE_LAYOUT);
    ibus_component_add_engine(component, engine_desc);
    ibus_bus_register_component(bus, component);
    im_log("已注册组件 %s（引擎名 %s）", IM_COMPONENT_NAME, IM_ENGINE_NAME);
}

static void on_bus_connected(IBusBus *bus, gpointer data)
{
    (void)data;
    im_log("ibus 总线已连接");
    im_start(bus);
}

static gboolean on_startup_timeout(gpointer data)
{
    (void)data;
    if (!im_started)
    {
        im_log("等不到 ibus-daemon（会话里没有输入法服务？）——先挂着，通道保持重试");
    }
    return G_SOURCE_REMOVE;
}

int main(int argc, char **argv)
{
    IBusBus *bus;

    /* component XML 的 <exec> 可能带 --ibus 之类的参数，本引擎不区分 */
    for (int i = 1; i < argc; i++)
    {
        if (g_strcmp0(argv[i], "--debug") == 0 || g_strcmp0(argv[i], "-v") == 0)
        {
            im_debug = TRUE;
        }
    }
    if (g_getenv("XWORKD_IM_DEBUG") != NULL)
    {
        im_debug = TRUE;
    }

    setlocale(LC_ALL, ""); /* ibus 需要有 locale 才能正确处理输入 */
    ibus_init();
    g_weak_ref_init(&current_engine, NULL);

    /* 通道与 ibus 无关，先连上（xworkd 可能也已经就绪） */
    chan_init();

    /* 用 async 版：daemon 没就绪时**不退出**，等它起来自动接上。
     * 为什么不等比退出好：xworkd 拉起引擎的时机可能早于 ibus-daemon，
     * 引擎一退出就会让"本机输入法"静默失效（而用户只会看到打字没反应）。 */
    bus = ibus_bus_new_async();
    g_signal_connect(bus, "connected", G_CALLBACK(on_bus_connected), NULL);
    g_signal_connect(bus, "disconnected", G_CALLBACK(on_bus_disconnected), NULL);
    if (ibus_bus_is_connected(bus))
    {
        im_start(bus);
    }
    else
    {
        im_log("等待 ibus 总线就绪…");
        g_timeout_add_seconds(10, on_startup_timeout, NULL);
    }

    ibus_main();

    chan_shutdown();
    g_clear_pointer(&chan.path, g_free);
    for (guint i = 0; i < chan_npaths; i++)
        g_clear_pointer(&chan_paths[i], g_free);
    chan_npaths = 0;
    g_clear_pointer(&chan.in, g_byte_array_unref);
    g_clear_pointer(&chan.out, g_byte_array_unref);
    g_weak_ref_clear(&current_engine);
    return 0;
}
