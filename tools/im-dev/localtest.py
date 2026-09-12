#!/usr/bin/env python3
"""localtest.py —— xworkd-im 引擎的本地对照测试（开发用，不是产品代码）。

为什么要有它：引擎的寄存器/预编辑/提交这几条路必须能在**不依赖 xworkd、也不依赖
远端会话**的情况下单独验证，否则每次回归都要连客户端 + 起远端会话，太重。

它做的事：
  1. 起一个干净的 Xvfb（:31，默认 -ac）+ 私有 dbus 会话 + 私有 ibus-daemon
     —— 完全不碰当前桌面的输入法设置（不用 GNOME 输入源那一套）；
  2. 扮演 xworkd：在 UNIX socket 上等引擎连上来，按时间线发 PREEDIT/COMMIT/RESET，
     并记录引擎回传的 CARET / FOCUS / STATE；
  3. 用 zenity --entry 当"远端应用"，在每个关键时刻截图到 --outdir。

用法（必须包在私有 dbus 会话里，否则会撞上用户自己的 ibus-daemon）：
    dbus-run-session -- python3 tools/im-dev/localtest.py [--engine build/xworkd-im]
                                                        [--outdir /tmp/xworkd-im-test]

产物：
    <outdir>/01-empty.png 02-preedit-ni.png 03-preedit-nihao.png 04-commit.png 05-keys.png
    <outdir>/engine.log   ← 引擎 stderr（XWORKD_IM_DEBUG=1 打开后很详细）
    <outdir>/summary.txt  ← 全部收发的帧
"""

import argparse
import os
import shutil
import select
import signal
import socket
import struct
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 与 src/im_proto.h 保持一致
IM_CARET, IM_FOCUS, IM_STATE = 0x01, 0x02, 0x03
IM_PREEDIT, IM_COMMIT, IM_RESET = 0x11, 0x12, 0x13
IM_NAME = {IM_CARET: "CARET", IM_FOCUS: "FOCUS", IM_STATE: "STATE"}
STATE_NAME = {0: "READY", 1: "DISABLED"}


def log(msg):
    print(f"[test] {msg}", flush=True)


