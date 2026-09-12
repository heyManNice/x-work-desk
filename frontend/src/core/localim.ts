/* core/localim.ts —— 本机输入法（正式版）：用本机 IME 组词，文字直接落到远端应用。
 *
 * 原理：桌面视图上放一个**不可见的 textarea**，让它始终持有焦点 —— Chromium 于是把
 * 本机 IME 的组词引到这里，并产生 composition 事件：
 *     compositionupdate → 预编辑串 → 经会话 WS 发给远端引擎 update_preedit_text
 *     compositionend    → 最终文本   → 远端引擎 commit_text
 * 远端应用会把这串字**画在自己的输入框里**（位置天然精确，无需伪造按键）。
 *
 * 与按键转发的关系：非组合按键照旧由 InputRelay 转发（见 input.ts 的
 * isComposing/keyCode 229 短路）；组合中的按键不转发，交给本机 IME。
 *
 * 位置：远端应用会通过引擎上报插入点矩形（MSG_IM_CARET），这里把它当作隐藏输入框的
 * 位置 —— 本机 IME 的候选窗于是出现在**远端输入框**旁边；拿不到 caret 时退回跟随鼠标。
 *
 * 通道：只依赖 Session 注入的发送函数与 setCaret()。客户端**不**直连远端任何 socket，
 * 鉴权与网络边界都在 xworkd（见 docs/input-method-local.md §3/§7）。
 */

import type { IMCaret } from '../protocol';

export interface LocalIMOpt {
    /** 桌面视图容器（隐藏输入框挂在这里） */
    stage: HTMLElement;
    /** 渲染远端画面的画布（点击后要把焦点抢回隐藏输入框） */
    canvas: HTMLCanvasElement;
    /** 发往远端：预编辑串 + 串内光标位置（字符数） */
    preedit: (text: string, pos: number) => void;
    /** 发往远端：提交最终文本 */
    commit: (text: string) => void;
    /** 发往远端：丢弃当前组合 */
    reset: () => void;
    /** 远端画面坐标 → 本地 CSS 坐标（让本机候选窗对准远端光标；拿不到就退回跟随鼠标） */
    toLocal?: (x: number, y: number) => { x: number; y: number };
    /** 联调日志（可选；写文件便于排查“本机 IME 到底有没有接上”） */
    log?: (msg: string) => void;
}

export class LocalIM {
    private opt: LocalIMOpt;
    private ta: HTMLTextAreaElement;
    private off: Array<() => void> = [];
    private composing = false;
    /** 远端应用上报的插入点矩形（远端屏幕坐标），null = 当前拿不到 */
    private caret: IMCaret | null = null;
    /** 已采用的锚点 y（远端坐标）：同一行内不因上报口径差异而跳动，见 anchorOf() */
    private anchorY: number | null = null;

    constructor(opt: LocalIMOpt) {
        this.opt = opt;

        const ta = document.createElement('textarea');
        ta.className = 'im-soft-input';
        ta.setAttribute('data-im-soft', '1');   /* input.ts 据此不当成"输入控件" */
        ta.setAttribute('autocomplete', 'off');
        ta.setAttribute('autocorrect', 'off');
        ta.setAttribute('spellcheck', 'false');
        ta.setAttribute('aria-hidden', 'true');
        ta.tabIndex = -1;
        opt.stage.appendChild(ta);
        this.ta = ta;

        const on = <K extends keyof HTMLElementEventMap>(
            el: HTMLElement | Window,
            type: K | string,
            fn: (e: Event) => void,
            opts?: AddEventListenerOptions,
        ): void => {
            el.addEventListener(type as string, fn, opts);
            this.off.push(() => el.removeEventListener(type as string, fn));
        };

        /* 位置：优先跟随远端 caret（由 Session 在收到 MSG_IM_CARET 时调 setCaret）；
         * 没有 caret 时退回跟随鼠标。 */
        on(window, 'mousemove', (e) => {
            if (this.caret) return;   /* 有远端 caret 就以它为准，别被鼠标拖跑 */
            const ev = e as MouseEvent;
            this.placeAt(ev.clientX, ev.clientY + 16);
        });

        /* 点击画面后把焦点抢回隐藏输入框，否则本机 IME 会失效 */
        on(opt.canvas, 'mousedown', () => { window.setTimeout(() => ta.focus(), 0); });
        on(opt.canvas, 'mouseup', () => { ta.focus(); });

        /* 焦点变化记日志：确认隐藏输入框是否真的拿着焦点（IME 前提） */
        on(ta, 'focus', () => this.log(`soft input focused`));
        on(ta, 'blur', () => this.log('soft input blurred'));

        /* 组合期间的按键：**目前只记日志**，不拿它重建拼音串。
         * 原因：libpinyin 的 preedit 本来就是汉字（它的拼音串/候选在辅助区），
         * 而不同平台/IME 行为不同（Windows 上就未必一样）。
         * 以后要让"组合阶段显示拼音"，正路是取 IME 的 auxiliary text（ibu 面板通道），
         * 而不是猜按键（Backspace/翻页/选择都会让猜法不准）。
         * 留着这条日志是为了将来确认"组合期间 DOM 到底收不收到按键"。 */
        on(ta, 'keydown', (e) => {
            const ev = e as KeyboardEvent;
            if (!this.composing && !ev.isComposing) return;
            this.log(`keydown key=${JSON.stringify(ev.key)} isComposing=${ev.isComposing} keyCode=${ev.keyCode}`);
        });

        /* ---- 本机 IME 的组词事件 ---- */
        on(ta, 'compositionstart', () => {
            this.composing = true;
            this.placeAtCaret();      /* 组合开始就定位：之后不跟随，避免候选窗乱跳 */
            this.log('compositionstart');
        });
        on(ta, 'compositionupdate', (e) => {
            const s = (e as CompositionEvent).data ?? '';
            this.log(`compositionupdate ${JSON.stringify(s)}`);
            this.opt.preedit(s, this.charPos());
        });
        on(ta, 'compositionend', (e) => {
            this.composing = false;
            const s = (e as CompositionEvent).data ?? '';
            this.log(`compositionend ${JSON.stringify(s)}`);
            /* 有内容就提交；空（用户取消）就收起 preedit */
            if (s) this.opt.commit(s);
            else this.opt.reset();
            ta.value = '';
        });
        /* 兜底：非组合的输入（如本机 IME 直接上屏）也提交 */
        on(ta, 'input', () => {
            if (this.composing) return;
            const v = ta.value;
            if (!v) return;
            this.log(`input ${JSON.stringify(v)}`);
            this.opt.commit(v);
            ta.value = '';
        });

        /* 窗口失焦：把组合收掉，别让远端一直挂着一段没人管的 preedit */
        on(window, 'blur', () => { if (this.composing) this.opt.reset(); });

        this.log('LocalIM ready');
        this.focus();
    }

