#pragma once

/* 服务端版本（编译期固定，与客户端同发布包保持一致；经 GET /api/info 暴露） */
#define XWORKD_VERSION "0.1.0"

typedef struct
{
    int port;
    char www_root[1024];
    int auth_mode; /* AUTH_SHADOW / AUTH_NONE */
    char session_cmd[1024];
    int server; /* SERVER_XVFB / SERVER_XORG */
    int width, height;
    int fps;
} config;

extern config g_cfg;

enum
{
    SERVER_XVFB = 0,
    SERVER_XORG = 1
};
