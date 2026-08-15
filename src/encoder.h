#pragma once
#include "session.h"

int init_encoder(encoder_ctx *enc, video_buf *vb, int fps);
void encode_frame(runtime *rt);
