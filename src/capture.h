#pragma once
#include "session.h"

int init_shm(capture_ctx *cap, int width, int height);
void *capture_thread(void *arg);
