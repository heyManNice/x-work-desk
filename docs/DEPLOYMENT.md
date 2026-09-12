# XWorkDesk 生产部署指南

本文面向多用户正式部署（`--auth shadow`，真实系统账号认证）。开发调试用
`--auth none` 即可，见项目 README。

## 1. 权限要求

服务**必须以 root 运行**，原因：

- shadow 认证要读 `/etc/shadow`（`getspnam`）；
- 每个登录用户需要 `setuid/setgid/initgroups` 切换到自己的身份；
- 需要创建并 chown 目标用户的 `/run/user/<uid>` 运行时目录。

不需要知道 root 密码：把服务加入 `sudo` 组的管理员账号
（`sudo ./deploy/install.sh`）即可获得同等能力。

## 2. 依赖与构建

```bash
# 依赖: gcc meson ninja node npm xauth + libx11-dev libxext-dev libxtst-dev
#       + libx264-dev libopus-dev（H.264 静态 x264 软件编码，无 FFmpeg）
#       虚拟显示：xserver-xorg-video-dummy（默认 --server xorg）+ xvfb（回退
#       --server xvfb）+ x11-xserver-utils（cvt，运行期改分辨率）

# 自建 x264（系统无 libx264-dev 时；生成 libx264.a 供 meson 静态链接）
cd third_party/x264 && ./configure --enable-static --disable-cli --disable-shared && make -j$(nproc)

# 后端
# 可选：apt install libibus-1.0-dev —— 只有装了这个才会额外构建「本机输入法」的
#       远端 ibus 中继引擎（im/xworkd-im.c）。它是可选目标：缺开发包时 meson 自动跳过，
#       不影响远程桌面本身。引擎会随 deploy/install.sh 与服务端包一起分发。
cd /path/to/x-work-desk && meson setup build && ninja -C build

# 桌面客户端（主进程 TypeScript + 渲染层 Vite）
cd frontend && npm install && npm run build
# 产出 dist-electron/（主进程）与 dist/（渲染层）
```

## 3. 用户管理
每个可登录用户必须是一个**本地系统账号**（暂不支持 LDAP/AD）：

```bash
sudo useradd -m -s /bin/bash <user>
sudo passwd <user>
```

要点：

- **keyring 密码必须等于账号密码**。服务会在会话启动时用登录密码自动解锁
  GNOME Keyring；若用户曾把 keyring 设成别的密码，应用仍会弹提示，需用
  seahorse 改回或删除 `~/.local/share/keyrings/` 重建。
- 用户的 home 目录建议放在本地盘（GNOME 在 NFS 上易出问题）。
- 登录失败会记录到 journald，日志里不含密码。

## 4. systemd 部署（推荐）

```bash
# 默认端口 5268
sudo ./deploy/install.sh

# 自定义端口 / 会话参数
XWORKD_PORT=8080 XWORKD_EXTRA_ARGS="--width 1920 --height 1080 --fps 60" sudo ./deploy/install.sh
```

脚本做的事：校验构建产物 → 安装 xserver-xorg-video-dummy → 用仓库路径生成
`/etc/systemd/system/xworkd.service` → 安装 GNOME Shell 动画覆盖与
WirePlumber 音频覆盖 → 对在线用户 `systemctl --user daemon-reload` 并重启
wireplumber → 接入实体机登录拦截 PAM（`install-pam.sh`，无 GDM 自动跳过）→
清理旧版 Nautilus 扩展残留 → 开机自启 → 重启服务。

**虚拟显示服务器（`--server`）**：默认 `xorg`——每用户一个 headless
Xorg + dummy 驱动（无显示器/显卡，内存帧缓冲），支持 RandR 运行时改
分辨率：前端窗口变化时 `xrandr` 直接切换屏幕尺寸，抓帧管线重建编码器并
重发 CONFIG，**桌面不重启**。切换分辨率约 100ms。启动配置见
`src/sessproc.c` 的 `write_xorg_conf`（Virtual 上限 8192x8192）。
`--server xvfb` 可回退到旧行为（改分辨率需重建桌面，已改为异步重建 +
systemctl 超时，不再卡住事件循环）。运行时改分辨率依赖 `cvt`
（`x11-xserver-utils`）。

