/* ssh/pool.cts —— SSH 连接池（同一账户复用一条连接）。
 *
 * 对「同一个账户」只建立一条 TCP + 一次 SSH 认证的连接：终端 shell、系统监控
 * exec、文件 SFTP 各自在这条连接上开自己的 channel（SSH 协议原生支持一条连接
 * 多 channel），避免每启用一个功能就重做一遍 TCP 握手 + KEX + 密码认证
 * （密码认证在广域网上往往是秒级开销）。
 *
 * 复用键：user@host:port；持有者（holder）为 ssh:<tabId> / sys:<tabId> /
 * file:<tabId> / once:<n>，引用计数归零才真正断开。因此关闭某个标签只关掉它
 * 自己的 channel，不影响同一主机上其它标签/面板。
 *
 * 与「全局连接池」的区别：不做跨主机的空闲连接驻留，条目随最后一个使用者
 * 释放而销毁；连接意外断开时按 holder 前缀回调各功能模块做清理。
 */

import { Client } from 'ssh2';
import type { SshCred } from './types.cjs';

/** 池条目（一条已建立/正在建立的 SSH 连接） */
export interface ConnEntry {
    key: string;
    opt: SshCred;
    client: Client;
    refs: number;
    holders: Set<string>;
    ready: boolean;
    dead: boolean;
    readyCbs: Array<() => void>;
    failCbs: Array<(r: { ok: false; msg: string }) => void>;
    /** holder -> cb：一次性借用者关心「连接何时断开」，避免 IPC 调用永不返回 */
    closedCbs: Map<string, () => void>;
}

export type AcquireResult = { ok: true; conn: ConnEntry } | { ok: false; msg: string };

/** 借用结果（借用已有连接或临时新建） */
export type BorrowResult =
    | { ok: true; client: Client; onClose: (cb: () => void) => () => void; release: () => void }
    | { ok: false; msg: string };

/** 连接意外断开时，按 holder 前缀回调（ssh/sys/file）做各功能的清理 */
const closedHandlers = new Map<string, (id: string) => void>();

/** 注册某类 holder 的断线清理回调（各功能模块在模块加载时调用一次） */
export function onConnClosed(kind: string, cb: (id: string) => void): void {
    closedHandlers.set(kind, cb);
}

const pool = new Map<string, ConnEntry>();    /* key -> entry */
const holders = new Map<string, ConnEntry>(); /* holder -> entry（按持有者释放用） */
let onceSeq = 0;

function keyOf(o: SshCred): string {
    return `${String((o && o.user) || '')}@${String((o && o.host) || 'localhost')}:${Number((o && o.port) || 0) || 22}`;
}

function connectClient(opt: SshCred): Client {
    const client = new Client();
    client.connect({
        host: String(opt.host || 'localhost'),
        port: Number(opt.port) || 22,
        username: String(opt.user || ''),
        password: opt.pass ? String(opt.pass) : undefined,
        readyTimeout: 12000,
    });
    return client;
}

/** 建池条目：处理「就绪 / 连接失败 / 断开」三种结局 */
function poolOpen(key: string, opt: SshCred): ConnEntry {
    const client = connectClient(opt);
    const entry: ConnEntry = {
        key,
        opt: { ...opt },
        client,
        refs: 0,
        holders: new Set<string>(),
        ready: false,
        dead: false,
        readyCbs: [],
        failCbs: [],
        closedCbs: new Map<string, () => void>(),
    };
    pool.set(key, entry);
    let settled = false;

    client.on('ready', () => {
        settled = true;
        entry.ready = true;
        const cbs = entry.readyCbs;
        entry.readyCbs = [];
        entry.failCbs = [];
        for (const cb of cbs) cb();
    });
    client.on('error', (e) => {
        if (settled) return; /* 就绪后的错误由 close 统一处置 */
        settled = true;
        entry.dead = true;
        if (pool.get(key) === entry) pool.delete(key);
        const msg = (e && e.message) || String(e);
        const cbs = entry.failCbs;
        entry.readyCbs = [];
        entry.failCbs = [];
        for (const cb of cbs) cb({ ok: false, msg });
    });
    client.on('close', () => {
        entry.dead = true;
        if (pool.get(key) === entry) pool.delete(key);
        if (!settled) {
            settled = true;
            const cbs = entry.failCbs;
            entry.readyCbs = [];
            entry.failCbs = [];
            for (const cb of cbs) cb({ ok: false, msg: 'SSH 连接已断开' });
        }
        onPoolClosed(entry);
    });
    return entry;
}

