#!/usr/bin/env python3
"""模拟双连接登录 + 接管流程，验证服务端会话管理。"""

import base64
import hashlib
import os
import socket
import struct
import sys
import time


class WS:
    def __init__(self, port=5268):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.s.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            resp += self.s.recv(4096)

    def send(self, payload):
        mask = os.urandom(4)
        h = b"\x82"
        n = len(payload)
        if n < 126:
            h += bytes([0x80 | n])
        elif n < 65536:
            h += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            h += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.s.sendall(h + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv(self, timeout=15):
        self.s.settimeout(timeout)
        hdr = self.s.recv(2)
        if len(hdr) < 2:
            return None
        n = hdr[1] & 0x7F
        if n == 126:
            n = struct.unpack(">H", self.s.recv(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self.s.recv(8))[0]
        data = b""
        while len(data) < n:
            data += self.s.recv(n - len(data))
        return data

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass


def msg_login(user, passwd, w=1280, h=720):
    ub, pb = user.encode(), passwd.encode()
    return b"\x10" + struct.pack("<H", len(ub)) + ub + struct.pack("<H", len(pb)) + pb + struct.pack("<HH", w, h)


def main():
    user = sys.argv[1] if len(sys.argv) > 1 else "cd2"
    passwd = sys.argv[2] if len(sys.argv) > 2 else "1234"

    a = WS()
    a.send(msg_login(user, passwd))
    print("[A] waiting login result...")
    while True:
        m = a.recv()
        if m and m[0] == 3:
            print(f"[A] login result ok={m[1]==1}")
            break
    while True:
        m = a.recv(timeout=20)
        if m and m[0] == 2:
            print(f"[A] config {int.from_bytes(m[1:3],'little')}x{int.from_bytes(m[3:5],'little')}")
            break
    print("[A] session up, opening second connection...")

    b = WS()
    b.send(msg_login(user, passwd))
    print("[B] waiting session-exists...")
    while True:
        m = b.recv()
        if m and m[0] == 5:
            print("[B] got MSG_SESSION_EXISTS, sending takeover")
            b.send(b"\x15")  # MSG_TAKEOVER
            break
        if m and m[0] == 3:
            print(f"[B] unexpected login result ok={m[1]==1}")
            break

    print("[B] waiting login result...")
    while True:
        m = b.recv(timeout=30)
        if m and m[0] == 3:
            print(f"[B] login result ok={m[1]==1}")
            break
    got_cfg = False
    end = time.time() + 25
    while time.time() < end:
        try:
            m = b.recv(timeout=5)
        except socket.timeout:
            continue
        if not m:
            break
        if m[0] == 2:
            got_cfg = True
            print(f"[B] config {int.from_bytes(m[1:3],'little')}x{int.from_bytes(m[3:5],'little')}")
            break
        if m[0] == 1:
            print(f"[B] video frame {len(m)}B")
            break
    print("[B] got config:", got_cfg)

    print("[A] waiting close...")
    try:
        m = a.recv(timeout=8)
        print("[A] got", m[0] if m else "closed", "len", len(m) if m else 0)
    except socket.timeout:
        print("[A] timeout (still open?)")
    a.close()
    b.close()


if __name__ == "__main__":
    main()
