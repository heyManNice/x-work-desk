/* core/session.ts —— 单个远程连接会话（一个标签一个实例）。
 *
 * 自包含：自己创建 canvas / hud / overlay / 工具条 DOM（挂在外部传入的容器内），
 * 维护 WebSocket 连接、H.264 解码渲染、输入转发、音频、剪贴板文本共享。
 * 不依赖任何 UI 框架；App 层通过 onStatus 回调驱动标签/标题栏状态。
 * 注：文件传输不在会话层，走顶栏 SFTP 文件面板。
 */

import {
    MSG_VIDEO, MSG_CONFIG, MSG_LOGIN_RESULT, MSG_CLOSE, MSG_SESSION_EXISTS,
    MSG_LOCAL_IN_USE,
    MSG_CURSOR, MSG_AUDIO, MSG_CLIPBOARD,
    parseConfig, parseLoginResult, parseCursor,
    msgLogin, msgResize, msgKeyframe, msgTakeover, msgTakeoverCancel,
    msgKickLocal,
    msgLogout, msgRequestConfig, msgClipboard, msgSetFps, msgSetCodec,
    msgSetAnimations, msgSetAudio, msgSetClipboard,
} from '../protocol';
import type { CursorImage } from '../protocol';
import { VideoRenderer } from '../decoder';
import { InputRelay } from '../input';
import { AudioPlayer } from '../audio';
import type { ServerTarget } from '../server';
import { scaleFactor, type HostConfig } from './host';
import { clipWriteText, clipPoll } from '../platform';
import { showConfirm } from '../modal';

export type SessionState = 'connecting' | 'running' | 'error' | 'closed';

export interface SessionStatus {
    state: SessionState;
    info?: string;
}

export interface SessionOptions {
    root: HTMLElement;          /* 会话视图容器（Session 在内部自建 DOM） */
    host: HostConfig;           /* 展示名/配置 */
    target: ServerTarget;       /* origin / wsUrl / apiBase */
    name: string;               /* 主机显示名（连接中提示“正在连接 名字”用） */
    user: string;
    pass: string;
    onStatus: (s: SessionStatus) => void;
    onRequestClose?: () => void; /* 请求关闭本标签（取消接管/取消实体机占用等） */
}

export class Session {
    readonly id: string;
    private opt: SessionOptions;
    private ws: WebSocket | null = null;
    private renderer: VideoRenderer | null = null;
    private relay: InputRelay | null = null;
    private audio = new AudioPlayer();
    private active = false;              /* 该会话是否被用户激活（输入/音频/剪贴板） */
    private loginWaiting = false;
    private clipEnabled = false;
    private clipCache = '';
    private audioEnabled = false;
    private cfgW = 1280;
    private cfgH = 720;
    private configured = false;
    private destroyed = false;
    private status: SessionState = 'connecting';

    /* DOM（attach 时创建） */
    private stage!: HTMLElement;
    private canvas!: HTMLCanvasElement;
    private overlay!: HTMLElement;
    private ovSpinner!: HTMLElement;
    private ovText!: HTMLElement;
    private ovBtns!: HTMLElement;
    private ovBtn!: HTMLButtonElement;
    private hudRes!: HTMLElement;
    private hudFps!: HTMLElement;
    private hudLat!: HTMLElement;
    private hudBw!: HTMLElement;
    private hudDec!: HTMLElement;

    private hudTimer = 0;
    private clipTimer = 0;
    private ro: ResizeObserver | null = null;
    private frameCount = 0;
    private bwBytes = 0;
    private decSum = 0;
    private decCount = 0;
    private keyReqT = 0;

    constructor(id: string, opt: SessionOptions) {
        this.id = id;
        this.opt = opt;
        this.clipEnabled = !!opt.host.clipboard;
        this.audioEnabled = !!opt.host.audio;
        this.buildDom();
    }

    get isConfigured(): boolean {
        return this.configured;
    }
    get currentState(): SessionState {
        return this.status;
    }

    /* ---------------- DOM ---------------- */

