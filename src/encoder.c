#include "encoder.h"
#include "net.h"
#include "protocol.h"
#include "config.h"
#include "util.h"

#include <stdlib.h>
#include <string.h>
#include <x264.h>

int init_encoder(encoder_ctx *enc, video_buf *vb, int fps)
{
    x264_param_t p;
    x264_param_default_preset(&p, "ultrafast", "zerolatency");
    p.i_width = vb->width;
    p.i_height = vb->height;
    p.i_csp = X264_CSP_I420;
    p.i_fps_num = fps > 0 ? fps : 30;
    p.i_fps_den = 1;
    p.i_keyint_max = 120;
    p.i_bframe = 0;
    p.b_repeat_headers = 1; /* 每个关键帧前带 SPS/PPS */
    /* 大分辨率下单线程编码是瓶颈（2550x1284 约 20fps 上限）。
     * 使用片级多线程：一帧切多片并行编码，保持低延迟的同时利用多核。 */
    p.i_threads = 4;
    p.b_sliced_threads = 1;
    p.rc.i_lookahead = 0;
    p.i_log_level = X264_LOG_ERROR;
    x264_param_apply_profile(&p, "baseline");
    /* 码率上限走 VBV 约束：初始化即开启（默认 50Mbps 高上限），
     * 运行期 reconfig 只允许调整 vbv 值（不能从关闭切到开启）。
     * 自动=高上限（质量由 CRF 决定），选码率=具体上限。 */
    p.rc.i_rc_method = X264_RC_CRF;
    p.rc.f_rf_constant = 23;
    p.rc.i_vbv_max_bitrate = 50000;
    p.rc.i_vbv_buffer_size = 50000;

    enc->param = p; /* 保存参数，供运行期 reconfig */
    enc->cur_kbps = 0;
    enc->cur_crf = 23;

    enc->enc = x264_encoder_open(&p);
    if (!enc->enc)
    {
        log_err("x264_encoder_open 失败");
        return -1;
    }

    /* 取 SPS/PPS 用于 CONFIG 消息 */
    x264_nal_t *nal;
    int i_nal;
    if (x264_encoder_headers(enc->enc, &nal, &i_nal) < 0)
    {
        log_err("x264_encoder_headers 失败");
        return -1;
    }
    for (int i = 0; i < i_nal; i++)
    {
        const uint8_t *d = nal[i].p_payload;
        size_t n = nal[i].i_payload;
        /* 剥离 4 字节起始码 00 00 00 01，保留裸 NAL */
        if (n >= 4 && d[0] == 0 && d[1] == 0 && d[2] == 0 && d[3] == 1)
        {
            d += 4;
            n -= 4;
        }
        if (nal[i].i_type == NAL_SPS)
        {
            enc->sps = malloc(n);
            memcpy(enc->sps, d, n);
            enc->sps_len = n;
        }
        else if (nal[i].i_type == NAL_PPS)
        {
            enc->pps = malloc(n);
            memcpy(enc->pps, d, n);
            enc->pps_len = n;
        }
    }
    if (!enc->sps || !enc->pps)
    {
        log_err("未取到 SPS/PPS");
        return -1;
    }

    vb->yuv = malloc((size_t)vb->width * vb->height * 3 / 2);
    if (!vb->yuv)
        return -1;
    return 0;
}

void encode_frame(runtime *rt)
{
    /* 无人连接（断开连接后桌面后台保留）时不编码，节省 CPU */
    if (!atomic_load(&rt->conn))
        return;
    encoder_ctx *enc = &rt->enc;
    /* 运行期码率/质量调整：参数变化时在抓帧线程内 reconfig，
     * 避免跨线程调用 x264（capture 线程与事件循环线程并发） */
    {
        int kbps = atomic_load(&rt->bitrate_kbps);
        int crf = atomic_load(&rt->crf);
        if (kbps != enc->cur_kbps || crf != enc->cur_crf)
        {
            enc->cur_kbps = kbps;
            enc->cur_crf = crf;
            x264_param_t p = enc->param;
            p.rc.f_rf_constant = (float)crf; /* CRF 质量档 */
            if (kbps > 0)
            {
                /* 码率上限：VBV 约束（1 秒缓冲） */
                p.rc.i_vbv_max_bitrate = kbps;
                p.rc.i_vbv_buffer_size = kbps;
            }
            else
            {
                /* 自动：恢复高上限，质量完全由 CRF 决定 */
                p.rc.i_vbv_max_bitrate = 50000;
                p.rc.i_vbv_buffer_size = 50000;
            }
            x264_encoder_reconfig(enc->enc, &p);
            log_info("编码器 reconfig: bitrate=%d crf=%d", kbps, crf);
        }
    }
    video_buf *vb = &rt->video;
    x264_picture_t pic, pic_out;
    x264_picture_init(&pic);
    x264_picture_init(&pic_out);
    pic.img.i_csp = X264_CSP_I420;
    pic.img.i_plane = 3;
    pic.img.plane[0] = vb->yuv;
    pic.img.plane[1] = vb->yuv + (size_t)vb->width * vb->height;
    pic.img.plane[2] = vb->yuv + (size_t)vb->width * vb->height * 5 / 4;
    pic.img.i_stride[0] = vb->width;
    pic.img.i_stride[1] = vb->width / 2;
    pic.img.i_stride[2] = vb->width / 2;
    pic.i_pts = rt->cap.frame_index++;
    if (atomic_exchange(&rt->cap.req_keyframe, 0))
        pic.i_type = X264_TYPE_IDR;

    x264_nal_t *nals;
    int i_nals;
    int sz = x264_encoder_encode(enc->enc, &nals, &i_nals, &pic, &pic_out);
    if (sz <= 0)
        return;

    int is_key = 0;
    size_t total = 0;
    for (int i = 0; i < i_nals; i++)
    {
        if (nals[i].i_type == NAL_SLICE_IDR)
            is_key = 1;
        total += nals[i].i_payload; /* Annex-B 已含起始码，直接拼接 */
    }
    if (total == 0)
        return;

    /* MSG_VIDEO + flags + Annex-B 字节流 */
    uint8_t *buf = malloc(2 + total);
    uint8_t *p = buf;
    *p++ = MSG_VIDEO;
    *p++ = is_key ? VIDEO_FLAG_KEY : 0;
    for (int i = 0; i < i_nals; i++)
    {
        memcpy(p, nals[i].p_payload, nals[i].i_payload);
        p += nals[i].i_payload;
    }
    conn *c = atomic_load(&rt->conn);
    if (c)
        net_push_take(c, buf, (size_t)(p - buf), 1);
    else
        free(buf);
}
