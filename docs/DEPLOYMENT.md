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
# 依赖: gcc meson ninja node npm Xvfb xauth + libx11-dev libxext-dev libxtst-dev

# 自建 x264（系统无 libx264-dev 时）
cd third_party/x264 && ./configure --disable-asm --disable-cli --enable-static && make -j$(nproc)

# 后端
cd /path/to/x-work-desk && meson setup build && ninja -C build

# 前端
cd frontend && npm install && npm run build
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

脚本做的事：校验构建产物 → 用仓库路径生成
`/etc/systemd/system/xworkd.service` → `daemon-reload` → 开机自启 → 重启服务。

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
sudo setsid nohup ./build/xworkd --auth shadow \
  --www-root ./frontend/dist --port 5268 \
  </dev/null >>/tmp/xworkd.log 2>&1 &
```

## 5. 网络与安全

> 当前服务为明文 HTTP/WS，传输登录密码与桌面画面。**公网/跨网段必须加 TLS**。

最小可行方案：nginx 反代 + `wss://`（示例见
`deploy/nginx-xworkd.conf.example`，前端会自动按页面协议选择 ws/wss）。
反代后只放行 443，5268 仅监听 127.0.0.1 或内网。

现状与建议：

- **登录限速未内置**：目前认证接口无频率限制，公网部署建议加 fail2ban 或
  在反代层限流；
- **审计**：认证成功/失败打 journald，生产环境请保留日志并定期归档；
- **端口**：默认绑定 0.0.0.0，请按需收紧防火墙；
- **同一用户多开**：每个浏览器标签页是一个独立会话，目前无每用户上限，
  资源敏感时需自行加限制或靠反代层控制。

## 6. 资源规划

- 每个在线用户 = 1 个 Xvfb + 1 个 GNOME 会话 + 1 条 x264 编码线程，
  实测单会话约 **500MB~1GB 内存 + 1~2 核**。CPU 核数决定能同时编多少路。
- 显示号分配范围为 `:10` ~ `:199`（`find_free_display`），即**最多约 190 个
  并发会话**；需要更多请改 `src/session.c` 中的范围。
- 无空闲超时：用户不注销、网络不断开会话不销毁，长期占用资源时可自行
  添加空闲断连策略。
- systemd 单元已放宽 `LimitNOFILE=65536`，避免连接数撑满默认 fd 上限。

## 7. 常见问题

- **登录失败 "无 shadow 条目"**：账号不存在，先 `useradd`。
- **登录失败 "账户已锁定"**：`sudo passwd -u <user>` 解锁。
- **黑屏**：浏览器需 Chrome/Edge（WebCodecs）；GNOME 首次启动约 5~10 秒。
- **提示 keyring 未解锁**：keyring 密码与账号密码不一致（见第 3 节）。
- **端口被占**：`sudo systemctl stop xworkd` 或换 `--port` 重新安装。
- **`Xvfb`/`xauth` 缺失**：`sudo apt install xvfb xauth`。
- **认证模式**：`--auth shadow` 必须 root；开发用 `--auth none`（任意账号
  可登录，非 root 时以当前进程用户运行会话）。
