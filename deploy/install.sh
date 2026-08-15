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
if [[ ! -f "$REPO_DIR/frontend/dist/index.html" ]]; then
    echo "错误: 缺少 $REPO_DIR/frontend/dist，请先构建前端" >&2
    exit 1
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
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl --no-pager --lines=25 status "$SERVICE_NAME"

echo
echo "部署完成。"
echo "  查看日志: journalctl -u ${SERVICE_NAME} -f"
echo "  访问地址: http://<本机IP>:${PORT}/"