    private buildDom(): void {
        const root = this.opt.root;
        root.textContent = '';
        root.classList.add('session-view');

        const stage = document.createElement('div');
        stage.className = 'session-stage';
        stage.dataset.ratio = this.opt.host.ratio;

        const canvas = document.createElement('canvas');
        canvas.className = 'session-canvas';
        canvas.width = this.cfgW;
        canvas.height = this.cfgH;

        /* hud */
        const hud = document.createElement('div');
        hud.className = 'session-hud';
        if (this.opt.host.debug) hud.classList.add('show');
        const mk = (c: string) => {
            const s = document.createElement('span');
            s.className = c;
            s.textContent = '0';
            hud.appendChild(s);
            return s;
        };
        this.hudRes = mk('sh-res');
        this.hudFps = mk('sh-fps');
        this.hudLat = mk('sh-lat');
        this.hudBw = mk('sh-bw');
        this.hudDec = mk('sh-dec');

        /* overlay */
        const overlay = document.createElement('div');
        overlay.className = 'session-overlay show';
        const spinner = document.createElement('div');
        spinner.className = 'spinner big';
        const ovText = document.createElement('div');
        ovText.className = 'ov-text';
        ovText.textContent = `正在连接 ${this.opt.name}`;
        /* 断开/错误画面底部：重新连接按钮（仅中断/失败时显示） */
        const ovBtns = document.createElement('div');
        ovBtns.className = 'ov-btns';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn ov-retry';
        retry.textContent = '重新连接';
        retry.addEventListener('click', () => this.reconnect());
        ovBtns.append(retry);
        ovBtns.hidden = true;
        overlay.append(spinner, ovText, ovBtns);

        stage.append(canvas, hud, overlay);
        root.appendChild(stage);

        this.stage = stage;
        this.canvas = canvas;
        this.overlay = overlay;
        this.ovSpinner = spinner;
        this.ovText = ovText;
        this.ovBtns = ovBtns;
        this.ovBtn = retry;

        this.renderer = new VideoRenderer(canvas);
        this.renderer.onKeyframeRequest = () => this.send(msgKeyframe());
        this.renderer.onResize = (w, h) => {
            this.cfgW = w;
            this.cfgH = h;
            this.relay?.setSize(w, h);
            this.hudRes.textContent = `${w}x${h}`;
            this.applyRatio();
        };
        this.renderer.onError = (m) => { this.ovText.textContent = m; };
        this.renderer.onDecodeTime = (ms) => { this.decSum += ms; this.decCount++; };

        this.relay = new InputRelay(canvas, (d) => this.send(d));
        this.relay.attach();
        this.relay.setActive(false);
        this.relay.setRatio(this.opt.host.ratio);
        this.relay.setSize(this.cfgW, this.cfgH);

        /* 容器尺寸变化（窗口缩放/标签激活等）时重排画布 CSS 显示尺寸 */
        this.ro = new ResizeObserver(() => this.layoutCanvas());
        this.ro.observe(stage);
        this.applyRatio();
    }

    /* 画布 CSS 布局：把（可能是物理高分辨率）缓冲区等比缩放到容器内显示。
     * 关键：桌面显示缩放≠1 时 devicePixelRatio>1，视频缓冲分辨率远大于
     * 容器 CSS 像素，若不显式设置 CSS 尺寸会溢出窗口。 */
    private layoutCanvas(): void {
        const st = this.stage;
        const cv = this.canvas;
        if (!st || !cv) return;
        const sw = st.clientWidth || 1;
        const sh = st.clientHeight || 1;
        const vw = this.cfgW || 1;
        const vh = this.cfgH || 1;
        let w: number;
        let h: number;
        let l = 0;
        let t = 0;
        const ratio = this.opt.host.ratio;
        if (ratio === 'stretch') {
            w = sw;
            h = sh;
        } else if (ratio === 'pixel') {
            /* 点对点：1 视频像素 = 1 CSS 像素 */
            w = vw;
            h = vh;
        } else {
            /* fit：等比 contain 居中，四周留黑边 */
            const s = Math.min(sw / vw, sh / vh);
            w = Math.round(vw * s);
            h = Math.round(vh * s);
            l = Math.round((sw - w) / 2);
            t = Math.round((sh - h) / 2);
        }
        cv.style.left = `${l}px`;
        cv.style.top = `${t}px`;
        cv.style.width = `${w}px`;
        cv.style.height = `${h}px`;
    }

    /* 显示比例：fit 等比居中 / stretch 拉伸 / pixel 点对点（CSS 控制） */
    private applyRatio(): void {
        this.stage.dataset.ratio = this.opt.host.ratio;
        this.layoutCanvas();
    }

    setRatio(mode: HostConfig['ratio']): void {
        this.opt.host.ratio = mode;
        this.relay?.setRatio(mode);
        this.applyRatio();
    }

    /* ---------------- 连接 ---------------- */

