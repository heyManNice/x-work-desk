# XWorkDesk — Linux X11 多用户低延迟远程桌面（服务端 + 桌面客户端）

服务端（C）为每个系统账号在独立虚拟显示器（headless Xorg/Xvfb）上启动 GNOME
桌面，抓帧 + H.264 编码经 WebSocket 推给客户端；客户端是 **Electron + SolidJS**
桌面应用（Windows / Linux / macOS），以标签页管理多台主机 —— 远程桌面、SSH
终端、SFTP 文件面板、系统资源监控等一站完成。

## 功能总览

**桌面客户端（frontend/，Electron + Vite + SolidJS）**

- **远程桌面**：H.264 解码渲染；分辨率可选（自动跟随窗口 / 预设）并支持
  **倍率缩放**（真实分辨率 = 所选 × `1/4…2`）；画面比例（适应/拉伸/点对点）；
  鼠标键盘输入回注；剪贴板双向共享；音频传输；桌面动画 / 静态帧优化 / 码率 /
  帧率 / 画质可配。
- **SSH 终端**：内置 xterm 终端（ssh2），侧栏主机可一键连终端；连接前自动探测
  远端是否安装服务端，未装可引导通过 SSH 一键安装。
- **远程文件（SFTP）**：工具栏“文件”面板 —— 浏览 / 上传 / 下载 / 重命名 /
  新建 / 删除 / 搜索，同一连接内记住上次目录。
- **系统资源监控**：顶栏 CPU、内存两个按钮实时显示远端占用；点开独立面板：
  CPU 占用曲线 / 型号核数 / CPU Top 进程；内存 / 缓存 / Swap / 磁盘占用。
- **主机管理**：侧栏保存多台主机（可收起，记忆状态）；每台主机独立标签，可随时
  断开 / 注销。
- **沉浸全屏**：窗口级全屏 + 顶部悬浮工具栏（鼠标移出自动隐藏）；自定义标题栏
  与窗口控制（Win/Linux 右上最小化/最大化/关闭；macOS 红黄绿灯 + 应用名置右）。
- **多平台产物**：Windows MSI(x64) / NSIS(arm64)、Linux deb(x64/arm64)、
  macOS dmg(x64/Apple Silicon)。

**服务端（src/，C + meson）**

- shadow+crypt 真实账号认证（需 root）；每个登录用户一个独立 GNOME 会话。
- Xorg dummy 虚拟显示支持运行时改分辨率（桌面不重启）；音频采集、剪贴板共享
  （含复制文件 uri-list）、文件传输 API、会话接管。

## 架构

```
┌────────────────── 桌面客户端 (Electron + Vite + SolidJS) ───────────────────┐
│  主机列表 / 标签页 / SFTP 面板 / 系统监控 / 全屏沉浸工具条                    │
│   · 远程桌面：WS → H.264 帧 → Chromium 解码 → Canvas                         │
│   · 输入：鼠标/键盘 → 二进制 WS 消息 → 远端 X                                │
│   · SSH / SFTP / 系统监控：主进程 ssh2 → 远端                                │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ HTTP + WebSocket（服务端自研，零依赖）
┌───────────────────────────────▼──────────────────────────────────────────────┐
│  后端 xworkd (C, meson)                                                       │
│  · net.c     HTTP + WebSocket 服务器（poll 事件循环）                         │
│  · session.c 会话管理：每个登录用户一个 runtime                                │
│  · auth.c    shadow+crypt 认证（需 root）；--auth none 开发模式                │
│  · capture.c Xorg(dummy)/Xvfb 虚拟屏抓帧 + BGRA→NV12                          │
│  · encoder.c H.264（CPU-only，静态链接 x264，无 FFmpeg）                    │
│  · input.c   XTest 注入鼠标/键盘                                              │
│  · audio.c / clip.c  音频采集、剪贴板共享（含文件）                            │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ 每个登录用户一套
                      ┌─────────▼──────────┐
                      │ Xorg(dummy)/Xvfb :N│
                      │ GNOME 会话          │
                      └────────────────────┘
```

