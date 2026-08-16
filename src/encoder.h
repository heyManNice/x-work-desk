#pragma once
#include <stddef.h>
#include <stdint.h>

struct AVCodecContext;
struct AVFrame;
struct AVPacket;
struct runtime;

/* 编码器子系统的自有状态 */
typedef struct encoder_ctx
{
    struct AVCodecContext *ctx; /* FFmpeg 编码上下文 */
    struct AVFrame *frame;      /* 输入帧（NV12） */
    struct AVPacket *pkt;       /* 输出包 */
    int kind;                   /* 0=libx264 1=nvenc 2=vaapi */
    int cur_kbps;               /* 当前生效码率（0=质量模式） */
    int cur_crf;                /* 当前生效质量档 */
    uint8_t *sps;
    size_t sps_len;
    uint8_t *pps;
    size_t pps_len;
} encoder_ctx;

int init_encoder(struct runtime *rt); /* 分配缓冲并打开编码器（含硬件检测与回退） */
void encode_frame(struct runtime *rt);
void encoder_close(encoder_ctx *enc); /* 关闭编码器（分辨率切换重建用） */
void encoder_destroy(encoder_ctx *enc); /* 释放编码器资源（teardown 用） */
