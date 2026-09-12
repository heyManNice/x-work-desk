/* ssh/sftp.cts —— 远程文件面板（SFTP 子系统，复用同账户 SSH 连接）。
 *
 * 同一标签重复打开面板只重建 SFTP channel，连接本体由 ssh/pool 复用；
 * 标签关闭时才释放引用（引用归零才真正断开连接）。
 */

import { dialog } from 'electron';
import path from 'node:path';
import type { FileEntryWithStats, SFTPWrapper } from 'ssh2';
import { getWin } from '../window.cjs';
import { downloadsDir, sanitizeName, uniquePath } from '../util.cjs';
import { sshAcquire, sshRelease, hasHolder, onConnClosed, type ConnEntry } from './pool.cjs';
import type { SshCred, SshResult, SftpEntry, SftpOpenResult, SftpListResult } from './types.cjs';

export interface SftpOpenOpt extends SshCred {
    id: number;
}

export interface SftpIdOpt {
    id: number;
}

export interface SftpPathOpt extends SftpIdOpt {
    path: string;
}

export interface SftpRenameOpt extends SftpIdOpt {
    from: string;
    to: string;
}

export interface SftpRemoveOpt extends SftpPathOpt {
    isDir: boolean;
}

export interface SftpUploadOpt extends SftpIdOpt {
    dir: string;
}

export interface SftpUploadResult {
    ok: boolean;
    canceled?: boolean;
    uploaded?: string[];
    msg?: string;
}

export interface SftpDownloadResult {
    ok: boolean;
    dest?: string;
    name?: string;
    msg?: string;
}

interface FileSess {
    conn: ConnEntry;
    sftp: SFTPWrapper;
}

const fileSessions = new Map<number, FileSess>();

function sftpGet(id: number): SFTPWrapper | null {
    const r = fileSessions.get(id);
    return r && r.sftp ? r.sftp : null;
}

/** 只关闭 SFTP channel，不释放连接引用（同一标签重新打开面板时用） */
function sftpDropChannel(id: number): void {
    const r = fileSessions.get(id);
    if (!r) return;
    fileSessions.delete(id);
    try { r.sftp.end(); } catch { /* 忽略 */ }
}

export function sftpClose(id: number): void {
    sftpDropChannel(id);
    sshRelease(`file:${id}`);
}

function sftpJoin(dir: string, name: string): string {
    const d = dir == null || dir === '' ? '' : String(dir);
    const n = String(name).replace(/^\/+/, '');
    if (d === '/' || d === '') return '/' + n;
    return d.replace(/\/+$/, '') + '/' + n;
}

function readdirEntries(
    sftp: SFTPWrapper,
    p: string,
    cb: (err: Error | null, rows: SftpEntry[] | null) => void,
): void {
    sftp.readdir(p, (err, list) => {
        if (err) return cb(err, null);
        const rows = (list || [])
            .filter((f: FileEntryWithStats) => f && f.filename && f.filename !== '.' && f.filename !== '..')
            .map((f: FileEntryWithStats): SftpEntry => {
                const a = f.attrs || ({} as FileEntryWithStats['attrs']);
                const isDir = (a.mode & 0o040000) === 0o040000;
                return {
                    name: String(f.filename),
                    isDir: !!isDir,
                    size: a.size || 0,
                    mtime: a.mtime != null ? Number(a.mtime) * 1000 : 0,
                };
            });
        rows.sort((x, y) => {
            if (x.isDir !== y.isDir) return x.isDir ? -1 : 1;
            return x.name.localeCompare(y.name);
        });
        cb(null, rows);
    });
}

/** 打开（复用/建立连接 → 开 SFTP channel → 定位到用户主目录并列出） */
export async function sftpOpen(opt: SftpOpenOpt): Promise<SftpOpenResult> {
    const id = Number(opt.id);
    const holder = `file:${id}`;
    /* 先取得连接引用（同账户已有连接则直接复用），再丢弃旧的 SFTP channel，
     * 保证同一标签反复打开面板不会把连接断开重建。 */
    const res = await sshAcquire({ host: opt.host, port: opt.port, user: opt.user, pass: opt.pass }, holder);
    if (!res.ok) return { ok: false, msg: '连接失败: ' + (res.msg || '未知错误') };
    if (!hasHolder(holder)) return { ok: false, msg: '已取消' }; /* 建连期间标签已关闭 */
    sftpDropChannel(id);
    const client = res.conn.client;

    /* 远端 $HOME：文件面板初始目录 */
    const home = await new Promise<string>((resolve) => {
        client.exec('printf %s "$HOME"', (err, stream) => {
            if (err) return resolve('/');
            const ch: Buffer[] = [];
            stream.on('data', (d: Buffer) => ch.push(d));
            stream.on('close', () => resolve(Buffer.concat(ch).toString().trim() || '/'));
            stream.on('error', () => resolve('/'));
        });
    });

    const got = await new Promise<SFTPWrapper | Error>((resolve) => client.sftp((err2, sftp) => resolve(err2 || sftp)));
    if (got instanceof Error) { sftpClose(id); return { ok: false, msg: 'sftp 打开失败: ' + got.message }; }
    const sftp = got;
    if (!hasHolder(holder)) { /* 打开 channel 期间标签被关闭 */
        try { sftp.end(); } catch { /* 忽略 */ }
        return { ok: false, msg: '已取消' };
    }
    fileSessions.set(id, { conn: res.conn, sftp });

    const start = home && home.startsWith('/') ? home : '/';
    const rows = await new Promise<SftpEntry[] | Error>((resolve) => {
        readdirEntries(sftp, start, (e, r) => resolve(e || r || []));
    });
    if (rows instanceof Error) { sftpClose(id); return { ok: false, msg: '读取目录失败: ' + rows.message }; }
    return { ok: true, cwd: start, entries: rows };
}