**GNOME 动画覆盖（`--force-animations`）**：Xvfb 是软件渲染
（llvmpipe），GNOME Shell 48+ 检测到非硬件加速会强制抑制动画，使前端
"桌面动画"开关不生效。部署脚本会给用户 systemd 单元
`org.gnome.Shell@x11.service` 写入覆盖，给 gnome-shell 加
`--force-animations` 跳过抑制；动画实际开/关仍由前端开关控制
（`org.gnome.desktop.interface enable-animations`，默认关，打开时动画
期间 CPU 占用会明显上升）。实体机硬件渲染时该覆盖无副作用；不需要可
删除 `/etc/systemd/user/org.gnome.Shell@x11.service.d/` 后对每个在线用户
执行 `systemctl --user daemon-reload`。

**音频覆盖（VM 内禁用模拟声卡）**：VMware 等虚拟机模拟的 PCI 声卡
（ES1371）在 PipeWire 下时序不稳定，输出全零导致音频采集静音。部署脚本
安装 WirePlumber 规则，仅当节点带 `cpu.vm.name`（即虚拟机内）时禁用
ALSA PCI 输出/输入节点，会话回退到 Dummy Output，桌面音频经软件 sink 的
monitor 稳定采集。客户端播放声音，虚拟机本地无需出声。实体机没有
`cpu.vm.name`，真实声卡不受影响；不需要时删除
`/etc/xdg/wireplumber/wireplumber.conf.d/50-xworkd-vm-audio.conf` 并重启各
用户 wireplumber。

音频采集依赖 PipeWire 命令行工具（`pw-record`/`pw-link`/`pw-metadata`，
软件包 `pipewire-bin`）。采集逻辑见 `src/audio.c`：查询用户会话默认输出
sink 的 monitor 端口并接入录音流（20ms 小延迟），不再写死 `auto_null`。

常用运维命令：

```bash
systemctl status xworkd          # 状态
journalctl -u xworkd -f          # 实时日志
sudo systemctl restart xworkd    # 重启
sudo systemctl stop xworkd       # 停止
```

卸载：

```bash
sudo systemctl disable --now xworkd
sudo rm /etc/systemd/system/xworkd.service
sudo systemctl daemon-reload
```

无 systemd 的环境手动运行：

```bash
sudo setsid nohup ./build/xworkd --auth shadow --port 5268 \
  </dev/null >>/tmp/xworkd.log 2>&1 &
```

### 本机输入法引擎（可选）

构建时若装了 `libibus-1.0-dev`，`deploy/install.sh` 与服务端包会额外安装：

| 文件 | 位置 | 说明 |
|---|---|---|
| `xworkd-im` | `/usr/libexec/xworkd/xworkd-im` | ibus 中继引擎（组件 XML 里的 `<exec>` 指到这里） |
| `xworkd-im.xml` | `/usr/share/ibus/component/xworkd-im.xml` | ibus 组件注册；缺它 GNOME 输入源里看不到该引擎 |

卸载（客户端「关于 → 卸载服务端」也会做这几步）：删这两个文件 + `ibus write-cache`。
运行时由服务端在**会话内**把它挂成当前 GNOME 输入源（客户端勾选「本机输入法」时），
关闭/断开时恢复原来的输入源。注意：**同一个用户**的远程会话与本机桌面共用一份 dconf，
所以勾选期间该用户桌面的输入源也会被切换（关闭即恢复）。

## 5. 网络与安全

> 当前服务为**明文 HTTP/WS**，传输登录密码与桌面画面。限本机/可信内网使用；
> 跨网段或公网请自行加一层加密（本仓库不内置、也不提供现成反代配置）。

两种常见做法（任选其一，都需要你自己部署）：

- **TLS 反代**：自己用 nginx/Caddy 等终止 TLS，反代到 `127.0.0.1:5268`（需升级
  WebSocket）。客户端填「服务器地址 `https://host`」+「远程桌面端口 = 反代端口」。
- **SSH 隧道**：把 `127.0.0.1:5268` 通过 SSH 转发到本地（如
  `ssh -L 5268:127.0.0.1:5268 user@host`），客户端直连 `127.0.0.1:5268`。
  加密由 SSH 提供，服务端无需任何改动；注意隧道方案下不需要把 5268 对外暴露。

