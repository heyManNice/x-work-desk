/* 与服务端一致的二进制协议 */

export const MSG_VIDEO = 0x01;
export const MSG_CONFIG = 0x02;
export const MSG_LOGIN_RESULT = 0x03;
export const MSG_CLOSE = 0x04;
export const MSG_SESSION_EXISTS = 0x05;

export const MSG_LOGIN = 0x10;
export const MSG_MOUSE = 0x11;
export const MSG_KEY = 0x12;
export const MSG_KEYFRAME = 0x13;
export const MSG_RESIZE = 0x14;
export const MSG_TAKEOVER = 0x15;
export const MSG_TAKEOVER_CANCEL = 0x16;
export const MSG_SET_FPS = 0x17;
export const MSG_SET_CODEC = 0x18;
export const MSG_SET_ANIMATIONS = 0x19;

export const VIDEO_FLAG_KEY = 0x01;
export const MOUSE_FLAG_MOTION = 0x01;
export const MOUSE_FLAG_BUTTON = 0x02;

export interface VideoConfig {
    width: number;
    height: number;
    sps: Uint8Array;
    pps: Uint8Array;
}

export interface LoginResult {
    ok: boolean;
    text: string;
}

const enc = new TextEncoder();

function u16(v: number): [number, number] {
    return [v & 0xff, (v >> 8) & 0xff];
}

function rdU16(b: Uint8Array, o: number): number {
    return b[o] | (b[o + 1] << 8);
}

/* ---------- 服务端 -> 客户端消息解析 ---------- */
export function parseLoginResult(b: Uint8Array): LoginResult {
    return {
        ok: b[1] === 1,
        text: new TextDecoder().decode(b.subarray(2)),
    };
}

export function parseConfig(b: Uint8Array): VideoConfig {
    let o = 1;
    const width = rdU16(b, o); o += 2;
    const height = rdU16(b, o); o += 2;
    const sl = rdU16(b, o); o += 2;
    const sps = b.subarray(o, o + sl); o += sl;
    const pl = rdU16(b, o); o += 2;
    const pps = b.subarray(o, o + pl);
    return { width, height, sps, pps };
}

/* ---------- 客户端 -> 服务端消息构造 ---------- */
export function msgLogin(user: string, pass: string, w: number, h: number): Uint8Array {
    const u = enc.encode(user);
    const p = enc.encode(pass);
    const b = new Uint8Array(1 + 2 + u.length + 2 + p.length + 4);
    let o = 0;
    b[o++] = MSG_LOGIN;
    const [ul, uh] = u16(u.length);
    b[o++] = ul; b[o++] = uh;
    b.set(u, o); o += u.length;
    const [pl, ph] = u16(p.length);
    b[o++] = pl; b[o++] = ph;
    b.set(p, o); o += p.length;
    const [wl, wh] = u16(w);
    const [hl, hh] = u16(h);
    b[o++] = wl; b[o++] = wh;
    b[o++] = hl; b[o++] = hh;
    return b;
}

export function msgResize(w: number, h: number): Uint8Array {
    const b = new Uint8Array(5);
    b[0] = MSG_RESIZE;
    b[1] = w & 0xff; b[2] = (w >> 8) & 0xff;
    b[3] = h & 0xff; b[4] = (h >> 8) & 0xff;
    return b;
}

export function msgMouseMotion(x: number, y: number): Uint8Array {
    const b = new Uint8Array(6);
    let o = 0;
    b[o++] = MSG_MOUSE;
    b[o++] = MOUSE_FLAG_MOTION;
    const [xl, xh] = u16(x);
    const [yl, yh] = u16(y);
    b[o++] = xl; b[o++] = xh;
    b[o++] = yl; b[o++] = yh;
    return b;
}

/* button 使用 X11 按钮号 */
export function msgMouseButton(x: number, y: number, button: number, pressed: boolean): Uint8Array {
    const b = new Uint8Array(8);
    let o = 0;
    b[o++] = MSG_MOUSE;
    b[o++] = MOUSE_FLAG_BUTTON;
    const [xl, xh] = u16(x);
    const [yl, yh] = u16(y);
    b[o++] = xl; b[o++] = xh;
    b[o++] = yl; b[o++] = yh;
    b[o++] = button;
    b[o++] = pressed ? 1 : 0;
    return b;
}

export function msgKey(pressed: boolean, code: string): Uint8Array {
    const c = enc.encode(code);
    const b = new Uint8Array(2 + c.length);
    b[0] = MSG_KEY;
    b[1] = pressed ? 1 : 0;
    b.set(c, 2);
    return b;
}

export function msgKeyframe(): Uint8Array {
    return new Uint8Array([MSG_KEYFRAME]);
}

export function msgTakeover(): Uint8Array {
    return new Uint8Array([MSG_TAKEOVER]);
}

export function msgTakeoverCancel(): Uint8Array {
    return new Uint8Array([MSG_TAKEOVER_CANCEL]);
}

export function msgSetFps(fps: number): Uint8Array {
    return new Uint8Array([MSG_SET_FPS, fps & 0xff]);
}

export function msgSetCodec(staticSkip: boolean, bitrateKbps: number, crf: number): Uint8Array {
    return new Uint8Array([
        MSG_SET_CODEC,
        staticSkip ? 1 : 0,
        bitrateKbps & 0xff,
        (bitrateKbps >> 8) & 0xff,
        crf & 0xff,
    ]);
}

export function msgSetAnimations(enable: boolean): Uint8Array {
    return new Uint8Array([MSG_SET_ANIMATIONS, enable ? 1 : 0]);
}
