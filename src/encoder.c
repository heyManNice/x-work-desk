/* encoder.c —— H.264 编码器（FFmpeg libavcodec 封装）。
 * 编码器按可用性选择：h264_nvenc（NVIDIA）→ h264_vaapi（Intel/AMD）
 * → libx264（软件回退）。码率/质量档运行期可调（重建编码器）。
 * 统一使用 NV12 输入、global header（SPS/PPS 在 extradata，
 * 前端用 avcC description 配置解码器，不依赖关键帧携带参数集）。 */
#define _POSIX_C_SOURCE 200809L
#include "encoder.h"
#include "net.h"
#include "protocol.h"
#include "config.h"
#include "util.h"

#include <stdlib.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/pixfmt.h>
#include <libavutil/hwcontext.h>

enum
{
    ENC_X264 = 0,
    ENC_NVENC = 1,
    ENC_VAAPI = 2
};

static const char *kind_name(int kind)
{
    switch (kind)
    {
    case ENC_NVENC: return "nvenc";
    case ENC_VAAPI: return "vaapi";
    default: return "libx264";
    }
}

/* 从 avcC extradata 解析裸 SPS/PPS NAL（前端 description / codec string 用） */
/* 从 Annex-B 字节流解析裸 SPS(7)/PPS(8) NAL，写入 enc（已有则跳过） */
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

/* 从编码器 extradata 解析 SPS/PPS（avcC 或 Annex-B） */
static void extract_sps_pps(encoder_ctx *enc)
{
    AVCodecContext *ctx = enc->ctx;
    if (!ctx->extradata || ctx->extradata_size < 5)
        return;
    /* avcC 格式：[0]=1 [1]=profile [2]=compat [3]=level [4]=0xff [5]=0xe1
     *             [6..7]=spsLen sps [8+spsLen]=1 [9..10]=ppsLen pps */
    if (ctx->extradata[0] == 1 && ctx->extradata_size >= 11)
    {
        uint8_t *e = ctx->extradata;
        int sps_len = (e[6] << 8) | e[7];
        int pps_len = (e[8 + sps_len + 1] << 8) | e[8 + sps_len + 2];
        if (sps_len > 0 && 8 + sps_len + 2 + pps_len <= ctx->extradata_size)
        {
            enc->sps = malloc((size_t)sps_len);
            memcpy(enc->sps, e + 8, (size_t)sps_len);
            enc->sps_len = (size_t)sps_len;
            enc->pps = malloc((size_t)pps_len);
            memcpy(enc->pps, e + 11 + sps_len, (size_t)pps_len);
            enc->pps_len = (size_t)pps_len;
        }
        return;
    }
    /* Annex-B 格式（libx264 global header）：00 00 00 01 67(SPS) ... 00 00 00 01 68(PPS)
     * 提取裸 NAL（含类型字节，去掉起始码） */
    extract_sps_pps_annexb(enc, ctx->extradata, ctx->extradata_size);
}