> 服务端不再提供前端静态文件（客户端自带界面离线加载），浏览器直接访问
> `http://host:5268/` 只会得到 404。

现状与建议：

- **登录限速未内置**：目前认证接口无频率限制，公网部署建议加 fail2ban 或
  在反代层限流；
- **接口面**：服务端只暴露 WebSocket `/ws`、版本信息 `/api/info` 与本机
  `127.0.0.1` 专用的 `/api/local/`（令牌在 `/run/xworkd/local.token`）。无文件
  传输 HTTP 接口（已移除，文件传输走客户端 SFTP）；反代时建议直接拒绝
  `/api/local/` 的对外暴露；
- **审计**：认证成功/失败打 journald，生产环境请保留日志并定期归档；
- **端口**：默认绑定 0.0.0.0，请按需收紧防火墙；
- **同一用户多开**：每个客户端连接都是一个独立会话，目前无每用户上限，
  资源敏感时需自行加限制或靠反代层控制。

## 6. 资源规划

- 每个在线用户 = 1 个虚拟 X 服务器（默认 headless Xorg+dummy，`--server xvfb`
  时是 Xvfb）+ 1 个 GNOME 会话 + 1 条 x264 编码线程，
  实测单会话约 **500MB~1GB 内存 + 1~2 核**。CPU 核数决定能同时编多少路。
- 显示号分配范围为 `:10` ~ `:199`（`find_free_display`，见 `src/sessproc.c`），即
  **最多约 190 个并发会话**；需要更多请改该函数的上界。
- 无空闲超时：用户不注销、网络不断开会话不销毁，长期占用资源时可自行
  添加空闲断连策略。
- systemd 单元已放宽 `LimitNOFILE=65536`，避免连接数撑满默认 fd 上限。

**实体机与远程冲突（root + `--auth shadow` 部署自动启用）**

- 远程登录前若检测到该账号正坐在实体机屏幕（`seat0`，如 GDM 图形登录）前
  使用，前端会提示“踢出实体机”，确认后服务端执行
  `loginctl terminate-session` 结束实体机会话（GNOME 回落 greeter），随后才
  建立远程会话；
- 反向：实体机 GDM 登录同一账号时，安装脚本（`deploy/install-pam.sh`，随
  server-bundle 一并分发）把守卫 `xworkd-gdm-guard` 接入 `/etc/pam.d/gdm-password`
  （`auth optional pam_exec`，密码验证通过后执行）。登录动作发生时守卫调用服务端
  本地接口（`127.0.0.1:5268/api/local/session[/end]`，令牌在 `/run/xworkd/local.token`）
  结束该账号的远程会话——此刻实体机桌面尚未创建，注销远程是安全的，实体机
  **一次干净登录**，远程端收到明确原因；
- 踢出实体机会话是**不可撤销**操作（等同注销该用户桌面并丢弃其中未保存
  内容），登录前弹窗会再次向用户说明，取消可中止本次远程登录；
- 开发态（`--auth none` / 非 root）自动跳过冲突检测；目标机无 GDM（纯 headless）
  时 install-pam 自动跳过 PAM 接入，不影响纯远程使用。

## 7. 常见问题

- **登录失败 "无 shadow 条目"**：账号不存在，先 `useradd`。
- **登录失败 "账户已锁定"**：`sudo passwd -u <user>` 解锁。
- **视频黑屏**：客户端为 Electron（Chromium）无需额外设置；多为 GNOME 首次
  启动约 5~10 秒或服务端旧会话残留（见 README）。
- **提示 keyring 未解锁**：keyring 密码与账号密码不一致（见第 3 节）。
- **端口被占**：`sudo systemctl stop xworkd` 或换 `--port` 重新安装。
- **`Xvfb`/`xauth` 缺失**：`sudo apt install xvfb xauth`。
- **`pw-record` 等缺失**：`sudo apt install pipewire-bin`（音频传输需要）。
- **认证模式**：`--auth shadow` 必须 root；开发用 `--auth none`（任意账号
  可登录，非 root 时以当前进程用户运行会话）。
