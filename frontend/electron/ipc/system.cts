/* ipc/system.cts —— 连通性探测与剪贴板。 */

import { clipboard } from 'electron';
import net from 'node:net';
import fs from 'node:fs';

export interface PingOpt {
    host: string;
    port: number;
}

export interface ClipData {
    text: string | null;
    files: string[];
}

/** 解析 text/uri-list（Nautilus/Windows 复制文件）：每行一个 file:// URI */
function parseUriList(buf: Buffer): string[] {
    const text = buf.toString('utf8');
    const files: string[] = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        let u = t;
        try { u = decodeURIComponent(t); } catch { /* keep */ }
        const m = /^file:\/\/(.+)$/i.exec(u);
        if (!m) continue;
        let p = m[1];
        /* 去掉 host（file://localhost/ 或 file:/// ） */
        if (p.startsWith('localhost/')) p = p.slice('localhost/'.length);
        p = p.replace(/\r$/, '');
        if (process.platform === 'win32') {
            /* file:///C:/x -> C:\x */
            if (/^[a-zA-Z]:\//.test(p)) p = p.replace(/\//g, '\\');
        }
        if (p && fs.existsSync(p)) files.push(p);
    }
    return files;
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

/** 读取剪贴板：返回 { text, files }。files 仅在桌面复制文件场景出现。
 *  注：当前 Electron 的 clipboard 已改为 Promise/W3C API（readText/writeText 异步，
 *  availableFormats/readBuffer 已移除，改用 read() 的 ClipboardItem.types/getType）。 */
export async function clipPoll(): Promise<ClipData> {
    let text = '';
    try {
        text = (await clipboard.readText()) || '';
    } catch { /* 读取失败按空处理 */ }
    const files: string[] = [];
    try {
        const items = await clipboard.read();
        for (const it of items || []) {
            const types = (it && it.types) || [];
            if (types.includes('text/uri-list') || types.includes('text/uri-list;charset=utf-8')) {
                const blob = await it.getType('text/uri-list');
                /* getType 的返回在类型上是 Blob | ClipboardBookmark，这里按能力判断 */
                const ab = (blob as Blob).arrayBuffer;
                if (typeof ab !== 'function') continue;
                files.push(...parseUriList(Buffer.from(await ab.call(blob))));
            }
        }
    } catch { /* 非文件场景无 files */ }
    /* 返回前确保全部字段可结构化克隆（IPC） */
    return {
        text: typeof text === 'string' && text.length ? text : null,
        files: files.filter((f) => typeof f === 'string'),
    };
}
