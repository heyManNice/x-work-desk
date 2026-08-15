#pragma once
#include "session.h"

int init_shm(runtime *rt);
void *capture_thread(void *arg);
