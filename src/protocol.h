#pragma once
#include <stdint.h>

/* ---------- 服务端 -> 客户端 ---------- */
#define MSG_VIDEO 0x01        /* flags(1) + Annex-B NAL 数据 */
#define MSG_CONFIG 0x02       /* w(2) h(2) spsLen(2) sps ppsLen(2) pps */
#define MSG_LOGIN_RESULT 0x03 /* ok(1) + 文本消息 */
#define MSG_CLOSE 0x04        /* 文本原因 */

/* ---------- 客户端 -> 服务端 ---------- */
#define MSG_LOGIN 0x10    /* userLen(2) user passLen(2) pass w(2) h(2) */
#define MSG_MOUSE 0x11    /* flags(1) x(2) y(2) [button(1) pressed(1)] */
#define MSG_KEY 0x12      /* pressed(1) + code 字符串 (event.code) */
#define MSG_KEYFRAME 0x13 /* 请求关键帧 */
#define MSG_RESIZE 0x14   /* w(2) h(2)：前端视口变化，重建会话分辨率 */

#define VIDEO_FLAG_KEY 0x01    /* MSG_VIDEO flags: 关键帧 */
#define MOUSE_FLAG_MOTION 0x01 /* MSG_MOUSE flags */
#define MOUSE_FLAG_BUTTON 0x02

#define DEFAULT_WIDTH 1280
#define DEFAULT_HEIGHT 720
