# XWorkDesk — Linux X11 多用户低延迟远程桌面（MVP）

一个用 C 编写的多用户虚拟桌面服务器：浏览器前端仿登录管理器登录，后端（以 root 运行）
用账号密码认证后，为每个用户启动独立的 Xvfb 虚拟显示器，抓帧 + H.264 编码推流到浏览器，
并把鼠标/键盘事件回注到 X 服务器。低延迟、多用户、办公场景。

## 架构

```
┌─────────────────────────── 浏览器 (Vite + 原生 TS) ───────────────────────────┐
│  登录管理器界面  →  WebSocket(WS)  →  收到 H.264 帧 → WebCodecs 解码 → Canvas   │
│  鼠标/键盘事件 → 二进制协议消息 → WS                                       │
└────────────────────────────────────┬─────────────────────────────────────────┘
                                     │ HTTP(静态文件) + WebSocket(自研, 零依赖)
┌────────────────────────────────────▼─────────────────────────────────────────┐
│  后端 xworkd (C, meson)                                                        │
│  · net.c      自研 HTTP + WebSocket 服务器（poll 事件循环, 非阻塞）           │
│  · session.c  会话管理：每个登录用户一个 runtime                              │
│  · auth.c     shadow+crypt 认证（需 root）；--auth none 开发模式               │
│  · capture.c  Xvfb 虚拟屏 + XShmGetImage 抓帧 + BGRA→I420                     │
│  · encoder.c  H.264 编码（FFmpeg：NVENC/VAAPI 硬件优先，回退 libx264）      │
│  · input.c    XTestFakeMotion/Button/Key 输入注入                              │
└────────────────────────────────────┬─────────────────────────────────────────┘
                                     │ 启动 / 认证
                        ┌────────────▼────────────┐
                        │  Xvfb :N (每个用户独立)  │
                        │  会话应用 (openbox/xterm/--app) │
                        └─────────────────────────┘
```

- 每个 WebSocket 连接 = 一个用户会话，分配独立 display `:10` 起，X 授权用
  `/tmp/xworkd_auth_<N>`（xauth 生成 cookie）。
- 视频流：服务端关键帧（含 SPS/PPS）→ 客户端请求关键帧 → 收到后开始解码 delta 帧。
- 前端解码依赖 **WebCodecs**（Chrome / Edge；Firefox 需开启 flag）。

## 二进制协议

所有消息均为二进制 WebSocket 帧，首字节为类型：

| 方向 | 类型 | 载荷 |
|------|------|------|
| S→C | `0x01` VIDEO | flags(1) + Annex-B NAL 字节流（flags bit0=关键帧） |
| S→C | `0x02` CONFIG | w(2) h(2) spsLen(2) sps ppsLen(2) pps |
| S→C | `0x03` LOGIN_RESULT | ok(1) + 文本 |
| S→C | `0x04` CLOSE | 原因文本 |
| C→S | `0x10` LOGIN | userLen(2) user passLen(2) pass |
| C→S | `0x11` MOUSE | flags(1) x(2) y(2) [button(1) pressed(1)] |
| C→S | `0x12` KEY | pressed(1) + KeyboardEvent.code 字符串 |
| C→S | `0x13` KEYFRAME | （请求关键帧） |

## 构建

依赖：`gcc meson ninja node npm Xvfb xauth` + X11 开发头文件
（`libx11-dev libxext-dev libxtst-dev libxfixes-dev`）+ FFmpeg 开发库
（`libavcodec-dev libavutil-dev`；硬件编码需系统含 NVENC/VAAPI 支持）。

```bash
# 1) 安装依赖（Debian/Ubuntu）
sudo apt install libavcodec-dev libavutil-dev libxfixes-dev

# 2) 后端（meson）
meson setup build && ninja -C build      # 产出 build/xworkd

# 3) 前端（vite）
cd frontend && npm install && npm run build   # 产出 frontend/dist
```

## 运行

默认桌面会话为 **完整 GNOME/Ubuntu 会话**（`gnome-session --session=ubuntu`，
自动用 `dbus-run-session` 提供会话总线），会继承登录用户的主题、扩展、
输入法等配置；无 `gnome-session` 的系统退化为裸 GNOME Shell / openbox / xterm。

开发/无 root 环境（跳过真实认证，任意账号可登录，桌面以当前用户运行）：

```bash
./build/xworkd --auth none --www-root ./frontend/dist --port 5268
```

生产（root，shadow 认证，登录后以该用户身份运行 GNOME Shell）：

