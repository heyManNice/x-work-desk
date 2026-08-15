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
    msgLogin,
    msgResize,
    msgKeyframe,
    msgTakeover,
    msgTakeoverCancel,
    msgSetFps,
    msgSetCodec,
    msgSetAnimations,
} from './protocol';
import { VideoRenderer } from './decoder';
import { InputRelay } from './input';
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
const settingsBtn = $('#settings-btn') as HTMLButtonElement;
const settingsPanel = $('#settings-panel') as HTMLElement;
const setDebug = $('#set-debug') as HTMLInputElement;
const setStatic = $('#set-static') as HTMLInputElement;
const setAnim = $('#set-anim') as HTMLInputElement;
const setBitrate = $('#set-bitrate') as HTMLSelectElement;
const setQuality = $('#set-quality') as HTMLSelectElement;
const rowQuality = $('#row-quality') as HTMLElement;
const setFps = $('#set-fps') as HTMLSelectElement;
const setRes = $('#set-res') as HTMLSelectElement;
const setRatio = $('#set-ratio') as HTMLSelectElement;
const debugHud = $('#debug-hud') as HTMLElement;
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

/* ---------- 设置偏好（localStorage 持久化） ---------- */
const PREFS_KEY = 'xwd-prefs';

interface Prefs {
    debug?: boolean;
    static?: boolean;
    anim?: boolean;
    bitrate?: number;
    quality?: number;
    fps?: number;
    res?: string;
    ratio?: string;
}

function loadPrefs(): Prefs {
    try {
        return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Prefs;
    } catch {
        return {};
    }
}

function savePrefs(p: Prefs): void {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    } catch {
        /* 忽略 */
    }
}

function applyDebugPref(show: boolean): void {
    debugHud.style.display = show ? '' : 'none';
}

function applyFpsPref(): void {
    const fps = parseInt(setFps.value, 10) || 30;
    if (active) send(msgSetFps(fps));
}

/* 码率质量行仅在码率=自动时显示；应用编码设置 */
function applyCodecPref(): void {
    const auto = setBitrate.value === '0';
    rowQuality.hidden = !auto;
    setQuality.disabled = !auto; /* 非自动时码率质量不可修改 */
    const staticSkip = setStatic.checked;
    const kbps = auto ? 0 : parseInt(setBitrate.value, 10) || 0;
    const q = parseInt(setQuality.value, 10);
    const crf = Number.isFinite(q) ? q : 23; /* 注意 0（无损）是合法值，不能用 || 兜底 */
    if (active) send(msgSetCodec(staticSkip, kbps, crf));
}

function applyAnimPref(): void {
    if (active) send(msgSetAnimations(setAnim.checked));
}

/* 固定分辨率（设置面板选择）；返回 null 表示自动跟随视口 */
function fixedResolution(): [number, number] | null {
    const v = setRes.value;
    if (v === 'auto') return null;
    const [w, h] = v.split('x').map((x) => parseInt(x, 10));
    return [w, h];
}

type RatioMode = 'fit' | 'stretch' | 'pixel';

/* 应用屏幕比例显示模式；点对点需要视频像素尺寸（canvas.width/height） */
function applyRatio(mode: RatioMode, vw?: number, vh?: number): void {
    canvas.classList.remove('fit', 'stretch', 'pixel');
    relay?.setRatio(mode); /* 鼠标坐标按显示模式映射（适应需去黑边） */
    if (mode === 'stretch') {
        canvas.classList.add('stretch');
        canvas.style.width = '';
        canvas.style.height = '';
    } else if (mode === 'pixel') {
        canvas.classList.add('pixel');
        canvas.style.width = `${vw || canvas.width}px`;
        canvas.style.height = `${vh || canvas.height}px`;
    } else {
        canvas.classList.add('fit');
        canvas.style.width = '';
        canvas.style.height = '';
    }
}

/* 前端可视区域物理分辨率：innerWidth/Height 是视口 CSS 像素（随窗口大小变化，
 * 已含系统显示缩放），乘 devicePixelRatio 得到设备像素。这样浏览器窗口调整时
 * 桌面分辨率跟随重建，且在 150%/200% 缩放下画面 1:1 对应物理像素、不发糊。 */