    connect(): void {
        if (this.destroyed) return;
        this.setStatus('connecting', `正在连接 ${this.opt.name}`);
        this.ovText.textContent = `正在连接 ${this.opt.name}`;
        this.ovSpinner.hidden = false;
        this.overlay.classList.add('show');

        const { target, user, pass } = this.opt;
        this.loginWaiting = true;
        let w = this.cfgW;
        let h = this.cfgH;
        const res = this.opt.host.res;
        if (res && res !== 'auto') {
            const m = /^(\d+)x(\d+)$/i.exec(res);
            if (m) {
                w = Math.round(Number(m[1]));
                h = Math.round(Number(m[2]));
            }
        } else {
            /* 自适应：登录即按会话容器当前 CSS 尺寸 × devicePixelRatio
             * 计算物理分辨率，避免首次连接用了画布默认 1280x720 */
            const [vw, vh] = this.viewportSize();
            w = vw;
            h = vh;
        }
        /* 分辨率倍率换算：真实分辨率 = 基础分辨率 × host.scale */
        [w, h] = this.scaled(w, h);
        this.cfgW = w;
        this.cfgH = h;
        this.renderer?.destroy();
        this.canvas.width = w;
        this.canvas.height = h;
        this.layoutCanvas();

        try {
            this.ws = new WebSocket(target.wsUrl);
        } catch {
            this.loginWaiting = false;
            this.fail('无法创建连接：地址格式错误');
            return;
        }
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this.send(msgLogin(user, pass, w, h));
        };
        this.ws.onmessage = (ev) => {
            this.handleMessage(new Uint8Array(ev.data as ArrayBuffer));
        };
        this.ws.onclose = () => {
            if (this.destroyed) return;
            if (this.loginWaiting) {
                this.loginWaiting = false;
                this.fail('无法连接到服务器：请检查主机地址与端口');
            } else if (this.status === 'running' || this.status === 'connecting') {
                this.setStatus('closed', '连接已断开');
                this.ovText.textContent = '连接已断开';
                this.ovSpinner.hidden = true;
                this.overlay.classList.add('show');
            }
        };
        this.ws.onerror = () => { /* onclose 统一处理 */ };
    }

    private fail(text: string): void {
        this.setStatus('error', text);
        this.ovText.textContent = text;
        this.ovSpinner.hidden = true;
        this.overlay.classList.add('show');
    }

    /* 断开连接（会话保留在服务端，可重连） */
    disconnect(): void {
        if (this.ws) {
            this.ws.onclose = null;
            try { this.ws.close(); } catch { /* 忽略 */ }
            this.ws = null;
        }
        if (this.status === 'running') {
            this.setStatus('closed', '已手动断开');
            this.ovText.textContent = '已断开（会话保留）';
            this.ovSpinner.hidden = true;
            this.overlay.classList.add('show');
        }
        this.relay?.setActive(false);
        this.audio.stop();
        this.releaseClipTimer();
    }

    /* overlay“重新连接”按钮：先清理当前连接（relay/音频/剪贴板），
     * 再按原配置重新发起登录（与首次连接同一路径；解码器按需重建）。
     * loginWaiting 防重入：正在重连时再次点击会被忽略，一次点击即生效。 */
    reconnect(): void {
        if (this.destroyed || this.loginWaiting) return;
        this.disconnect();
        this.connect();
    }

    /* 注销：销毁远程会话后断开。返回 true 表示已发起注销/断开，调用方应关闭标签 */
    async logout(): Promise<boolean> {
        const ok = await showConfirm(
            '注销退出',
            '注销将销毁远程桌面会话并退出登录。\n\n确定注销吗？',
        );
        if (!ok) return false;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.disconnect();
            return true;
        }
        this.send(msgLogout());
        /* 兜底：服务端应在注销后关闭连接 */
        window.setTimeout(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try { this.ws.close(); } catch { /* 忽略 */ }
            }
        }, 1500);
        return true;
    }

    destroy(): void {
        this.destroyed = true;
        window.clearInterval(this.hudTimer);
        this.ro?.disconnect();
        this.ro = null;
        this.releaseClipTimer();
        this.relay?.setActive(false);
        this.relay?.releaseAll();
        this.audio.stop();
        this.renderer?.destroy();
        if (this.ws) {
            this.ws.onclose = null;
            try { this.ws.close(); } catch { /* 忽略 */ }
            this.ws = null;
        }
        this.opt.root.textContent = '';
    }

    /* ---------------- 激活切换 ---------------- */

    setActive(on: boolean): void {
        this.active = on;
        this.relay?.setActive(on);
        if (on) {
            if (this.audioEnabled) this.audio.start();
            this.startClipTimer();
            this.handleResize(); /* 切回时按当前窗口尺寸校正分辨率（auto） */
        } else {
            this.audio.stop();
            this.releaseClipTimer();
        }
    }

    /* 窗口尺寸变化（由 App 在窗口 resize 时对激活会话调用） */
    handleResize(): void {
        if (!this.active) return;
        const res = this.opt.host.res;
        if (res && res !== 'auto') return;
        const [w, h] = this.scaled(...this.viewportSize());
        if (w !== this.cfgW || h !== this.cfgH) {
            this.send(msgResize(w, h));
        }
    }

    /* 分辨率倍率换算：真实分辨率 = 基础分辨率 × host.scale；偶数化并限幅到 4096 */
    private scaled(w: number, h: number): [number, number] {
        const f = scaleFactor(this.opt.host.scale);
        if (f === 1) return [w, h];
        const even = (v: number) => {
            const x = Math.round(v);
            return x % 2 ? x + 1 : x;
        };
        return [
            Math.min(4096, even(w * f)),
            Math.min(4096, even(h * f)),
        ];
    }

    private viewportSize(): [number, number] {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(this.stage.clientWidth * dpr);
        const h = Math.round(this.stage.clientHeight * dpr);
        return [
            Math.max(320, Math.min(4096, w)) & ~1,
            Math.max(200, Math.min(4096, h)) & ~1,
        ];
    }

    /* ---------------- 消息处理 ---------------- */

    private handleMessage(b: Uint8Array): void {
        switch (b[0]) {
            case MSG_CLIPBOARD:
                void this.clipWrite(new TextDecoder().decode(b.subarray(1)));
                break;
            case MSG_AUDIO:
                this.audio.feed(b.subarray(1));
                break;
            case MSG_CURSOR:
                this.applyCursor(parseCursor(b));
                break;
            case MSG_LOGIN_RESULT:
                this.handleLoginResult(b);
                break;
            case MSG_CONFIG:
                this.handleConfigMsg(b);
                break;
            case MSG_SESSION_EXISTS:
                void this.handleSessionExists();
                break;
            case MSG_LOCAL_IN_USE:
                void this.handleLocalInUse();
                break;
            case MSG_VIDEO: {
                const flags = b[1];
                if ((flags & 0x01) !== 0) {
                    this.hudLat.textContent = this.keyReqT
                        ? `${Math.round(performance.now() - this.keyReqT)} ms` : '0 ms';
                    this.keyReqT = 0;
                }
                this.renderer?.feed(b.subarray(2), (flags & 0x01) !== 0);
                this.frameCount++;
                this.bwBytes += b.byteLength;
                break;
            }
            case MSG_CLOSE: {
                const reason = new TextDecoder().decode(b.subarray(1));
                if (this.ws) {
                    this.ws.onclose = null;
                    try { this.ws.close(); } catch { /* 忽略 */ }
                    this.ws = null;
                }
                this.relay?.setActive(false);
                this.audio.stop();
                this.releaseClipTimer();
                this.setStatus('error', reason || '连接被关闭');
                this.ovText.textContent = reason || '连接被服务端关闭';
                this.ovSpinner.hidden = true;
                this.overlay.classList.add('show');
                break;
            }
            default:
                break;
        }
    }

    private handleLoginResult(b: Uint8Array): void {
        const r = parseLoginResult(b);
        this.loginWaiting = false;
        if (!r.ok) {
            this.fail(r.text);
            return;
        }
        /* 登录成功：按主机配置下发编码/偏好 */
        const c = this.opt.host;
        this.send(msgSetFps(c.fps));
        this.send(msgSetCodec(!!c.staticSkip, c.bitrate, c.quality));
        this.send(msgSetAnimations(!!c.anim));
        this.send(msgSetAudio(!!c.audio));
        this.send(msgSetClipboard(!!c.clipboard));

        this.setStatus('running');
        this.overlay.classList.remove('show');
        if (this.audioEnabled) this.audio.start();

        /* 重连/接管后恢复交互：disconnect 与 MSG_CLOSE 会关闭输入 relay 与
         * 剪贴板轮询，这里按标签激活状态恢复（否则重连后鼠标键盘无响应） */
        this.relay?.setActive(this.active);
        if (this.active) this.startClipTimer();

        /* auto 分辨率：登录后延时校准一次（首帧容器布局可能尚未稳定），
         * 尺寸不符会补发 msgResize，避免首次连接分辨率不正确 */
        if (this.opt.host.res === 'auto') {
            window.setTimeout(() => {
                if (!this.destroyed && this.status === 'running') this.handleResize();
            }, 400);
        }

        /* 接管/重连后若渲染器仍未配置（错过 CONFIG），请求补发 */
        window.setTimeout(() => {
            if (!this.destroyed && this.status === 'running' && !this.renderer?.isConfigured) {
                this.send(msgRequestConfig());
            }
        }, 900);
    }

    private handleConfigMsg(b: Uint8Array): void {
        const cfg = parseConfig(b);
        this.renderer?.configure(cfg);
        this.relay?.setSize(cfg.width, cfg.height);
        this.cfgW = cfg.width;
        this.cfgH = cfg.height;
        this.hudRes.textContent = `${cfg.width}x${cfg.height}`;
        this.send(msgKeyframe());
    }

    private async handleSessionExists(): Promise<void> {
        const take = await showConfirm(
            '会话提醒',
            '该账号已有会话在使用。\n\n继续登录将接管并断开前一个连接（桌面会话不注销）。是否继续？',
        );
        if (this.destroyed) return;
        if (take) {
            this.send(msgTakeover());
        } else {
            /* 用户取消：断开本次连接并关闭本标签页 */
            this.send(msgTakeoverCancel());
            this.disconnect();
            this.opt.onRequestClose?.();
        }
    }

    /* 实体机占用：服务端检测到该账号正坐在实体机（本机屏幕）前登录。
     * 确认后服务端会先结束实体机会话再继续登录流程；取消则断开。 */
    private async handleLocalInUse(): Promise<void> {
        const kick = await showConfirm(
            '检测到实体机占用',
            '该账号正在实体机（本机屏幕）上登录使用。\n\n继续登录将结束实体机上的会话（需先踢出实体机），之后才进入远程桌面。是否踢出实体机并继续？',
        );
        if (this.destroyed) return;
        if (kick) {
            this.send(msgKickLocal());
        } else {
            /* 用户取消：断开本次连接并关闭本标签页 */
            this.disconnect();
            this.opt.onRequestClose?.();
        }
    }

    /* ---------------- 剪贴板 ---------------- */

    private async clipWrite(text: string): Promise<void> {
        try {
            await clipWriteText(text);
            this.clipCache = text;
        } catch { /* 忽略：写入失败不打断 */ }
    }

    /* 轮询本地剪贴板：文本变化→同步远程 */
    private async clipReadPush(): Promise<void> {
        if (!this.active || !this.clipEnabled) return;
        try {
            const p = await clipPoll();
            if (p.text && p.text !== this.clipCache) {
                this.clipCache = p.text;
                this.send(msgClipboard(p.text));
            }
        } catch { /* 忽略 */ }
    }

    private startClipTimer(): void {
        if (this.clipTimer) return;
        this.clipTimer = window.setInterval(() => void this.clipReadPush(), 1500);
    }

    private releaseClipTimer(): void {
        window.clearInterval(this.clipTimer);
        this.clipTimer = 0;
    }

    setClipboardEnabled(on: boolean): void {
        this.clipEnabled = on;
        if (!on) this.releaseClipTimer();
        else if (this.active) this.startClipTimer();
        if (this.status === 'running') this.send(msgSetClipboard(on));
    }

    setAudioEnabled(on: boolean): void {
        this.audioEnabled = on;
        if (on && this.active && this.status === 'running') this.audio.start();
        else this.audio.stop();
        if (this.status === 'running') this.send(msgSetAudio(on));
    }

    /* ---------------- 光标 / hud ---------------- */

    private applyCursor(c: CursorImage): void {
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
            this.canvas.style.cursor = `url(${url}) ${c.hx} ${c.hy}, auto`;
        } catch { /* 忽略 */ }
    }

    /* 每秒刷新 hud 指标（仅 debug 时启用） */
    private startHudTimer(): void {
        this.hudTimer = window.setInterval(() => {
            this.hudFps.textContent = `${this.frameCount} FPS`;
            this.frameCount = 0;
            const kbps = (this.bwBytes * 8) / 1000;
            this.hudBw.textContent = kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
            this.bwBytes = 0;
            this.hudDec.textContent = this.decCount ? `${(this.decSum / this.decCount).toFixed(1)} ms` : '0 ms';
            this.decSum = 0;
            this.decCount = 0;
        }, 1000);
    }

    /* ---------------- 状态 ---------------- */

    private setStatus(state: SessionState, info?: string): void {
        this.status = state;
        this.opt.onStatus({ state, info });
        /* 断开/失败画面显示“重新连接”，连接中隐藏 */
        if (this.ovBtns) this.ovBtns.hidden = !(state === 'error' || state === 'closed');
        if (state === 'running' && this.opt.host.debug) this.startHudTimer();
    }

    private send(d: Uint8Array): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(d);
    }
}
