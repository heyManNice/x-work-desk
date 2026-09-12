/* ipc/system.cts —— 连通性探测与剪贴板（仅文本）。 */

import { clipboard } from 'electron';
import net from 'node:net';

export interface PingOpt {
    host: string;
    port: number;
}

export interface ClipData {
    text: string | null;
}

/** TCP 连通性探测（主机状态/延迟）：返回连接耗时毫秒；失败 -1 */
export function pingHost(opt: PingOpt): Promise<number> {
    return new Promise((resolve) => {
        const host = String((opt && opt.host) || '').trim();
        const port = Number((opt && opt.port) || 5268);
        if (!host) { resolve(-1); return; }
        const t0 = Date.now();
        const sock = net.connect({ host, port });
        let settled = false;
        const done = (ok: boolean): void => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch { /* 忽略 */ }
            resolve(ok ? Date.now() - t0 : -1);
        };
        sock.setTimeout(2000);
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
    });
}

export async function clipWriteText(text: unknown): Promise<void> {
    try { await clipboard.writeText(String(text ?? '')); } catch { /* 忽略 */ }
}

/** 读取剪贴板文本（仅文本：文件传输改走 SFTP 面板，不再做剪贴板文件同步）。
 *  注：当前 Electron 的 clipboard 已改为 Promise/W3C API（readText/writeText 异步，
 *  availableFormats/readBuffer 已移除）。 */
export async function clipPoll(): Promise<ClipData> {
    let text = '';
    try {
        text = (await clipboard.readText()) || '';
    } catch { /* 读取失败按空处理 */ }
    /* 确保字段可结构化克隆（IPC） */
    return { text: typeof text === 'string' && text.length ? text : null };
}
