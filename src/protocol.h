#pragma once
#include <stdint.h>

/* ---------- 服务端 -> 客户端 ---------- */
#define MSG_VIDEO 0x01          /* flags(1) + Annex-B NAL 数据 */
#define MSG_CONFIG 0x02         /* w(2) h(2) spsLen(2) sps ppsLen(2) pps */
#define MSG_LOGIN_RESULT 0x03   /* ok(1) + 文本消息 */
#define MSG_CLOSE 0x04          /* 文本原因 */
#define MSG_SESSION_EXISTS 0x05 /* 该账户已有活跃会话（询问是否注销接管） */
#define MSG_CURSOR 0x06         /* 光标图像：w(2) h(2) hx(2) hy(2) + RGBA */
#define MSG_AUDIO 0x07          /* Opus 音频帧（20ms/帧） */
#define MSG_CLIPBOARD 0x08      /* 剪贴板文本（UTF-8，双向） */
#define MSG_LOCAL_IN_USE 0x0e   /* 服务端→客户端：检测到实体机(seat0)正登录该账号，需先踢出实体机会话（文本=用户名） */

/* ---------- 客户端 -> 服务端 ---------- */
#define MSG_LOGIN 0x10           /* userLen(2) user passLen(2) pass w(2) h(2) */
#define MSG_MOUSE 0x11           /* flags(1) x(2) y(2) [button(1) pressed(1)] */
#define MSG_KEY 0x12             /* pressed(1) + code 字符串 (event.code) */
#define MSG_KEYFRAME 0x13        /* 请求关键帧 */
#define MSG_RESIZE 0x14          /* w(2) h(2)：前端视口变化，重建会话分辨率 */
#define MSG_TAKEOVER 0x15        /* 确认注销旧会话并接管 */
#define MSG_TAKEOVER_CANCEL 0x16 /* 取消接管 */
#define MSG_SET_FPS 0x17         /* 设置最大帧率：fps(1) */
#define MSG_SET_CODEC 0x18       /* 编码设置：staticSkip(1) bitrateKbps(2) crf(1) */
#define MSG_SET_ANIMATIONS 0x19  /* 桌面动画开关：enable(1) */
#define MSG_SET_AUDIO 0x1a       /* 音频传输开关：enable(1) */
#define MSG_SET_CLIPBOARD 0x1b   /* 剪贴板共享开关：enable(1) */
#define MSG_LOGOUT 0x1c          /* 客户端→服务端：注销当前会话（销毁桌面，等同远程注销） */
#define MSG_REQUEST_CONFIG 0x1e  /* 客户端→服务端：请求重发 CONFIG（接管后错过 SPS 时补拉流） */
#define MSG_KICK_LOCAL 0x1f      /* 客户端→服务端：确认已结束实体机会话（踢出 seat0），继续远程登录 */

#define VIDEO_FLAG_KEY 0x01    /* MSG_VIDEO flags: 关键帧 */
#define MOUSE_FLAG_MOTION 0x01 /* MSG_MOUSE flags */
#define MOUSE_FLAG_BUTTON 0x02

#define DEFAULT_WIDTH 1280
#define DEFAULT_HEIGHT 720
