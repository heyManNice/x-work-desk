import './style.css';
import {
    MSG_VIDEO,
    MSG_CONFIG,
    MSG_LOGIN_RESULT,
    parseConfig,
    parseLoginResult,
    MSG_CLOSE,
    msgLogin,
    msgResize,
    msgKeyframe,
} from './protocol';
import { VideoRenderer } from './decoder';
import { InputRelay } from './input';

const $ = <T extends HTMLElement = HTMLElement>(s: string): T =>
    document.querySelector(s) as T;

const loginScreen = $('#login-screen');
const deskScreen = $('#desk-screen');
const userInput = $('#xwd-account') as HTMLInputElement;
const passInput = $('#xwd-pass') as HTMLInputElement;
const loginForm = $('#login-form') as HTMLFormElement;
const loginBtn = $('#login-btn') as HTMLButtonElement;
const btnLabel = $('.btn-label');
const btnSpinner = $('.spinner');
const loginError = $('#login-error') as HTMLElement;
const canvas = $('#screen') as HTMLCanvasElement;
const disconnectBtn = $('#disconnect-btn');
const connectingOverlay = $('#connecting-overlay');
const dbgRes = $('#dbg-res');
const dbgFps = $('#dbg-fps');
const dbgLat = $('#dbg-lat');
const dbgBw = $('#dbg-bw');
const dbgDec = $('#dbg-dec');

let ws: WebSocket | null = null;
let renderer: VideoRenderer | null = null;
let relay: InputRelay | null = null;
let pendingLogin: { user: string; pass: string; w: number; h: number } | null = null;
let active = false;
let frameCount = 0;
let fpsTimer = 0;
let lastFps = 0;
let bwBytes = 0;   /* 本秒收到的字节数（带宽统计） */
let decSum = 0;    /* 本秒解码耗时累计（ms） */
let decCount = 0;  /* 本秒解码帧数 */
let resizeTimer = 0;
let keyReqTime = 0; /* 关键帧请求时间，用于估算往返延迟 */

/* 前端可视区域物理分辨率：innerWidth/Height 是视口 CSS 像素（随窗口大小变化，
 * 已含系统显示缩放），乘 devicePixelRatio 得到设备像素。这样浏览器窗口调整时
 * 桌面分辨率跟随重建，且在 150%/200% 缩放下画面 1:1 对应物理像素、不发糊。 */
function viewportSize(): [number, number] {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    /* H.264 要求宽高均为偶数（16x16 宏块），向下取偶，避免服务端 x264 打开失败 */
    return [
        Math.max(320, Math.min(4096, w)) & ~1,
        Math.max(200, Math.min(4096, h)) & ~1,
    ];
}

function sendResize(): void {
    const [w, h] = viewportSize();
    send(msgResize(w, h));
}

function send(data: Uint8Array): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
}

/* 请求关键帧并记录时间，用于估算往返延迟 */
function requestKeyframe(): void {
    keyReqTime = performance.now();
    send(msgKeyframe());
}

function connect(): void {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        /* 连接已就绪（如登录失败后重试）：直接发送，避免等 onopen 不触发 */
        if (pendingLogin && ws.readyState === WebSocket.OPEN) {
            send(msgLogin(pendingLogin.user, pendingLogin.pass, pendingLogin.w, pendingLogin.h));
            pendingLogin = null;
        }
        return;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        if (pendingLogin) {
            send(msgLogin(pendingLogin.user, pendingLogin.pass, pendingLogin.w, pendingLogin.h));
            pendingLogin = null;
        }
    };

    ws.onmessage = (ev) => {
        handleMessage(new Uint8Array(ev.data as ArrayBuffer));
    };

    ws.onclose = () => {
        if (active) onDisconnect();
    };

    ws.onerror = () => { };
}

function handleMessage(b: Uint8Array): void {
    const t = b[0];
    if (t === MSG_LOGIN_RESULT) {
        const r = parseLoginResult(b);
        if (r.ok) {
            loginBtn.hidden = true;
            showDesktop();
        } else {
            loginFail(r.text);
        }
    } else if (t === MSG_CONFIG) {
        const cfg = parseConfig(b);
        renderer?.configure(cfg);
        relay?.setSize(cfg.width, cfg.height);
        dbgRes.textContent = `${cfg.width}x${cfg.height}`;
        requestKeyframe();
    } else if (t === MSG_VIDEO) {
        const flags = b[1];
        /* 只在收到"本次请求对应的关键帧"时更新延迟，并清除标记，
         * 避免服务端周期性关键帧把过期请求时间显示成错误延迟 */
        if ((flags & 0x01) !== 0 && keyReqTime) {
            dbgLat.textContent = `${Math.round(performance.now() - keyReqTime)} ms`;
            keyReqTime = 0;
        }
        renderer?.feed(b.subarray(2), (flags & 0x01) !== 0);
        frameCount++;
        bwBytes += b.byteLength;
    } else if (t === MSG_CLOSE) {
        onDisconnect();
    }
}