class Peer:
    """扮演 xworkd 一侧的通道对端。"""

    def __init__(self, path):
        self.path = path
        self.frames = []          # [(type, payload_bytes)]
        self.conn = None
        self.buf = b""
        if os.path.exists(path):
            os.unlink(path)
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(path)
        os.chmod(path, 0o600)
        self.srv.listen(1)
        self.srv.setblocking(False)

    def accept(self, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            r, _, _ = select.select([self.srv], [], [], 0.2)
            if r:
                self.conn, _ = self.srv.accept()
                self.conn.setblocking(False)
                log(f"引擎已连上通道：{self.path}")
                return True
        log("警告：引擎没有连上通道（它自己会每秒重试）")
        return False

    def pump(self):
        """读走一切待读帧（非阻塞）。"""
        if self.conn is None:
            if not self.accept(timeout=0.05):
                return
        while True:
            r, _, _ = select.select([self.conn], [], [], 0)
            if not r:
                break
            try:
                data = self.conn.recv(4096)
            except BlockingIOError:
                break
            if not data:
                self.conn.close()
                self.conn = None
                break
            self.buf += data
        while len(self.buf) >= 3:
            mtype = self.buf[0]
            (plen,) = struct.unpack_from("<H", self.buf, 1)
            if len(self.buf) < 3 + plen:
                break
            payload = self.buf[3:3 + plen]
            self.buf = self.buf[3 + plen:]
            self.frames.append((mtype, payload))

    def send(self, mtype, payload=b""):
        frame = struct.pack("<BH", mtype, len(payload)) + payload
        if self.conn is not None:
            self.conn.sendall(frame)

    def preedit(self, text, pos=None):
        if pos is None:
            pos = len(text)
        self.send(IM_PREEDIT, struct.pack("<H", pos) + text.encode())

    def commit(self, text):
        self.send(IM_COMMIT, text.encode())

    def reset(self):
        self.send(IM_RESET)

    def summary(self):
        lines = []
        for mtype, payload in self.frames:
            if mtype == IM_CARET:
                x, y, w, h = struct.unpack("<hhhh", payload)
                lines.append(f"CARET   x={x} y={y} w={w} h={h}")
            elif mtype == IM_FOCUS:
                lines.append(f"FOCUS   {payload[0]}")
            elif mtype == IM_STATE:
                lines.append(f"STATE   {STATE_NAME.get(payload[0], payload[0])}")
            else:
                lines.append(f"0x{mtype:02x}    {payload!r}")
        return lines


def run(cmd, **kw):
    kw.setdefault("stdout", subprocess.DEVNULL)
    kw.setdefault("stderr", subprocess.DEVNULL)
    return subprocess.Popen(cmd, **kw)


def sh(cmd, env=None):
    return subprocess.run(cmd, env=env, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True, check=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default=os.path.join(ROOT, "build", "xworkd-im"))
    ap.add_argument("--outdir", default="/tmp/xworkd-im-test")
    ap.add_argument("--display", default=":31")
    ap.add_argument("--sock", default="/tmp/xworkd-im-dev.sock")
    ap.add_argument("--keep", action="store_true", help="结束后不清理（排错用）")
    args = ap.parse_args()

    if not os.access(args.engine, os.X_OK):
        sys.exit(f"找不到可执行引擎：{args.engine}（先 ninja -C build）")
    if "DBUS_SESSION_BUS_ADDRESS" not in os.environ:
        log("提示：建议用 `dbus-run-session -- python3 tools/im-dev/localtest.py` 跑，"
            "否则会和桌面自己的 ibus-daemon 抢名字")

    os.makedirs(args.outdir, exist_ok=True)
    env = dict(os.environ)
    env["DISPLAY"] = args.display
    env.pop("XAUTHORITY", None)          # Xvfb 用 -ac，不需要授权文件
    env["GTK_IM_MODULE"] = "ibus"
    env["XMODIFIERS"] = "@im=ibus"
    env["QT_IM_MODULE"] = "ibus"
    env["XWORKD_IM_SOCK"] = args.sock
    env["XWORKD_IM_DEBUG"] = "1"
    # ibus 的地址文件按显示号存，私有会话必须让 ibus-* 工具用同一个显示号
    procs = []

    def cleanup():
        for p in reversed(procs):
            if p.poll() is None:
                p.terminate()
        time.sleep(0.3)
        for p in reversed(procs):
            if p.poll() is None:
                p.kill()
        if not args.keep:
            shutil.rmtree(f"/tmp/.X11-unix/X{args.display.lstrip(':')}", ignore_errors=True)
            for f in (args.sock, f"/tmp/.X{args.display.lstrip(':')}-lock"):
                try:
                    os.unlink(f)
                except OSError:
                    pass
        else:
            log(f"--keep：socket {args.sock} 与截图留在 {args.outdir}")

    def fail(msg):
        log(f"失败：{msg}")
        cleanup()
        sys.exit(1)

    try:
        # 1) 干净的 X 服务器
        shutil.rmtree(f"/tmp/.X11-unix/X{args.display.lstrip(':')}", ignore_errors=True)
        try:
            os.unlink(f"/tmp/.X{args.display.lstrip(':')}-lock")
        except OSError:
            pass
        procs.append(run(["Xvfb", args.display, "-screen", "0", "1280x800x24", "-ac"]))
        for _ in range(50):
            if os.path.exists(f"/tmp/.X11-unix/X{args.display.lstrip(':')}"):
                break
            time.sleep(0.1)
        else:
            fail("Xvfb 没起来")
        log(f"Xvfb {args.display} 就绪")

        # 2) 私有 ibus-daemon（--panel disable 免掉面板依赖；-x 提供 XIM 兜底）
        procs.append(run(["ibus-daemon", "-x", "-r", "--panel", "disable"],
                         env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        # 就绪探测必须找**真正会跟 daemon 说话**的命令：`ibus version` 只打印库版本号，
        # daemon 没起来也会成功（踩过这个坑）。`ibus list-engine` 拿不到引擎表就是没就绪。
        for _ in range(100):
            out = sh(["ibus", "list-engine"], env=env)
            if (out.stdout or "").strip():
                break
            time.sleep(0.1)
        else:
            fail("ibus-daemon 没起来（list-engine 一直为空）")
        log(f"ibus-daemon 就绪（list-engine 有输出）")

        # 3) 通道对端要先于引擎存在（引擎也会自己重试，这一步只是少等一秒）
        peer = Peer(args.sock)

        # 4) 引擎：手动启动（--ibus 是 daemon 拉起时才带的，这里模拟"用户自己起"）
        eng_log = open(os.path.join(args.outdir, "engine.log"), "w")
        procs.append(run([args.engine], env=env, stdout=eng_log, stderr=eng_log))
        time.sleep(0.8)
        if procs[-1].poll() is not None:
            fail(f"引擎 exit={procs[-1].returncode}，看 {args.outdir}/engine.log")
        peer.accept()

        # 5) 切到我们的引擎（X11 下应用直连 ibus，手工切换即可；GNOME/Wayland 不适用）
        out = sh(["ibus", "engine", "xworkd-im"], env=env)
        log(f"ibus engine xworkd-im → {(out.stdout or '').strip() or 'ok'}")
        got = sh(["ibus", "engine"], env=env)
        if "xworkd-im" not in (got.stdout or ""):
            fail(f"切换失败，当前引擎：{(got.stdout or '').strip()}")

        # 6) "远端应用"：zenity 的输入框（GTK3，会走 ibus IM 模块）
        procs.append(run(["zenity", "--entry", "--title=xworkd-im 测试", "--text=请输入：",
                          "--width=420"], env=env))
        time.sleep(2.0)
        wids = sh(["xdotool", "search", "--name", "xworkd-im 测试"], env=env).stdout.split()
        if not wids:
            fail("找不到 zenity 窗口")
        wid = wids[-1]
        sh(["xdotool", "windowactivate", "--sync", wid], env=env)
        sh(["xdotool", "windowfocus", wid], env=env)
        time.sleep(0.3)
        # 点进输入框，让 GTK 的 IM context 拿到焦点（应用才会报 cursor_location）
        sh(["xdotool", "mousemove", "--window", wid, "200", "60", "click", "1"], env=env)
        time.sleep(1.0)
        log(f"zenity 窗口 {wid} 已点击输入框")

        shots = []

        def shot(name):
            path = os.path.join(args.outdir, name)
            time.sleep(0.5)
            peer.pump()
            sh(["import", "-window", "root", "-display", args.display, path], env=env)
            shots.append(path)
            log(f"截图 {name}（已收到 {len(peer.frames)} 帧）")

        def settle(sec=0.6):
            end = time.time() + sec
            while time.time() < end:
                peer.pump()
                time.sleep(0.05)

        shot("01-empty.png")

        log('→ PREEDIT "ni"')
        peer.preedit("ni")
        settle()
        shot("02-preedit-ni.png")

        log('→ PREEDIT "nihao"（cursor=5）')
        peer.preedit("nihao", 5)
        settle()
        shot("03-preedit-nihao.png")

        log('→ COMMIT "你好"')
        peer.commit("你好")
        settle()
        shot("04-commit.png")

        log("→ 普通按键透传（xdotool type abc）")
        sh(["xdotool", "type", "--delay", "80", "abc"], env=env)
        settle()
        shot("05-keys.png")

        log("→ RESET")
        peer.reset()
        settle(0.4)

        # 结果
        peer.pump()
        lines = peer.summary()
        with open(os.path.join(args.outdir, "summary.txt"), "w") as f:
            f.write("\n".join(lines) + "\n")

        caret = [l for l in lines if l.startswith("CARET")]
        focus = [l for l in lines if l.startswith("FOCUS")]
        state = [l for l in lines if l.startswith("STATE")]
        log(f"收到 CARET {len(caret)} 条 / FOCUS {len(focus)} 条 / STATE {len(state)} 条")
        for l in caret[:3]:
            log("  " + l)
        for l in lines[-6:]:
            log("  " + l)
        log(f"产物目录：{args.outdir}")
        log("请人工核对截图：02/03 的输入框里应有下划线 preedit，04 里应是「你好」，"
            "05 里应是「你好abc」")
    finally:
        cleanup()


if __name__ == "__main__":
    signal.signal(signal.SIGINT, lambda *_: sys.exit(130))
    main()
