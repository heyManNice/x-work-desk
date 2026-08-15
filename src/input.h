#pragma once
#include "session.h"

void input_handle_mouse(runtime *rt, const uint8_t *data, size_t len);
void input_handle_key(runtime *rt, const uint8_t *data, size_t len);
