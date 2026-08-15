#!/bin/bash
# 诊断 XWorkDesk 会话的 keyring/总线状态（供修复后验证使用）
UID_ARG="${1:-1000}"

echo "=== 会话相关进程 ==="
ps aux | grep -E "Xvfb :|gnome-session|gnome-shell|gnome-keyring-daemon" | grep -v grep

echo
echo "=== gnome-session 是否带 --builtin（应能看到）==="
ps aux | grep "gnome-session" | grep -v grep

echo
echo "=== 各会话进程的 DBUS 总线地址 ==="
for pid in $(pgrep -f "gnome-keyring-daemon --start" 2>/dev/null; pgrep -f "gnome-session" 2>/dev/null); do
  addr=$(tr "\0" "\n" < /proc/$pid/environ 2>/dev/null | grep "^DBUS_SESSION_BUS_ADDRESS=" | head -1)
  cmd=$(tr "\0" " " < /proc/$pid/cmdline 2>/dev/null | cut -c1-80)
  [ -n "$addr" ] && echo "pid=$pid $addr  ($cmd)"
done | sort -u

echo
echo "=== 每个私有总线上 secrets 服务的 login 集合锁定状态 ==="
for pid in $(pgrep -f "gnome-keyring-daemon --start" 2>/dev/null); do
  addr=$(tr "\0" "\n" < /proc/$pid/environ 2>/dev/null | grep "^DBUS_SESSION_BUS_ADDRESS=" | cut -d= -f2-)
  [ -z "$addr" ] && continue
  echo "--- bus=$addr (daemon pid=$pid) ---"
  DBUS_SESSION_BUS_ADDRESS="$addr" dbus-send --session --print-reply \
    --dest=org.freedesktop.secrets \
    /org/freedesktop/secrets/collection/login \
    org.freedesktop.DBus.Properties.Get \
    string:org.freedesktop.Secret.Collection string:Locked 2>&1 | grep -E "variant|Error" || echo "(无法查询)"
done