- 每次登录连接对应服务端一个用户会话（独立 display，从 `:10` 起）。
- 视频流：关键帧（含 SPS/PPS）→ 客户端按需请求关键帧后解码 delta 帧。
- 同账号已在别处登录时会话提醒，可选择接管（桌面会话不销毁）。

## 二进制协议

消息为二进制 WebSocket 帧，首字节为类型（完整定义见 `frontend/src/protocol.ts`
与 `src/protocol.h`）：

| 方向 | 类型 | 含义 |
|------|------|------|
| S→C | `0x01` VIDEO | H.264 Annex-B NAL 字节流（flags bit0=关键帧） |
| S→C | `0x02` CONFIG | 宽高 + SPS/PPS |
| S→C | `0x03` LOGIN_RESULT | 登录结果 + 文本 |
| S→C | `0x04` CLOSE | 关闭原因 |
| S→C | `0x05` SESSION_EXISTS | 同账号已有会话，需接管确认 |
| S→C | `0x06` CURSOR | 远程光标图像 |
| S→C | `0x07` AUDIO | 音频帧 |
| S→C | `0x08` CLIPBOARD | 剪贴板文本 |
| S→C | `0x09` TRANSFER_TOKEN | 文件传输会话令牌 |
| S→C | `0x0a` TRANSFER_REQUEST | 文件传输请求（下载/上传） |
| S→C | `0x0b` TRANSFER_ERROR | 传输错误 |
| S→C | `0x0c` CLIPBOARD_FILES | 剪贴板复制的文件路径列表 |
| S→C | `0x0d` SESSION_DIRS | home / desktop 目录 |
| C→S | `0x10` LOGIN | user/pass + 请求宽高 |
| C→S | `0x11` MOUSE | 移动 / 按键 |
| C→S | `0x12` KEY | 键盘事件（KeyboardEvent.code） |
| C→S | `0x13` KEYFRAME | 请求关键帧 |
| C→S | `0x14` RESIZE | 变更分辨率 |
| C→S | `0x15`/`0x16` TAKEOVER(_CANCEL) | 接管 / 取消接管 |
| C→S | `0x17` SET_FPS / `0x18` SET_CODEC / `0x19` SET_ANIMATIONS / `0x1a` SET_AUDIO / `0x1b` SET_CLIPBOARD | 编码与功能开关 |
| C→S | `0x1c` LOGOUT / `0x1e` REQUEST_CONFIG | 注销 / 请求重发 CONFIG |

## 构建

依赖：`gcc meson ninja node npm Xvfb xauth` + X11 开发头
（`libx11-dev libxext-dev libxtst-dev libxfixes-dev`）+ 编码库
（`libx264-dev` 提供静态库；音频用 `libopus-dev`）。H.264 为 CPU 软件
编码（静态 x264，无 FFmpeg/libavcodec 依赖）。

```bash
# 1) 后端（meson；系统无 libx264-dev 时先自建：
#    cd third_party/x264 && ./configure --enable-static --disable-cli \
#        --disable-shared && make -j$(nproc)，再执行下方命令）
sudo apt install libx264-dev libopus-dev libxfixes-dev xvfb xauth
meson setup build && ninja -C build        # 产出 build/xworkd（静态 x264，无动态 FFmpeg）

# 2) 前端（vite，被 Electron 加载）
cd frontend && npm install && npm run build   # 产出 frontend/dist

# 3) 单元测试（纯逻辑模块，可无头运行）
meson test -C build    # test-util / test-msgq / test-ws
```

**桌面客户端（开发运行）**：

```bash
cd frontend && npm install
DISPLAY=:0 npx electron .     # Linux 桌面壳开发运行（加载 dist）
```

**打包**（electron-builder）：

```bash
cd frontend
npx electron-builder --win msi        # Windows MSI（x64）
npx electron-builder --win nsis --arm64   # Windows ARM64 原生 NSIS
npx electron-builder --linux deb      # Linux deb
npx electron-builder --mac dmg        # macOS dmg（x64 / --arm64）
```

