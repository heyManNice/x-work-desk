/* core/about.tsx —— 顶栏“关于”按钮 + 悬浮面板（风格与其他工具弹出面板一致）。
 *
 * 内容：
 *   - 客户端版本号（编译期固定）＋“已是最新版本”（暂未接入更新检查）
 *   - 已连接主机时：服务端版本（GET /api/info，服务端编译期固定并暴露）、
 *     系统版本 / 桌面环境版本（经 SSH 采集远端）；依据内置服务端版本
 *     （与客户端同版本号）比较：低于内置 → “更新”，否则 → “重新安装”。
 */

import { createSignal, createEffect, Show } from 'solid-js';
import { Info, X } from 'lucide-solid';
import { sshHostAboutInfo, logMainEntries, logSaveReport, platform } from '../platform';
import { activePopup, isPopup, togglePopup } from './popups';
import { notifyError, notifySuccess } from './notify';
import { showConfirm } from '../modal';
import { APP_VERSION, BUNDLED_SERVER_VERSION, cmpVer } from './version';
import { buildLogReport, clientStartedAt, errText, fmtDateTime, logInfo, logReportName } from './log';

/* ---------------- 对外上下文（由 App 供给） ---------------- */

export interface AboutCtx {
    kind: 'desktop' | 'terminal'; /* 连接类型：桌面远程 / SSH 终端 */
    name: string;
    apiBase: string;   /* http://host:5268（桌面会话所在服务端）；SSH 终端为空 */
    host: string;      /* SSH 主机 */
    port: number;      /* SSH 端口 */
    user: string;
    pass: string;
}

export type InstallResult = { ok: boolean; needSudo?: boolean; msg?: string };

const AW = 280; /* 与 CSS .about-panel 宽度保持一致（居中/夹紧换算用） */

const [pos, setPos] = createSignal({ x: 0, y: 0 });
const [hostCtx, setHostCtx] = createSignal<AboutCtx | null>(null);
const [installFn, setInstallFn] = createSignal<((c: AboutCtx) => Promise<InstallResult>) | null>(null);
const [uninstallFn, setUninstallFn] = createSignal<((c: AboutCtx) => Promise<InstallResult>) | null>(null);

/* App 在激活主机变化/安装处理可用后调用 */
export function setAboutHost(c: AboutCtx | null): void { setHostCtx(c); }
export function setAboutInstall(fn: ((c: AboutCtx) => Promise<InstallResult>) | null): void {
    setInstallFn(() => fn); /* 信号存的是函数，用 updater 写法消除重载歧义 */
}
export function setAboutUninstall(fn: ((c: AboutCtx) => Promise<InstallResult>) | null): void {
    setUninstallFn(() => fn);
}

/* ---------------- 面板数据状态 ---------------- */

const [serverState, setServerState] = createSignal<'idle' | 'loading' | 'ok' | 'err'>('idle');
const [serverVersion, setServerVersion] = createSignal('');
const [sysState, setSysState] = createSignal<'idle' | 'loading' | 'done'>('idle');
const [sysInfo, setSysInfo] = createSignal<{ os?: string; de?: string; deVersion?: string; shell?: string } | null>(null);
const [busy, setBusy] = createSignal(false);
const [loadTick, setLoadTick] = createSignal(0);

async function refresh(): Promise<void> {
    const c = hostCtx();
    if (!c) return;
    setServerState('loading');
    setServerVersion('');
    setSysState('loading');
    setSysInfo(null);
    /* 服务端版本（仅桌面远程）：GET /api/info（编译期固定并暴露）；旧版 404 → 视为过旧 */
    if (c.kind === 'desktop') {
        try {
            const ac = new AbortController();
            const timer = window.setTimeout(() => ac.abort(), 4000);
            const resp = await fetch(`${c.apiBase}/api/info`, { signal: ac.signal });
            window.clearTimeout(timer);
            if (!resp.ok) throw new Error('http');
            const j = (await resp.json().catch(() => null)) as { version?: unknown } | null;
            const v = j && typeof j.version === 'string' ? j.version : '';
            setServerVersion(v);
            setServerState(v ? 'ok' : 'err');
        } catch {
            setServerState('err');
        }
    } else {
        setServerState('idle');
        setServerVersion('');
    }
    /* 系统 / 桌面环境 / shell 版本：经 SSH 采集 */
    const info = await sshHostAboutInfo({ host: c.host, port: c.port, user: c.user, pass: c.pass });
    setSysInfo(info);
    setSysState('done');
}

