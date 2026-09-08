#!/usr/bin/env bash
# install-pam.sh —— 接入“实体机登录拦截”PAM（gdm-password）。
# 由 deploy/install.sh 与 server-bundle 内置 install.sh 调用。
# 用法: bash install-pam.sh [守卫脚本源路径]
#   - 守卫脚本安装到 /usr/libexec/xworkd-gdm-guard
#   - 仅在存在 /etc/pam.d/gdm-password（装了 GDM）时生效；否则跳过
#   - 幂等（已带标记行则跳过）；改动前备份 gdm-password 为 .xworkd.bak
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")" && pwd)/xworkd-gdm-guard}"
GDM_PAM="/etc/pam.d/gdm-password"

if [ ! -f "$SRC" ]; then
    echo "install-pam: 缺少守卫脚本 $SRC，跳过 PAM 集成"
    exit 0
fi
if [ ! -f "$GDM_PAM" ]; then
    echo "install-pam: 未检测到 GDM（无 $GDM_PAM），跳过实体机登录拦截"
    exit 0
fi

install -m 0755 "$SRC" /usr/libexec/xworkd-gdm-guard
if ! command -v curl >/dev/null 2>&1; then
    echo "install-pam: 安装 curl（守卫本地接口依赖）..."
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl >/dev/null 2>&1 || true
fi

MARK="# --- xworkd: 实体机登录前结束同账号远程会话 ---"
if grep -qF "$MARK" "$GDM_PAM"; then
    echo "install-pam: gdm-password 已接入（幂等跳过）"
    exit 0
fi

cp -a "$GDM_PAM" "$GDM_PAM.xworkd.bak"
# 在第一个 session 行前（auth 密码验证之后）插入守卫 auth 行
awk -v mark="$MARK" '
    /^session[ \t]/ && !done {
        print mark
        print "auth    optional        pam_exec.so /usr/libexec/xworkd-gdm-guard"
        done = 1
    }
    { print }
' "$GDM_PAM" > "$GDM_PAM.new"
mv "$GDM_PAM.new" "$GDM_PAM"
chmod 0644 "$GDM_PAM"
echo "install-pam: 已接入 $GDM_PAM（实体机登录前结束同账号远程会话）"
