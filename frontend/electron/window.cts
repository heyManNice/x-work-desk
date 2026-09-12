/* window.cts —— 主窗口单例与「向渲染层推送」的统一出口。
 *
 * 其它模块只通过这里拿窗口 / 推事件，避免各自持有 BrowserWindow 引用，
 * 也让「窗口未创建 / 已销毁」的判空只写一次。
 */

import { BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { appRoot } from './util.cjs';

let win: BrowserWindow | null = null;

/** 当前主窗口（未创建或已关闭时为 null） */
export function getWin(): BrowserWindow | null {
    return win;
}

/** 向渲染层推事件（进度、状态变化等） */
export function sendToUi(channel: string, payload: unknown): void {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

export function sendWinMax(maxed: boolean): void {
    sendToUi('xwd:win-max', maxed);
}

export function sendWinFs(fs: boolean): void {
    sendToUi('xwd:win-fs', fs);
}

/** 创建主窗口并加载前端（dev 用 XWD_DEV_URL，prod 加载 dist/index.html） */
export function createWindow(): void {
    win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        title: 'XWorkDesk',
        backgroundColor: '#1e1f22',
        autoHideMenuBar: true,
        /* 无系统边框：UI 自绘标题栏（自制最小化/最大化/关闭） */
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: false,
            /* 桌面壳只运行自身打包的受信前端，不加载任何远端页面；
             * 关闭安全上下文限制以直连非 localhost 明文 ws/wss。 */
            webSecurity: false,
        },
    });

    win.setMenuBarVisibility(false);

    /* 禁用整个应用的缩放：
     *  - 默认应用菜单的 View→Zoom In/Out/Reset 加速键（Ctrl + / - / 0）
     *  - Ctrl + 鼠标滚轮造成的页面缩放
     * before-input-event 里 preventDefault 可同时拦截菜单加速键与页面按键。 */
    win.webContents.on('before-input-event', (e, input) => {
        if (!input.control && !input.meta) return;
        const k = input.key;
        const code = input.code;
        if (k === '+' || k === '=' || k === '-' || k === '_' || k === '0'
            || code === 'NumpadAdd' || code === 'NumpadSubtract') {
            e.preventDefault();
        }
    });
    /* Ctrl+滚轮 兜底：一旦缩放被改动立即复位 */
    win.webContents.on('zoom-changed', () => {
        if (!win || win.isDestroyed()) return;
        if (Math.abs(win.webContents.getZoomFactor() - 1) > 1e-6) win.webContents.setZoomFactor(1);
    });
    win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { /* 忽略 */ });

    win.on('maximize', () => sendWinMax(true));
    win.on('unmaximize', () => sendWinMax(false));
    /* 全屏状态变化同步给渲染层（X11/Windows 无 enter/leave-full-screen 事件，靠 resize 兜底检测） */
    let lastFs = false;
    const pushFs = (): void => {
        if (!win) return;
        const fs = win.isFullScreen();
        if (fs !== lastFs) { lastFs = fs; sendWinFs(fs); }
    };
    win.on('resize', pushFs);
    win.on('enter-full-screen', () => sendWinFs(true)); /* macOS */
    win.on('leave-full-screen', () => sendWinFs(false));

    const devUrl = process.env.XWD_DEV_URL;
    if (devUrl) {
        void win.loadURL(devUrl);
    } else {
        void win.loadFile(path.join(appRoot(), 'dist', 'index.html'));
    }

    /* 站内新窗口（如有）一律交给系统浏览器 */
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
    });

    win.on('closed', () => { win = null; });
}
