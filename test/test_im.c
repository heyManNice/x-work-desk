/* test_im.c —— 输入法中继通道（src/im.c）的单元测试：不依赖会话/WS/ibus。
 *
 * 覆盖三类最容易出错的地方：
 *   1. 帧编解码边界（半包、超长、多帧粘包）—— 这是"必须分片处理"的经典坑；
 *   2. socket 的建立与权限（0600，只有会话用户能连）；
 *   3. 引擎接入/上报/断开这一圈生命周期，以及 xworkd → 引擎的下行发送。
 *
 * 运行：ninja -C build && ./build/test-im
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include "im.h"
#include "im_proto.h"

#include <errno.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

static int g_fail = 0;

#define CHECK(cond, ...)                              \
    do                                                \
    {                                                 \
        if (!(cond))                                  \
        {                                             \
            g_fail++;                                 \
            printf("  ✗ %s:%d ", __FILE__, __LINE__); \
            printf(__VA_ARGS__);                      \
            printf("\n");                             \
        }                                             \
    } while (0)

static const char *me_name(void)
{
    struct passwd *pw = getpwuid(getuid());
    return pw ? pw->pw_name : "nobody";
}

/* ---------------- 1. 帧编解码 ---------------- */

static void test_frame_codec(void)
{
    unsigned char buf[IM_HEADER_LEN + IM_PAYLOAD_MAX];
    unsigned char type = 0;
    const unsigned char *payload = NULL;
    size_t plen = 0, used = 0, n;
    int r;

    printf("帧编解码\n");

    /* CARET：i16×4，负值要能原样往返（多显示器左侧会是负坐标） */
    n = im_frame_encode_caret(buf, sizeof buf, -12, 345, 0, 26);
    CHECK(n == IM_HEADER_LEN + 8, "CARET 帧长应为 11，实际 %zu", n);
    CHECK(buf[0] == IM_MSG_CARET, "type 应为 CARET");
    r = im_frame_decode(buf, n, &type, &payload, &plen, &used);
    CHECK(r == 1 && used == n && plen == 8, "解码 CARET 失败（r=%d used=%zu）", r, used);
    if (r == 1)
    {
        int x = (int16_t)im_get_u16le(payload), y = (int16_t)im_get_u16le(payload + 2);
        CHECK(x == -12 && y == 345, "坐标往返错误：x=%d y=%d", x, y);
    }

    /* 半包：少一个字节必须判"数据不足"，不能当错误 */
    r = im_frame_decode(buf, n - 1, &type, &payload, &plen, &used);
    CHECK(r == 0, "半包应返回 0（数据不足），实际 %d", r);
    r = im_frame_decode(buf, 1, &type, &payload, &plen, &used);
    CHECK(r == 0, "只有一个字节时应返回 0，实际 %d", r);

    /* 粘包：两帧连在一起，解码第一帧只应消费第一帧的长度 */
    n = im_frame_encode_u8(buf, sizeof buf, IM_MSG_FOCUS, 1);
    n += im_frame_encode_u8(buf + n, sizeof buf - n, IM_MSG_STATE, IM_STATE_DISABLED);
    r = im_frame_decode(buf, n, &type, &payload, &plen, &used);
    CHECK(r == 1 && type == IM_MSG_FOCUS && plen == 1, "粘包首帧解析错误");
    r = im_frame_decode(buf + used, n - used, &type, &payload, &plen, &used);
    CHECK(r == 1 && type == IM_MSG_STATE && payload[0] == IM_STATE_DISABLED,
          "粘包第二帧解析错误");

    /* 超长：声明长度超过上限必须报非法（让上层断开重连，而不是继续错位解析） */
    {
        unsigned char bad[IM_HEADER_LEN];
        bad[0] = IM_MSG_CARET;
        im_put_u16le(bad + 1, IM_PAYLOAD_MAX + 1);
        r = im_frame_decode(bad, sizeof bad, &type, &payload, &plen, &used);
        CHECK(r == -1, "超长帧应返回 -1，实际 %d", r);
    }

    /* UTF-8 校验：客户端来的文本不可信，钒法序列必须被拦住 */
    CHECK(im_utf8_valid("你好", 6) == 1, "合法中文应通过");
    CHECK(im_utf8_valid("", 0) == 1, "空串应通过");
    CHECK(im_utf8_valid("\xff\xfe", 2) == 0, "非法首字节应被拒");
    CHECK(im_utf8_valid("\xe4\xbd", 2) == 0, "截断序列应被拒");
    CHECK(im_utf8_valid("\xc0\xaf", 2) == 0, "过长编码应被拒");
    CHECK(im_utf8_valid("\xed\xa0\x80", 3) == 0, "代理对应被拒");
    CHECK(im_utf8_valid("\xf4\x90\x80\x80", 4) == 0, "超出 Unicode 范围应被拒");

    /* PREEDIT：pos(u16) + UTF-8；长文本截断必须停在字符边界上 */
    {
        char big[IM_PAYLOAD_MAX * 2 + 4];
        size_t units = (IM_PAYLOAD_MAX * 2) / 3, i;
        for (i = 0; i < units; i++)
            memcpy(big + i * 3, "字", 3);
        big[units * 3] = '\0';
        n = im_frame_encode_preedit(buf, sizeof buf, 1, big);
        CHECK(n != 0 && n <= IM_HEADER_LEN + IM_PAYLOAD_MAX, "PREEDIT 帧长越界：%zu", n);
        CHECK((n - IM_HEADER_LEN - 2) % 3 == 0, "截断没有落在 UTF-8 边界上（%zu）",
              n - IM_HEADER_LEN - 2);
    }
}