export function sftpList(opt: SftpPathOpt): Promise<SftpListResult> {
    return new Promise<SftpListResult>((resolve) => {
        const sftp = sftpGet(Number(opt.id));
        const p = String(opt.path || '/');
        if (!sftp) return resolve({ ok: false, msg: '未连接' });
        readdirEntries(sftp, p, (err, rows) => {
            if (err) return resolve({ ok: false, msg: (err && err.message) || String(err) });
            resolve({ ok: true, cwd: p, entries: rows });
        });
    });
}

export function sftpMkdir(opt: SftpPathOpt): Promise<SshResult> {
    return new Promise<SshResult>((resolve) => {
        const sftp = sftpGet(Number(opt.id));
        if (!sftp) return resolve({ ok: false, msg: '未连接' });
        sftp.mkdir(String(opt.path || ''), (e) => resolve(e ? { ok: false, msg: e.message } : { ok: true }));
    });
}

export function sftpRename(opt: SftpRenameOpt): Promise<SshResult> {
    return new Promise<SshResult>((resolve) => {
        const sftp = sftpGet(Number(opt.id));
        if (!sftp) return resolve({ ok: false, msg: '未连接' });
        sftp.rename(String(opt.from || ''), String(opt.to || ''), (e) => resolve(e ? { ok: false, msg: e.message } : { ok: true }));
    });
}

/** 递归删除目录 */
function rmrf(sftp: SFTPWrapper, p: string, done: (e?: Error | null) => void): void {
    sftp.readdir(p, (e, list) => {
        if (e) return sftp.rmdir(p, done);
        let i = 0;
        const items = list || [];
        const next = (): void => {
            if (i >= items.length) return sftp.rmdir(p, (er) => done(er));
            const f = items[i++];
            const fp = sftpJoin(p, f.filename);
            const isDir = (f.attrs.mode & 0o040000) === 0o040000;
            if (isDir) rmrf(sftp, fp, () => next());
            else sftp.unlink(fp, () => next()); /* 单项失败不阻断整体 */
        };
        next();
    });
}

export function sftpRemove(opt: SftpRemoveOpt): Promise<SshResult> {
    return new Promise<SshResult>((resolve) => {
        const sftp = sftpGet(Number(opt.id));
        const p = String(opt.path || '');
        if (!sftp) return resolve({ ok: false, msg: p ? '未连接' : '路径为空' });
        if (!opt.isDir) {
            sftp.unlink(p, (e) => resolve(e ? { ok: false, msg: e.message } : { ok: true }));
            return;
        }
        rmrf(sftp, p, (e) => resolve(e ? { ok: false, msg: e.message } : { ok: true }));
    });
}

/** 上传：弹本地文件选择框，fastPut 到当前目录 */
export async function sftpUpload(opt: SftpUploadOpt): Promise<SftpUploadResult> {
    const sftp = sftpGet(Number(opt.id));
    const dir = String(opt.dir || '/');
    if (!sftp) return { ok: false, msg: '未连接' };
    let paths: string[] = [];
    try {
        const opts: Electron.OpenDialogOptions = {
            title: '选择要上传的文件',
            properties: ['openFile', 'multiSelections'],
        };
        const w = getWin();
        const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
        if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
        paths = r.filePaths;
    } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        return { ok: false, msg: '选择文件失败: ' + m };
    }
    const done: string[] = [];
    for (const lp of paths) {
        const name = path.basename(lp);
        await new Promise<void>((res) => {
            sftp.fastPut(lp, sftpJoin(dir, name), (e) => { if (!e) done.push(name); res(); });
        });
    }
    return { ok: true, uploaded: done };
}

/** 下载：静默保存到系统「下载」目录（自动避免重名） */
export function sftpDownload(opt: SftpPathOpt): Promise<SftpDownloadResult> {
    return new Promise<SftpDownloadResult>((resolve) => {
        const sftp = sftpGet(Number(opt.id));
        const rp = String(opt.path || '');
        if (!sftp) return resolve({ ok: false, msg: !rp ? '路径为空' : '未连接' });
        if (!rp) return resolve({ ok: false, msg: '路径为空' });
        const name = sanitizeName(String(rp).split('/').pop() || 'file');
        const dest = uniquePath(path.join(downloadsDir(), name));
        sftp.fastGet(rp, dest, (e) => {
            resolve(e ? { ok: false, msg: e.message } : { ok: true, dest, name });
        });
    });
}

/* 连接意外断开：清掉 SFTP 会话（后续操作提示未连接） */
onConnClosed('file', (id) => {
    const n = Number(id);
    const r = fileSessions.get(n);
    if (!r) return;
    try { r.sftp.end(); } catch { /* 忽略 */ }
    fileSessions.delete(n);
});
