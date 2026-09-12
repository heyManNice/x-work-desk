#!/usr/bin/env python3
"""imcheck.py —— 验证 xworkd 的「输入法中继通道」接线（开发用，不依赖 ibus/客户端）。

它检查四件事：
  1. 登录后能拿到会话；
  2. 会话进程的环境里有 XWORKD_IM_SOCK（证明路径真的交给了会话内的引擎）；
  3. socket 文件存在、权限 0600，且能以"假引擎"身份连上（服务端接受连接）；
  4. 断开客户端后 socket 文件被清理（不留给下一个会话）。

用法：
    # XDG_CONFIG_HOME 指向临时目录：切输入源会写 dconf，开发时别动到本机桌面设置
    XDG_CONFIG_HOME=/tmp/imdev-config ./build/xworkd --auth none --port 8099 \
        --app "xsetroot -solid '#223366' & sleep 999" > /tmp/xworkd-dev.log 2>&1 &
    python3 tools/im-dev/imcheck.py --port 8099 --user "$USER" --server-log /tmp/xworkd-dev.log
"""

import argparse
import base64
import glob
import os
import re
import socket
import struct
import sys
import time

MSG_LOGIN = 0x10
MSG_LOGIN_RESULT = 0x03


class WS:
    """极简 WebSocket 客户端（只够本仓库的测试用）。"""

    def __init__(self, port=5268):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n"
                        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                        "Sec-WebSocket-Version: 13\r\n\r\n").encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.s.recv(4096)
            if not chunk:
                raise RuntimeError("WS 升级失败")
            resp += chunk

    def send(self, payload):
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            hdr = bytes([0x82, 0x80 | n])
        else:
            hdr = bytes([0x82, 0x80 | 126]) + struct.pack(">H", n)
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv(self, timeout=20):
        self.s.settimeout(timeout)
        try:
            hdr = self.s.recv(2)
        except socket.timeout:
            return None
        if len(hdr) < 2:
            return b""
        n = hdr[1] & 0x7F
        if n == 126:
            n = struct.unpack(">H", self.s.recv(2))[0]
        data = b""
        while len(data) < n:
            d = self.s.recv(n - len(data))
            if not d:
                break
            data += d
        return data

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


def msg_login(user, passwd, w=1280, h=720):
    ub, pb = user.encode(), passwd.encode()
    return (b"\x10" + struct.pack("<H", len(ub)) + ub + struct.pack("<H", len(pb)) + pb +
            struct.pack("<HH", w, h))


def find_sock():
    pat = re.compile(r"/xworkd-im-\d+-\d+\.sock$")
    out = []
    for d in ("/run/xworkd", "/tmp"):
        for p in glob.glob(d + "/*.sock"):
            if pat.search(p):
                out.append(p)
    return sorted(out)


