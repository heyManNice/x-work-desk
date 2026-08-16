import './style.css';
import {
    MSG_VIDEO,
    MSG_CONFIG,
    MSG_LOGIN_RESULT,
    parseConfig,
    parseLoginResult,
    parseCursor,
    MSG_CLOSE,
    MSG_SESSION_EXISTS,
    MSG_CURSOR,
    MSG_AUDIO,
    msgLogin,
    msgResize,
    msgKeyframe,
    msgTakeover,
    msgTakeoverCancel,
} from './protocol';
import { VideoRenderer } from './decoder';
import { InputRelay } from './input';
import { AudioPlayer } from './audio';
import { initStats, setResolution, onVideoFrame, onDecodeTime,
         requestKeyframeTime, onKeyframeReceived, resetStats } from './stats';
import { initSettings, getFixedResolution, applyDisplayRatio,
         applyAllPrefs, setResizeRequest } from './settings';
import type { CursorImage } from './protocol';

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
const debugHud = $('#debug-hud') as HTMLElement;
const connectingOverlay = $('#connecting-overlay');

let ws: WebSocket | null = null;
let renderer: VideoRenderer | null = null;
let relay: InputRelay | null = null;
const audioPlayer = new AudioPlayer();
let pendingLogin: { user: string; pass: string; w: number; h: number } | null = null;
let active = false;
let resizeTimer = 0;

/* 前端可视区域物理分辨率：innerWidth/Height 是视口 CSS 像素（随窗口大小变化，
 * 已含系统显示缩放），乘 devicePixelRatio 得到设备像素。这样浏览器窗口调整时
 * 桌面分辨率跟随重建，且在 150%/200% 缩放下画面 1:1 对应物理像素、不发糊。 */
function viewportSize(): [number, number] {
    const fixed = getFixedResolution();
    if (fixed) return fixed;
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
    requestKeyframeTime();
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
    if (t === MSG_AUDIO) {
        audioPlayer.feed(b.subarray(1));
    } else if (t === MSG_CURSOR) {
        applyCursor(parseCursor(b));
    } else if (t === MSG_LOGIN_RESULT) {
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
        setResolution(cfg.width, cfg.height);
        applyDisplayRatio(cfg.width, cfg.height);
        requestKeyframe();
    } else if (t === MSG_SESSION_EXISTS) {
        /* 该账户已有活跃会话：询问是否注销旧会话并接管 */
        const take = window.confirm('该账户已在其他窗口登录。\n\n是否注销旧会话并接管？');
        send(take ? msgTakeover() : msgTakeoverCancel());
    } else if (t === MSG_VIDEO) {
        const flags = b[1];
        if ((flags & 0x01) !== 0) onKeyframeReceived();
        renderer?.feed(b.subarray(2), (flags & 0x01) !== 0);
        onVideoFrame(b.byteLength);
    } else if (t === MSG_CLOSE) {
        onDisconnect();
    }
}

/* 应用远程光标：转成 data URL 后设为 canvas 的 CSS cursor（含热点） */
function applyCursor(c: CursorImage): void {
    try {
        const cv = document.createElement('canvas');
        cv.width = c.width;
        cv.height = c.height;
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        const img = ctx.createImageData(c.width, c.height);
        img.data.set(c.pixels);
        ctx.putImageData(img, 0, 0);
        const url = cv.toDataURL('image/png');
        canvas.style.cursor = `url(${url}) ${c.hx} ${c.hy}, auto`;
    } catch {
        /* 忽略：光标设置失败时保持默认 */
    }
}

function showDesktop(): void {
    active = true;
    loginScreen.classList.remove('active');
    deskScreen.classList.add('active');
    /* 接管空闲会话时 CONFIG 可能已先到达（渲染器已配置），直接隐藏提示层 */
    connectingOverlay.hidden = renderer?.isConfigured ?? false;
    resetStats();    /* 指标占位显示 0，避免进入桌面后内容跳动 */
    applyAllPrefs(); /* 应用调试信息/帧率/码率/动画等设置 */
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
    audioPlayer.stop(); /* 断开时停止音频播放 */
    relay?.setActive(false);
    renderer?.destroy();
    relay?.releaseAll();
    passInput.value = ''; /* 注销后清空密码 */
    resetStats(); /* 指标保持占位显示 0，避免下次进入桌面时内容跳动 */
    deskScreen.classList.remove('active');
    loginScreen.classList.add('active');
    loginBtn.disabled = false;
    loginBtn.classList.remove('loading');
    btnSpinner.hidden = true;
    btnLabel.textContent = '登录';
    connectingOverlay.hidden = true;
    loginError.hidden = true;
}

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

/* 初始化渲染器与输入 */
renderer = new VideoRenderer(canvas);
renderer.onKeyframeRequest = () => requestKeyframe();
renderer.onResize = () => {
    /* 不再在这里隐藏提示层：等收到第一帧实际渲染的画面再隐藏，
     * 避免编码器就绪（CONFIG）但桌面还在启动时出现无提示的黑屏等待 */
};
renderer.onError = (msg) => {
    connectingOverlay.hidden = false;
    const p = connectingOverlay.querySelector('p');
    if (p) p.textContent = msg;
};
renderer.onDecodeTime = (ms) => {
    onDecodeTime(ms);
    if (!connectingOverlay.hidden) {
        connectingOverlay.hidden = true; /* 首帧渲染完成，桌面已出画面 */
    }
};

relay = new InputRelay(canvas, send);
relay.attach();

/* 初始化统计与设置模块 */
initStats({ getActive: () => active });
initSettings({
    send,
    canvas,
    setRatioMode: (m) => relay?.setRatio(m),
    debugHud,
    isActive: () => active,
    onAudioToggle: (enable) => (enable ? audioPlayer.start() : audioPlayer.stop()),
});
setResizeRequest(() => sendResize());
