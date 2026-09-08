/* encoder.c —— H.264 视频编码器（CPU-only，静态链接 x264，无 FFmpeg 依赖）。
 * 抓帧线程把 BGRA 转成 NV12 后直接调用 x264 编码，输出 Annex-B 字节流。
 * 参数与旧 FFmpeg/libavcodec 实现保持一致：
 *   - preset=ultrafast + tune=zerolatency（无 B 帧、低延迟）
 *   - GOP(关键帧间隔)=120
 *   - CRF 质量模式；当指定码率上限 kbps 时叠加 VBV 上限
 * 首个关键帧中的 SPS/PPS 被提取出来，经 MSG_CONFIG 提前推给前端，
 * 以便前端用 avcC description 配置解码器（不依赖关键帧携带参数集）。
 * 码率/质量档运行期可调：x264 参数变化时重建编码器并重发 CONFIG。 */
#define _POSIX_C_SOURCE 200809L
#include "session.h"
#include "encoder.h"
#include "net.h"
#include "protocol.h"
#include "config.h"
#include "util.h"

#include <stdlib.h>
#include <string.h>
#include <x264.h>

/* 从 Annex-B 字节流解析裸 SPS(7)/PPS(8) NAL，写入 enc（已有则跳过）。
 * e 指向不含帧头的 Annex-B 流（含起始码）。 */
static void extract_sps_pps_annexb(encoder_ctx *enc, const uint8_t *e, int size)
{
    /* 在 from 之后找下一个 NAL 起始码（支持 3/4 字节），返回位置，*sc 记起始码长 */
    int next_start(const uint8_t *d, int sz, int from, int *sc)
    {
        for (int i = from; i + 3 <= sz; i++)
        {
            if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1)
            {
                *sc = (i + 3 < sz && d[i + 3] == 0) ? 4 : 3;
                return i;
            }
        }
        return -1;
    }
    int sc = 0;
    for (int i = 0; (i = next_start(e, size, i, &sc)) >= 0; i += sc)
    {
        if (i + sc >= size)
            break;
        int type = e[i + sc] & 0x1f;
        if (type != 7 && type != 8)
            continue;
        int start = i + sc;
        int nsc = 0;
        int next = next_start(e, size, start + 1, &nsc);
        int end = next >= 0 ? next : size;
        if (end <= start)
            continue;
        if (type == 7)
        {
            if (!enc->sps)
            {
                enc->sps = malloc((size_t)(end - start));
                memcpy(enc->sps, e + start, (size_t)(end - start));
                enc->sps_len = (size_t)(end - start);
            }
        }
        else if (!enc->pps)
        {
            enc->pps = malloc((size_t)(end - start));
            memcpy(enc->pps, e + start, (size_t)(end - start));
            enc->pps_len = (size_t)(end - start);
        }
    }
}

