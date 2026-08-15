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
│  · encoder.c  x264 (ultrafast, zerolatency, baseline) H.264 编码              │
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
（`libx11-dev libxext-dev libxtst-dev`）+ `libx264`（无系统包时自建）。

```bash
# 1) 构建 x264（若系统无 libx264-dev / 无法 sudo）
cd third_party/x264 && ./configure --disable-asm --disable-cli --enable-static && make -j$(nproc)

# 2) 后端（meson）
meson setup build && ninja -C build      # 产出 build/xworkd

# 3) 前端（vite）
cd frontend && npm install && npm run build   # 产出 frontend/dist
```

## 运行

默认桌面会话为 **GNOME Shell**（自动用 `dbus-run-session` 提供会话总线）。

开发/无 root 环境（跳过真实认证，任意账号可登录，桌面以当前用户运行）：

```bash
./build/xworkd --auth none --www-root ./frontend/dist --port 8080
```

生产（root，shadow 认证，登录后以该用户身份运行 GNOME Shell）：

```bash
sudo ./build/xworkd --www-root ./frontend/dist --port 8080
# 可选：--app "gnome-shell" 显式指定；--width/--height/--fps 调整屏幕与帧率
```

打开 `http://<host>:8080/`，输入系统账号密码登录。

> 说明：`--auth shadow` 会校验真实系统密码（如 `test` / `Test1234`），并以该用户
> 身份启动会话，需要 root。若提示密码错误，请先 `sudo passwd test` 设置密码。
> 无 root 的 `--auth none` 模式不校验密码，桌面以当前进程用户运行。

## 常见问题

- **浏览器黑屏**：需 Chrome/Edge（WebCodecs）；GNOME Shell 首次启动较慢
  （约 5~10 秒），请耐心等待。
- **`Xvfb`/`xauth` 缺失**：`sudo apt install xvfb xauth`。
- **认证失败**：`--auth shadow` 必须以 root 运行才能读 `/etc/shadow`。
- **端口被占**：换 `--port`。

## 目录

```
src/        后端 C 源码（meson 管理）
frontend/   前端 Vite + 原生 TS
third_party/x264   x264 源码（自建）
test/       冒烟测试脚本（node WebSocket 客户端等）
```
