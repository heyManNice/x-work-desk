/* core/termSession.ts —— SSH 终端会话（xterm.js 渲染 + 主进程 ssh2）。
 *
 * 一个终端标签对应一条 SSH 连接：主进程建立连接/通道，
 * 渲染层用 xterm.js 展示与输入，数据经 IPC 流式收发。
 */

import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
    sshConnect, sshWrite, sshResize, sshClose, sshOnData, sshOnClose,
    clipWriteText, clipPoll,
} from '../platform';
import type { SessionState, SessionStatus } from './session';

export interface SshOptions {
    root: HTMLElement;
    host: string;
    port: number;
    user: string;
    pass: string;
    name: string;                 /* 主机显示名（连接中提示“正在连接 名字”用） */
    onStatus: (s: SessionStatus) => void;
}

/* 终端字体：Maple Mono CN —— Latin 与 CJK 成对设计、严格 2:1 等宽、含中文字形 */
const TERM_FONT_FAMILY = '"Maple Mono CN", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
/* 字号（Ctrl + 滚轮缩放，本地持久化） */
const TERM_FS_KEY = 'xwd-term-fontsize';
const TERM_FS_DEFAULT = 13;
const TERM_FS_MIN = 8;
const TERM_FS_MAX = 30;

function loadTermFontSize(): number {
    try {
        const v = Number(localStorage.getItem(TERM_FS_KEY));
        if (Number.isFinite(v) && v >= TERM_FS_MIN && v <= TERM_FS_MAX) return v;
    } catch { /* 忽略 */ }
    return TERM_FS_DEFAULT;
}
function saveTermFontSize(v: number): void {
    try { localStorage.setItem(TERM_FS_KEY, String(v)); } catch { /* 忽略 */ }
}

/* ---------------- 终端配色：跟随 App 主题（html[data-theme]） ---------------- */

/* 深色：现状无自定 ANSI 调色（用 xterm 默认，适配深底） */
const TERM_THEME_DARK: ITheme = {
    background: '#101014',
    foreground: '#d8dee9',
    cursor: '#8fa3c0',
};
/* 浅色：参考 VS Code Light 终端配色（不是简单反色，保证对比度） */
const TERM_THEME_LIGHT: ITheme = {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#1f6feb',
    selectionBackground: '#add6ff',
    black: '#000000',
    red: '#cd3131',
    green: '#00bc00',
    yellow: '#949800',
    blue: '#0451a5',
    magenta: '#bc05bc',
    cyan: '#0598bc',
    white: '#555555',
    brightBlack: '#666666',
    brightRed: '#cd3131',
    brightGreen: '#14ce14',
    brightYellow: '#b5ba00',
    brightBlue: '#0451a5',
    brightMagenta: '#bc05bc',
    brightCyan: '#0598bc',
    brightWhite: '#a5a5a5',
};

function currentTermTheme(): ITheme {
    return document.documentElement.dataset.theme === 'light' ? TERM_THEME_LIGHT : TERM_THEME_DARK;
}

