/* core/termSession.ts —— SSH 终端会话（xterm.js 渲染 + 主进程 ssh2）。
 *
 * 一个终端标签对应一条 SSH 连接：主进程建立连接/通道，
 * 渲染层用 xterm.js 展示与输入，数据经 IPC 流式收发。
 */

import { Terminal } from '@xterm/xterm';
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

export class TerminalSession {
    readonly id: string;
    private opt: SshOptions;
    private term: Terminal;
    private fit: FitAddon;
    private conn = false;
    private destroyed = false;
    private status: SessionState = 'connecting';

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

    constructor(id: string, opt: SshOptions) {
        this.id = id;
        this.opt = opt;
        this.buildDom();
        this.term = new Terminal({
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 13,
            lineHeight: 1.25,
            cursorBlink: true,
            scrollback: 4000,
            theme: {
                background: '#101014',
                foreground: '#d8dee9',
                cursor: '#8fa3c0',
            },
        });
        this.fit = new FitAddon();
        this.term.loadAddon(this.fit);
        /* 缓存最新选中文本：右键菜单“复制”用 */
        this.term.onSelectionChange(() => {
            this.lastSel = this.term.getSelection() || '';
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
            this.menu.remove();
            this.menu = null;
        }
    }

    /* 读取系统剪贴板文本并粘贴到终端（走主进程 IPC，Electron 环境可靠） */
    private async pasteClipboard(): Promise<void> {
        try {
            const r = await clipPoll();
            const t = (r && r.text) || '';
            if (!t || this.destroyed || !this.conn) return;
            this.term.paste(t);
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
