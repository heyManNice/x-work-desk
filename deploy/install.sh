#!/usr/bin/env bash
# 将 xworkd 安装为 systemd 服务（root 运行、开机自启、崩溃自动重启）
#
# 用法:
#   sudo ./deploy/install.sh [服务名]          # 默认服务名 xworkd
#   XWORKD_PORT=8080 sudo ./deploy/install.sh  # 自定义端口
#   XWORKD_EXTRA_ARGS="--width 1920 --height 1080 --fps 60" sudo ./deploy/install.sh
#
# 卸载:
#   sudo systemctl disable --now xworkd && sudo rm /etc/systemd/system/xworkd.service && sudo systemctl daemon-reload
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${1:-xworkd}"
PORT="${XWORKD_PORT:-5268}"
EXTRA_ARGS="${XWORKD_EXTRA_ARGS:-}"

if [[ $EUID -ne 0 ]]; then
    echo "错误: 请用 root/sudo 运行（需要写 /etc/systemd/system）" >&2
    exit 1
fi

if [[ ! -x "$REPO_DIR/build/xworkd" ]]; then
    echo "错误: 缺少 $REPO_DIR/build/xworkd，请先构建后端" >&2
    exit 1
fi

# Xorg+dummy 虚拟显示（默认 --server xorg，支持运行时改分辨率）依赖
if ! dpkg -s xserver-xorg-video-dummy >/dev/null 2>&1; then
    echo "安装 xserver-xorg-video-dummy（Xorg 虚拟显示驱动）..."
    apt-get install -y xserver-xorg-video-dummy
fi

echo "仓库路径: $REPO_DIR"
echo "服务名:   $SERVICE_NAME"
echo "端口:     $PORT"

# 生成 unit（替换路径/端口占位符，追加可选参数）
UNIT="$(mktemp)"
trap 'rm -f "$UNIT"' EXIT
sed -e "s|__XWORKD_HOME__|$REPO_DIR|g" \
    -e "s|__XWORKD_PORT__|$PORT|g" \
    "$REPO_DIR/deploy/xworkd.service.in" > "$UNIT"
if [[ -n "$EXTRA_ARGS" ]]; then
    sed -i "s|^ExecStart=.*|& $EXTRA_ARGS|" "$UNIT"
fi

install -m 0644 "$UNIT" "/etc/systemd/system/${SERVICE_NAME}.service"

# 安装 GNOME Shell 用户单元覆盖：Xvfb 软件渲染下允许前端"桌面动画"开关真正生效
# （gnome-shell --force-animations；实际开关仍由前端 gsettings 控制，默认关）
SHELL_OVERRIDE_SRC="$REPO_DIR/deploy/org.gnome.Shell@x11.service.d"
SHELL_OVERRIDE_DST="/etc/systemd/user/org.gnome.Shell@x11.service.d"
mkdir -p "$SHELL_OVERRIDE_DST"
install -m 0644 "$SHELL_OVERRIDE_SRC/force-animations.conf" \
    "$SHELL_OVERRIDE_DST/force-animations.conf"

# 安装 WirePlumber 覆盖：VM 内禁用不稳定的 PCI 模拟声卡，回退 Dummy Output，
# 保证桌面音频采集稳定（实体机无 cpu.vm.name，不受影响）
WP_CONF_DST="/etc/xdg/wireplumber/wireplumber.conf.d"
mkdir -p "$WP_CONF_DST"
install -m 0644 "$REPO_DIR/deploy/wireplumber.d/50-xworkd-vm-audio.conf" \
    "$WP_CONF_DST/50-xworkd-vm-audio.conf"

# 让已在线的用户 systemd 实例加载覆盖（离线用户下次登录自动生效）
for u in $(loginctl list-users --no-legend 2>/dev/null | awk '{print $2}'); do
    uid="$(id -u "$u" 2>/dev/null || true)"
    if [[ -n "$uid" && -S "/run/user/$uid/bus" ]]; then
        su -s /bin/bash "$u" -c \
            "XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus systemctl --user daemon-reload" \
            >/dev/null 2>&1 || true
        su -s /bin/bash "$u" -c \
            "XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus systemctl --user restart wireplumber" \
            >/dev/null 2>&1 || true
    fi
done

# ---- 文件传输（新方案：客户端拖放/复制粘贴，不依赖 Nautilus 扩展）----
# 清理旧版 Nautilus 右键菜单扩展（如有历史安装残留）
NAUT_EXT_DIR="/usr/share/nautilus-python/extensions"
if [ -f "$NAUT_EXT_DIR/xworkd_menu.py" ]; then
    rm -f "$NAUT_EXT_DIR/xworkd_menu.py"
    echo "已移除旧版 Nautilus 右键扩展: $NAUT_EXT_DIR/xworkd_menu.py"
    if pgrep -x nautilus >/dev/null 2>&1; then
        pkill -x nautilus 2>/dev/null || true
    fi
fi

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
# 接入实体机登录拦截 PAM（幂等；无 GDM 自动跳过）
bash "$REPO_DIR/deploy/install-pam.sh" "$REPO_DIR/deploy/xworkd-gdm-guard"
systemctl restart "$SERVICE_NAME"
systemctl --no-pager --lines=25 status "$SERVICE_NAME"

echo
echo "部署完成。"
echo "  查看日志: journalctl -u ${SERVICE_NAME} -f"
echo "  访问地址: http://<本机IP>:${PORT}/"
