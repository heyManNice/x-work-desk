#pragma once
#include "net.h"

/* 处理 /api 下的文件传输请求。
 * method: "GET"/"POST"；path_q: 含 query 的原始路径；
 * xworkd_token: 扩展请求头 X-Workd-Token（可为 NULL）；
 * body/body_len: POST body（http.c 已累积完整）。
 * 返回 1=已处理（含错误响应），0=未匹配。 */
int transfer_handle_http(conn *c, const char *method, const char *path_q,
                         const char *xworkd_token,
                         const uint8_t *body, size_t body_len);