/* 用给定参数打开 x264 编码器；成功返回 0，失败返回 -1 */
static int encoder_x264_open(runtime *rt, int kbps, int crf)
{
    encoder_ctx *enc = &rt->enc;
    video_buf *vb = &rt->video;
    int fps = atomic_load(&rt->fps) > 0 ? atomic_load(&rt->fps) : 30;

    x264_param_t param;
    x264_param_default_preset(&param, "ultrafast", "zerolatency");

    param.i_width = vb->width;
    param.i_height = vb->height;
    param.i_csp = X264_CSP_NV12; /* capture 填充的就是 NV12（Y + 交错 UV） */
    param.i_fps_num = fps;
    param.i_fps_den = 1;
    param.i_timebase_num = 1;
    param.i_timebase_den = fps;
    param.b_annexb = 1;         /* 输出含起始码的 Annex-B（与旧实现一致） */
    param.i_bframe = 0;         /* 低延迟，无 B 帧 */
    param.i_keyint_max = 120;   /* GOP 120 */
    param.i_keyint_min = 1;     /* 允许随时请求 IDR 关键帧 */
    param.b_repeat_headers = 1; /* 关键帧携带 SPS/PPS：首关键帧提取后发 CONFIG，
                                 * 前端也能在任意关键帧处随机接入 */

    /* 码率/质量策略（等价旧 libx264：CRF + 可选 VBV 上限） */
    param.rc.i_rc_method = X264_RC_CRF;
    param.rc.f_rf_constant = crf > 0 ? (float)crf : 23.0f;
    if (kbps > 0)
    {
        param.rc.i_vbv_max_bitrate = kbps * 1000; /* bps */
        param.rc.i_vbv_buffer_size = kbps * 1000;
    }

    x264_t *x264 = x264_encoder_open(&param);
    if (!x264)
    {
        log_err("x264 编码器打开失败 (%dx%d fps=%d kbps=%d crf=%d)",
                vb->width, vb->height, fps, kbps, crf);
        return -1;
    }
    enc->x264 = x264;
    enc->cur_kbps = kbps;
    enc->cur_crf = crf > 0 ? crf : 23;
    log_info("编码器: x264 (CPU-only) %dx%d fps=%d kbps=%d crf=%d",
             vb->width, vb->height, fps, kbps, enc->cur_crf);
    return 0;
}

/* 打开编码器（CPU-only x264），成功返回 0 */
static int encoder_open(runtime *rt, int kbps, int crf)
{
    return encoder_x264_open(rt, kbps, crf);
}

/* 关闭并释放编码器（SPS/PPS 一并清空，重建后首个关键帧重新提取） */
void encoder_close(encoder_ctx *enc)
{
    if (enc->x264)
        x264_encoder_close(enc->x264);
    enc->x264 = NULL;
    enc->cur_kbps = 0;
    enc->cur_crf = 23;
    free(enc->sps);
    enc->sps = NULL;
    enc->sps_len = 0;
    free(enc->pps);
    enc->pps = NULL;
    enc->pps_len = 0;
}

void encoder_destroy(encoder_ctx *enc)
{
    encoder_close(enc);
}

int init_encoder(runtime *rt)
{
    encoder_ctx *enc = &rt->enc;
    video_buf *vb = &rt->video;
    /* 视频缓冲：Y 平面 + 交错 UV（NV12），总大小 w*h*3/2 */
    vb->yuv = malloc((size_t)vb->width * vb->height * 3 / 2);
    if (!vb->yuv)
        return -1;
    enc->x264 = NULL;
    enc->sps = NULL;
    enc->pps = NULL;
    enc->sps_len = enc->pps_len = 0;
    enc->cur_kbps = 0;
    enc->cur_crf = 23;
    /* 立即打开 x264 编码器，失败则返回 -1 */
    return encoder_open(rt, atomic_load(&rt->bitrate_kbps),
                        atomic_load(&rt->crf));
}

/* 发送 CONFIG 消息（假定调用方已持有 enc->lock） */
static void encoder_send_config_locked(conn *c, runtime *rt)
{
    encoder_ctx *enc = &rt->enc;
    if (!enc->sps || !enc->pps)
        return; /* SPS/PPS 尚未提取（首个关键帧后才会发送） */
    size_t len = 9 + enc->sps_len + enc->pps_len;
    uint8_t *buf = malloc(len);
    uint8_t *p = buf;
    *p++ = MSG_CONFIG;
    wr_u16(p, (uint16_t)rt->video.width);
    p += 2;
    wr_u16(p, (uint16_t)rt->video.height);
    p += 2;
    wr_u16(p, (uint16_t)enc->sps_len);
    p += 2;
    memcpy(p, enc->sps, enc->sps_len);
    p += enc->sps_len;
    wr_u16(p, (uint16_t)enc->pps_len);
    p += 2;
    memcpy(p, enc->pps, enc->pps_len);
    net_push_take(c, buf, len, 0);
}

