#!/usr/bin/env bash
# 制作随客户端分发的 xworkd 服务端自包含安装包（Linux amd64，Ubuntu/Debian）。
#
# 用法:  tools/make-server-bundle.sh
# 产出:  frontend/server-bundle/xworkd-server.tar.gz
#
# 安装包内：xworkd 二进制 + install.sh（apt 依赖→systemd 安装启动）
# 远端安装：sudo bash install.sh   （由客户端经 SSH sftp 推送后以 sudo 执行）

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO="$(pwd)"

BIN="$REPO/build/xworkd"
OUT="$REPO/frontend/server-bundle/xworkd-server.tar.gz"
STAGE="$REPO/build/bundle"
SERVICE_NAME="xworkd"
PREFIX="/opt/$SERVICE_NAME"

if [[ ! -x "$BIN" ]]; then echo "缺少 $BIN（先构建后端）"; exit 1; fi

rm -rf "$STAGE"
mkdir -p "$STAGE/xworkd-server"
cp "$BIN" "$STAGE/xworkd-server/xworkd"
cp "$REPO/deploy/xworkd-gdm-guard" "$STAGE/xworkd-server/xworkd-gdm-guard"
cp "$REPO/deploy/install-pam.sh" "$STAGE/xworkd-server/install-pam.sh"
# 输入法中继引擎（可选目标：构建机没装 libibus-1.0-dev 时产物里就没有）
HAS_IM=0
if [[ -x "$REPO/build/xworkd-im" && -f "$REPO/im/xworkd-im.xml" ]]; then
  cp "$REPO/build/xworkd-im" "$STAGE/xworkd-server/xworkd-im"
  cp "$REPO/im/xworkd-im.xml" "$STAGE/xworkd-server/xworkd-im.xml"
  HAS_IM=1
fi

cat > "$STAGE/xworkd-server/install.sh" <<EOF
#!/usr/bin/env bash
# xworkd 服务端一键安装（需 root）。目标需为可运行 GNOME 桌面的 Ubuntu/Debian 主机。
set -euo pipefail
if [[ \$(id -u) -ne 0 ]]; then echo "需要 root"; exit 1; fi
PREFIX="$PREFIX"
mkdir -p "\$PREFIX"
echo "[xworkd] 安装运行/会话基础依赖（Xorg dummy、X 运行库、libopus 等）..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null 2>&1 || true
apt-get install -y xserver-xorg-video-dummy x11-xserver-utils xauth xclip dbus-x11 libopus0 libx11-6 libxext6 libxtst6 libxfixes3 libxrandr2 >/dev/null 2>&1 || true
install -m 0755 xworkd "\$PREFIX/xworkd"
# 输入法中继引擎（随包分发则装上；组件 XML 必须进 /usr/share/ibus/component）
if [[ -f xworkd-im && -f xworkd-im.xml ]]; then
    echo "[xworkd] 安装输入法中继引擎（xworkd-im）..."
    mkdir -p /usr/libexec/xworkd
    install -m 0755 xworkd-im /usr/libexec/xworkd/xworkd-im
    install -m 0644 xworkd-im.xml /usr/share/ibus/component/xworkd-im.xml
    for pkg in libibus-1.0-5 ibus; do
        dpkg -s "\$pkg" >/dev/null 2>&1 || apt-get install -y "\$pkg" >/dev/null 2>&1 || true
    done
    ibus write-cache >/dev/null 2>&1 || true
fi
cat > /etc/systemd/system/$SERVICE_NAME.service <<UNIT
[Unit]
Description=XWorkDesk remote desktop server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
ExecStart=\$PREFIX/xworkd --auth shadow --port 5268
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
