/* 鼠标 / 键盘事件 -> 二进制协议消息 */

import { msgMouseMotion, msgMouseButton, msgKey } from './protocol';

export class InputRelay {
    private send: (d: Uint8Array) => void;
    private canvas: HTMLCanvasElement;
    private width = 1280;
    private height = 720;
    private pressedKeys = new Set<string>();
    private active = false; // 仅桌面激活时才转发输入并拦截默认行为
    private ratio: 'fit' | 'stretch' | 'pixel' = 'fit';
    /** 本机输入法模式：开启后"输入法切换键"留在本地（见 isLocalReservedKey） */
    private localIME = false;

    constructor(canvas: HTMLCanvasElement, send: (d: Uint8Array) => void) {
        this.canvas = canvas;
        this.send = send;
    }

    setActive(on: boolean): void {
        this.active = on;
        if (!on) this.releaseAll();
    }

    /** 本机输入法开关（勾选主机配置时由 Session 设置） */
    setLocalIME(on: boolean): void {
        this.localIME = on;
    }

    /**
     * 本地保留键：本机输入法的切换键**不能**转发到远端。
     * 为什么：远端的当前输入法引擎正是我们的中继引擎，把切换键送过去会让远端切走它，
     * 结果"本机输入法突然失效"（服务端会回报 MSG_IM_STATE=被切走）。
     * 保留键既不转发也不 preventDefault —— 交给本机桌面/IME 处理。
     * 注：只保留 Super 系与 Ctrl+Space；Ctrl+Shift 不保留（远端终端要用 Ctrl+Shift+V 粘贴）。
     */
    private isLocalReservedKey(e: KeyboardEvent): boolean {
        if (!this.localIME) return false;
        if (e.metaKey) return true; /* Super / Super+Space：GNOME 用它切输入源 */
        if (e.ctrlKey && e.code === 'Space') return true; /* Ctrl+Space：部分 IME 的切换键 */
        return false;
    }

    setSize(w: number, h: number): void {
        this.width = w;
        this.height = h;
    }

    setRatio(mode: 'fit' | 'stretch' | 'pixel'): void {
        this.ratio = mode;
    }

    private scale(e: MouseEvent): [number, number] {
        const r = this.canvas.getBoundingClientRect();
        let x = e.clientX - r.left;
        let y = e.clientY - r.top;

        if (this.ratio === 'fit') {
            /* 适应模式：画面等比缩放居中，canvas 四周可能有黑边，
             * 需先去掉黑边偏移再按画面比例映射 */
            const s = Math.min(r.width / this.width, r.height / this.height);
            const vw = this.width * s;
            const vh = this.height * s;
            x -= (r.width - vw) / 2;
            y -= (r.height - vh) / 2;
            return [
                Math.max(0, Math.min(this.width - 1, Math.round(x / s))),
                Math.max(0, Math.min(this.height - 1, Math.round(y / s))),
            ];
        }

        /* 拉伸 / 点对点：按 canvas 显示区域比例映射 */
        return [
            Math.max(0, Math.min(this.width - 1, Math.round((x / r.width) * this.width))),
            Math.max(0, Math.min(this.height - 1, Math.round((y / r.height) * this.height))),
        ];
    }

    /** 远端画面坐标 → 本地 CSS 坐标（本地 IME 候选窗要对准远端光标用得上）。
     *  与 scale() 互为逆变换，三种显示模式都支持。 */
    remoteToLocal(x: number, y: number): { x: number; y: number } {
        const r = this.canvas.getBoundingClientRect();
        if (this.ratio === 'fit') {
            const s = Math.min(r.width / this.width, r.height / this.height);
            return {
                x: r.left + (r.width - this.width * s) / 2 + x * s,
                y: r.top + (r.height - this.height * s) / 2 + y * s,
            };
        }
        if (this.ratio === 'pixel') {
            return { x: r.left + x, y: r.top + y };
        }
        return {
            x: r.left + (x / this.width) * r.width,
            y: r.top + (y / this.height) * r.height,
        };
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
            /* 本机输入法（IME）正在组词：按键归本地 IME——不转发、也不要 preventDefault，
             * 否则拼音根本进不了 IME（见 core/localim.ts） */
            if (e.isComposing || e.keyCode === 229) return;
            if (this.isLocalReservedKey(e)) return; // 输入法切换键：留在本地
            if (isTypingTarget(e.target)) return; // 焦点在输入框：交给控件，不转发给远端
            if (e.code && !this.pressedKeys.has(e.code)) {
                this.send(msgKey(true, e.code));
                this.pressedKeys.add(e.code);
            }
            e.preventDefault();
        });

        window.addEventListener('keyup', (e) => {
            if (!this.active) return;
            if (e.isComposing || e.keyCode === 229) return;
            if (this.isLocalReservedKey(e)) return;
            /* 已转发过的按键必须补发抬起（即使焦点已移入输入框），避免远端按键卡住；
             * 未转发过且当前在输入框内敲的按键则忽略 */
            const tracked = !!e.code && this.pressedKeys.has(e.code);
            if (!tracked && isTypingTarget(e.target)) return;
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

/* 键盘事件是否应交给普通输入控件处理（而非转发给远端桌面）。
 * 桌面会话把 keydown/keyup 绑在 window 上，若不排除，则面板里的
 * 输入框（文件面板路径、Tun 服务器/排除地址等）都无法输入。 */
function isTypingTarget(target: EventTarget | null): boolean {
    const el = (target as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
    if (!el || el.nodeType !== 1) return false;
    /* 本机输入法的隐藏输入框（core/localim.ts）：它只用来承接 IME 组词，
     * 不承担普通按键输入 —— 普通按键应当继续转发给远端，组合中的按键已由
     * keydown 里的 isComposing 短路拦在前面。 */
    if (el.hasAttribute && el.hasAttribute('data-im-soft')) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}