async function runInstall(): Promise<void> {
    const c = hostCtx();
    const fn = installFn();
    if (!c || !fn || busy()) return;
    setBusy(true);
    try {
        const r = await fn(c);
        if (r.ok) {
            notifySuccess('服务端已就绪', `${c.name} 的 XWorkDesk 服务端已更新为内置版本。`);
            setLoadTick((t) => t + 1); /* 刷新服务端版本 */
        } else {
            notifyError('操作失败', `${r.needSudo ? '远端账号缺少 sudo 权限。\n' : ''}${r.msg || '未知错误'}`);
        }
    } catch (e) {
        notifyError('操作失败', e instanceof Error ? e.message : String(e));
    } finally {
        setBusy(false);
    }
}

async function runUninstall(): Promise<void> {
    const c = hostCtx();
    const fn = uninstallFn();
    if (!c || !fn || busy()) return;
    const go = await showConfirm(
        '卸载服务端',
        `将从 ${c.host} 移除 XWorkDesk 服务端：\n`
        + '· 停止并删除 systemd 服务 xworkd\n'
        + '· 删除 /opt/xworkd、PAM 登录拦截钩子与随包覆盖文件\n'
        + '· 保留系统账号与用户数据\n\n'
        + '注意：该主机的远程桌面会立即断开。',
    );
    if (!go) return;
    setBusy(true);
    try {
        const r = await fn(c);
        if (r.ok) {
            notifySuccess('服务端已卸载', `${c.name} 的 XWorkDesk 服务端已移除。`);
            setLoadTick((t) => t + 1); /* 刷新服务端状态（将显示为未知） */
        } else {
            notifyError('卸载失败', `${r.needSudo ? '远端账号缺少 sudo 权限。\n' : ''}${r.msg || '未知错误'}`);
        }
    } catch (e) {
        notifyError('卸载失败', e instanceof Error ? e.message : String(e));
    } finally {
        setBusy(false);
    }
}

/* ---------------- 客户端启动时间 / 日志报告 ---------------- */

const p2 = (n: number): string => String(n).padStart(2, '0');

/** 面板里的启动时间：今天只显示时分秒，跨天再带上月日 */
function startLabel(): string {
    const d = new Date(clientStartedAt());
    const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? hm : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`;
}

function runLabel(): string {
    const s = Math.floor((Date.now() - clientStartedAt()) / 1000);
    if (s < 60) return `${s} 秒`;
    if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
    return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分钟`;
}

/** 导出日志报告：渲染层内存日志 + 主进程内存日志 → 用户选位置落盘。
 * 日志不写常规文件（见 core/log.ts），所以这是唯一的留证出口。 */