/* ---------------- 2/3. 通道生命周期 ---------------- */

typedef struct
{
    int nframes;
    unsigned char last_type;
    unsigned char buf[1024];
    size_t len;
    int nup;   /* 收到的 IM_EV_ENGINE_UP 次数（引擎接入） */
    int ndown; /* 收到的 IM_EV_ENGINE_DOWN 次数（引擎断开） */
} capture;

static void on_event(void *ud, uint8_t type, const uint8_t *payload, size_t len)
{
    capture *cap = ud;

    /* 内部生命周期事件不走通道，单独计数（上层用它推送状态给客户端） */
    if (type == IM_EV_ENGINE_UP)
    {
        cap->nup++;
        return;
    }
    if (type == IM_EV_ENGINE_DOWN)
    {
        cap->ndown++;
        return;
    }
    cap->nframes++;
    cap->last_type = type;
    cap->len = len < sizeof cap->buf ? len : sizeof cap->buf;
    memcpy(cap->buf, payload, cap->len);
}

static int connect_engine(const char *path)
{
    struct sockaddr_un sa;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0)
        return -1;
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    snprintf(sa.sun_path, sizeof sa.sun_path, "%s", path);
    if (connect(fd, (struct sockaddr *)&sa, sizeof sa) != 0)
    {
        printf("  （连接 %s 失败：%s）\n", path, strerror(errno));
        close(fd);
        return -1;
    }
    return fd;
}

/* 跑一轮事件循环（只在测试里这么用：真实现里由 eventloop.c 驱动） */
static void pump(im_ctx *im, capture *cap)
{
    struct pollfd fds[8];
    int n = im_poll(im, fds, 0);
    if (poll(fds, n, 200) > 0)
        im_events(im, fds);
}