/* 用指定编码器打开；成功返回 0，失败返回 -1（调用方负责回退） */
static int encoder_open_kind(runtime *rt, const AVCodec *codec, int kind,
                             int kbps, int crf)
{
    encoder_ctx *enc = &rt->enc;
    video_buf *vb = &rt->video;
    int fps = atomic_load(&rt->fps) > 0 ? atomic_load(&rt->fps) : 30;

    AVCodecContext *ctx = avcodec_alloc_context3(codec);
    if (!ctx)
        return -1;
    ctx->width = vb->width;
    ctx->height = vb->height;
    ctx->time_base = (AVRational){1, fps};
    ctx->framerate = (AVRational){fps, 1};
    ctx->gop_size = 120;
    ctx->max_b_frames = 0;
    ctx->pix_fmt = AV_PIX_FMT_NV12;
    ctx->bit_rate = kbps > 0 ? kbps * 1000 : 0;

    if (kind == ENC_X264)
    {
        av_opt_set(ctx->priv_data, "preset", "ultrafast", 0);
        av_opt_set(ctx->priv_data, "tune", "zerolatency", 0);
        av_opt_set(ctx->priv_data, "crf", crf > 0 ? "18" : "23", 0); /* 默认质量档 */
        if (crf > 0)
        {
            char buf[16];
            snprintf(buf, sizeof buf, "%d", crf);
            av_opt_set(ctx->priv_data, "crf", buf, 0);
        }
        if (kbps > 0)
        {
            /* CRF + VBV 码率上限 */
            av_opt_set(ctx->priv_data, "maxrate", "0", 0);
            av_opt_set(ctx->priv_data, "bufsize", "0", 0);
            char br[32];
            snprintf(br, sizeof br, "%d", kbps * 1000);
            av_opt_set(ctx->priv_data, "maxrate", br, 0);
            av_opt_set(ctx->priv_data, "bufsize", br, 0);
        }
    }
    else if (kind == ENC_NVENC)
    {
        av_opt_set(ctx->priv_data, "preset", "p1", 0); /* 最低延迟档 */
        av_opt_set(ctx->priv_data, "tune", "ull", 0);
        av_opt_set(ctx->priv_data, "zerolatency", "1", 0);
        av_opt_set(ctx->priv_data, "rc-lookahead", "0", 0);
        if (kbps > 0)
        {
            av_opt_set(ctx->priv_data, "rc", "cbr", 0);
            char br[32];
            snprintf(br, sizeof br, "%d", kbps * 1000);
            av_opt_set(ctx->priv_data, "b", br, 0);
            av_opt_set(ctx->priv_data, "maxrate", br, 0);
            av_opt_set(ctx->priv_data, "bufsize", br, 0);
        }
        else
        {
            av_opt_set(ctx->priv_data, "rc", "constqp", 0);
            char cq[16];
            /* NVENC cq：0 最高质量，51 最差；与质量档映射 */
            snprintf(cq, sizeof cq, "%d", crf > 0 ? crf : 18);
            av_opt_set(ctx->priv_data, "cq", cq, 0);
        }
    }
    else /* VAAPI */
    {
        AVBufferRef *hw_ctx = NULL;
        if (av_hwdevice_ctx_create(&hw_ctx, AV_HWDEVICE_TYPE_VAAPI, NULL, NULL, 0) < 0)
        {
            avcodec_free_context(&ctx);
            return -1;
        }
        AVBufferRef *frames_ref = av_hwframe_ctx_alloc(hw_ctx);
        if (!frames_ref)
        {
            av_buffer_unref(&hw_ctx);
            avcodec_free_context(&ctx);
            return -1;
        }
        AVHWFramesContext *frames = (AVHWFramesContext *)frames_ref->data;
        frames->format = AV_PIX_FMT_VAAPI;
        frames->sw_format = AV_PIX_FMT_NV12;
        frames->width = vb->width;
        frames->height = vb->height;
        frames->initial_pool_size = 4;
        if (av_hwframe_ctx_init(frames_ref) < 0)
        {
            av_buffer_unref(&frames_ref);
            av_buffer_unref(&hw_ctx);
            avcodec_free_context(&ctx);
            return -1;
        }
        ctx->hw_frames_ctx = frames_ref;
        ctx->pix_fmt = AV_PIX_FMT_VAAPI;
        if (kbps > 0)
        {
            char br[32];
            snprintf(br, sizeof br, "%d", kbps * 1000);
            av_opt_set(ctx->priv_data, "rc_mode", "CBR", 0);
            av_opt_set(ctx->priv_data, "b", br, 0);
            av_opt_set(ctx->priv_data, "maxrate", br, 0);
        }
        av_opt_set(ctx->priv_data, "compression_level", "1", 0);
    }

    if (avcodec_open2(ctx, codec, NULL) < 0)
    {
        avcodec_free_context(&ctx);
        return -1;
    }
    enc->ctx = ctx;
    enc->kind = kind;
    enc->cur_kbps = kbps;
    enc->cur_crf = crf;
    enc->frame = av_frame_alloc();
    enc->pkt = av_packet_alloc();
    if (!enc->frame || !enc->pkt)
        return -1;
    extract_sps_pps(enc);
    log_info("编码器: %s (%dx%d fps=%d)", kind_name(kind), vb->width, vb->height, fps);
    return 0;
}

