#pragma once

typedef struct
{
    int port;
    char www_root[1024];
    int auth_mode; /* AUTH_SHADOW / AUTH_NONE */
    char run_as[64];
    char session_cmd[1024];
    int width, height;
    int fps;
} config;

extern config g_cfg;