    /** 远端上报插入点（Session 收到 MSG_IM_CARET 时调用）。
     * w=h=0 是“没有真实插入点”的占位值（应用失焦/自绘控件），此时退回跟随鼠标。 */
    setCaret(c: IMCaret | null): void {
        if (c && (c.w !== 0 || c.h !== 0)) {
            this.caret = c;
            this.log(`remote caret ${c.x},${c.y} ${c.w}x${c.h}`);
            if (this.composing) this.placeAtCaret();
        } else if (this.caret !== null) {
            this.caret = null;
            this.anchorY = null; /* 焦点没了：重新开始算锚点 */
            this.log('remote caret cleared（退回跟随鼠标）');
        }
    }

    /**
     * 由远端矩形算出定位锚点（远端坐标）。两个实测到的坑：
     *  ① 应用对"插入点"有两套上报口径：普通插入点 vs 组词期间的**预编辑外接矩形**。
     *     同一行实测为 `y=88 h=25` 与 `y=84 h=36` —— 底边差 7px（预编辑矩形含
     *     下划线/descent 而偏胖），直接用 y+h 会让候选窗在组词时**往下跳小半行**。
     *     → 把 h 夹到"线盒"量级，两种口径就落回同一个位置。
     *  ② 同一行内 y 还会抖几像素 → 变化很小就沿用上一次的锚点，避免候选窗跟着跳。
     */
    private anchorOf(c: IMCaret): { x: number; y: number } {
        /* 远端像素；常规行盒高度量级（预编辑矩形会明显大于它） */
        const LINE_BOX_MAX = 28;
        /* 同一行内可容忍的 y 变化（小于它视为抖动；真正的换行差分远大于此） */
        const Y_JITTER = 8;
        const y = c.y + Math.min(c.h, LINE_BOX_MAX);
        if (this.anchorY === null || Math.abs(y - this.anchorY) > Y_JITTER) this.anchorY = y;
        return { x: c.x, y: this.anchorY };
    }

    /** 当前 preedit 里的光标位置（**字符数**：代理对算 1 个字符，与服务端/ibus 一致） */
    private charPos(): number {
        const v = this.ta.value;
        const end = this.ta.selectionStart ?? v.length;
        let n = 0;
        for (let i = 0; i < end; i++) {
            const c = v.charCodeAt(i);
            if (c >= 0xd800 && c <= 0xdbff && i + 1 < end) i++;   /* 跳过低位代理 */
            n++;
        }
        return n;
    }

    private log(msg: string): void {
        this.opt.log?.(msg);
    }

    /** 把隐藏输入框摆到本地视图坐标处（IME 会把候选窗画在它的插入点上） */
    private placeAt(x: number, y: number): void {
        this.ta.style.left = `${Math.max(0, Math.min(window.innerWidth - 2, x))}px`;
        this.ta.style.top = `${Math.max(0, Math.min(window.innerHeight - 2, y))}px`;
    }

    /** 定位到远端插入点那一行的下方（有 toLocal 映射且坐标有意义时才做） */
    private placeAtCaret(): void {
        const c = this.caret;
        if (!c || !this.opt.toLocal) return;
        if (c.w === 0 && c.h === 0) return;   /* 0,0 是"没有真实插入点"的占位值 */
        const a = this.anchorOf(c);
        const p = this.opt.toLocal(a.x, a.y);
        this.placeAt(p.x, p.y);
        this.log(`place at remote caret → local ${Math.round(p.x)},${Math.round(p.y)}（锚点 y=${a.y}）`);
    }

    focus(): void {
        try {
            this.ta.focus({ preventScroll: true });
        } catch { /* 忽略 */ }
    }

    dispose(): void {
        for (const f of this.off.splice(0)) f();
        this.ta.remove();
    }
}