def find_env_in_procs(var):
    """谁的环境里有 var（用来证明会话进程拿到了 XWORKD_IM_SOCK）"""
    out = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/environ", "rb") as f:
                env = f.read().split(b"\0")
        except OSError:
            continue
        for e in env:
            if e.startswith(var.encode() + b"="):
                out.append((int(pid), e.decode()))
                break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--user", default=os.environ.get("USER", "root"))
    ap.add_argument("--password", default="x")
    ap.add_argument("--server-log", default=None)
    ap.add_argument("--allow-real-dconf", action="store_true",
                    help="允许改动真实 dconf（危险：会话与桌面同用户时共用同一份，会改掉桌面的输入法）")
    args = ap.parse_args()

    # 硬护栏：服务端的"切输入源"会写目标用户的 dconf。若会话用户就是当前登录用户，
    # 会话与桌面**共用同一个 HOME/dconf**，测试会把桌面的输入法配置一起改掉（踩过）。
    # 所以默认拒绝，除非显式 --allow-real-dconf。
    if not args.allow_real_dconf and args.user == os.environ.get("USER"):
        print("拒绝运行：--user 与当前登录用户相同，会话将共用你桌面的 dconf。")
        print("  理由：测试会切换并恢复输入源，可能改掉你自己的输入法设置。")
        print("  如确实要测，加 --allow-real-dconf，并在跑完后核对：")
        print("    gsettings get org.gnome.desktop.input-sources sources")
        return 2

    fails = []

    def check(cond, what):
        print(("  ✓ " if cond else "  ✗ ") + what)
        if not cond:
            fails.append(what)

    before = set(find_sock())
    print(f"登录前已有 IM socket：{sorted(before) or '（无）'}")

    ws = WS(args.port)
    ws.send(msg_login(args.user, args.password))
    ok = False
    for _ in range(40):
        data = ws.recv(timeout=10)
        if not data:
            continue
        if data[0] == MSG_LOGIN_RESULT:
            ok = data[1] == 1
            print(f"登录结果：{'成功' if ok else '失败·' + data[2:].decode('utf-8', 'replace')}")
            break
    if not ok:
        print("登录失败，后续检查无意义")
        ws.close()
        return 1

    # 会话起来要一点时间（Xvfb + 会话进程）
    new = []
    for _ in range(50):
        new = [p for p in find_sock() if p not in before]
        if new:
            break
        time.sleep(0.2)
    print("检查：")
    check(bool(new), f"会话已创建 IM socket：{new or '（没有）'}")
    if not new:
        ws.close()
        return 1
    sock_path = new[0]

    st = os.stat(sock_path)
    check((st.st_mode & 0o777) == 0o600, f"socket 权限 0600（实际 {oct(st.st_mode & 0o777)}）")

    envs = find_env_in_procs("XWORKD_IM_SOCK")
    matched = [p for p in envs if p[1].endswith(sock_path)]
    check(bool(matched), f"会话进程环境含 XWORKD_IM_SOCK={sock_path}"
                         f"（命中 {[(p, v.split('=', 1)[1]) for p, v in envs] or '无'}）")

    # 以"假引擎"身份接入：服务端应该接受，并在日志里记一行
    eng = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        eng.connect(sock_path)
        connected = True
    except OSError as e:
        connected = False
        print(f"    （连接失败：{e}）")
    check(connected, "假引擎能连上通道（服务端 accept 正常）")

    if args.server_log and os.path.exists(args.server_log):
        time.sleep(0.3)
        with open(args.server_log, "r", errors="replace") as f:
            log = f.read()
        check("IM 通道就绪" in log, "服务端日志有「IM 通道就绪」")
        check("IM：引擎已接入" in log, "服务端日志有「引擎已接入」")

    # ---------------- 双向转发 ----------------
    def ws_wait(mtype, timeout=5.0):
        """等一条指定类型的 WS 消息（跳过视频/音频等噪声）。"""
        end = time.time() + timeout
        while time.time() < end:
            d = ws.recv(timeout=max(0.1, end - time.time()))
            if not d:
                continue
            if d[0] == mtype:
                return d
        return None

    def engine_wait(mtype, timeout=5.0):
        """等一条指定类型的通道帧。"""
        eng.settimeout(timeout)
        while True:
            try:
                hdr = eng.recv(3)
            except socket.timeout:
                return None
            if len(hdr) < 3:
                return None
            n = struct.unpack("<H", hdr[1:3])[0]
            body = b""
            while len(body) < n:
                chunk = eng.recv(n - len(body))
                if not chunk:
                    break
                body += chunk
            if hdr[0] == mtype:
                return hdr[0], body

    # 1) 客户端开启本机输入法 → 应收到"引擎就绪"
    ws.send(bytes([0x20, 1]))  # MSG_IM_ENABLE enable=1
    st = ws_wait(0x25)
    check(st is not None and st[1] == 0, f"ENABLE 后收到 STATE=就绪（实得 {st and st[1]!r}）")

    # 1b) 服务端应在**会话内**把引擎挂成输入源（这一步才是真正"激活引擎"）
    if args.server_log:
        time.sleep(0.5)
        with open(args.server_log, "r", errors="replace") as f:
            log = f.read()
        check("IM：记住原输入源" in log, "服务端先记住了原输入源（关闭时才能还原）")
        check("IM：已把 xworkd-im 挂为当前输入源" in log,
              "服务端已在会话内切换输入源")
        if "IM：找不到会话总线" in log:
            check(False, "居然没找到会话总线（环境问题）")

    # 2) 引擎上报 CARET → 客户端应原样收到矩形（含负坐标）
    eng.sendall(struct.pack("<BH", 0x01, 8) + struct.pack("<hhhh", -12, 345, 0, 26))
    caret = ws_wait(0x24)
    ok = caret is not None and struct.unpack("<hhhh", caret[1:9]) == (-12, 345, 0, 26)
    check(ok, f"CARET 原样转发（实得 {caret and struct.unpack('<hhhh', caret[1:9])}）")

    # 3) 客户端 preedit/commit → 引擎应收到 PREEDIT(pos+文本) / COMMIT
    ws.send(bytes([0x21]) + struct.pack("<H", 5) + "nihao".encode())
    f = engine_wait(0x11)
    check(f is not None and struct.unpack("<H", f[1][:2])[0] == 5 and f[1][2:] == b"nihao",
          f"客户端 preedit 到达引擎（实得 {f and f[1]!r}）")

    ws.send(bytes([0x22]) + "你好".encode())
    f = engine_wait(0x12)
    check(f is not None and f[1] == "你好".encode(), f"客户端 commit 到达引擎（实得 {f and f[1]!r}）")

    ws.send(bytes([0x23]))  # MSG_IM_RESET
    f = engine_wait(0x13)
    check(f is not None, "客户端 reset 到达引擎")

    # 4) 非法 UTF-8 必须被挡在服务端（不能喂给引擎）
    ws.send(bytes([0x21]) + struct.pack("<H", 0) + b"\xff\xfe")
    leak = engine_wait(0x11, timeout=1.0)
    check(leak is None, "非法 UTF-8 不会转发给引擎")

    # 5) 引擎被切走（STATE=1）→ 客户端应收到提示
    eng.sendall(struct.pack("<BH", 0x03, 1) + bytes([1]))
    st = ws_wait(0x25)
    check(st is not None and st[1] == 1, f"引擎 STATE=被切走 转发到位（实得 {st and st[1]!r}）")

    # 6) 引擎掉线 → 客户端应收到"引擎不在"（因为客户端开着本机输入法）
    eng.close()
    st = ws_wait(0x25)
    check(st is not None and st[1] == 2, f"引擎掉线通知客户端（实得 {st and st[1]!r}）")

    # 7) 关闭本机输入法 → 输入源应被恢复
    ws.send(bytes([0x20, 0]))
    time.sleep(0.6)
    if args.server_log:
        with open(args.server_log, "r", errors="replace") as f:
            log = f.read()
        check("IM：已恢复原输入源" in log, "关闭本机输入法后输入源已恢复")

    ws.send(bytes([0x1c]))  # MSG_LOGOUT
    gone = False
    for _ in range(100):
        if not os.path.exists(sock_path):
            gone = True
            break
        time.sleep(0.2)
    check(gone, "注销会话后 socket 已被清理")
    check(sys.platform and not find_sock(), f"没有残留的 IM socket（{find_sock() or '无'}）")
    ws.close()

    print("== 全部通过 ==" if not fails else f"== 失败 {len(fails)} 项 ==")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
