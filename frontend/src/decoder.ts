/* 使用 WebCodecs 解码 H.264 (avc1) 并渲染到 canvas */
import type { VideoConfig } from './protocol';

function hex(v: number): string {
    return v.toString(16).padStart(2, '0');
}

export class VideoRenderer {
    private decoder: VideoDecoder | null = null;
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private configured = false;
    private haveKey = false; // 已收到关键帧，之后才能解码 delta

    onKeyframeRequest: (() => void) | null = null;
    onResize: ((w: number, h: number) => void) | null = null;
    onError: ((msg: string) => void) | null = null;
    onDecodeTime: ((ms: number) => void) | null = null;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d')!;
    }

    get isConfigured(): boolean {
        return this.configured;
    }

    configure(cfg: VideoConfig): void {
        if (typeof VideoDecoder === 'undefined') {
            this.onError?.('当前浏览器不支持 WebCodecs，请使用 Chrome / Edge');
            return;
        }
        const codec = `avc1.${hex(cfg.sps[1])}${hex(cfg.sps[2])}${hex(cfg.sps[3])}`;
        try {
            this.decoder?.close();
        } catch {
            /* ignore */
        }
        this.decoder = new VideoDecoder({
            output: (frame: VideoFrame) => this.draw(frame),
            error: (e) => {
                this.haveKey = false;
                this.onError?.(`解码错误: ${String(e)}`);
                this.onKeyframeRequest?.();
            },
        });
        /* 关键帧自带 SPS/PPS（服务端未使用 global header），
         * 解码器不需要 description，直接喂 Annex-B 字节流 */
        this.decoder.configure({
            codec,
            optimizeForLatency: true,
        } as VideoDecoderConfig);
        this.canvas.width = cfg.width;
        this.canvas.height = cfg.height;
        this.configured = true;
        this.haveKey = false;
        this.onResize?.(cfg.width, cfg.height);
        this.onKeyframeRequest?.();
    }

    feed(data: Uint8Array, isKey: boolean): void {
        if (!this.configured || !this.decoder) return;
        if (!isKey && !this.haveKey) return; // 等待首个关键帧，不喂 delta
        if (this.decoder.decodeQueueSize > 8) return; // 低延迟：丢弃积压帧
        try {
            this.decoder.decode(
                new EncodedVideoChunk({
                    type: isKey ? 'key' : 'delta',
                    timestamp: Math.round(performance.now() * 1000),
                    data: data as BufferSource,
                })
            );
            if (isKey) this.haveKey = true;
        } catch (e) {
            this.haveKey = false;
            this.onError?.(`解码失败: ${String(e)}`);
            this.onKeyframeRequest?.();
        }
    }

    private draw(frame: VideoFrame): void {
        /* 解码耗时：从 chunk 喂入（timestamp）到输出帧 */
        if (frame.timestamp > 0) {
            this.onDecodeTime?.(performance.now() - frame.timestamp / 1000);
        }
        try {
            this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        } catch {
            /* ignore */
        }
        try {
            frame.close();
        } catch {
            /* ignore */
        }
    }

    destroy(): void {
        try {
            this.decoder?.close();
        } catch {
            /* ignore */
        }
        this.decoder = null;
        this.configured = false;
    }
}
