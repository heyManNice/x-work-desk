#pragma once
#include <stddef.h>
#include <stdint.h>

struct x264_t;
struct runtime;

/* 编码器子系统的自有状态（CPU 软件编码：静态链接 x264，无 FFmpeg 依赖） */
typedef struct encoder_ctx
{
    struct x264_t *x264; /* x264 编码器实例 */
    int cur_kbps;        /* 当前生效码率（0=纯 CRF 质量模式） */
    int cur_crf;         /* 当前生效质量档 */
    uint8_t *sps;        /* 裸 SPS（首个关键帧提取，用于 MSG_CONFIG） */
    size_t sps_len;
    uint8_t *pps;
    size_t pps_len;
} encoder_ctx;

int init_encoder(struct runtime *rt); /* 分配 YUV 缓冲并打开 x264 编码器 */
void encode_frame(struct runtime *rt);
void encoder_close(encoder_ctx *enc);   /* 关闭编码器（分辨率/参数重建用） */
void encoder_destroy(encoder_ctx *enc); /* 释放编码器资源（teardown 用） */