/* 所有终端会话共享一个 data-theme 监听（最后一个退订时断开） */
const themeWatchers = new Set<() => void>();
let themeObserver: MutationObserver | null = null;
function watchTheme(cb: () => void): () => void {
    themeWatchers.add(cb);
    if (!themeObserver) {
        themeObserver = new MutationObserver(() => { for (const f of themeWatchers) f(); });
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    return () => {
        themeWatchers.delete(cb);
        if (themeWatchers.size === 0 && themeObserver) {
            themeObserver.disconnect();
            themeObserver = null;
        }
    };
}

export class TerminalSession {
    readonly id: string;
    private opt: SshOptions;
    private term: Terminal;
    private fit: FitAddon;
    private conn = false;
    private destroyed = false;
    private status: SessionState = 'connecting';
    private fontSize = loadTermFontSize();

    private wrap!: HTMLElement;
    private overlay!: HTMLElement;
    private ovSpinner!: HTMLElement;
    private ovText!: HTMLElement;
    private unData: (() => void) | null = null;
    private unClose: (() => void) | null = null;
    private ro: ResizeObserver | null = null;
    /* 右键菜单（复制 / 粘贴） */
    private menu: HTMLElement | null = null;
    private menuClean: (() => void) | null = null;
    private lastSel = '';

    private unTheme: (() => void) | null = null;

    constructor(id: string, opt: SshOptions) {
        this.id = id;
        this.opt = opt;
        this.buildDom();
        this.term = new Terminal({
            fontFamily: TERM_FONT_FAMILY,
            fontSize: this.fontSize,
            lineHeight: 1.25,
            cursorBlink: true,
            scrollback: 4000,
            theme: currentTermTheme(),
        });
        this.fit = new FitAddon();
        this.term.loadAddon(this.fit);
        /* 缓存最新选中文本：右键菜单“复制”用 */
        this.term.onSelectionChange(() => {
            this.lastSel = this.term.getSelection() || '';
        });
        /* 与应用主题同步：切换深浅色时更新终端配色 */
        this.unTheme = watchTheme(() => {
            if (!this.destroyed) this.term.options.theme = currentTermTheme();
        });
    }

    get currentState(): SessionState {
        return this.status;
    }

    private buildDom(): void {
        const root = this.opt.root;
        root.textContent = '';
        root.classList.add('session-view');

        const wrap = document.createElement('div');
        wrap.className = 'term-wrap';

        const overlay = document.createElement('div');
        overlay.className = 'session-overlay show';
        const spinner = document.createElement('div');
        spinner.className = 'spinner big';
        const text = document.createElement('div');
        text.className = 'ov-text';
        text.textContent = `正在连接 ${this.opt.name}`;
        overlay.append(spinner, text);

        root.append(wrap, overlay);
        this.wrap = wrap;
        this.overlay = overlay;
        this.ovSpinner = spinner;
        this.ovText = text;

        this.ro = new ResizeObserver(() => {
            if (this.conn) this.layout();
        });
        this.ro.observe(root);

        /* Ctrl + 鼠标滚轮：缩放终端字号（捕获阶段拦截，避免触发页面缩放/终端滚动） */
        root.addEventListener('wheel', (e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            e.stopPropagation();
            this.zoomBy(e.deltaY < 0 ? 1 : -1);
        }, { capture: true, passive: false });

        /* Ctrl/Cmd + Shift + C / V：复制选中 / 粘贴（Linux 终端约定，xterm 自身只处理原生粘贴）。
         * 在捕获阶段拦下：既不让 xterm 把该组合键（如 Ctrl+Shift+C 会被当成 Ctrl+C→SIGINT）
         * 发给远端，也不触发浏览器默认动作。 */
        root.addEventListener('keydown', (e) => {
            if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
            const k = e.key.toLowerCase();
            if (k !== 'c' && k !== 'v') return;
            e.preventDefault();
            e.stopPropagation();
            if (k === 'c') this.copySelection();
            else void this.pasteClipboard();
        }, { capture: true });
    }

    /* Ctrl/Cmd+Shift+C：把终端选中内容写入系统剪贴板 */
    private copySelection(): void {
        const sel = this.term.getSelection() || this.lastSel;
        if (sel) void clipWriteText(sel);
        this.restoreFocus();
    }

    /* 调整终端字号：重排并通知远端 PTY 新行列数 */
    private zoomBy(step: number): void {
        const next = Math.min(TERM_FS_MAX, Math.max(TERM_FS_MIN, this.fontSize + step));
        if (next === this.fontSize) return;
        this.fontSize = next;
        this.term.options.fontSize = next; /* xterm 支持运行时改字号 */
        saveTermFontSize(next);
        if (!this.conn) return;
        try { this.fit.fit(); } catch { /* 忽略 */ }
        this.sendResize();
    }

    /* 打开 xterm 到容器并适配尺寸 */
    private layout(): void {
        try {
            const host = this.wrap.querySelector('.term-host') as HTMLElement | null;
            if (!host) return;
            this.term.open(host);
            this.fit.fit();
            this.sendResize();
        } catch { /* 尺寸未稳时忽略，等待下次 */ }
    }

    private sendResize(): void {
        try {
            sshResize(this.id, this.term.cols, this.term.rows);
        } catch { /* 忽略 */ }
    }

    /* 建立 SSH 连接并开始会话 */
    async connect(): Promise<void> {
        const { host, port, user, pass } = this.opt;
        this.setStatus('connecting');
        this.ovText.textContent = `正在连接 ${this.opt.name}`;
        this.ovSpinner.hidden = false;
        this.overlay.classList.add('show');

        const res = await sshConnect({ id: this.id, host, port, user, pass: pass || undefined });
        if (this.destroyed) return;
        if (!res.ok) {
            this.setStatus('error', res.msg || 'SSH 连接失败');
            this.ovText.textContent = res.msg || 'SSH 连接失败';
            this.ovSpinner.hidden = true;
            this.overlay.classList.add('show');
            return;
        }
        this.conn = true;
        this.setStatus('running');

        /* 挂载终端并开始收发 */
        const termHost = document.createElement('div');
        termHost.className = 'term-host';
        this.wrap.textContent = '';
        this.wrap.appendChild(termHost);
        this.wrap.classList.add('show');
        this.overlay.classList.remove('show');
        /* 右键菜单：复制选中文字 / 粘贴剪贴板 */
        termHost.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.lastSel = this.term.getSelection() || '';
            this.openTermMenu(e.clientX, e.clientY);
        });
        requestAnimationFrame(() => {
            this.layout();
            this.term.focus();
        });

        this.term.onData((d) => sshWrite(this.id, d));
        this.unData = sshOnData(this.id, (d) => {
            try { this.term.write(d); } catch { /* 忽略 */ }
        });
        this.unClose = sshOnClose(this.id, () => {
            if (this.destroyed) return;
            this.conn = false;
            this.setStatus('closed', '连接已关闭');
            this.ovText.textContent = 'SSH 连接已关闭';
            this.ovSpinner.hidden = true;
            this.overlay.classList.add('show');
        });
    }

    setActive(on: boolean): void {
        if (!on) return;
        requestAnimationFrame(() => {
            if (this.destroyed) return;
            try { this.fit.fit(); } catch { /* 忽略 */ }
            this.sendResize();
            if (this.conn) this.term.focus();
        });
    }

    handleResize(): void {
        if (!this.conn) return;
        try { this.fit.fit(); } catch { /* 忽略 */ }
        this.sendResize();
    }

    /* ---------------- 右键菜单：复制 / 粘贴 ---------------- */

    private openTermMenu(x: number, y: number): void {
        this.closeTermMenu();
        const m = document.createElement('div');
        m.className = 'ctx-menu';
        /* 视口内裁剪，避免超出窗口 */
        const W = 148, H = 2 * 33 + 10 + 6;
        m.style.left = `${Math.min(x, window.innerWidth - W - 8)}px`;
        m.style.top = `${Math.min(y, window.innerHeight - H - 8)}px`;

        const btnCopy = document.createElement('button');
        btnCopy.className = 'ctx-item';
        btnCopy.textContent = '复制';
        btnCopy.disabled = !this.lastSel; /* 无选中文字时不可用 */
        btnCopy.addEventListener('click', () => {
            this.closeTermMenu();
            if (this.lastSel) void clipWriteText(this.lastSel);
        });

        const btnPaste = document.createElement('button');
        btnPaste.className = 'ctx-item';
        btnPaste.textContent = '粘贴';
        btnPaste.addEventListener('click', () => {
            this.closeTermMenu();
            void this.pasteClipboard();
        });

        m.append(btnCopy, btnPaste);
        document.body.appendChild(m);
        this.menu = m;

        /* 点击菜单外 / Esc / 窗口失焦 时关闭 */
        const onDown = (ev: MouseEvent) => {
            if (this.menu && !this.menu.contains(ev.target as Node)) {
                this.closeTermMenu();
            }
        };
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') this.closeTermMenu();
        };
        const onBlur = () => this.closeTermMenu();
        window.addEventListener('mousedown', onDown, true);
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('blur', onBlur);
        this.menuClean = () => {
            window.removeEventListener('mousedown', onDown, true);
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('blur', onBlur);
        };
    }

    private closeTermMenu(): void {
        this.menuClean?.();
        this.menuClean = null;
        if (this.menu) {
            /* 焦点若在菜单按钮上（点“复制/粘贴”后按钮将被移除），关闭后需把焦点还给终端 */
            const ae = document.activeElement;
            const focusWasInMenu = !!ae && this.menu.contains(ae);
            this.menu.remove();
            this.menu = null;
            if (focusWasInMenu || ae === document.body) this.restoreFocus();
        }
    }

    /* 把键盘焦点还给终端：点过菜单按钮后按钮被移除、焦点落到 body，
     * 不归还就会出现“粘贴/复制后无法继续输入”的问题。 */
    private restoreFocus(): void {
        if (this.destroyed || !this.conn) return;
        if (!this.opt.root.classList.contains('active')) return; /* 非当前标签不抢焦点 */
        this.term.focus();
    }

    /* 读取系统剪贴板文本并粘贴到终端（走主进程 IPC，Electron 环境可靠） */
    private async pasteClipboard(): Promise<void> {
        try {
            const r = await clipPoll();
            const t = (r && r.text) || '';
            if (!t || this.destroyed || !this.conn) return;
            this.term.paste(t);
            this.restoreFocus(); /* 粘贴后确保仍可继续键入 */
        } catch { /* 忽略 */ }
    }

    /* 断开：关闭 SSH（会话由服务端结束） */
    disconnect(): void {
        if (this.conn || this.status === 'connecting') {
            sshClose(this.id);
        }
        this.conn = false;
    }

    destroy(): void {
        this.destroyed = true;
        this.unTheme?.();
        this.unTheme = null;
        this.closeTermMenu();
        this.unData?.();
        this.unClose?.();
        this.ro?.disconnect();
        sshClose(this.id);
        try { this.term.dispose(); } catch { /* 忽略 */ }
        this.opt.root.textContent = '';
    }

    private setStatus(state: SessionState, info?: string): void {
        this.status = state;
        this.opt.onStatus({ state, info });
    }
}
