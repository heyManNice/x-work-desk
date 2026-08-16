#pragma once
#include "session.h"

int init_encoder(runtime *rt); /* 分配缓冲并打开编码器（含硬件检测与回退） */
void encode_frame(runtime *rt);
void encoder_close(encoder_ctx *enc); /* 关闭编码器（分辨率切换重建用） */
void encoder_destroy(encoder_ctx *enc); /* 释放编码器资源（teardown 用） */