function viewportSize(): [number, number] {
    const fixed = fixedResolution();
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
    if (t === MSG_CURSOR) {
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
        dbgRes.textContent = `${cfg.width}x${cfg.height}`;
        applyRatio(setRatio.value as RatioMode, cfg.width, cfg.height);
        requestKeyframe();
    } else if (t === MSG_SESSION_EXISTS) {
        /* 该账户已有活跃会话：询问是否注销旧会话并接管 */
        const take = window.confirm('该账户已在其他窗口登录。\n\n是否注销旧会话并接管？');
        send(take ? msgTakeover() : msgTakeoverCancel());
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
    /* 指标占位显示 0，避免进入桌面后内容跳动 */
    dbgFps.textContent = '0 FPS';
    dbgLat.textContent = '0 ms';
    dbgBw.textContent = '0 kbps';
    dbgDec.textContent = '0.0 ms';
    applyDebugPref(setDebug.checked); /* 应用调试信息显示偏好 */
    applyFpsPref();                   /* 应用最大帧率设置 */
    applyCodecPref();                 /* 应用静态帧/码率/质量设置 */
    applyAnimPref();                  /* 应用桌面动画设置 */
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
    /* 指标保持占位显示 0，避免下次进入桌面时内容跳动 */
    dbgFps.textContent = '0 FPS';
    dbgLat.textContent = '0 ms';
    dbgBw.textContent = '0 kbps';
    dbgDec.textContent = '0.0 ms';
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
    keyReqTime = 0;
}

/* ---------- 事件绑定 ---------- */
/* 设置面板：初始化偏好 + 交互 */
{
    const prefs = loadPrefs();
    setDebug.checked = prefs.debug !== false;
    setStatic.checked = prefs.static !== false;
    setAnim.checked = prefs.anim !== false; /* 默认禁用动画（性能优先） */
    setBitrate.value = String(prefs.bitrate ?? 0);
    setQuality.value = String(prefs.quality ?? 23);
    setFps.value = String(prefs.fps && prefs.fps > 0 ? prefs.fps : 30);
    setRes.value = prefs.res && prefs.res !== 'auto' ? prefs.res : 'auto';
    setRatio.value = prefs.ratio || 'fit';
    applyDebugPref(setDebug.checked);
    applyCodecPref();
}

settingsBtn.addEventListener('click', () => {
    const open = settingsPanel.hidden;
    settingsPanel.hidden = !open;
    settingsBtn.classList.toggle('active', open);
});

/* 点击面板外部关闭 */
document.addEventListener('click', (e) => {
    if (!settingsPanel.hidden &&
        !settingsPanel.contains(e.target as Node) &&
        !settingsBtn.contains(e.target as Node)) {
        settingsPanel.hidden = true;
        settingsBtn.classList.remove('active');
    }
});

setDebug.addEventListener('change', () => {
    savePrefs({ ...loadPrefs(), debug: setDebug.checked });
    applyDebugPref(setDebug.checked);
});

setStatic.addEventListener('change', () => {
    savePrefs({ ...loadPrefs(), static: setStatic.checked });
    applyCodecPref();
});

setAnim.addEventListener('change', () => {
    savePrefs({ ...loadPrefs(), anim: setAnim.checked });
    applyAnimPref();
});


setBitrate.addEventListener('change', () => {
    savePrefs({ ...loadPrefs(), bitrate: parseInt(setBitrate.value, 10) || 0 });
    applyCodecPref();
});

setQuality.addEventListener('change', () => {
    const q = parseInt(setQuality.value, 10);
    savePrefs({ ...loadPrefs(), quality: Number.isFinite(q) ? q : 23 });
    applyCodecPref();
});

setFps.addEventListener('change', () => {
    const fps = parseInt(setFps.value, 10) || 30;
    savePrefs({ ...loadPrefs(), fps });
    applyFpsPref();
});

setRes.addEventListener('change', () => {
    savePrefs({ ...loadPrefs(), res: setRes.value });
    if (active) sendResize(); /* 运行中立即按新分辨率重建会话 */
});

setRatio.addEventListener('change', () => {
    savePrefs({ ...loadPrefs(), ratio: setRatio.value });
    applyRatio(setRatio.value as RatioMode, canvas.width, canvas.height);
});

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
    dbgFps.textContent = `${active ? lastFps : 0} FPS`;

    const kbps = (bwBytes * 8) / 1000;
    dbgBw.textContent = kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
    bwBytes = 0;

    const avgDec = decCount > 0 ? decSum / decCount : 0;
    dbgDec.textContent = `${avgDec.toFixed(1)} ms`;
    decSum = 0;
    decCount = 0;
}, 1000);

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
    decSum += ms;
    decCount++;
    if (!connectingOverlay.hidden) {
        connectingOverlay.hidden = true; /* 首帧渲染完成，桌面已出画面 */
    }
};

relay = new InputRelay(canvas, send);
relay.attach();
