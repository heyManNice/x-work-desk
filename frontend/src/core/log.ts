/* core/log.ts —— 客户端内存日志 + 日志报告（**不写文件**）。
 *
 * 为什么不落盘：写文件得经主进程，还受路径/权限限制（Windows 上把 /tmp 写死就是
 * 个坑），而现场排查真正需要的是「最近到底发生了什么」。所以这里只在内存里留最多
 * 2000 条（超过就一次丢掉最旧的 1000 条），用户要留证时到「关于」面板点
 * 「生成日志报告」，再由主进程弹保存框写到自选位置。
 *
 * 收录两类内容：
 *   ① 我们自己打的日志：logTrace/logInfo/logWarn/logError（各模块按意义择点调用）；
 *   ② JS 环境自己冒出来的报错：window.onerror、unhandledrejection、console.error/warn
 *      （第三方库往往只 console.error 而不抛异常，不挂这个钩子就会漏）。
 *
 * 主进程也有同款环形缓冲（electron/log.cts），生成报告时由主进程取出、在这里
 * 按时间合并，因此**报告只有一个格式化实现**。
 */

export type LogLevel = 'trace' | 'info' | 'warn' | 'error';

export interface LogEntry {
    /** 单调序号（报告里看顺序比时间戳更可靠） */
    seq: number;
    ts: number;
    level: LogLevel;
    /** 来源：模块名，或 'js' / 'promise' / 'console'（环境自动捕获） */
    scope: string;
    msg: string;
}

/** 内存条数上限；超限时一次性丢弃最旧的 TRIM 条（比每条都 splice 便宜） */
const MAX = 2000;
const TRIM = 1000;
/** 单条上限：第三方库可能一次打出几百 KB（截断而不是丢整条，保留线索） */
const MSG_MAX = 4000;

/** 客户端启动时刻（本模块被 import 的时刻 ≈ 应用启动） */
const startedAt = Date.now();
let entries: LogEntry[] = [];
let seq = 0;

export function clientStartedAt(): number {
    return startedAt;
}

export function logEntries(): readonly LogEntry[] {
    return entries;
}

export function logCount(): number {
    return entries.length;
}

function clip(s: string): string {
    const t = String(s ?? '').replace(/\s+$/, '');
    return t.length > MSG_MAX ? `${t.slice(0, MSG_MAX)}…（已截断，原长 ${t.length}）` : t;
}

function push(level: LogLevel, scope: string, msg: string): void {
    try {
        entries.push({ seq: ++seq, ts: Date.now(), level, scope, msg: clip(msg) });
        if (entries.length > MAX) entries = entries.slice(-(MAX - TRIM));
    } catch { /* 日志自身绝不抛：它不该拖垮业务 */ }
}

/** trace：很碎的过程日志（如本机输入法的每次组词更新） */
export function logTrace(scope: string, msg: string): void { push('trace', scope, msg); }
export function logInfo(scope: string, msg: string): void { push('info', scope, msg); }
export function logWarn(scope: string, msg: string): void { push('warn', scope, msg); }
export function logError(scope: string, msg: string): void { push('error', scope, msg); }

/** 把任意值转成可读文本（Error 带 stack；对象走 JSON，失败就 String） */
export function errText(e: unknown): string {
    if (e instanceof Error) return `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ''}`;
    if (typeof e === 'string') return e;
    try { return JSON.stringify(e); } catch { return String(e); }
}

let installed = false;

/** 挂全局报错捕获（渲染层入口调用一次）。幂等。 */
export function installLogCapture(): void {
    if (installed) return;
    installed = true;
    logInfo('app', '日志捕获已就绪（内存环形缓冲）');

    /* 未捕获异常：window 上的 error 事件（含各事件处理器里抛出的）。
     * capture=true 才能同时收到资源加载失败。 */
    window.addEventListener('error', (ev) => {
        const e = ev as ErrorEvent;
        if (e.error) {
            const at = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '未知位置';
            logError('js', `${errText(e.error)}\n  at ${at}`);
            return;
        }
        if (e.message) {
            logError('js', `${e.message}（${e.filename || '?'}:${e.lineno}:${e.colno}）`);
            return;
        }
        const t = e.target as (HTMLElement & { src?: string; href?: string }) | null;
        if (t && t.tagName) {
            logWarn('js', `资源加载失败：<${t.tagName.toLowerCase()}> ${t.src || t.href || ''}`);
        }
    }, true);

    /* 未处理的 Promise 拒绝（async 里漏 try/catch 的常见漏网之鱼） */
    window.addEventListener('unhandledrejection', (ev) => {
        logError('promise', errText((ev as PromiseRejectionEvent).reason));
    });

    /* 第三方库/浏览器原生告警只走 console —— 透传一份到内存（控制台行为不变） */
    const origError = console.error.bind(console);
    console.error = (...a: unknown[]): void => {
        logError('console', a.map(errText).join(' '));
        origError(...a);
    };
    const origWarn = console.warn.bind(console);
    console.warn = (...a: unknown[]): void => {
        logWarn('console', a.map(errText).join(' '));
        origWarn(...a);
    };
}

/* ---------------- 日志报告 ---------------- */

const p2 = (n: number): string => String(n).padStart(2, '0');

/** 2026-09-12 21:41:33 */
export function fmtDateTime(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
        + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 21:41:33.564 */
function fmtClock(ts: number): string {
    const d = new Date(ts);
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** 相对启动时刻：+12.345s —— 和"启动后多久出问题"直接对得上 */
function fmtRel(ts: number): string {
    return `+${((ts - startedAt) / 1000).toFixed(3)}s`;
}

function fmtLine(e: LogEntry): string {
    const msg = e.msg.replace(/\n/g, '\n        ');   /* 多行（stack）缩进对齐 */
    return `${fmtRel(e.ts).padStart(10)}  ${fmtClock(e.ts)}  ${e.level.toUpperCase().padEnd(5)}  [${e.scope}] ${msg}`;
}

/**
 * 生成报告文本。extra 是环境信息（版本/平台/窗口…），main 是主进程的内存日志。
 * 两边按时间戳合并排序，所以一眼能看出"客户端做了什么 → 主进程报了什么"。
 */
export function buildLogReport(extra: Record<string, string>, main: LogEntry[] = []): string {
    const all = [...entries, ...main].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    const L: string[] = [];
    L.push('XWorkDesk 日志报告');
    L.push('='.repeat(72));
    for (const [k, v] of Object.entries(extra)) L.push(`${k}：${v}`);
    L.push(`启动时间：${fmtDateTime(startedAt)}（报告生成于启动后 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒）`);
    L.push(`报告时间：${fmtDateTime(Date.now())}`);
    L.push(`日志条数：${all.length}（内存上限 ${MAX} 条，超出时丢弃最旧的 ${TRIM} 条）`);
    if (all.length > 0) {
        L.push(`时间范围：${fmtClock(all[0].ts)} ~ ${fmtClock(all[all.length - 1].ts)}（渲染层与主进程日志已按时间合并）`);
    }
    L.push('='.repeat(72));
    for (const e of all) L.push(fmtLine(e));
    L.push('');
    return L.join('\n');
}

/** 报告文件名：xworkd-log-20260912-214133.txt */
export function logReportName(): string {
    const d = new Date();
    return `xworkd-log-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
        + `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.txt`;
}
