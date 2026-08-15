#include "encoder.h"
#include "net.h"
#include "protocol.h"
#include "config.h"
#include "util.h"

#include <stdlib.h>
#include <string.h>
#include <x264.h>

int init_encoder(runtime *rt)
{
    x264_param_t p;
    x264_param_default_preset(&p, "ultrafast", "zerolatency");
    p.i_width = rt->width;
    p.i_height = rt->height;
    p.i_csp = X264_CSP_I420;
    p.i_fps_num = g_cfg.fps > 0 ? g_cfg.fps : 30;
    p.i_fps_den = 1;
    p.i_keyint_max = 120;
    p.i_bframe = 0;
    p.b_repeat_headers = 1; /* 每个关键帧前带 SPS/PPS */
    p.i_threads = 1;
    p.rc.i_lookahead = 0;
    p.i_log_level = X264_LOG_ERROR;
    x264_param_apply_profile(&p, "baseline");

    rt->enc = x264_encoder_open(&p);
    if (!rt->enc)
    {
        log_err("x264_encoder_open 失败");
        return -1;
    }

    /* 取 SPS/PPS 用于 CONFIG 消息 */
    x264_nal_t *nal;
    int i_nal;
    if (x264_encoder_headers(rt->enc, &nal, &i_nal) < 0)
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
            rt->sps = malloc(n);
            memcpy(rt->sps, d, n);
            rt->sps_len = n;
        }
        else if (nal[i].i_type == NAL_PPS)
        {
            rt->pps = malloc(n);
            memcpy(rt->pps, d, n);
            rt->pps_len = n;
        }
    }
    if (!rt->sps || !rt->pps)
    {
        log_err("未取到 SPS/PPS");
        return -1;
    }

    rt->yuv = malloc((size_t)rt->width * rt->height * 3 / 2);
    if (!rt->yuv)
        return -1;
    return 0;
}

void encode_frame(runtime *rt)
{
    x264_picture_t pic, pic_out;
    x264_picture_init(&pic);
    x264_picture_init(&pic_out);
    pic.img.i_csp = X264_CSP_I420;
    pic.img.i_plane = 3;
    pic.img.plane[0] = rt->yuv;
    pic.img.plane[1] = rt->yuv + (size_t)rt->width * rt->height;
    pic.img.plane[2] = rt->yuv + (size_t)rt->width * rt->height * 5 / 4;
    pic.img.i_stride[0] = rt->width;
    pic.img.i_stride[1] = rt->width / 2;
    pic.img.i_stride[2] = rt->width / 2;
    pic.i_pts = rt->frame_index++;
    if (rt->req_keyframe)
    {
        pic.i_type = X264_TYPE_IDR;
        rt->req_keyframe = 0;
    }

    x264_nal_t *nals;
    int i_nals;
    int sz = x264_encoder_encode(rt->enc, &nals, &i_nals, &pic, &pic_out);
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
    if (rt->conn)
        net_push(rt->conn, buf, (size_t)(p - buf), 1);
    free(buf);
}
