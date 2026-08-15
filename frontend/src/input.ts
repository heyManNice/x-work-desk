/* 鼠标 / 键盘事件 -> 二进制协议消息 */

import { msgMouseMotion, msgMouseButton, msgKey } from './protocol';

export class InputRelay {
    private send: (d: Uint8Array) => void;
    private canvas: HTMLCanvasElement;
    private width = 1280;
    private height = 720;
    private pressedKeys = new Set<string>();
    private active = false; // 仅桌面激活时才转发输入并拦截默认行为

    constructor(canvas: HTMLCanvasElement, send: (d: Uint8Array) => void) {
        this.canvas = canvas;
        this.send = send;
    }

    setActive(on: boolean): void {
        this.active = on;
        if (!on) this.releaseAll();
    }

    setSize(w: number, h: number): void {
        this.width = w;
        this.height = h;
    }

    private scale(e: MouseEvent): [number, number] {
        const r = this.canvas.getBoundingClientRect();
        const x = Math.round(((e.clientX - r.left) / r.width) * this.width);
        const y = Math.round(((e.clientY - r.top) / r.height) * this.height);
        return [
            Math.max(0, Math.min(this.width - 1, x)),
            Math.max(0, Math.min(this.height - 1, y)),
        ];
    }

    attach(): void {
        const cv = this.canvas;

        cv.addEventListener('mousemove', (e) => {
            if (!this.active) return;
            const [x, y] = this.scale(e);
            this.send(msgMouseMotion(x, y));
        });

        cv.addEventListener('mousedown', (e) => {
            if (!this.active) return;
            const [x, y] = this.scale(e);
            this.send(msgMouseButton(x, y, jsToXButton(e.button), true));
            e.preventDefault();
            cv.focus();
        });

        /* 远程桌面内右键时不弹出浏览器上下文菜单 */
        cv.addEventListener('contextmenu', (e) => {
            if (!this.active) return;
            e.preventDefault();
        });

        window.addEventListener('mouseup', (e) => {
            if (!this.active) return;
            const [x, y] = this.scale(e);
            this.send(msgMouseButton(x, y, jsToXButton(e.button), false));
        });

        cv.addEventListener(
            'wheel',
            (e) => {
                if (!this.active) return;
                const [x, y] = this.scale(e);
                // X11: 4=上滚 5=下滚 6=左滚 7=右滚
                const btn = Math.abs(e.deltaY) >= Math.abs(e.deltaX)
                    ? e.deltaY < 0 ? 4 : 5
                    : e.deltaX < 0 ? 6 : 7;
                this.send(msgMouseButton(x, y, btn, true));
                this.send(msgMouseButton(x, y, btn, false));
                e.preventDefault();
            },
            { passive: false }
        );

        window.addEventListener('keydown', (e) => {
            if (!this.active) return; // 登录页不拦截键盘，保证输入框可正常输入
            if (e.code && !this.pressedKeys.has(e.code)) {
                this.send(msgKey(true, e.code));
                this.pressedKeys.add(e.code);
            }
            e.preventDefault();
        });

        window.addEventListener('keyup', (e) => {
            if (!this.active) return;
            if (e.code) {
                this.send(msgKey(false, e.code));
                this.pressedKeys.delete(e.code);
            }
            e.preventDefault();
        });

        window.addEventListener('blur', () => this.releaseAll());
    }

    releaseAll(): void {
        for (const c of this.pressedKeys) this.send(msgKey(false, c));
        this.pressedKeys.clear();
    }
}

/* JS button -> X11 按钮号 */
function jsToXButton(b: number): number {
    switch (b) {
        case 0: return 1; // 左键
        case 1: return 2; // 中键
        case 2: return 3; // 右键
        case 3: return 8; // 后退
        case 4: return 9; // 前进
        default: return 1;
    }
}