void encode_frame(runtime *rt)
{
    encoder_ctx *enc = &rt->enc;
    /* 无人连接（断开连接后桌面后台保留）时不编码，节省 CPU */
    if (!atomic_load(&rt->conn))
        return;
    video_buf *vb = &rt->video;

    /* 接管空闲会话等场景：SPS/PPS 已存在但新连接需要 CONFIG，
     * 由抓帧线程补发（避免跨线程访问编码器状态） */
    if (atomic_exchange(&rt->cap.need_config, 0))
    {
        conn *c = atomic_load(&rt->conn);
        if (c)
            encoder_send_config_locked(c, rt);
        atomic_store(&rt->cap.req_keyframe, 1);
    }

    /* 运行期码率/质量调整：参数变化时重建编码器（重建在抓帧线程内，
     * 避免跨线程调用；重建后重发 CONFIG 并请求关键帧） */
    int want_kbps = atomic_load(&rt->bitrate_kbps);
    int want_crf = atomic_load(&rt->crf);
    if (want_kbps != enc->cur_kbps || want_crf != enc->cur_crf)
    {
        encoder_close(enc);
        if (encoder_open(rt, want_kbps, want_crf) != 0)
        {
            /* 重建失败：回退默认参数（自动码率 + 默认质量） */
            encoder_close(enc);
            if (encoder_open(rt, 0, 23) != 0)
            {
                return;
            }
        }
        conn *c = atomic_load(&rt->conn);
        if (c)
            encoder_send_config_locked(c, rt);
        atomic_store(&rt->cap.req_keyframe, 1);
    }
    if (!enc->x264)
    {
        return;
    }

    x264_picture_t pic, pic_out;
    x264_picture_init(&pic);
    pic.img.i_csp = X264_CSP_NV12;
    pic.img.i_plane = 2;
    pic.img.plane[0] = vb->yuv;
    pic.img.i_stride[0] = vb->width;
    pic.img.plane[1] = vb->yuv + (size_t)vb->width * vb->height;
    pic.img.i_stride[1] = vb->width;
    pic.i_pts = rt->cap.frame_index++;
    pic.i_type = atomic_exchange(&rt->cap.req_keyframe, 0)
                     ? X264_TYPE_IDR
                     : X264_TYPE_AUTO;

    x264_nal_t *nals = NULL;
    int n_nal = 0;
    if (x264_encoder_encode(enc->x264, &nals, &n_nal, &pic, &pic_out) < 0)
        return;
    if (n_nal <= 0)
        return;

    int is_key = pic_out.b_keyframe;
    size_t total = 0;
    for (int i = 0; i < n_nal; i++)
        total += nals[i].i_payload;
    if (total == 0)
        return;

    /* 拼接各 NAL（b_annexb=1，每段自带起始码）为完整 Annex-B 帧 */
    uint8_t *buf = malloc(2 + total);
    uint8_t *p = buf;
    *p++ = MSG_VIDEO;
    *p++ = is_key ? VIDEO_FLAG_KEY : 0;
    for (int i = 0; i < n_nal; i++)
    {
        memcpy(p, nals[i].p_payload, (size_t)nals[i].i_payload);
        p += nals[i].i_payload;
    }

    /* 关键帧携带 SPS/PPS（repeat_headers=0，仅 IDR 输出一次）。首次提取后
     * 发 CONFIG；重建编码器后 sps 被清空，会再次提取并重发 */
    if (is_key && !enc->sps)
    {
        extract_sps_pps_annexb(enc, buf + 2, (int)total);
        if (enc->sps && enc->pps)
        {
            conn *c = atomic_load(&rt->conn);
            if (c)
                encoder_send_config_locked(c, rt);
        }
    }
    conn *c = atomic_load(&rt->conn);
    if (c)
        net_push_take(c, buf, 2 + total, 1);
    else
        free(buf);
}
