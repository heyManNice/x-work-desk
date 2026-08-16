/* 左上角 debug 指标统计：FPS / 带宽 / 解码耗时 / 延迟 */

const $ = <T extends HTMLElement = HTMLElement>(s: string): T =>
    document.querySelector(s) as T;

const dbgRes = $('#dbg-res');
const dbgFps = $('#dbg-fps');
const dbgLat = $('#dbg-lat');
const dbgBw = $('#dbg-bw');
const dbgDec = $('#dbg-dec');

let frameCount = 0;
let lastFps = 0;
let bwBytes = 0; /* 本秒收到的字节数（带宽统计） */
let decSum = 0;  /* 本秒解码耗时累计（ms） */
let decCount = 0;
let keyReqTime = 0; /* 关键帧请求时间，用于估算往返延迟 */
let getActive: () => boolean = () => false;

export function initStats(opts: { getActive: () => boolean }): void {
    getActive = opts.getActive;
    window.setInterval(() => {
        lastFps = frameCount;
        frameCount = 0;
        dbgFps.textContent = `${getActive() ? lastFps : 0} FPS`;

        const kbps = (bwBytes * 8) / 1000;
        dbgBw.textContent = kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
        bwBytes = 0;

        const avgDec = decCount > 0 ? decSum / decCount : 0;
        dbgDec.textContent = `${avgDec.toFixed(1)} ms`;
        decSum = 0;
        decCount = 0;
    }, 1000);
}

export function setResolution(w: number, h: number): void {
    dbgRes.textContent = `${w}x${h}`;
}

export function onVideoFrame(bytes: number): void {
    frameCount++;
    bwBytes += bytes;
}

export function onDecodeTime(ms: number): void {
    decSum += ms;
    decCount++;
}

/* 请求关键帧并记录时间，用于估算往返延迟 */
export function requestKeyframeTime(): void {
    keyReqTime = performance.now();
}

/* 收到关键帧时更新延迟 */
export function onKeyframeReceived(): void {
    if (keyReqTime) {
        dbgLat.textContent = `${Math.round(performance.now() - keyReqTime)} ms`;
        keyReqTime = 0;
    }
}

/* 指标占位显示 0，避免内容跳动 */
export function resetStats(): void {
    dbgFps.textContent = '0 FPS';
    dbgLat.textContent = '0 ms';
    dbgBw.textContent = '0 kbps';
    dbgDec.textContent = '0.0 ms';
    frameCount = 0;
    lastFps = 0;
    bwBytes = 0;
    decSum = 0;
    decCount = 0;
    keyReqTime = 0;
}
