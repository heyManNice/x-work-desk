/* core/termSession.ts —— SSH 终端会话（xterm.js 渲染 + 主进程 ssh2）。
 *
 * 一个终端标签对应一条 SSH 连接：主进程建立连接/通道，
 * 渲染层用 xterm.js 展示与输入，数据经 IPC 流式收发。
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
    sshConnect, sshWrite, sshResize, sshClose, sshOnData, sshOnClose,
} from '../platform';
import type { SessionState, SessionStatus } from './session';

export interface SshOptions {
    root: HTMLElement;
    host: string;
    port: number;
    user: string;
    pass: string;
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
        text.textContent = '正在连接 SSH…';
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
        this.ovText.textContent = `正在连接 ${user}@${host}:${port} …`;
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

    /* 断开：关闭 SSH（会话由服务端结束） */
    disconnect(): void {
        if (this.conn || this.status === 'connecting') {
            sshClose(this.id);
        }
        this.conn = false;
    }

    destroy(): void {
        this.destroyed = true;
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