仓库内置 CI：`.github/workflows/build-packages.yml`（手动触发）并行打
Windows MSI / NSIS、Linux deb、macOS dmg × x64+arm64 共 6 个产物并上传。

## 运行

服务端默认会话为完整 GNOME/Ubuntu 会话（`gnome-session --session=ubuntu`，
`dbus-run-session` 提供会话总线）。开发 / 无 root（`--auth none` 任意账号，
桌面以当前用户运行）：

```bash
./build/xworkd --auth none --www-root ./frontend/dist --port 5268
```

生产（root，shadow 认证，登录后以该账号运行 GNOME 会话）：

```bash
sudo ./build/xworkd --auth shadow --www-root ./frontend/dist --port 5268
# 可选：--app "gnome-shell"；--width/--height/--fps；--server xorg|xvfb
```

**使用客户端**：启动桌面客户端 → 新建主机填 `host`（可用 `user@host[:port]`，
协议默认 `http://` + 端口 5268，可写 `https://`）→ 双击 / 右键连接。远程桌面
连接前会先经 SSH 探测服务端，未装可一键引导安装。服务端同机自测也可直接用
浏览器打开 `http://127.0.0.1:5268/`（同源部署为兜底，功能以桌面客户端为准）。

> `--auth shadow` 校验真实系统密码，并以该用户身份启动会话，需要 root。
> 无 root 的 `--auth none` 不校验密码，桌面以当前进程用户运行。

## 常见问题

- **视频黑屏 / 一直加载**：客户端 Electron 无需额外 WebCodecs 配置；多为
  GNOME 首次启动较慢（约 5~10 秒）或服务端旧会话残留所致（见下条）。
- **`Xvfb` / `xauth` 缺失**：`sudo apt install xvfb xauth`。
- **认证失败**：`--auth shadow` 必须以 root 运行；确认账号存在且已设密码
  （`sudo passwd test`）。
- **端口被占**：换 `--port` 重装 / 重启。

### 重启服务后新登录黑屏（旧会话残留）

`sudo pkill xworkd` 重启后旧会话（Xorg/Xvfb + gnome-session + gnome-shell）不会
自动退出，仍占用用户总线上的 `org.gnome.SessionManager` 名字，新登录会话检测到
同名实例即退出 → 黑屏。重启服务前先清理该用户残留会话：

```sh
sudo pkill -u <uid> gnome-session; sudo pkill -u <uid> gnome-shell
sudo pkill -f "Xorg :10"; sudo pkill -u <uid> gnome-keyring-daemon
```

确认 `org.gnome.SessionManager` 无持有者后再让用户重新登录。

### 应用提示 "The login keyring did not get unlocked"

登录桌面后应用弹 keyring 密码，多因 keyring 密码与账号密码不一致。会话启动
采用与 PAM 相同的标准流程自动解锁 login keyring（密码=账号密码）。若 keyring
曾用别的密码创建，首次需在会话内用 seahorse 改回或删除
`~/.local/share/keyrings/` 重建。

## 目录

```
src/                后端 C 源码（meson 管理）
frontend/           桌面客户端：Vite+SolidJS 前端 + Electron 壳 + core/* 模块
  electron/         主进程（ssh2 / SFTP / 系统监控 / 窗口控制 IPC）
  src/core/         会话、SSH 终端、SFTP 文件面板、系统监控、通知中心、弹窗协调
  server-bundle/    内置服务端安装包（一键安装用）
  build-resources/  打包图标
deploy/             systemd 单元、安装脚本、nginx TLS 反代示例、WirePlumber 覆盖
docs/DEPLOYMENT.md  服务端生产部署指南（权限、用户管理、资源规划、运维）
test/               服务端测试（node WebSocket 客户端、单元测试、冒烟脚本）
third_party/        内置 x264（系统无 libx264-dev 时使用）
```

生产部署（root + shadow 认证）请先阅读 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)：
`sudo ./deploy/install.sh` 即可安装为 systemd 服务并开机自启。