async function saveReport(): Promise<void> {
    if (busy()) return;
    setBusy(true);
    logInfo('about', '开始生成日志报告');
    try {
        const main = await logMainEntries();
        const text = buildLogReport({
            '客户端版本': `v${APP_VERSION}`,
            '平台': platform() || navigator.platform || '未知',
            '窗口尺寸': `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
            'userAgent': navigator.userAgent,
        }, main);
        logInfo('about', `日志报告内容已生成：${text.length} 字符（主进程日志 ${main.length} 条）`);
        const r = await logSaveReport(logReportName(), text);
        if (r.ok) {
            notifySuccess('日志报告已保存', r.path || '');
        } else if (r.canceled) {
            logInfo('about', '用户取消了保存日志报告');
        } else {
            notifyError('日志报告保存失败', r.msg || '未知错误');
        }
    } catch (e) {
        notifyError('日志报告保存失败', errText(e));
    } finally {
        setBusy(false);
    }
}

/* ---------------- 顶栏按钮 ---------------- */

export function AboutButton() {
    let btn: HTMLButtonElement | undefined;
    return (
        <button
            ref={btn}
            data-popup-trigger="about"
            class="tb-btn"
            classList={{ active: activePopup() === 'about' }}
            title="关于 XWorkDesk"
            onClick={() => {
                const opened = togglePopup('about');
                if (!opened) return;
                if (btn) {
                    const r = btn.getBoundingClientRect();
                    /* 居中于按钮，并夹紧到窗口左右边缘（两侧留 ~14px），避免面板贴边/出界 */
                    const m = 14;
                    setPos({
                        x: Math.min(Math.max(AW / 2 + m, r.left + r.width / 2), window.innerWidth - AW / 2 - m),
                        y: r.bottom + 8,
                    });
                }
                setLoadTick((t) => t + 1);
            }}
        >
            <Info size={15} />
        </button>
    );
}

/* ---------------- 悬浮面板（App 根部 fixed 渲染） ---------------- */

export function AboutPanelHost() {
    /* 面板打开且存在已连接主机时刷新数据（依赖 loadTick：每次打开/更新后重取） */
    createEffect(() => {
        const open = isPopup('about');
        const tick = loadTick();
        const c = hostCtx();
        if (open && c) void refresh();
    });

    const needUpdate = () => {
        if (serverState() !== 'ok') return true; /* 未知/接口不可用 → 视为低于内置 */
        return cmpVer(serverVersion(), BUNDLED_SERVER_VERSION) < 0;
    };
    const serverLabel = () => {
        const s = serverState();
        if (s === 'loading') return '…';
        if (s === 'ok') return `v${serverVersion()}`;
        return '未知';
    };
    const osLabel = () => (sysState() === 'loading' ? '…' : (sysInfo()?.os || '—'));
    const deLabel = () => (sysState() === 'loading' ? '…' : [sysInfo()?.de, sysInfo()?.deVersion].filter(Boolean).join(' ').trim() || '—');
    const shellLabel = () => (sysState() === 'loading' ? '…' : (sysInfo()?.shell || '—'));

    return (
        <Show when={isPopup('about')}>
            <div class="about-panel popup-panel" style={{ left: `${pos().x}px`, top: `${pos().y}px` }}>
                <div class="about-head">
                    <span class="npanel-title">关于</span>
                    <button class="npanel-x" onClick={() => togglePopup('about')} title="关闭"><X size={13} /></button>
                </div>
                <div class="about-body">
                    <div class="about-rows">
                        <div class="ab-row">
                            <span class="ab-name">XWorkDesk</span>
                            <span class="ab-ver">v{APP_VERSION}</span>
                            <span class="ab-fill" />
                            <span class="ab-tag ok">最新版本</span>
                        </div>
                        <Show when={hostCtx()}>
                            {(c) => (
                                <>
                                    <Show when={c().kind === 'desktop'}>
                                        <div class="ab-row">
                                            <span class="ab-name">XWorkDesk 服务端</span>
                                            <span class="ab-ver">{serverLabel()}</span>
                                            <span class="ab-fill" />
                                            <button
                                                class="ab-action act-danger"
                                                disabled={busy()}
                                                onClick={() => void runUninstall()}
                                                title="经 SSH 卸载远端服务端：停服务并删除程序与集成钩子（保留系统账号与用户数据）"
                                            >
                                                卸载
                                            </button>
                                            <button
                                                class="ab-action"
                                                disabled={busy()}
                                                onClick={() => void runInstall()}
                                                title="经 SSH 推送内置服务端安装包并一键安装"
                                            >
                                                {needUpdate() ? `更新到 v${BUNDLED_SERVER_VERSION}` : '重新安装'}
                                            </button>
                                        </div>
                                    </Show>
                                    <Show when={c().kind === 'terminal'}>
                                        <div class="ab-row">
                                            <span class="ab-name">终端</span>
                                            <span class="ab-fill" />
                                            <span class="ab-val">{shellLabel()}</span>
                                        </div>
                                    </Show>
                                    <div class="ab-row">
                                        <span class="ab-name">系统</span>
                                        <span class="ab-fill" />
                                        <span class="ab-val">{osLabel()}</span>
                                    </div>
                                    <Show when={c().kind === 'desktop'}>
                                        <div class="ab-row">
                                            <span class="ab-name">桌面环境</span>
                                            <span class="ab-fill" />
                                            <span class="ab-val">{deLabel()}</span>
                                        </div>
                                    </Show>
                                </>
                            )}
                        </Show>
                        {/* 最下方：客户端启动时间 + 日志报告导出（日志只存内存，不写文件） */}
                        <div class="ab-row">
                            <span class="ab-name">客户端启动</span>
                            <span class="ab-ver" title={`启动于 ${fmtDateTime(clientStartedAt())}，已运行 ${runLabel()}`}>
                                {startLabel()}
                            </span>
                            <span class="ab-fill" />
                            <button
                                class="ab-action"
                                disabled={busy()}
                                onClick={() => void saveReport()}
                                title="把内存里的运行日志与 JS 报错导出为文本文件（弹窗选择保存位置）"
                            >
                                生成日志报告
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </Show>
    );
}