static void test_channel(const char *path)
{
    im_ctx im;
    capture cap = {0, 0, {0}, 0, 0, 0};
    struct stat st;
    int cfd;
    uint8_t frame[64];
    size_t n;
    ssize_t got;

    printf("通道生命周期（%s）\n", path);
    memset(&im, 0, sizeof im);
    im.lfd = im.efd = -1;
    im_set_handler(&im, on_event, &cap);

    CHECK(im_open(&im, me_name(), ":99") == 0, "im_open 失败");
    CHECK(strcmp(im.path, path) == 0, "socket 路径不符：%s", im.path);

    /* 权限：0600，别的用户连不上（设计稿 §7 的安全要求） */
    CHECK(stat(path, &st) == 0 && S_ISSOCK(st.st_mode), "socket 文件不存在或类型不对");
    CHECK((st.st_mode & 0777) == 0600, "socket 权限应为 0600，实际 %03o", st.st_mode & 0777);

    /* 引擎接入 */
    cfd = connect_engine(path);
    CHECK(cfd >= 0, "客户端连接失败");
    if (cfd < 0)
        return;
    pump(&im, &cap);
    CHECK(im_engine_ready(&im) == 1, "引擎接入后 im_engine_ready 应为 1");
    CHECK(cap.nup == 1, "接入应产生一次 IM_EV_ENGINE_UP（实际 %d）", cap.nup);

    /* 引擎上报 CARET：分两片写进去，验证"半包要等" */
    n = im_frame_encode_caret(frame, sizeof frame, 100, 200, 0, 26);
    CHECK(write(cfd, frame, 4) == 4, "分片写第一段失败");
    pump(&im, &cap);
    CHECK(cap.nframes == 0, "半包不应触发回调（实际 %d 次）", cap.nframes);
    CHECK(write(cfd, frame + 4, n - 4) == (ssize_t)(n - 4), "分片写第二段失败");
    pump(&im, &cap);
    CHECK(cap.nframes == 1 && cap.last_type == IM_MSG_CARET, "未收到完整 CARET（%d 次）",
          cap.nframes);

    /* 下行：xworkd → 引擎（preedit 带位置 + commit） */
    CHECK(im_send_preedit(&im, "nihao", 3) == 0, "发 preedit 失败");
    got = read(cfd, frame, sizeof frame);
    CHECK(got == (ssize_t)(IM_HEADER_LEN + 2 + 5), "preedit 帧长不对：%zd", got);
    if (got > 0)
    {
        size_t used = 0, plen = 0;
        const unsigned char *payload = NULL;
        unsigned char type = 0;
        CHECK(im_frame_decode(frame, (size_t)got, &type, &payload, &plen, &used) == 1 &&
                  type == IM_MSG_PREEDIT,
              "下行 preedit 解码失败");
        CHECK(plen == 7 && im_get_u16le(payload) == 3 && memcmp(payload + 2, "nihao", 5) == 0,
              "preedit 载荷不对（pos 或文本）");
    }

    /* 引擎断开后：im_engine_ready=0，且下行发送应失败（上层据此提示用户） */
    close(cfd);
    pump(&im, &cap);
    CHECK(im_engine_ready(&im) == 0, "引擎断开后 im_engine_ready 应为 0");
    CHECK(cap.ndown == 1, "断开应产生一次 IM_EV_ENGINE_DOWN（实际 %d）", cap.ndown);
    CHECK(im_send_commit(&im, "你好") == -1, "无引擎时 im_send 应返回 -1");

    /* 关闭后 socket 文件要清掉，避免下次会话 bind 到残留路径 */
    im_close(&im);
    CHECK(access(path, F_OK) != 0, "im_close 后 socket 文件应已删除");
}

int main(void)
{
    char path[160];
    unsigned uid = (unsigned)geteuid();

    printf("== test-im ==\n");
    test_frame_codec();
    snprintf(path, sizeof path, "%s/xworkd-im-%u-99.sock",
             access("/run/xworkd", W_OK) == 0 ? "/run/xworkd" : "/tmp", uid);
    test_channel(path);

    if (g_fail == 0)
        printf("== 全部通过 ==\n");
    else
        printf("== 失败 %d 项 ==\n", g_fail);
    return g_fail == 0 ? 0 : 1;
}
