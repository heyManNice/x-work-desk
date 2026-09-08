#pragma once

/* 实体机（seat0，物理屏幕）图形会话检测与踢出 —— 基于 logind（loginctl）。
 * 仅在服务以 root 运行时有效（生产 --auth shadow）；开发态（非 root）返回 -1，
 * 调用方应跳过冲突检测，避免影响无权限环境下的联调。
 *
 * 测试钩子：设置环境变量 XWORKD_LOCAL_GUARD_FORCE=1 可强制
 * user_on_seat 返回“占用”、kick 直接成功，便于无实体机会话时验证
 * 前端提示/确认与登录流程（正式部署不会设置该变量）。 */

int localsess_user_on_seat(const char *user);        /* 1=实体机正登录 0=无 -1=无法判定 */
int localsess_kick_user(const char *user);           /* 踢出实体机会话并等待退出：0=成功 -1=失败 */
int localsess_seat_users(char users[][64], int max); /* 实体机正登录的用户名（去重），返回数量/-1 */
