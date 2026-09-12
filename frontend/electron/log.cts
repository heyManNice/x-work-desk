/* log.cts —— 主进程内存日志（与渲染层 core/log.ts 同款环形缓冲，**不写文件**）。
 *
 * 存在的意义：渲染层只看得见自己那半边，SSH/SFTP/安装引导这些"用户看到报错"的
 * 现场其实都在主进程。两边各自留一份内存日志，「生成日志报告」时由渲染层取走、
 * 按时间合并成一份文本（格式化只有渲染层那一份实现）。
 *
 * 上限与裁剪口径和渲染层一致：最多 2000 条，超出丢弃最旧的 1000 条。
 */

import { app } from 'electron';

export type MainLogLevel = 'trace' | 'info' | 'warn' | 'error';

export interface MainLogEntry {
    seq: number;
    ts: number;
    level: MainLogLevel;
    scope: string;
    msg: string;
}

const MAX = 2000;
const TRIM = 1000;
const MSG_MAX = 4000;

let entries: MainLogEntry[] = [];
let seq = 0;

export function mainLogEntries(): readonly MainLogEntry[] {
    return entries;
}

function clip(s: string): string {
    const t = String(s ?? '').replace(/\s+$/, '');
    return t.length > MSG_MAX ? `${t.slice(0, MSG_MAX)}…（已截断，原长 ${t.length}）` : t;
}

function push(level: MainLogLevel, scope: string, msg: string): void {
    try {
        entries.push({ seq: ++seq, ts: Date.now(), level, scope, msg: clip(msg) });
        if (entries.length > MAX) entries = entries.slice(-(MAX - TRIM));
    } catch { /* 日志自身绝不抛 */ }
}

export function mlogTrace(scope: string, msg: string): void { push('trace', scope, msg); }
export function mlogInfo(scope: string, msg: string): void { push('info', scope, msg); }
export function mlogWarn(scope: string, msg: string): void { push('warn', scope, msg); }
export function mlogError(scope: string, msg: string): void { push('error', scope, msg); }

/** 把任意值转成可读文本（Error 带 stack） */
export function merrText(e: unknown): string {
    if (e instanceof Error) return `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ''}`;
    if (typeof e === 'string') return e;
    try { return JSON.stringify(e); } catch { return String(e); }
}

let installed = false;

/** 挂主进程侧的异常/崩溃捕获（app 启动时调用一次）。幂等。
 *
 * 刻意**不**挂 process.on('uncaughtException')：那会让 Node 从"崩溃退出"变成
 * "带伤继续跑"，风险大于收益。这里只收：
 *   - unhandledRejection（只记日志，不改变行为）
 *   - 渲染进程/子进程异常退出（Electron 会给出 reason/exitCode）
 */
export function installMainLogCapture(): void {
    if (installed) return;
    installed = true;

    /* 启动即记一条环境信息：排查时"哪个 Electron/Chromium/Node"常常是第一个问题 */
    mlogInfo('app', `主进程启动：Electron ${process.versions.electron} / Chromium ${process.versions.chrome} `
        + `/ Node ${process.versions.node} / ${process.platform} ${process.arch}`);

    process.on('unhandledRejection', (reason) => {
        mlogError('main', `未处理的 Promise 拒绝：${merrText(reason)}`);
    });

    app.on('render-process-gone', (_e, _wc, details) => {
        mlogError('main', `渲染进程退出：reason=${details.reason} exitCode=${details.exitCode}`);
    });
    app.on('child-process-gone', (_e, details) => {
        mlogWarn('main', `子进程退出：type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
    });
}