function showDesktop(): void {
    active = true;
    loginScreen.classList.remove('active');
    deskScreen.classList.add('active');
    connectingOverlay.hidden = false;
    relay?.setActive(true);
    canvas.focus();
    sendResize(); /* 进入桌面后按当前视口同步分辨率 */
    triggerPasswordSave(); /* 登录成功后触发浏览器保存密码 */
}

/* 触发浏览器原生"保存密码"提示（无页面跳转、应用不保存任何密码）。
 * 隐藏 iframe 里的表单使用标准的 username/password 字段名，让浏览器识别为登录表单。
 * 页面内可见表单使用唯一字段名，仅用于避免自动填充建议，与保存无关。 */
function triggerPasswordSave(): void {
    try {
        let frame = document.getElementById('pw-save-frame') as HTMLIFrameElement | null;
        if (!frame) {
            frame = document.createElement('iframe');
            frame.id = 'pw-save-frame';
            frame.name = 'pw-save-frame';
            frame.style.display = 'none';
            document.body.appendChild(frame);
        }
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = '/';
        form.target = 'pw-save-frame';
        const u = document.createElement('input');
        u.type = 'text';
        u.name = 'username';
        u.value = userInput.value.trim();
        const p = document.createElement('input');
        p.type = 'password';
        p.name = 'password';
        p.value = passInput.value;
        form.appendChild(u);
        form.appendChild(p);
        document.body.appendChild(form);
        form.submit();
        form.remove();
    } catch {
        /* 忽略：某些环境不提示也不影响使用 */
    }
}

function loginFail(text?: string): void {
    loginBtn.disabled = false;
    loginBtn.classList.remove('loading');
    btnSpinner.hidden = true;
    btnLabel.textContent = '登录';
    loginError.hidden = !text;
    loginError.textContent = text ?? '';
}

function onDisconnect(): void {
    active = false;
    relay?.setActive(false);
    renderer?.destroy();
    relay?.releaseAll();
    passInput.value = ''; /* 注销后清空密码 */
    deskScreen.classList.remove('active');
    loginScreen.classList.add('active');
    loginBtn.disabled = false;
    loginBtn.classList.remove('loading');
    btnSpinner.hidden = true;
    btnLabel.textContent = '登录';
    connectingOverlay.hidden = true;
    loginError.hidden = true;
    frameCount = 0;
    lastFps = 0;
    bwBytes = 0;
    decSum = 0;
    decCount = 0;
    dbgFps.textContent = '';
    dbgLat.textContent = '';
    dbgBw.textContent = '';
    dbgDec.textContent = '';
    keyReqTime = 0;
}

/* ---------- 事件绑定 ---------- */
loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    loginError.hidden = true;
    const user = userInput.value.trim();
    const pass = passInput.value;
    if (!user || !pass) {
        return;
    }
    loginBtn.disabled = true;
    loginBtn.classList.add('loading');
    btnSpinner.hidden = false;
    btnLabel.textContent = '登录中…';
    const [vw, vh] = viewportSize();
    pendingLogin = { user, pass, w: vw, h: vh };
    connect();
});

disconnectBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (ws) { ws.close(); ws = null; }
    onDisconnect();
});

/* 窗口尺寸变化：防抖后按新视口重建会话分辨率 */
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
        if (active) sendResize();
    }, 400);
});

/* 每 1 秒刷新 FPS / 带宽 / 解码耗时统计 */
fpsTimer = window.setInterval(() => {
    lastFps = frameCount;
    frameCount = 0;
    if (active) dbgFps.textContent = `${lastFps} FPS`;

    const kbps = (bwBytes * 8) / 1000;
    dbgBw.textContent = kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
    bwBytes = 0;

    const avgDec = decCount > 0 ? decSum / decCount : 0;
    dbgDec.textContent = decCount > 0 ? `${avgDec.toFixed(1)} ms` : '';
    decSum = 0;
    decCount = 0;
}, 1000);

/* 初始化渲染器与输入 */
renderer = new VideoRenderer(canvas);
renderer.onKeyframeRequest = () => requestKeyframe();
renderer.onResize = () => {
    connectingOverlay.hidden = true;
};
renderer.onError = (msg) => {
    connectingOverlay.hidden = false;
    const p = connectingOverlay.querySelector('p');
    if (p) p.textContent = msg;
};
renderer.onDecodeTime = (ms) => {
    decSum += ms;
    decCount++;
};

relay = new InputRelay(canvas, send);
relay.attach();
