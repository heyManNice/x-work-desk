/* 后端管线冒烟测试：连接 WS -> 登录 -> 验证 CONFIG + H.264 视频流 */
const URL = process.env.WS_URL || 'ws://localhost:5268/ws';
const USER = process.env.USER || 'cd2';

const MSG_VIDEO = 0x01, MSG_CONFIG = 0x02, MSG_LOGIN_RESULT = 0x03, MSG_CLOSE = 0x04;
const MSG_LOGIN = 0x10, MSG_KEYFRAME = 0x13;

const enc = new TextEncoder();
function msgLogin(user, pass) {
    const u = enc.encode(user), p = enc.encode(pass);
    const b = new Uint8Array(1 + 2 + u.length + 2 + p.length + 4);
    let o = 0;
    b[o++] = MSG_LOGIN;
    b[o++] = u.length & 0xff; b[o++] = (u.length >> 8) & 0xff;
    b.set(u, o); o += u.length;
    b[o++] = p.length & 0xff; b[o++] = (p.length >> 8) & 0xff;
    b.set(p, o); o += p.length;
    const w = 1280, h = 720;
    b[o++] = w & 0xff; b[o++] = (w >> 8) & 0xff;
    b[o++] = h & 0xff; b[o++] = (h >> 8) & 0xff;
    return b;
}

const ws = new WebSocket(URL);
ws.binaryType = 'arraybuffer';
const started = Date.now();
let gotConfig = false, frames = 0, keyframes = 0, firstVideoAt = 0, loginResult = null;

ws.onopen = () => {
    console.log('[open] 已连接');
    ws.send(msgLogin(USER, 'test-password'));
    console.log('[login] 已发送登录');
};

ws.onmessage = (ev) => {
    const b = new Uint8Array(ev.data);
    const t = b[0];
    if (t === MSG_LOGIN_RESULT) {
        const ok = b[1] === 1;
        loginResult = ok;
        console.log('[login_result]', ok ? '成功' : '失败', new TextDecoder().decode(b.subarray(2)));
        if (ok) ws.send(new Uint8Array([MSG_KEYFRAME]));
    } else if (t === MSG_CONFIG) {
        let o = 1;
        const w = b[o] | (b[o + 1] << 8); o += 2;
        const h = b[o] | (b[o + 1] << 8); o += 2;
        const sl = b[o] | (b[o + 1] << 8); o += 2;
        const sps = b.subarray(o, o + sl);
        gotConfig = true;
        console.log(`[config] ${w}x${h} sps=${sps.length}B codec=avc1.${sps[1].toString(16).padStart(2, '0')}${sps[2].toString(16).padStart(2, '0')}${sps[3].toString(16).padStart(2, '0')}`);
        ws.send(new Uint8Array([MSG_KEYFRAME]));
    } else if (t === MSG_VIDEO) {
        frames++;
        if (b[1] & 1) keyframes++;
        if (!firstVideoAt) firstVideoAt = Date.now() - started;
    } else if (t === MSG_CLOSE) {
        console.log('[close]', new TextDecoder().decode(b.subarray(1)));
    }
};

ws.onclose = () => console.log('[closed]');

setTimeout(() => {
    const ok = loginResult === true && gotConfig && frames > 0;
    console.log(`\n=== 结果 ===`);
    console.log(`登录成功: ${loginResult}`);
    console.log(`CONFIG: ${gotConfig}`);
    console.log(`视频帧: ${frames} (关键帧 ${keyframes}) 首帧延迟 ${firstVideoAt}ms`);
    console.log(ok ? '✅ 后端管线正常' : '❌ 测试失败');
    process.exit(ok ? 0 : 1);
}, 12000);