/** 获取（必要时建立）到某账户的连接；holder 作为使用者标识参与引用计数 */
export function sshAcquire(opt: SshCred, holder: string): Promise<AcquireResult> {
    const key = keyOf(opt);
    let entry = pool.get(key);
    if (entry && entry.dead) entry = undefined;
    if (!entry) entry = poolOpen(key, opt);
    entry.refs += 1;
    entry.holders.add(holder);
    holders.set(holder, entry);
    if (entry.ready) return Promise.resolve({ ok: true, conn: entry });
    return new Promise<AcquireResult>((resolve) => {
        entry!.readyCbs.push(() => resolve({ ok: true, conn: entry! }));
        entry!.failCbs.push((r) => {
            holders.delete(holder);
            entry!.holders.delete(holder);
            entry!.refs = Math.max(0, entry!.refs - 1);
            resolve({ ok: false, msg: r.msg });
        });
    });
}

/** 释放一个使用者；最后一个使用者退出时才真正断开连接 */
export function sshRelease(holder: string): void {
    const entry = holders.get(holder);
    if (!entry) return;
    holders.delete(holder);
    entry.holders.delete(holder);
    entry.closedCbs.delete(holder);
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    if (pool.get(entry.key) === entry) pool.delete(entry.key);
    entry.dead = true;
    try { entry.client.end(); } catch { /* 忽略 */ }
}

/** 该 holder 是否仍持有连接（建连期间可能已被释放 → 调用方应放弃后续动作） */
export function hasHolder(holder: string): boolean {
    return holders.has(holder);
}

/** 连接断开（对端关闭/网络中断）：清理挂在它上面的各功能并通知前端，
 *  避免面板继续停留在“已连接”的假象 */
function onPoolClosed(entry: ConnEntry): void {
    for (const holder of Array.from(entry.holders)) {
        entry.holders.delete(holder);
        holders.delete(holder);
        const m = /^([a-z]+):(.*)$/.exec(holder);
        if (!m) continue;
        const cb = closedHandlers.get(m[1]);
        if (!cb) continue;
        try { cb(m[2]); } catch { /* 忽略 */ }
    }
    const cbs = Array.from(entry.closedCbs.values());
    entry.closedCbs.clear();
    entry.refs = 0;
    for (const cb of cbs) { try { cb(); } catch { /* 忽略 */ } }
}

/** 借一条连接做一次性任务（探测/启动/安装/关于）：
 *   - 池中已有该账户的活跃连接 → 直接借用，用完归还（不再重新认证）；
 *   - 没有 → 临时新建一条独立连接，用完即断（不进池，避免空闲连接驻留）。 */
export function sshBorrow(opt: SshCred): Promise<BorrowResult> {
    const key = keyOf(opt);
    const entry = pool.get(key);
    if (entry && entry.ready && !entry.dead) {
        const holder = `once:${++onceSeq}`;
        entry.refs += 1;
        entry.holders.add(holder);
        holders.set(holder, entry);
        return Promise.resolve({
            ok: true,
            client: entry.client,
            onClose: (cb: () => void) => {
                entry.closedCbs.set(holder, cb);
                return () => entry.closedCbs.delete(holder);
            },
            release: () => sshRelease(holder),
        });
    }
    return new Promise<BorrowResult>((resolve) => {
        const client = connectClient(opt);
        let done = false;
        const fin = (r: BorrowResult): void => { if (!done) { done = true; resolve(r); } };
        client.on('ready', () => fin({
            ok: true,
            client,
            onClose: (cb: () => void) => { client.once('close', cb); return () => { /* 临时连接随用随断 */ }; },
            release: () => { try { client.end(); } catch { /* 忽略 */ } },
        }));
        client.on('error', (e) => fin({ ok: false, msg: (e && e.message) || String(e) }));
        client.on('close', () => fin({ ok: false, msg: 'SSH 连接已断开' }));
    });
}
