#!/usr/bin/env bash
# xworkd-tun 安装脚本 —— 由客户端经 SSH 推送到 /tmp 后以 root 执行。
#
# 只负责「装」：准备依赖、解包 sing-box、写 systemd 单元。不生成配置、不启动服务。
# 生成配置 + 启动（systemctl enable --now）由客户端的「启用」完成。
#
# 用法: sudo bash install-tun.sh [安装包路径]
set -euo pipefail

PREFIX=/opt/xworkd-tun
CONF_DIR=/etc/xworkd-tun
UNIT=/etc/systemd/system/xworkd-tun.service
TGZ="${1:-/tmp/sing-box-1.14.0-linux-amd64.tar.gz}"

if [[ $(id -u) -ne 0 ]]; then
    echo "需要 root（sudo bash install-tun.sh）"
    exit 1
fi
if [[ ! -f "$TGZ" ]]; then
    echo "缺少安装包: $TGZ"
    exit 1
fi

echo "[xworkd-tun] 安装依赖: nftables（tun auto_route 需要）与 curl（测速用）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null 2>&1 || true
if ! apt-get install -y nftables curl >/dev/null 2>&1; then
    echo "[xworkd-tun] 警告: 依赖安装失败，请先确认 nftables 与 curl 可用"
fi

if [[ ! -c /dev/net/tun ]]; then
    echo "缺少 /dev/net/tun：内核未启用 TUN（modprobe tun）"
    exit 1
fi

echo "[xworkd-tun] 解包到 $PREFIX"
rm -rf "$PREFIX"
mkdir -p "$PREFIX"
tar -xzf "$TGZ" -C "$PREFIX" --strip-components=1
if [[ ! -x "$PREFIX/sing-box" ]]; then
    echo "解包后未找到 sing-box 可执行文件"
    exit 1
fi
chmod 0755 "$PREFIX/sing-box"

mkdir -p "$CONF_DIR"
chmod 0755 "$CONF_DIR"

echo "[xworkd-tun] 写入 systemd 单元 $UNIT"
cat > "$UNIT" <<'UNIT_EOF'
[Unit]
Description=XWorkDesk Tun proxy (sing-box)
Documentation=https://sing-box.sagernet.org/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# tun 需要创建 tun 设备、改路由与 nftables 规则，这里与 xworkd 服务同样以 root 运行。
# （若要收紧权限：建一个专用系统用户 + User= + AmbientCapabilities=CAP_NET_ADMIN）
User=root
Group=root
ExecStart=/opt/xworkd-tun/sing-box run -c /etc/xworkd-tun/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=xworkd-tun

[Install]
WantedBy=multi-user.target
UNIT_EOF
chmod 0644 "$UNIT"
systemctl daemon-reload

echo "[xworkd-tun] 已安装: $("$PREFIX/sing-box" version | head -1)"
echo "安装完成（未启动；配置与启动由客户端的「启用」完成）"
echo "XWORKD_TUN_INSTALL_OK"
