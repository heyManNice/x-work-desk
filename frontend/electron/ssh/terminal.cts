/* ssh/terminal.cts —— SSH 终端会话（在池化连接上开 shell channel）。
 *
 * 连接本体由 ssh/pool 持有并复用，这里只记录「哪个标签在用哪个 shell channel」；
 * 关闭标签只关掉自己的 channel 并释放引用，不影响同主机上的监控/文件面板。
 */

import type { ClientChannel } from 'ssh2';
import { sendToUi } from '../window.cjs';
import { sshAcquire, sshRelease, onConnClosed, type ConnEntry } from './pool.cjs';
import type { SshCred, SshResult } from './types.cjs';

export interface SshTermOpt extends SshCred {
    id: string;
}

interface TermRec {
    id: string;
    conn: ConnEntry | null;
    stream: ClientChannel | null;
    /** 建连/开 channel 期间已被关闭：就绪后自行放弃 */
    cancelled: boolean;
}

const sessions = new Map<string, TermRec>();

export function closeSshSession(id: string): void {
    const r = sessions.get(id);
    sessions.delete(id);
    if (r) {
        r.cancelled = true;
        try { if (r.stream) r.stream.close(); } catch { /* 忽略 */ }
    }
    /* 只释放本会话占用的引用：连接上还有监控/文件等使用者时不会被断开 */
    sshRelease(`ssh:${id}`);
}

export function sendSshClose(id: string, code: number): void {
    sendToUi('xwd:ssh:close', { id, code });
    closeSshSession(id);
}

/** 建立 SSH 连接（复用同账户连接）并打开伪终端通道 */
export function startSshSession({ id, host, port, user, pass }: SshTermOpt): Promise<SshResult> {
    const holder = `ssh:${id}`;
    return new Promise<SshResult>((resolve) => {
        let settled = false;
        const finish = (r: SshResult): void => { if (!settled) { settled = true; resolve(r); } };
        const fail = (msg: string): void => { closeSshSession(id); finish({ ok: false, msg }); };

        const rec: TermRec = { id, conn: null, stream: null, cancelled: false };
        sessions.set(id, rec);

        void sshAcquire({ host, port, user, pass }, holder).then((res) => {
            if (rec.cancelled) { finish({ ok: false, msg: '连接已取消' }); return; }
            if (!res.ok) {
                sessions.delete(id);
                finish({ ok: false, msg: 'SSH 连接失败: ' + (res.msg || '未知错误') });
                return;
            }
            rec.conn = res.conn;
            res.conn.client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
                if (err) { fail('打开远程 shell 失败: ' + err.message); return; }
                if (rec.cancelled) {
                    try { stream.close(); } catch { /* 忽略 */ }
                    finish({ ok: false, msg: '连接已取消' });
                    return;
                }
                rec.stream = stream;
                finish({ ok: true });
                stream.on('data', (d: Buffer) => sendToUi('xwd:ssh:data', { id, data: d }));
                stream.on('close', () => sendSshClose(id, 0));
                stream.on('error', () => { /* close 统一处理 */ });
            });
        });
    });
}

/** 终端输入 */
export function sshWrite(id: string, data: string | Uint8Array): void {
    const r = sessions.get(id);
    if (r && r.stream) {
        try { r.stream.write(data); } catch { /* 忽略 */ }
    }
}

/** 终端改窗（远端 PTY 行列数；像素宽高按惯例传 0） */
export function sshResize(id: string, cols: number, rows: number): void {
    const r = sessions.get(id);
    if (r && r.stream) {
        try { r.stream.setWindow(rows, cols, 0, 0); } catch { /* 忽略 */ }
    }
}

/* 连接意外断开：对应标签提示“连接已关闭” */
onConnClosed('ssh', (id) => {
    if (sessions.has(id)) sendSshClose(id, 0);
});
