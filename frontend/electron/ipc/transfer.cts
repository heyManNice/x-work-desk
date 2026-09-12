/* ipc/transfer.cts —— 文件传输（与远端桌面的 HTTP 分片接口对接）。
 *   下载：GET  /api/transfer/download -> 静默存到系统「下载」目录（不弹选择框）
 *   上传：POST /api/transfer/upload   -> 本地文件分片上传到远程桌面
 * 进度经 xwd:progress 推给渲染层。
 */

import fs from 'node:fs';
import path from 'node:path';
import { sendToUi } from '../window.cjs';
import { downloadsDir, sanitizeName, uniquePath } from '../util.cjs';

export interface DownloadOpt {
    api: string;
    token: string;
    paths: string[];
}

export interface UploadOpt {
    api: string;
    token: string;
    dir: string;
    files: string[];
}

export interface TransferResult {
    ok: boolean;
    msg: string;
}

/** 进度事件（xwd:progress） */
export interface TransferProgress {
    done: number;
    total: number;
    name: string;
}

export async function downloadRemoteFiles(opt: DownloadOpt): Promise<TransferResult> {
    const dlDir = downloadsDir();
    let ok = true;
    let msg = '';
    for (const p of opt.paths || []) {
        try {
            const name = sanitizeName(String(p).split('/').pop() || 'file');
            const url = `${opt.api}/api/transfer/download?token=${encodeURIComponent(opt.token)}&path=${encodeURIComponent(p)}`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}${resp.statusText ? ' ' + resp.statusText : ''}`);
            const total = Number(resp.headers.get('content-length') || 0);
            const buf = Buffer.from(await resp.arrayBuffer());
            const dest = uniquePath(path.join(dlDir, name));
            fs.writeFileSync(dest, buf);
            sendToUi('xwd:progress', { done: buf.length, total: total || buf.length, name } satisfies TransferProgress);
        } catch (err) {
            ok = false;
            msg = `${String(p).split('/').pop()}: ${err instanceof Error ? err.message : String(err)}`;
            break;
        }
    }
    return { ok, msg };
}

/** 按服务端分片协议 POST /api/transfer/upload?token&dir&name&offset，body 为原始分片 */
export async function uploadLocalFiles(opt: UploadOpt): Promise<TransferResult> {
    const CHUNK = 1024 * 1024; /* 1 MiB 分片 */
    let ok = true;
    let msg = '';
    for (const f of opt.files || []) {
        const name = sanitizeName(path.basename(f));
        try {
            const st = fs.statSync(f);
            if (!st.isFile()) continue; /* 目录/链接整批跳过 */
            const total = st.size;
            const fd = fs.openSync(f, 'r');
            let offset = 0;
            try {
                for (; ;) {
                    /* 空文件也发一次空 body 让服务端创建文件 */
                    const len = total === 0 ? 0 : Math.min(CHUNK, total - offset);
                    if (total !== 0 && len <= 0) break;
                    const b = Buffer.alloc(len);
                    if (len > 0) fs.readSync(fd, b, 0, len, offset);
                    const qs = new URLSearchParams({
                        token: opt.token, name, dir: opt.dir || '', offset: String(offset),
                    });
                    const resp = await fetch(`${opt.api}/api/transfer/upload?${qs}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: b,
                    });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    offset += len;
                    if (total === 0) break;
                    sendToUi('xwd:progress', { done: offset, total, name } satisfies TransferProgress);
                }
            } finally {
                fs.closeSync(fd);
            }
        } catch (err) {
            ok = false;
            msg = `${name}: ${err instanceof Error ? err.message : String(err)}`;
            break;
        }
    }
    return { ok, msg };
}
