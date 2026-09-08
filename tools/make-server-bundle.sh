#!/usr/bin/env bash
# 制作随客户端分发的 xworkd 服务端自包含安装包（Linux amd64，Ubuntu/Debian）。
#
# 用法:  tools/make-server-bundle.sh
# 产出:  frontend/server-bundle/xworkd-server.tar.gz
#
# 安装包内：xworkd 二进制 + www(frontend/dist) + install.sh（apt 依赖→systemd 安装启动）
# 远端安装：sudo bash install.sh   （由客户端经 SSH sftp 推送后以 sudo 执行）

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO="$(pwd)"

BIN="$REPO/build/xworkd"
DIST="$REPO/frontend/dist"
OUT="$REPO/frontend/server-bundle/xworkd-server.tar.gz"
STAGE="$REPO/build/bundle"
SERVICE_NAME="xworkd"
PREFIX="/opt/$SERVICE_NAME"

if [[ ! -x "$BIN" ]]; then echo "缺少 $BIN（先构建后端）"; exit 1; fi
if [[ ! -f "$DIST/index.html" ]]; then echo "缺少 $DIST（先构建前端）"; exit 1; fi

rm -rf "$STAGE"
mkdir -p "$STAGE/xworkd-server/www"
cp "$BIN" "$STAGE/xworkd-server/xworkd"
cp -r "$DIST"/. "$STAGE/xworkd-server/www/"
cp "$REPO/deploy/xworkd-gdm-guard" "$STAGE/xworkd-server/xworkd-gdm-guard"
cp "$REPO/deploy/install-pam.sh" "$STAGE/xworkd-server/install-pam.sh"

cat > "$STAGE/xworkd-server/install.sh" <<EOF
#!/usr/bin/env bash
# xworkd 服务端一键安装（需 root）。目标需为可运行 GNOME 桌面的 Ubuntu/Debian 主机。
set -euo pipefail
if [[ \$(id -u) -ne 0 ]]; then echo "需要 root"; exit 1; fi
PREFIX="$PREFIX"
mkdir -p "\$PREFIX"
echo "[xworkd] 安装运行/会话基础依赖（ffmpeg/Xorg dummy 等）..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null 2>&1 || true
apt-get install -y ffmpeg xserver-xorg-video-dummy x11-xserver-utils xauth xclip dbus-x11 >/dev/null 2>&1 || true
install -m 0755 xworkd "\$PREFIX/xworkd"
rm -rf "\$PREFIX/www"
cp -r www "\$PREFIX/www"
cat > /etc/systemd/system/$SERVICE_NAME.service <<UNIT
[Unit]
Description=XWorkDesk remote desktop server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
ExecStart=\$PREFIX/xworkd --auth shadow --www-root \$PREFIX/www --port 5268
WorkingDirectory=\$PREFIX
Restart=on-failure
RestartSec=3
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME
NoNewPrivileges=no
PrivateTmp=no

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable $SERVICE_NAME >/dev/null 2>&1 || true
# 接入实体机登录拦截 PAM（幂等；无 GDM 自动跳过）。cwd = 解包目录
bash install-pam.sh
systemctl restart $SERVICE_NAME
sleep 1
echo XWORKD_INSTALL_OK
EOF
chmod 0755 "$STAGE/xworkd-server/install.sh"

mkdir -p "$(dirname "$OUT")"
tar -C "$STAGE" -czf "$OUT" xworkd-server
rm -rf "$STAGE"
echo "生成: $OUT ($(du -h "$OUT" | cut -f1))"
