#pragma once

struct runtime;

void input_handle_mouse(struct runtime *rt, const uint8_t *data, size_t len);
void input_handle_key(struct runtime *rt, const uint8_t *data, size_t len);
