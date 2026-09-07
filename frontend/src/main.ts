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
    MSG_CLIPBOARD,
    MSG_TRANSFER_TOKEN,
    MSG_TRANSFER_REQUEST,
    MSG_TRANSFER_ERROR,
    parseTransferRequest,
    TRANSFER_ACT_DOWNLOAD,
    TRANSFER_ACT_UPLOADDIR,
    msgLogin,
    msgResize,
    msgKeyframe,
    msgTakeover,
    msgTakeoverCancel,
    msgClipboard,
} from './protocol';
import { VideoRenderer } from './decoder';
import { InputRelay } from './input';
import { AudioPlayer } from './audio';
import { setTransferToken, handleDownloadRequest, handleUploadRequest, showTransferError } from './transfer';
import { showConfirm } from './modal';
import { setServer, getServer, splitUserHost, resolveServer } from './server';
import {
    initStats, setResolution, onVideoFrame, onDecodeTime,
    requestKeyframeTime, onKeyframeReceived, resetStats
} from './stats';
import {
    initSettings, getFixedResolution, applyDisplayRatio,
    applyAllPrefs, setResizeRequest
} from './settings';
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
let clipboardEnabled = false;
let clipCache = '';
let pendingLogin: { user: string; pass: string; w: number; h: number } | null = null;
let active = false;
let loginWaiting = false; /* 登录请求已发出、尚未收到结果（连接失败判定用） */
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
            loginWaiting = true;
        }
        return;
    }
    /* 服务器地址在登录提交时解析并 setServer；连接用其 wsUrl（Tauri/跨机可连远程） */
    loginWaiting = true;
    ws = new WebSocket(getServer().wsUrl);
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
        if (loginWaiting) {
            /* 登录结果未收到即断开：连接失败（网络/地址错误，或 WebView/浏览器
             * 安全策略拦截了到 http/ws 后端的连接） */
            loginWaiting = false;
            loginFail('无法连接到服务器：请检查 账号@主机 地址与端口。\n若服务器仅支持 http，可能被浏览器的安全策略拦截');
        } else if (active) {
            onDisconnect();
        }
    };

    ws.onerror = () => { };
}

function handleClipboardMsg(b: Uint8Array): void {
    void clipWrite(new TextDecoder().decode(b.subarray(1)));
}

function handleLoginResult(b: Uint8Array): void {
    const r = parseLoginResult(b);
    loginWaiting = false;
    if (r.ok) {
        sessionStorage.removeItem('xwd-reconnect'); /* 登录成功，重连标记失效 */
        loginBtn.hidden = true;
        showDesktop();
    } else {
        loginFail(r.text);
    }
}

function handleConfigMsg(b: Uint8Array): void {
    const cfg = parseConfig(b);
    renderer?.configure(cfg);
    relay?.setSize(cfg.width, cfg.height);
    setResolution(cfg.width, cfg.height);
    applyDisplayRatio(cfg.width, cfg.height);
    requestKeyframe();
}

/* 自制确认弹窗见 modal.ts（showConfirm），用于第二人登录确认 */
async function handleSessionExists(): Promise<void> {
    /* 刷新/重连场景（pagehide 已标记）：静默继承旧会话（复用原桌面，不注销） */
    if (sessionStorage.getItem('xwd-reconnect') === '1') {
        sessionStorage.removeItem('xwd-reconnect');
        send(msgTakeover());
        return;
    }
    /* 第二处登录：自制弹窗警告，继承原会话（不注销） */
    const take = await showConfirm(
        '会话提醒',
        '该账号已有会话在使用。\n\n继续登录将断开前一个连接并继承其桌面（会话不会注销）。是否继续？',
    );
    send(take ? msgTakeover() : msgTakeoverCancel());
}

function handleVideoMsg(b: Uint8Array): void {
    const flags = b[1];
    if ((flags & 0x01) !== 0) onKeyframeReceived();
    renderer?.feed(b.subarray(2), (flags & 0x01) !== 0);
    onVideoFrame(b.byteLength);
}

/* 扩展触发的传输请求：download（路径列表）/ uploaddir（目标目录） */
function handleTransferRequestMsg(b: Uint8Array): void {
    const r = parseTransferRequest(b);
    if (r.action === TRANSFER_ACT_DOWNLOAD) {
        handleDownloadRequest(r.text);
    } else if (r.action === TRANSFER_ACT_UPLOADDIR) {
        handleUploadRequest(r.text.trim());
    }
}

