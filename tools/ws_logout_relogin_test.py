#!/usr/bin/env python3
"""模拟：登录 → 系统注销（杀 gnome-session）→ 立即重新登录，验证会话清理。"""

import base64
import os
import socket
import struct
import subprocess
import sys
import time


class WS:
    def __init__(self, port=5268):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n"
                        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                        "Sec-WebSocket-Version: 13\r\n\r\n").encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            resp += self.s.recv(4096)

    def send(self, payload):
        mask = os.urandom(4)
        n = len(payload)
        h = bytes([0x82, 0x80 | n]) if n < 126 else bytes([0x82, 0x80 | 126]) + struct.pack(">H", n)
        self.s.sendall(h + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

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
        except Exception:
            pass


def msg_login(user, passwd, w=1280, h=720):
    ub, pb = user.encode(), passwd.encode()
    return b"\x10" + struct.pack("<H", len(ub)) + ub + struct.pack("<H", len(pb)) + pb + struct.pack("<HH", w, h)


def login(ws, user, passwd, tag):
    ws.send(msg_login(user, passwd))
    end = time.time() + 25
    while time.time() < end:
        m = ws.recv(timeout=8)
        if m is None:
            print(f"[{tag}] timeout waiting result")
            return None
        if m == b"":
            print(f"[{tag}] connection closed")
            return "closed"
        if m[0] == 3:
            print(f"[{tag}] login result ok={m[1] == 1}")
            return m[1] == 1
        if m[0] == 5:
            print(f"[{tag}] SESSION_EXISTS, sending takeover")
            ws.send(b"\x15")
    return None


def main():
    user = sys.argv[1] if len(sys.argv) > 1 else "cd2"
    passwd = sys.argv[2] if len(sys.argv) > 2 else "1234"

    a = WS()
    r = login(a, user, passwd, "A")
    if not r:
        print("A login failed")
        return
    print("[A] session up, now simulating system logout (kill gnome-session)...")
    time.sleep(3)
    subprocess.run(["pkill", "-u", "1000", "-f", "gnome-session-binary"])
    print("[A] gnome-session killed, waiting for sweep cleanup...")
    time.sleep(2)
    print("[A] checking if A's connection is closed by server...")
    m = a.recv(timeout=10)
    print("[A] after logout got:", "closed" if m == b"" else ("msg " + str(m[0]) if m else "timeout/none"))

    print("=== now re-login immediately ===")
    b = WS()
    r2 = login(b, user, passwd, "B")
    print("[B] re-login result:", r2)
    if r2:
        m = b.recv(timeout=15)
        print("[B] after login got:", "closed" if m == b"" else ("msg " + str(m[0]) if m else "timeout/none"))
    a.close()
    b.close()


if __name__ == "__main__":
    main()