/* 打开编码器（nvenc → vaapi → libx264 回退），成功返回 0 */
static int encoder_open(runtime *rt, int kbps, int crf)
{
    const AVCodec *codec;

    /* 无损（CRF 0）硬件编码器不支持，直接回退 libx264 */
    if (crf > 0)
    {
        codec = avcodec_find_encoder_by_name("h264_nvenc");
        if (codec && encoder_open_kind(rt, codec, ENC_NVENC, kbps, crf) == 0)
            return 0;
        codec = avcodec_find_encoder_by_name("h264_vaapi");
        if (codec && encoder_open_kind(rt, codec, ENC_VAAPI, kbps, crf) == 0)
            return 0;
    }
    codec = avcodec_find_encoder(AV_CODEC_ID_H264);
    if (!codec)
    {
        log_err("找不到 H.264 编码器");
        return -1;
    }
    return encoder_open_kind(rt, codec, ENC_X264, kbps, crf);
}

/* 关闭并释放编码器（SPS/PPS 一并清空，重建后首个关键帧重新提取） */
void encoder_close(encoder_ctx *enc)
{
    if (enc->pkt)
        av_packet_free(&enc->pkt);
    if (enc->frame)
        av_frame_free(&enc->frame);
    if (enc->ctx)
        avcodec_free_context(&enc->ctx);
    enc->ctx = NULL;
    enc->kind = 0;
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
    enc->ctx = NULL;
    enc->frame = NULL;
    enc->pkt = NULL;
    enc->sps = NULL;
    enc->pps = NULL;
    enc->sps_len = enc->pps_len = 0;
    enc->cur_kbps = 0;
    enc->cur_crf = 23;
    enc->kind = 0;
    /* 立即打开编码器（含硬件检测与回退），失败则返回 -1 */
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
    if (!enc->ctx)
    {
        return;
    }

    AVFrame *frame = enc->frame;
    if (enc->kind == ENC_VAAPI)
    {
        /* 软件 NV12 帧上传到 VAAPI 硬件帧 */
        AVFrame *sw = av_frame_alloc();
        if (!sw)
        {
            return;
        }
        sw->format = AV_PIX_FMT_NV12;
        sw->width = vb->width;
        sw->height = vb->height;
        if (av_frame_get_buffer(sw, 32) < 0)
        {
            av_frame_free(&sw);
            return;
        }
        memcpy(sw->data[0], vb->yuv, (size_t)vb->width * vb->height);
        memcpy(sw->data[1], vb->yuv + (size_t)vb->width * vb->height,
               (size_t)vb->width * vb->height / 2);
        if (av_hwframe_get_buffer(enc->ctx->hw_frames_ctx, frame, 0) < 0 ||
            av_hwframe_transfer_data(frame, sw, 0) < 0)
        {
            av_frame_free(&sw);
            return;
        }
        av_frame_free(&sw);
    }
    else
    {
        frame->format = AV_PIX_FMT_NV12;
        frame->width = vb->width;
        frame->height = vb->height;
        frame->data[0] = vb->yuv;
        frame->data[1] = vb->yuv + (size_t)vb->width * vb->height;
        frame->linesize[0] = vb->width;
        frame->linesize[1] = vb->width;
    }
    frame->pts = rt->cap.frame_index++;
    if (atomic_exchange(&rt->cap.req_keyframe, 0))
        frame->pict_type = AV_PICTURE_TYPE_I;

    if (avcodec_send_frame(enc->ctx, frame) < 0)
    {
        return;
    }
    while (avcodec_receive_packet(enc->ctx, enc->pkt) == 0)
    {
        int is_key = (enc->pkt->flags & AV_PKT_FLAG_KEY) != 0;
        /* 关键帧携带 SPS/PPS（未设 global header）；首次提取后发 CONFIG，
         * 重建编码器（reconfig）后 sps 被清空，会再次提取并重发 */
        if (is_key && !enc->sps)
        {
            extract_sps_pps_annexb(enc, enc->pkt->data, enc->pkt->size);
            if (enc->sps && enc->pps)
            {
                conn *c = atomic_load(&rt->conn);
                if (c)
                    encoder_send_config_locked(c, rt);
            }
        }
        size_t total = enc->pkt->size;
        if (total == 0)
            continue;
        uint8_t *buf = malloc(2 + total);
        uint8_t *p = buf;
        *p++ = MSG_VIDEO;
        *p++ = is_key ? VIDEO_FLAG_KEY : 0;
        memcpy(p, enc->pkt->data, total);
        conn *c = atomic_load(&rt->conn);
        if (c)
            net_push_take(c, buf, 2 + total, 1);
        else
            free(buf);
        av_packet_unref(enc->pkt);
    }
}