```bash
sudo ./build/xworkd --www-root ./frontend/dist --port 5268
# 可选：--app "gnome-shell" 显式指定；--width/--height/--fps 调整屏幕与帧率
```

打开 `http://<host>:5268/`，输入系统账号密码登录。

> 说明：`--auth shadow` 会校验真实系统密码（如 `test` / `Test1234`），并以该用户
> 身份启动会话，需要 root。若提示密码错误，请先 `sudo passwd test` 设置密码。
> 无 root 的 `--auth none` 模式不校验密码，桌面以当前进程用户运行。

## 常见问题

- **浏览器黑屏**：需 Chrome/Edge（WebCodecs）；GNOME Shell 首次启动较慢
  （约 5~10 秒），请耐心等待。
- **`Xvfb`/`xauth` 缺失**：`sudo apt install xvfb xauth`。
- **认证失败**：`--auth shadow` 必须以 root 运行才能读 `/etc/shadow`。
- **端口被占**：换 `--port`。

### 应用提示 "The login keyring did not get unlocked"（GNOME Keyring 未解锁）

**现象**：登录桌面后打开 VSCode 等应用，弹窗要求手动输入 keyring 密码；
即使输入正确密码，下次登录仍会再次弹出。

**原因**（`src/session.c` 会话启动包装脚本）：

1. 早期实现用 `gnome-keyring-daemon --start` + `--unlock` 解锁 keyring。实测
   这两个子命令在该环境下并不可靠：`--start` 新建守护进程时不输出环境变量，
   `--unlock` 往往自己再拉一个守护进程，密码送不到持有
   `org.freedesktop.secrets` 的那个守护进程上。
2. systemd 用户实例（`user@UID.service`，为 snap 应用提供 cgroup/用户总线）
   默认启用 `gnome-keyring-daemon.socket`，会抢占 `%t/keyring/control` 路径
   并再激活一个没有密码的 keyring 守护进程；应用连到的这个守护进程始终是
   锁定的，所以每次都弹窗。
3. 曾尝试给 gnome-session 加 `--builtin` 强制走内置会话管理（不向 systemd
   注册），但 Ubuntu 的 gnome-session 47 没有该选项，会导致桌面直接黑屏。

**方案**：改用与 `pam_gnome_keyring` 相同的标准流程，把登录密码交给 keyring
守护进程并让其自动解锁 login keyring（等价于正常桌面登录的 PAM 流程）：

```sh
printf '%s' "$XWD_KEYRING_PASS" | gnome-keyring-daemon --login --components=secrets
sleep 1
eval "$(gnome-keyring-daemon --start --components=secrets)"
```

该方案即使 systemd 的 `gnome-keyring-daemon.socket` 处于 active 状态也有效：
`--login` 的守护进程会抢到 secrets 服务名字，后续 socket 激活的守护进程无法
注册同名服务，应用连到的始终是已解锁的守护进程。

**注意**：keyring 密码是用户自己的登录密码（`--auth shadow` 模式）。若某用户
的 `login.keyring` 曾用其他密码创建，首次仍会弹窗让用户输入一次正确密码，
之后即自动解锁。

### 重启服务后新登录黑屏（旧会话残留）

**现象**：`sudo pkill xworkd` 后重启服务，新登录显示黑屏；日志出现
`Session manager already running`。

**原因**：重启服务时旧会话（Xvfb + gnome-session + gnome-shell）不会自动退出，
它仍占用 systemd 用户总线上的 `org.gnome.SessionManager` 名字；新会话的
gnome-session 检测到同名实例后立即退出。

**处理**：重启服务前先清理该用户的残留会话进程：

```sh
sudo pkill -u <uid> gnome-session; sudo pkill -u <uid> gnome-shell
sudo pkill -f "Xvfb :10"; sudo pkill -u <uid> gnome-keyring-daemon
```

确认 `org.gnome.SessionManager` 已无持有者后，再让用户重新登录。

## 目录

```
src/                后端 C 源码（meson 管理）
frontend/           前端 Vite + 原生 TS
deploy/             systemd 单元、安装脚本、nginx TLS 反代示例
docs/DEPLOYMENT.md  生产部署指南（权限、用户管理、资源规划、运维）
test/               冒烟测试脚本（node WebSocket 客户端等）
```

生产部署（root + shadow 认证）请先阅读 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)：
`sudo ./deploy/install.sh` 即可安装为 systemd 服务并开机自启。
