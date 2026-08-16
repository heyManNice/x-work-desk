/* 登录页设置面板：偏好持久化（localStorage）+ 控件交互 + 各设置下发 */

import { msgSetFps, msgSetCodec, msgSetAnimations, msgSetAudio, msgSetClipboard } from './protocol';

export type RatioMode = 'fit' | 'stretch' | 'pixel';

export interface SettingsContext {
    send: (d: Uint8Array) => void;
    canvas: HTMLCanvasElement;
    setRatioMode: (m: RatioMode) => void; /* 鼠标坐标按显示模式映射 */
    debugHud: HTMLElement;
    isActive: () => boolean;
    onAudioToggle: (enable: boolean) => void; /* 打开/关闭前端音频播放 */
    onClipboardToggle: (enable: boolean) => void; /* 打开/关闭前端剪贴板监听 */
}

const $ = <T extends HTMLElement = HTMLElement>(s: string): T =>
    document.querySelector(s) as T;

const settingsBtn = $('#settings-btn') as HTMLButtonElement;
const settingsPanel = $('#settings-panel') as HTMLElement;
const setDebug = $('#set-debug') as HTMLInputElement;
const setStatic = $('#set-static') as HTMLInputElement;
const setAnim = $('#set-anim') as HTMLInputElement;
const setAudio = $('#set-audio') as HTMLInputElement;
const setClipboard = $('#set-clipboard') as HTMLInputElement;
const setBitrate = $('#set-bitrate') as HTMLSelectElement;
const setQuality = $('#set-quality') as HTMLSelectElement;
const rowQuality = $('#row-quality') as HTMLElement;
const setFps = $('#set-fps') as HTMLSelectElement;
const setRes = $('#set-res') as HTMLSelectElement;
const setRatio = $('#set-ratio') as HTMLSelectElement;

const PREFS_KEY = 'xwd-prefs';

export interface Prefs {
    debug?: boolean;
    static?: boolean;
    anim?: boolean;
    audio?: boolean;
    clipboard?: boolean;
    bitrate?: number;
    quality?: number;
    fps?: number;
    res?: string;
    ratio?: string;
}

let ctx: SettingsContext = {
    send: () => {},
    canvas: document.createElement('canvas'),
    setRatioMode: () => {},
    debugHud: document.createElement('div'),
    isActive: () => false,
    onAudioToggle: () => {},
    onClipboardToggle: () => {},
};

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
    ctx.debugHud.style.display = show ? '' : 'none';
}

function applyFpsPref(): void {
    const fps = parseInt(setFps.value, 10) || 30;
    if (ctx.isActive()) ctx.send(msgSetFps(fps));
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
    if (ctx.isActive()) ctx.send(msgSetCodec(staticSkip, kbps, crf));
}

function applyAnimPref(): void {
    if (ctx.isActive()) ctx.send(msgSetAnimations(setAnim.checked));
}

function applyAudioPref(): void {
    ctx.onAudioToggle(setAudio.checked);
    if (ctx.isActive()) ctx.send(msgSetAudio(setAudio.checked));
}

function applyClipboardPref(): void {
    ctx.onClipboardToggle(setClipboard.checked);
    if (ctx.isActive()) ctx.send(msgSetClipboard(setClipboard.checked));
}

/* 固定分辨率（设置面板选择）；返回 null 表示自动跟随视口 */
export function getFixedResolution(): [number, number] | null {
    const v = setRes.value;
    if (v === 'auto') return null;
    const [w, h] = v.split('x').map((x) => parseInt(x, 10));
    return [w, h];
}

/* 应用屏幕比例显示模式；点对点需要视频像素尺寸（canvas.width/height） */
function applyRatio(mode: RatioMode, vw?: number, vh?: number): void {
    const canvas = ctx.canvas;
    canvas.classList.remove('fit', 'stretch', 'pixel');
    ctx.setRatioMode(mode); /* 鼠标坐标按显示模式映射（适应需去黑边） */
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

/* main 在收到 CONFIG 时调用：按当前选择应用屏幕比例 */
export function applyDisplayRatio(vw: number, vh: number): void {
    applyRatio(setRatio.value as RatioMode, vw, vh);
}

/* 登录成功进入桌面时应用全部设置 */
export function applyAllPrefs(): void {
    applyDebugPref(setDebug.checked);
    applyFpsPref();
    applyCodecPref();
    applyAnimPref();
    applyAudioPref();
    applyClipboardPref();
}

export function initSettings(c: SettingsContext): void {
    ctx = c;

    /* 初始化偏好 */
    const prefs = loadPrefs();
    setDebug.checked = prefs.debug !== false;
    setStatic.checked = prefs.static !== false;
    setAnim.checked = prefs.anim !== false; /* 默认禁用动画（性能优先） */
    setAudio.checked = prefs.audio === true; /* 默认关闭音频传输 */
    setClipboard.checked = prefs.clipboard === true; /* 默认关闭剪贴板共享 */
    setBitrate.value = String(prefs.bitrate ?? 0);
    setQuality.value = String(prefs.quality ?? 23);
    setFps.value = String(prefs.fps && prefs.fps > 0 ? prefs.fps : 30);
    setRes.value = prefs.res && prefs.res !== 'auto' ? prefs.res : 'auto';
    setRatio.value = prefs.ratio || 'fit';
    applyDebugPref(setDebug.checked);
    applyCodecPref();

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

    setAudio.addEventListener('change', () => {
        savePrefs({ ...loadPrefs(), audio: setAudio.checked });
        applyAudioPref();
    });

    setClipboard.addEventListener('change', () => {
        savePrefs({ ...loadPrefs(), clipboard: setClipboard.checked });
        applyClipboardPref();
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
        if (ctx.isActive()) sendResize();
    });

    setRatio.addEventListener('change', () => {
        savePrefs({ ...loadPrefs(), ratio: setRatio.value });
        applyRatio(setRatio.value as RatioMode, ctx.canvas.width, ctx.canvas.height);
    });
}

function sendResize(): void {
    if (onResizeRequest) onResizeRequest();
}

let onResizeRequest: (() => void) | null = null;
export function setResizeRequest(fn: () => void): void {
    onResizeRequest = fn;
}