function handleMessage(b: Uint8Array): void {
    switch (b[0]) {
        case MSG_TRANSFER_TOKEN:
            setTransferToken(new TextDecoder().decode(b.subarray(1)));
            break;
        case MSG_TRANSFER_ERROR:
            showTransferError(new TextDecoder().decode(b.subarray(1)));
            break;
        case MSG_TRANSFER_REQUEST:
            handleTransferRequestMsg(b);
            break;
        case MSG_CLIPBOARD:
            handleClipboardMsg(b);
            break;
        case MSG_AUDIO:
            audioPlayer.feed(b.subarray(1));
            break;
        case MSG_CURSOR:
            applyCursor(parseCursor(b));
            break;
        case MSG_LOGIN_RESULT:
            handleLoginResult(b);
            break;
        case MSG_CONFIG:
            handleConfigMsg(b);
            break;
        case MSG_SESSION_EXISTS:
            handleSessionExists();
            break;
        case MSG_VIDEO:
            handleVideoMsg(b);
            break;
        case MSG_CLOSE:
            onDisconnect();
            break;
        default:
            break;
    }
}

/* ---------- 剪贴板共享 ---------- */
async function clipWrite(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
        clipCache = text;
    } catch {
        /* 无用户手势时写入可能被拒；内容已在远程，提示用户手动粘贴 */
    }
}

/* 页面获得焦点/可见时读取浏览器剪贴板，内容变化则推送服务端 */
async function clipReadPush(): Promise<void> {
    if (!clipboardEnabled) return;
    try {
        const t = await navigator.clipboard.readText();
        if (t && t !== clipCache) {
            clipCache = t;
            send(msgClipboard(t));
        }
    } catch {
        /* 无权限/非手势读取失败则忽略 */
    }
}

window.addEventListener('focus', () => { void clipReadPush(); });
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void clipReadPush();
});

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
}

function loginFail(text?: string): void {
    loginWaiting = false;
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
    /* 保留解码器：同分辨率重连时不重建，避免画面闪烁；
     * 分辨率变化时 configure() 会按新尺寸重建 */
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
    const pass = passInput.value;
    /* 用户名框支持 user@host[:port]：拆分出账号与目标服务器 */
    const { user, hostPort } = splitUserHost(userInput.value);
    if (!user || !pass) {
        return;
    }
    const srv = resolveServer(hostPort);
    if (!srv) {
        loginError.textContent = '无法确定服务器：请以 user@host 形式输入主机地址';
        loginError.hidden = false;
        return;
    }
    setServer(srv);
    /* 在用户手势内同步做一次同文档导航（history.pushState）：Chrome 的密码
     * 管理器把"提交了含密码的表单 + 发生同文档导航"识别为登录成功，从而弹出
     * 保存密码提示（Chromium 原生行为，CL 802593005）。页面不刷新，WS 登录
     * 照常进行。 */
    history.pushState({}, '', '/');
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

/* 刷新/关闭前标记“正在重连”：刷新后重新登录时静默接管旧会话，
 * 避免服务端误判“已有活跃会话”而弹出确认框（刷新时序竞态） */
window.addEventListener('pagehide', () => {
    sessionStorage.setItem('xwd-reconnect', '1');
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
/* 诊断（Tauri/WebKit 调试）：把 WebCodecs 可用性与错误写入窗口标题，
 * 便于在无界面环境用 xdotool 读标题确认（WebKitGTK 可能不支持 WebCodecs） */
try {
    document.title =
        typeof VideoDecoder === 'undefined' || typeof VideoFrame === 'undefined'
            ? 'XWD-ERR:WebCodecs 不可用'
            : 'XWD-OK:WebCodecs 可用';
} catch { /* ignore */ }
renderer.onKeyframeRequest = () => requestKeyframe();
renderer.onResize = () => {
    /* 不再在这里隐藏提示层：等收到第一帧实际渲染的画面再隐藏，
     * 避免编码器就绪（CONFIG）但桌面还在启动时出现无提示的黑屏等待 */
};
renderer.onError = (msg) => {
    connectingOverlay.hidden = false;
    const p = connectingOverlay.querySelector('p');
    if (p) p.textContent = msg;
    try { document.title = 'XWD-ERR:' + String(msg).slice(0, 40); } catch { /* ignore */ }
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
    onClipboardToggle: (enable) => { clipboardEnabled = enable; },
});
setResizeRequest(() => sendResize());
