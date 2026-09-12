/* 与服务端一致的二进制协议 */

export const MSG_VIDEO = 0x01;
export const MSG_CONFIG = 0x02;
export const MSG_LOGIN_RESULT = 0x03;
export const MSG_CLOSE = 0x04;
export const MSG_SESSION_EXISTS = 0x05;
export const MSG_CURSOR = 0x06;
export const MSG_AUDIO = 0x07;
export const MSG_CLIPBOARD = 0x08;
export const MSG_LOCAL_IN_USE = 0x0e;   /* 实体机(seat0)正登录该账号：需先踢出实体机会话 */

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
export const MSG_SET_AUDIO = 0x1a;
export const MSG_SET_CLIPBOARD = 0x1b;
export const MSG_LOGOUT = 0x1c; /* 注销当前会话（销毁桌面） */
export const MSG_REQUEST_CONFIG = 0x1e; /* 请求重发 CONFIG（接管后补拉流） */
export const MSG_KICK_LOCAL = 0x1f; /* 确认踢出实体机会话，继续远程登录 */

/* 本机输入法中继（IM，见 docs/input-method-local.md）：服务端↔引擎走 AF_UNIX，
 * 客户端只跟服务端走这几个 WS 消息；IME 的组词发生在本机，引擎只负责上屏。 */
export const MSG_IM_ENABLE = 0x20;  /* enable(1)：开关本机输入法模式（服务端据此切/还原输入源） */
export const MSG_IM_PREEDIT = 0x21; /* pos(2) + UTF-8：预编辑串（空串=收起） */
export const MSG_IM_COMMIT = 0x22;  /* UTF-8：提交文本 */
export const MSG_IM_RESET = 0x23;   /* 丢弃当前组合 */
export const MSG_IM_CARET = 0x24;   /* 远端插入点矩形：x,y,w,h 各 i16（有符号，小端） */
export const MSG_IM_STATE = 0x25;   /* 引擎状态：state(1) */

/* 引擎状态（与 src/im_proto.h 的 IM_STATE_* 保持一致） */
export const IM_STATE_READY = 0;    /* 引擎已接入且是当前引擎 */
export const IM_STATE_DISABLED = 1; /* 引擎被用户/系统切走 */
export const IM_STATE_ABSENT = 2;   /* 远端引擎不在（未装/未激活/已退出） */

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

export interface CursorImage {
    width: number;
    height: number;
    hx: number;
    hy: number;
    pixels: Uint8Array; /* RGBA 直通格式 */
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

export function parseCursor(b: Uint8Array): CursorImage {
    let o = 1;
    const width = rdU16(b, o); o += 2;
    const height = rdU16(b, o); o += 2;
    const hx = rdU16(b, o); o += 2;
    const hy = rdU16(b, o); o += 2;
    const pixels = b.subarray(o, o + width * height * 4);
    return { width, height, hx, hy, pixels };
}

/* 远端插入点矩形（屏幕坐标，可含负值：多显示器在左侧） */
export interface IMCaret {
    x: number;
    y: number;
    w: number;
    h: number;
}

export function parseIMCaret(b: Uint8Array): IMCaret {
    const i16 = (o: number): number => ((rdU16(b, o) << 16) >> 16); /* 有符号 */
    return { x: i16(1), y: i16(3), w: i16(5), h: i16(7) };
}

export function parseIMState(b: Uint8Array): number {
    return b.length > 1 ? b[1] : IM_STATE_ABSENT;
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

export function msgKickLocal(): Uint8Array {
    return new Uint8Array([MSG_KICK_LOCAL]);
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

export function msgSetAudio(enable: boolean): Uint8Array {
    return new Uint8Array([MSG_SET_AUDIO, enable ? 1 : 0]);
}

export function msgSetClipboard(enable: boolean): Uint8Array {
    return new Uint8Array([MSG_SET_CLIPBOARD, enable ? 1 : 0]);
}

export function msgClipboard(text: string): Uint8Array {
    const t = enc.encode(text);
    const b = new Uint8Array(1 + t.length);
    b[0] = MSG_CLIPBOARD;
    b.set(t, 1);
    return b;
}

export function msgLogout(): Uint8Array {
    return new Uint8Array([MSG_LOGOUT]);
}

export function msgRequestConfig(): Uint8Array {
    return new Uint8Array([MSG_REQUEST_CONFIG]);
}

/* ---------- 本机输入法（IM）：客户端 -> 服务端 ---------- */

export function msgIMEnable(enable: boolean): Uint8Array {
    return new Uint8Array([MSG_IM_ENABLE, enable ? 1 : 0]);
}

/** pos = 串内光标位置（**字符数**，不是 UTF-16 索引，也不是字节数） */
export function msgIMPreedit(text: string, pos: number): Uint8Array {
    const t = enc.encode(text);
    const b = new Uint8Array(3 + t.length);
    b[0] = MSG_IM_PREEDIT;
    b[1] = pos & 0xff;
    b[2] = (pos >> 8) & 0xff;
    b.set(t, 3);
    return b;
}

export function msgIMCommit(text: string): Uint8Array {
    const t = enc.encode(text);
    const b = new Uint8Array(1 + t.length);
    b[0] = MSG_IM_COMMIT;
    b.set(t, 1);
    return b;
}

export function msgIMReset(): Uint8Array {
    return new Uint8Array([MSG_IM_RESET]);
}
