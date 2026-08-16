/* 远程桌面音频播放：WebCodecs 解码 Opus → WebAudio 播放 */

export class AudioPlayer {
    private decoder: AudioDecoder | null = null;
    private ctx: AudioContext | null = null;
    private nextTime = 0;
    private enabled = false;

    get isEnabled(): boolean {
        return this.enabled;
    }

    start(): void {
        if (this.enabled) return;
        if (typeof AudioDecoder === 'undefined') return;
        try {
            this.ctx = new AudioContext();
            this.nextTime = this.ctx.currentTime + 0.1;
            this.decoder = new AudioDecoder({
                output: (data: AudioData) => this.play(data),
                error: () => { /* 忽略单帧解码错误 */ },
            });
            this.decoder.configure({
                codec: 'opus',
                sampleRate: 48000,
                numberOfChannels: 2,
            } as AudioDecoderConfig);
            this.enabled = true;
        } catch {
            /* 不支持则静默禁用 */
        }
    }

    stop(): void {
        this.enabled = false;
        try {
            this.decoder?.close();
        } catch { /* 忽略 */ }
        this.decoder = null;
        if (this.ctx) {
            try { this.ctx.close(); } catch { /* 忽略 */ }
            this.ctx = null;
        }
    }

    feed(data: Uint8Array): void {
        if (!this.enabled || !this.decoder) return;
        if (this.decoder.decodeQueueSize > 16) return; /* 丢弃积压，保持低延迟 */
        try {
            this.decoder.decode(new EncodedAudioChunk({
                type: 'key',
                timestamp: 0,
                data: data as BufferSource,
            }));
        } catch { /* 忽略 */ }
    }

    private play(data: AudioData): void {
        if (!this.ctx || !this.enabled) {
            data.close();
            return;
        }
        try {
            const buf = this.ctx.createBuffer(
                data.numberOfChannels,
                data.numberOfFrames,
                data.sampleRate
            );
            for (let ch = 0; ch < data.numberOfChannels; ch++) {
                data.copyTo(buf.getChannelData(ch), {
                    planeIndex: ch,
                    format: 'f32-planar',
                });
            }
            data.close();
            const src = this.ctx.createBufferSource();
            src.buffer = buf;
            src.connect(this.ctx.destination);
            const t = Math.max(this.nextTime, this.ctx.currentTime);
            src.start(t);
            this.nextTime = t + buf.duration;
        } catch {
            data.close();
        }
    }
}
