#pragma once

typedef struct
{
    int port;
    char www_root[1024];
    int auth_mode; /* AUTH_SHADOW / AUTH_NONE */
    char session_cmd[1024];
    int server;    /* SERVER_XVFB / SERVER_XORG */
    int width, height;
    int fps;
} config;

extern config g_cfg;

enum
{
    SERVER_XVFB = 0,
    SERVER_XORG = 1
};
