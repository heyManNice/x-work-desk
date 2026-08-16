#pragma once

struct runtime;

/* 桌面音频传输（audio.c）：PipeWire 采集 → Opus 编码 → MSG_AUDIO */
int audio_start(struct runtime *rt);
void audio_stop(struct runtime *rt);
