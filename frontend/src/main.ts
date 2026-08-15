import './style.css';
import {
    MSG_VIDEO,
    MSG_CONFIG,
    MSG_LOGIN_RESULT,
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
const userInput = $('#username') as HTMLInputElement;
const passInput = $('#password') as HTMLInputElement;
const loginForm = $('#login-form') as HTMLFormElement;
const loginBtn = $('#login-btn') as HTMLButtonElement;
const btnLabel = $('.btn-label');
const btnSpinner = $('.spinner');
const loginErr = $('#login-error');
const connStatus = $('#conn-status');
const statusEl = $('#status');
const fpsEl = $('#fps');
const canvas = $('#screen') as HTMLCanvasElement;
const disconnectBtn = $('#disconnect-btn');
const connectingOverlay = $('#connecting-overlay');

let ws: WebSocket | null = null;
let renderer: VideoRenderer | null = null;
let relay: InputRelay | null = null;
let pendingLogin: { user: string; pass: string; w: number; h: number } | null = null;
let active = false;
let frameCount = 0;
let fpsTimer = 0;
let lastFps = 0;
let resizeTimer = 0;

/* 前端视口尺寸（扣除顶栏高度，与桌面可视区域 1:1 对应） */
function viewportSize(): [number, number] {
    const w = Math.floor(window.innerWidth);
    const h = Math.floor(window.innerHeight - 52); // 顶栏约 52px
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

function setConnStatus(text: string, color?: string): void {
    connStatus.textContent = text;
    connStatus.style.color = color ?? '';
}

function connect(): void {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        setConnStatus('已连接', '#34d399');
        if (pendingLogin) {
            send(msgLogin(pendingLogin.user, pendingLogin.pass, pendingLogin.w, pendingLogin.h));
            pendingLogin = null;
        }
    };

    ws.onmessage = (ev) => {
        handleMessage(new Uint8Array(ev.data as ArrayBuffer));
    };

    ws.onclose = () => {
        setConnStatus('未连接');
        if (active) onDisconnect('连接已断开');
    };

    ws.onerror = () => { };
}

function handleMessage(b: Uint8Array): void {
    const t = b[0];
    if (t === MSG_LOGIN_RESULT) {
        const ok = b[1] === 1;
        const txt = new TextDecoder().decode(b.subarray(2));
        if (ok) {
            loginBtn.hidden = true;
            showDesktop();
        } else {
            loginFail(txt);
        }
    } else if (t === MSG_CONFIG) {
        let o = 1;
        const w = b[o] | (b[o + 1] << 8); o += 2;
        const h = b[o] | (b[o + 1] << 8); o += 2;
        const sl = b[o] | (b[o + 1] << 8); o += 2;
        const sps = b.subarray(o, o + sl); o += sl;
        const pl = b[o] | (b[o + 1] << 8); o += 2;
        const pps = b.subarray(o, o + pl);
        renderer?.configure({ width: w, height: h, sps, pps });
        relay?.setSize(w, h);
        send(msgKeyframe());
    } else if (t === MSG_VIDEO) {
        const flags = b[1];
        renderer?.feed(b.subarray(2), (flags & 0x01) !== 0);
        frameCount++;
    } else if (t === MSG_CLOSE) {
        onDisconnect(new TextDecoder().decode(b.subarray(1)));
    }
}

function showDesktop(): void {
    active = true;
    loginScreen.classList.remove('active');
    deskScreen.classList.add('active');
    statusEl.textContent = '正在启动桌面会话…';
    connectingOverlay.hidden = false;
    relay?.setActive(true);
    canvas.focus();
    sendResize(); /* 进入桌面后按当前视口同步分辨率 */
}

function loginFail(txt: string): void {
    loginBtn.disabled = false;
    loginBtn.classList.remove('loading');
    btnSpinner.hidden = true;
    btnLabel.textContent = '登录';
    loginErr.hidden = false;
    loginErr.textContent = txt || '登录失败';
}

function onDisconnect(msg: string): void {
    active = false;
    relay?.setActive(false);
    renderer?.destroy();
    relay?.releaseAll();
    deskScreen.classList.remove('active');
    loginScreen.classList.add('active');
    loginBtn.disabled = false;
    loginBtn.classList.remove('loading');
    btnSpinner.hidden = true;
    btnLabel.textContent = '登录';
    if (msg) {
        loginErr.hidden = false;
        loginErr.textContent = msg;
    }
    connectingOverlay.hidden = true;
}

/* ---------- 事件绑定 ---------- */
loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const user = userInput.value.trim();
    const pass = passInput.value;
    if (!user || !pass) {
        loginErr.hidden = false;
        loginErr.textContent = '请输入用户名和密码';
        return;
    }
    loginErr.hidden = true;
    loginBtn.disabled = true;
    loginBtn.classList.add('loading');
    btnSpinner.hidden = false;
    btnLabel.textContent = '登录中…';
    const [vw, vh] = viewportSize();
    pendingLogin = { user, pass, w: vw, h: vh };
    connect();
});

disconnectBtn.addEventListener('click', () => {
    if (ws) { ws.close(); ws = null; }
    onDisconnect('已主动断开');
});

/* 窗口尺寸变化：防抖后按新视口重建会话分辨率 */
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
        if (active) sendResize();
    }, 400);
});

/* FPS 统计 */
fpsTimer = window.setInterval(() => {
    lastFps = frameCount;
    frameCount = 0;
    if (active && lastFps > 0) fpsEl.textContent = `${lastFps} FPS`;
    else if (active) fpsEl.textContent = '';
}, 1000);

/* 初始化渲染器与输入 */
renderer = new VideoRenderer(canvas);
renderer.onKeyframeRequest = () => send(msgKeyframe());
renderer.onResize = () => {
    statusEl.textContent = '桌面已连接';
    connectingOverlay.hidden = true;
};
renderer.onError = (msg) => {
    statusEl.textContent = msg;
    connectingOverlay.hidden = false;
};

relay = new InputRelay(canvas, send);
relay.attach();
