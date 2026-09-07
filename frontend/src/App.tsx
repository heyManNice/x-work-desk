/* App.tsx —— XWorkDesk 桌面客户端主界面（SolidJS）。
 *
 * 布局：
 *   自制标题栏（无边框窗口：Win/Linux 右上三按钮、macOS 左上红黄绿；主题切换）
 *   左侧 连接边栏（localStorage 保存多主机，可新建/编辑/删除）
 *   右侧 标签页工作区（每标签一个独立远程连接会话）
 */

import {
    createSignal, createEffect, For, Show,
    onMount, onCleanup, type Accessor,
} from 'solid-js';
import {
    Monitor, Plus, Pencil, Trash2, Minus, Copy, Square, X,
    Sun, Moon, LogOut, Unplug, Link, PanelLeftOpen, PanelLeftClose,
    Maximize2, Minimize2, Terminal as TerminalIcon,
} from 'lucide-solid';
import {
    isMac, winMinimize, winToggleMaximize, winClose,
    winIsMaximized, onWinMaximizeChange, platform, clipWriteText,
    sshProbeServer, sshStartServer, sshInstallServer, sshOnInstallProgress,
} from './platform';
import { resolveServer, type ServerTarget } from './server';
import { showConfirm } from './modal';
import type { HostConfig, RatioMode } from './core/host';
import {
    loadHosts, saveHosts, upsertHost, removeHost,
    defaultHost, newId, hostDisplay,
} from './core/host';
import { Session, type SessionState, type SessionStatus } from './core/session';
import { TerminalSession } from './core/termSession';
import {
    NBell, NotifyPanelHost,
    startTask, patchTask, finishTask,
    notifyInfo, notifySuccess, notifyError,
} from './core/notify';

/* ---------------- 主题 ---------------- */

const THEME_KEY = 'xwd-theme';
type Theme = 'dark' | 'light';

function initTheme(): Theme {
    try {
        const s = localStorage.getItem(THEME_KEY);
        if (s === 'dark' || s === 'light') return s;
    } catch { /* 忽略 */ }
    try {
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch {
        return 'dark';
    }
}

const [theme, setTheme] = createSignal<Theme>(initTheme());

function applyTheme(): void {
    document.documentElement.dataset.theme = theme();
    try { localStorage.setItem(THEME_KEY, theme()); } catch { /* 忽略 */ }
}
createEffect(applyTheme);

/* 平台（标题栏布局）：darwin / win32 / linux */
document.documentElement.dataset.platform = platform();
if (isMac()) document.documentElement.dataset.platform = 'darwin';

/* ---------------- 主机 / 标签 / 会话 ---------------- */

export type ConnKind = 'desktop' | 'terminal';

interface TabRec {
    id: number;
    type: ConnKind;
    hostId: string;
    title: string;
    sub: string;
    status: Accessor<SessionState>;
    setStatus: (s: SessionState) => void;
}

/* 标签会话通用句柄（桌面 Session / SSH 终端共有操作） */
interface ConnSession {
    setActive(on: boolean): void;
    destroy(): void;
    disconnect(): void;
    handleResize(): void;
}

const [hosts, setHostsSig] = createSignal<HostConfig[]>(loadHosts());
const [tabs, setTabsSig] = createSignal<TabRec[]>([]);
const [activeId, setActiveId] = createSignal<number | null>(null);

/* 左侧主机面板展开/收起（记忆） */
const SB_KEY = 'xwd-sidebar-collapsed';
function initSbCollapsed(): boolean {
    try { return localStorage.getItem(SB_KEY) === '1'; } catch { return false; }
}
const [sbCollapsed, setSbCollapsed] = createSignal<boolean>(initSbCollapsed());
createEffect(() => {
    try { localStorage.setItem(SB_KEY, sbCollapsed() ? '1' : '0'); } catch { /* 忽略 */ }
});

/* 全屏状态 */
const [fsActive, setFsActive] = createSignal(false);
document.addEventListener('fullscreenchange', () => {
    setFsActive(document.fullscreenElement != null);
});

const sessionMap = new Map<number, ConnSession>();
const pendingMap = new Map<number, {
    type: ConnKind;
    host: HostConfig;
    target: ServerTarget | null;
    sshHost: string;
    sshPort: number;
    user: string;
    pass: string;
}>();
const tabEls = new Map<number, HTMLElement>();

function activeViewRoot(): HTMLElement | null {
    const id = activeId();
    return id == null ? null : (tabEls.get(id) ?? null);
}

/* 全屏切换（目标=当前激活会话视图，全屏内含顶部悬浮工具条） */
function toggleFullscreen(): void {
    if (document.fullscreenElement) {
        void document.exitFullscreen();
        return;
    }
    const el = activeViewRoot();
    if (el) void el.requestFullscreen();
}

let tabSeq = 0;

function setHosts(h: HostConfig[]): void {
    setHostsSig(h);
    saveHosts(h);
}

/* 窗口 resize → 通知激活会话（auto 分辨率时跟随） */
window.addEventListener('resize', () => {
    const id = activeId();
    if (id != null) sessionMap.get(id)?.handleResize();
});

/* ---------------- 弹窗状态 ---------------- */

/* 主机编辑弹窗：open 驱动常驻层开关动画；data 为当前编辑快照（关闭时保留以播收起动画） */
const [editorOpen, setEditorOpen] = createSignal(false);
const [editorData, setEditorData] = createSignal<HostConfig | null>(null);

const [pw, setPw] = createSignal<{ open: boolean; title: string; label: string }>({
    open: false, title: '', label: '',
});
let passResolver: ((v: string | null) => void) | null = null;

function askPassword(title: string, label: string): Promise<string | null> {
    return new Promise((res) => {
        passResolver = res;
        setPw({ open: true, title, label });
    });
}
function resolvePassword(v: string | null): void {
    passResolver?.(v);
    passResolver = null;
    /* 保留 title/label：收起动画期间面板内容不空白 */
    setPw((p) => ({ ...p, open: false }));
}

/* ---------------- 主机右键菜单 ---------------- */

const [ctxMenu, setCtxMenu] = createSignal<{ x: number; y: number; host: HostConfig } | null>(null);

/* 正在“一键安装远程桌面服务端”的主机 id 集合（安装期间桌面连接置灰防重复） */
const [installingIds, setInstallingIds] = createSignal<Set<string>>(new Set());
function setInstalling(id: string, on: boolean): void {
    setInstallingIds((s) => {
        const n = new Set(s);
        if (on) n.add(id); else n.delete(id);
        return n;
    });
}
function isInstalling(id: string): boolean {
    return installingIds().has(id);
}

/* 菜单打开时：点击任意处 / Esc / 失焦 关闭 */
window.addEventListener('click', () => setCtxMenu(null));
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setCtxMenu(null); });
window.addEventListener('blur', () => setCtxMenu(null));

function openHostMenu(e: MouseEvent, h: HostConfig): void {
    e.preventDefault();
    e.stopPropagation();
    const MW = 176;
    const MH = 262;
    const x = Math.min(Math.max(8, e.clientX), window.innerWidth - MW - 8);
    const y = Math.min(Math.max(8, e.clientY), window.innerHeight - MH - 8);
    setCtxMenu({ x, y, host: h });
}

function ctxDo(fn: (m: { x: number; y: number; host: HostConfig }) => void): void {
    const m = ctxMenu();
    if (!m) return;
    setCtxMenu(null);
    fn(m);
}

async function copyClip(t: string): Promise<void> {
    try { await clipWriteText(t); } catch { /* 忽略 */ }
}

function ctxConnectDesktop(): void {
    ctxDo((m) => { void connectHost(m.host, 'desktop'); });
}
function ctxConnectTerminal(): void {
    ctxDo((m) => { void connectHost(m.host, 'terminal'); });
}
function ctxEdit(): void {
    ctxDo((m) => openEditorEdit(m.host));
}
async function ctxLogout(): Promise<void> {
    const m = ctxMenu();
    if (!m) return;
    setCtxMenu(null);
    const t = tabs().find((x) => x.hostId === m.host.id);
    if (!t) return;
    if (t.type !== 'desktop') {
        /* SSH 终端：无“注销远程会话”，断开并关标签 */
        sessionMap.get(t.id)?.disconnect();
        closeTab(t.id);
        return;
    }
    const s = sessionMap.get(t.id) as Session | undefined;
    if (s) {
        const did = await s.logout();
        if (did) closeTab(t.id);
    }
}
async function ctxCopyName(): Promise<void> {
    ctxDo((m) => { void copyClip(m.host.name || m.host.host); });
}
async function ctxCopyHost(): Promise<void> {
    ctxDo((m) => { void copyClip(m.host.host); });
}
async function ctxDelete(): Promise<void> {
    const m = ctxMenu();
    if (!m) return;
    setCtxMenu(null);
    const ok = await showConfirm(
        '删除主机',
        `确定删除主机“${m.host.name || hostDisplay(m.host)}”吗？\n已打开的连接标签也会一并关闭。`,
    );
    if (ok) deleteHostById(m.host.id);
}

/* ---------------- 动作 ---------------- */

function openEditorForNew(): void {
    setEditorData(defaultHost());
    setEditorOpen(true);
}

function openEditorEdit(h: HostConfig): void {
    setEditorData({ ...h });
    setEditorOpen(true);
}

function saveEditor(d: HostConfig): void {
    const editing = editorData();
    if (!editing) return;
    if (!d.name.trim()) d.name = d.host || '未命名主机';
    d.id = editing.id || newId();
    setHosts(upsertHost(hosts(), d));
    setEditorOpen(false); /* 保留 data：让收起动画期间面板仍存在 */
}

function deleteHostById(id: string): void {
    /* 关闭该主机的所有标签 */
    const victims = tabs().filter((t) => t.hostId === id).map((t) => t.id);
    for (const vid of victims) closeTab(vid);
    setHosts(removeHost(hosts(), id));
    if (editorOpen() && editorData()?.id === id) setEditorOpen(false);
}

/* 从保存的主机地址解析出纯主机名（剥 scheme/端口），SSH 走 22 端口 */
function sshHostOf(h: HostConfig): string {
    let hp = (h.host || '').trim();
    const s = /^[a-z][a-z0-9+.-]*:\/\//i.exec(hp);
    if (s) hp = hp.slice(s[0].length);
    hp = hp.replace(/\/+$/, '');
    const c = hp.lastIndexOf(':');
    if (c > 0 && /^\d+$/.test(hp.slice(c + 1))) hp = hp.slice(0, c);
    return hp || 'localhost';
}

/* 桌面连接前：经 SSH 探测远端服务端，未装/停止则引导一键安装/启动。
/* 一键安装（经通知中心反馈进度）：主进程 xwd:ssh:install-progress → 进度条/阶段文案 */
async function installServerWithProgress(opt: { host: string; port: number; user: string; pass?: string }) {
    const id = startTask('正在安装服务端', '准备连接…');
    const off = sshOnInstallProgress((p) => {
        patchTask(id, { pct: p.pct, label: p.label });
    });
    try {
        const r = await sshInstallServer(opt);
        if (r.ok) {
            finishTask(id, true, { title: '服务端安装完成', body: 'XWorkDesk 服务端已就绪。' });
        } else {
            finishTask(id, false, { title: '服务端安装失败', body: r.msg || '未知错误' });
        }
        return r;
    } catch (e) {
        const em = e instanceof Error ? e.message : String(e);
        finishTask(id, false, { title: '服务端安装失败', body: em });
        return { ok: false, msg: em };
    } finally {
        off();
    }
}

/* 桌面连接前：经 SSH 探测远端服务端，未装/停止则引导一键安装/启动。
 * 返回 false 表示用户取消/失败（终止连接）。 */
async function ensureServerReady(h: HostConfig, pass: string): Promise<boolean> {
    const opt = { host: sshHostOf(h), port: 22, user: h.user, pass };
    const probe = await sshProbeServer(opt);
    if (!probe.ok || probe.status === 'unreachable') {
        /* SSH 不通：可能服务端已直接开放端口，交给 ws 直连尝试 */
        return true;
    }
    if (probe.status === 'running') return true;

    if (probe.status === 'stopped') {
        const go = await showConfirm(
            '服务端已停止',
            `远端已安装 XWorkDesk 服务端，但当前未运行。\n\n是否通过 SSH 启动它？`,
        );
        if (!go) return false;
        const st = await sshStartServer(opt);
        if (st.ok) {
            notifySuccess('服务端已启动', `${hostDisplay(h)} 的 XWorkDesk 服务端已恢复运行。`);
            return true;
        }
        const hint = st.needSudo
            ? `远端账号缺少 sudo 权限，无法自动启动。\n\n请让管理员执行：\nsudo visudo 添加  ${opt.user} ALL=(ALL:ALL) ALL\n或运行  sudo usermod -aG sudo ${opt.user}\n授权后重试。`
            : '请检查 sudo 密码 / 远端状态。';
        notifyError('启动失败', `${st.msg || '未知错误'}\n\n${hint}`);
        return false;
    }

    /* not_installed */
    const go = await showConfirm(
        '远程桌面',
        `未检测到该主机的远程桌面服务端（XWorkDesk Server）。\n\n是否通过 SSH 一键安装？\n（需要远端账号可 sudo、可联网安装依赖；目标应为可运行 GNOME 的桌面主机）`,
    );
    if (!go) return false;
    setInstalling(h.id, true); /* 安装期间该主机桌面入口置灰防重复 */
    try {
        const inst = await installServerWithProgress(opt);
        if (!inst.ok) {
            if (inst.needSudo) {
                notifyError('远程桌面服务端安装失败', `远端账号缺少 sudo 权限，无法自动安装。\n\n请让该主机管理员执行：\n1) sudo visudo 添加  ${opt.user} ALL=(ALL:ALL) ALL\n2) 或运行  sudo usermod -aG sudo ${opt.user}\n\n授权后重新连接即可一键安装。`);
            }
            return false;
        }
        const after = await sshProbeServer(opt);
        if (after.ok && after.status === 'running') {
            notifySuccess('远程桌面服务端已就绪', `${hostDisplay(h)} 的远程桌面服务端已安装并运行，正在连接…`);
            return true;
        }
        notifyError('安装后未就绪', '服务未能启动，请到远端查看：journalctl -u xworkd -n 50');
        return false;
    } finally {
        setInstalling(h.id, false);
    }
}

/* 点击主机：建立/激活连接（kind=desktop 桌面远程 / terminal SSH 终端） */
async function connectHost(h: HostConfig, kind: ConnKind = 'desktop'): Promise<void> {
    /* 该主机正在一键安装服务端：桌面连接暂不可用，避免重复安装 */
    if (kind === 'desktop' && isInstalling(h.id)) {
        notifyInfo('正在安装远程桌面服务端', `${h.name || hostDisplay(h)} 的服务端正在安装，请稍候…`);
        return;
    }
    /* 已打开的标签里有同类型连接在跑 → 直接激活 */
    const ex = tabs().find((t) => t.hostId === h.id && t.type === kind);
    if (ex) {
        setActiveId(ex.id);
        return;
    }

    let target: ServerTarget | null = null;
    if (kind === 'desktop') {
        target = resolveServer(h.host);
        if (!target) {
            setEditorData({ ...h }); /* 地址无效：打开编辑 */
            setEditorOpen(true);
            return;
        }
    }

    let pass = h.pass || '';
    if (!pass) {
        const label = kind === 'terminal'
            ? `SSH 连接 ${hostDisplay(h)}`
            : `连接 ${hostDisplay(h)}`;
        const p = await askPassword(
            label,
            `请输入 ${h.user || ''} 的密码（此主机未保存密码）：`,
        );
        if (p === null) return; /* 用户取消 */
        pass = p;
    }

    /* 桌面远程：先经 SSH 探测服务端，未装/停止则引导安装/启动 */
    if (kind === 'desktop') {
        const ready = await ensureServerReady(h, pass);
        if (!ready) return;
    }

    /* 再次检查（等待期间可能已打开） */
    const ex2 = tabs().find((t) => t.hostId === h.id && t.type === kind);
    if (ex2) { setActiveId(ex2.id); return; }

    const id = ++tabSeq;
    const [st, setSt] = createSignal<SessionState>('connecting');
    const sshPort = 22;
    const rec: TabRec = {
        id,
        type: kind,
        hostId: h.id,
        title: h.name || hostDisplay(h),
        sub: hostDisplay(h),
        status: st,
        setStatus: (s: SessionState) => setSt(s),
    };
    pendingMap.set(id, {
        type: kind,
        host: { ...h },
        target,
        sshHost: kind === 'terminal' ? sshHostOf(h) : '',
        sshPort,
        user: h.user,
        pass,
    });
    setTabsSig([...tabs(), rec]);
    setActiveId(id);
}

function closeTab(id: number): void {
    sessionMap.get(id)?.destroy();
    sessionMap.delete(id);
    pendingMap.delete(id);
    const next = tabs().filter((t) => t.id !== id);
    setTabsSig(next);
    if (activeId() === id) {
        setActiveId(next.length ? next[next.length - 1].id : null);
    }
}

function activateTab(id: number): void {
    setActiveId(id);
}

/* 激活会话切换：输入/音频/剪贴板仅作用于激活标签 */
createEffect(() => {
    const id = activeId();
    sessionMap.forEach((s, tid) => s.setActive(tid === id));
});

/* 侧栏展开/收起、进入/退出全屏都会改变会话可视区 → auto 分辨率需向远程更新 */
createEffect(() => {
    void sbCollapsed();
    void fsActive();
    const t = window.setTimeout(() => {
        const id = activeId();
        if (id != null) sessionMap.get(id)?.handleResize();
    }, 340);
    return () => window.clearTimeout(t);
});

/* 断开：断开连接并清除当前标签 */
function disconnectActive(): void {
    const id = activeId();
    if (id == null) return;
    sessionMap.get(id)?.disconnect();
    closeTab(id);
}

/* 注销：仅桌面远程会话支持（销毁远程桌面）；SSH 终端直接断开并关标签 */
async function logoutActive(): Promise<void> {
    const id = activeId();
    if (id == null) return;
    const tab = tabs().find((t) => t.id === id);
    if (!tab) return;
    if (tab.type !== 'desktop') {
        disconnectActive();
        return;
    }
    const s = sessionMap.get(id) as Session | undefined;
    if (!s) { closeTab(id); return; }
    const did = await s.logout();
    if (did) closeTab(id);
}

/* ---------------- 组件：标题栏 ---------------- */

/* 顶部工具：主题 + 窗口控制（并入右侧顶栏，与标签/操作同一行） */
function TopTools() {
    const [maxed, setMaxed] = createSignal(false);
    onMount(() => {
        void winIsMaximized().then(setMaxed);
        return onWinMaximizeChange((m) => setMaxed(m));
    });
    const onCtl = (act: string) => {
        if (act === 'min') winMinimize();
        else if (act === 'max') winToggleMaximize();
        else if (act === 'close') winClose();
    };
    return (
        <>
            <button class="tb-btn" onClick={() => setTheme(theme() === 'dark' ? 'light' : 'dark')} title="切换深色/浅色">
                <Sun class="ico-sun" size={15} />
                <Moon class="ico-moon" size={15} />
            </button>
            <div class="tb-winbtns">
                <button class="tb-ctl" onClick={() => onCtl('min')} title="最小化"><Minus size={12} /></button>
                <button class="tb-ctl tb-max-btn" classList={{ 'is-maxed': maxed() }} onClick={() => onCtl('max')} title={maxed() ? '还原' : '最大化'}>
                    <Copy class="ico-restore" size={12} />
                    <Square class="ico-max" size={11} />
                </button>
                <button class="tb-ctl tb-close" onClick={() => onCtl('close')} title="关闭"><X size={12} /></button>
            </div>
            <div class="tb-macdots">
                <button class="macdot macdot-close" onClick={() => winClose()} title="关闭" />
                <button class="macdot macdot-min" onClick={() => winMinimize()} title="最小化" />
                <button class="macdot macdot-max" onClick={() => winToggleMaximize()} title="最大化" />
            </div>
        </>
    );
}

/* ---------------- 组件：左侧边栏 ---------------- */

function Sidebar() {
    const activeHostId = () => {
        const id = activeId();
        return id == null ? null : tabs().find((t) => t.id === id)?.hostId ?? null;
    };
    return (
        <aside class="sidebar" classList={{ collapsed: sbCollapsed() }}>
            <div class="sidebar-head">
                <div class="sb-logo" title="XWorkDesk"><Monitor size={16} /><span class="sb-appname">XWorkDesk</span></div>
                <div class="sb-head-right">
                    <button class="icon-btn" onClick={openEditorForNew} title="新建主机"><Plus size={16} /></button>
                    <button
                        class="icon-btn"
                        onClick={() => setSbCollapsed(true)}
                        title="收起主机面板"
                    >
                        <PanelLeftClose size={15} />
                    </button>
                </div>
            </div>
            <ul class="host-list">
                <For each={hosts()}>
                    {(h) => (
                        <li
                            class="host-item"
                            classList={{ active: activeHostId() === h.id, installing: isInstalling(h.id) }}
                            onClick={() => void connectHost(h)}
                            onContextMenu={(e) => openHostMenu(e, h)}
                        >
                            <span class="host-dot" />
                            <div class="host-line" title={hostDisplay(h)}>
                                <span class="host-name">{h.name || hostDisplay(h)}</span>
                                <span class="host-addr-inline">{hostDisplay(h)}</span>
                            </div>
                            <div class="host-ops">
                                <button class="host-op" title="SSH 终端连接" onClick={(e) => { e.stopPropagation(); void connectHost(h, 'terminal'); }}><TerminalIcon size={14} /></button>
                                <button
                                    class="host-op"
                                    classList={{ disabled: isInstalling(h.id) }}
                                    title={isInstalling(h.id) ? '正在安装远程桌面服务端…' : '连接远程桌面'}
                                    disabled={isInstalling(h.id)}
                                    onClick={(e) => { e.stopPropagation(); if (!isInstalling(h.id)) void connectHost(h, 'desktop'); }}
                                ><Monitor size={14} /></button>
                            </div>
                        </li>
                    )}
                </For>
                <Show when={hosts().length === 0}>
                    <div style={{ 'text-align': 'center', 'padding': '16px 8px', color: 'var(--text-faint)' }}>
                        还没有保存的主机
                    </div>
                </Show>
            </ul>
            <div class="sidebar-foot">
                <span>共 {hosts().length} 台主机</span>
            </div>
        </aside>
    );
}

/* ---------------- 组件：标签 + 会话视图 ---------------- */

function TabBar() {
    const activeTab = () => tabs().find((x) => x.id === activeId());
    return (
        <div class="tabbar">
            {/* 收起时：标签栏最左的展开按钮 */}
            <Show when={sbCollapsed()}>
                <button class="tab-toggle" onClick={() => setSbCollapsed(false)} title="展开主机面板">
                    <PanelLeftOpen size={15} />
                </button>
            </Show>
            <div class="tab-list">
                <For each={tabs()}>
                    {(t) => (
                        <div
                            class="tab"
                            classList={{ active: t.id === activeId() }}
                            onClick={() => activateTab(t.id)}
                        >
                            <span class="tab-state" classList={{ [t.status()]: true }} />
                            {t.type === 'terminal' ? <TerminalIcon size={12} class="tab-type-icon" /> : <Monitor size={12} class="tab-type-icon" />}
                            <span class="tab-label" title={t.sub}>{t.title}</span>
                            <button
                                class="tab-close"
                                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                                title="关闭标签"
                            >
                                <X size={12} />
                            </button>
                        </div>
                    )}
                </For>
            </div>
            {/* 右侧同排：全屏/断开/注销(按会话类型) + 主题 + 窗口控制 */}
            <div class="topbar-right">
                <Show when={activeTab()}>
                    {(a) => (
                        <div class="tabbar-actions">
                            <Show when={a().type === 'desktop'}>
                                <button class="tab-btn" onClick={toggleFullscreen} title={fsActive() ? '退出全屏' : '全屏显示'}>
                                    {fsActive() ? <Minimize2 size={13} /> : <Maximize2 size={13} />} 全屏
                                </button>
                            </Show>
                            <button class="tab-btn" onClick={disconnectActive} title="断开并关闭此标签">
                                <Unplug size={13} /> 断开
                            </button>
                            <Show when={a().type === 'desktop'}>
                                <button class="tab-btn danger" onClick={() => void logoutActive()} title="注销远程会话并关闭此标签">
                                    <LogOut size={13} /> 注销
                                </button>
                            </Show>
                        </div>
                    )}
                </Show>
                <NBell />
                <TopTools />
            </div>
        </div>
    );
}

function SessionPane(props: { id: number }) {
    let rootEl: HTMLDivElement | undefined;
    onMount(() => {
        const pend = pendingMap.get(props.id);
        const rec = tabs().find((t) => t.id === props.id);
        if (!pend || !rec || !rootEl) return;
        tabEls.set(props.id, rootEl);

        let sess: ConnSession;
        if (pend.type === 'terminal') {
            /* SSH 终端 */
            const ts = new TerminalSession(String(props.id), {
                root: rootEl,
                host: pend.sshHost,
                port: pend.sshPort,
                user: pend.user,
                pass: pend.pass,
                onStatus: (s: SessionStatus) => rec.setStatus(s.state),
            });
            sess = ts;
            void ts.connect();
        } else {
            /* 桌面远程 */
            const s = new Session(String(props.id), {
                root: rootEl,
                host: pend.host,
                target: pend.target!,
                user: pend.user,
                pass: pend.pass,
                onStatus: (s: SessionStatus) => rec.setStatus(s.state),
            });
            sess = s;
            s.connect();
        }
        sessionMap.set(props.id, sess);
        sess.setActive(activeId() === props.id);

        /* 全屏悬浮工具条：仅桌面远程（全屏时鼠标移到顶部中央出现“退出全屏”） */
        if (pend.type !== 'terminal') {
            const fsBar = document.createElement('div');
            fsBar.className = 'fs-toolbar';
            fsBar.hidden = true;
            const btnFs = document.createElement('button');
            btnFs.className = 'btn primary';
            btnFs.textContent = '退出全屏';
            btnFs.addEventListener('click', () => {
                if (document.fullscreenElement) void document.exitFullscreen();
            });
            fsBar.appendChild(btnFs);
            rootEl.appendChild(fsBar);
            rootEl.addEventListener('mousemove', (e) => {
                if (document.fullscreenElement === rootEl) fsBar.hidden = !(e.clientY < 70);
            });
            rootEl.addEventListener('mouseleave', () => { fsBar.hidden = true; });
            document.addEventListener('fullscreenchange', function onFs() {
                if (document.fullscreenElement !== rootEl) fsBar.hidden = true;
            });
        }
    });
    onCleanup(() => {
        const sess = sessionMap.get(props.id);
        if (sess) {
            sess.destroy();
            sessionMap.delete(props.id);
        }
        tabEls.delete(props.id);
    });
    return (
        <div
            ref={rootEl}
            class="session-view"
            classList={{ active: activeId() === props.id }}
        />
    );
}

function Workspace() {
    return (
        <section class="main">
            <TabBar />
            <div class="workspace">
                <Show when={tabs().length === 0} fallback={<For each={tabs()}>{(t) => <SessionPane id={t.id} />}</For>}>
                    <div class="empty">
                        <div class="empty-logo"><Monitor size={56} /></div>
                        <p class="empty-hint">从左侧选择一个主机开始连接，或新建一个</p>
                        <button class="btn primary" onClick={openEditorForNew}><Plus size={15} /> 新建主机</button>
                    </div>
                </Show>
            </div>
        </section>
    );
}

/* ---------------- 组件：主机编辑弹窗 ---------------- */

const RES_OPTIONS = [
    ['auto', '自动（跟随窗口）'], ['3840x2160', '4K 3840×2160'], ['2560x1440', '2K 2560×1440'],
    ['1920x1080', '1080P 1920×1080'], ['1280x720', '720P 1280×720'],
] as const;
const RATIO_OPTIONS: Array<[RatioMode, string]> = [
    ['fit', '适应（等比居中）'], ['stretch', '拉伸填充'], ['pixel', '点对点'],
];
const BITRATE_OPTIONS: Array<[number, string]> = [
    [0, '自动'], [1000, '1 Mbps'], [2000, '2 Mbps'], [4000, '4 Mbps'], [8000, '8 Mbps'], [16000, '16 Mbps'],
];
const FPS_OPTIONS: Array<[number, string]> = [[30, '30 FPS'], [15, '15 FPS'], [60, '60 FPS']];
const QUALITY_OPTIONS: Array<[number, string]> = [
    [23, '默认'], [28, '最差（更流畅）'], [25, '较低'], [18, '较高'], [0, '无损'],
];

function HostEditor() {
    const editing = () => editorData();
    const closeEditor = () => setEditorOpen(false);
    const isNew = () => !editing()?.id;
    let rName!: HTMLInputElement;
    let rHost!: HTMLInputElement;
    let rUser!: HTMLInputElement;
    let rPass!: HTMLInputElement;
    let rRes!: HTMLSelectElement;
    let rRatio!: HTMLSelectElement;
    let rBitrate!: HTMLSelectElement;
    let rFps!: HTMLSelectElement;
    let rQuality!: HTMLSelectElement;
    let rAudio!: HTMLInputElement;
    let rClip!: HTMLInputElement;
    let rAnim!: HTMLInputElement;
    let rStatic!: HTMLInputElement;
    let rDebug!: HTMLInputElement;
    let errEl!: HTMLDivElement;

    const collect = (): HostConfig | null => {
        const h = editing()!;
        if (!rHost.value.trim()) {
            errEl.textContent = '请填写服务器地址';
            errEl.hidden = false;
            return null;
        }
        errEl.hidden = true;
        const num = (s: string, def: number) => {
            const n = Number(s);
            return Number.isFinite(n) ? n : def;
        };
        return {
            ...h,
            name: rName.value.trim(),
            host: rHost.value.trim(),
            user: rUser.value.trim(),
            pass: rPass.value.trim(),
            res: rRes.value,
            ratio: rRatio.value as RatioMode,
            bitrate: num(rBitrate.value, 0),
            fps: num(rFps.value, 30),
            quality: num(rQuality.value, 23),
            audio: rAudio.checked,
            clipboard: rClip.checked,
            anim: rAnim.checked,
            staticSkip: rStatic.checked,
            debug: rDebug.checked,
        };
    };

    const submit = () => {
        const d = collect();
        if (d) saveEditor(d);
    };

    return (
        <div class="modal-layer" classList={{ show: editorOpen() }} onClick={(e) => { if (e.target === e.currentTarget) closeEditor(); }}>
            <Show when={editing()}>
                {(h) => (
                    <div class="modal-panel" onClick={(e) => e.stopPropagation()}>
                        <div class="mp-head">
                            <span class="mp-title">{isNew() ? '新建主机' : '编辑主机'}</span>
                            <button class="mp-x" onClick={closeEditor}><X size={13} /></button>
                        </div>
                        <div class="mp-body">
                            <div class="he-grid he-grid-basic">
                                <label class="field">
                                    <span>名称</span>
                                    <input ref={rName} value={h().name} placeholder="例如：工作电脑 / 家里服务器" />
                                </label>
                                <label class="field">
                                    <span>服务器地址</span>
                                    <input ref={rHost} value={h().host} placeholder="host[:端口]，如 192.168.1.10 或 :5268" />
                                </label>
                            </div>
                            <div class="he-grid">
                                <label class="field">
                                    <span>用户名</span>
                                    <input ref={rUser} value={h().user} placeholder="远程系统用户名" />
                                </label>
                                <label class="field">
                                    <span>密码</span>
                                    <input ref={rPass} type="password" value={h().pass ?? ''} placeholder="可选，留空则连接时询问" />
                                </label>
                            </div>
                            <details class="he-adv" open>
                                <summary>连接配置</summary>
                                <div class="he-grid">
                                    <label class="field"><span>分辨率</span>
                                        <select ref={rRes} value={h().res}>
                                            {RES_OPTIONS.map(([v, t]) => <option value={v}>{t}</option>)}
                                        </select>
                                    </label>
                                    <label class="field"><span>画面比例</span>
                                        <select ref={rRatio} value={h().ratio}>
                                            {RATIO_OPTIONS.map(([v, t]) => <option value={v}>{t}</option>)}
                                        </select>
                                    </label>
                                    <label class="field"><span>码率</span>
                                        <select ref={rBitrate} value={String(h().bitrate)}>
                                            {BITRATE_OPTIONS.map(([v, t]) => <option value={String(v)}>{t}</option>)}
                                        </select>
                                    </label>
                                    <label class="field"><span>帧率</span>
                                        <select ref={rFps} value={String(h().fps)}>
                                            {FPS_OPTIONS.map(([v, t]) => <option value={String(v)}>{t}</option>)}
                                        </select>
                                    </label>
                                    <label class="field"><span>画质</span>
                                        <select ref={rQuality} value={String(h().quality)}>
                                            {QUALITY_OPTIONS.map(([v, t]) => <option value={String(v)}>{t}</option>)}
                                        </select>
                                    </label>
                                </div>
                                <div class="he-checks">
                                    <label class="chk"><input ref={rAudio} type="checkbox" checked={h().audio} /> 传输音频</label>
                                    <label class="chk"><input ref={rClip} type="checkbox" checked={h().clipboard} /> 共享剪贴板</label>
                                    <label class="chk"><input ref={rAnim} type="checkbox" checked={h().anim} /> 桌面动画</label>
                                    <label class="chk"><input ref={rStatic} type="checkbox" checked={h().staticSkip} /> 静态帧优化</label>
                                    <label class="chk"><input ref={rDebug} type="checkbox" checked={h().debug} /> 显示调试信息</label>
                                </div>
                            </details>
                            <div class="he-error" ref={errEl} hidden />
                        </div>
                        <div class="mp-foot">
                            <Show when={!isNew()}>
                                <button class="btn danger" onClick={() => { const id = h().id; deleteHostById(id); }}>删除</button>
                            </Show>
                            <span class="mp-spacer" />
                            <button class="btn" onClick={closeEditor}>取消</button>
                            <button class="btn primary" onClick={submit}>保存</button>
                        </div>
                    </div>
                )}
            </Show>
        </div>
    );
}

/* ---------------- 组件：主机右键菜单 ---------------- */

function HostContextMenu() {
    const m = () => ctxMenu();
    return (
        <Show when={m()}>
            <div class="ctx-menu" role="menu" style={{ left: `${m()!.x}px`, top: `${m()!.y}px` }}>
                <div class="ctx-arrow" />
                <button
                    class="ctx-item"
                    disabled={m() ? isInstalling(m()!.host.id) : false}
                    onClick={ctxConnectDesktop}
                ><Monitor size={13} /> 连接远程桌面</button>
                <button class="ctx-item" onClick={ctxConnectTerminal}><TerminalIcon size={13} /> 连接 SSH</button>
                <button class="ctx-item" onClick={() => void ctxLogout()}><LogOut size={13} /> 注销</button>
                <button class="ctx-item" onClick={ctxEdit}><Pencil size={13} /> 编辑</button>
                <div class="ctx-sep" />
                <button class="ctx-item" onClick={() => void ctxCopyName()}><Copy size={13} /> 复制名字</button>
                <button class="ctx-item" onClick={() => void ctxCopyHost()}><Link size={13} /> 复制 IP</button>
                <div class="ctx-sep" />
                <button class="ctx-item danger" onClick={() => void ctxDelete()}><Trash2 size={13} /> 删除</button>
            </div>
        </Show>
    );
}

/* ---------------- 组件：密码询问 ---------------- */

function PasswordDialog() {
    let input!: HTMLInputElement;
    createEffect(() => {
        if (pw().open) {
            requestAnimationFrame(() => {
                if (input) {
                    input.value = '';
                    input.focus();
                }
            });
        }
    });
    const submit = () => {
        const v = input.value;
        resolvePassword(v.length ? v : null);
    };
    return (
        <div class="modal-layer" classList={{ show: pw().open }}>
            <div class="modal-panel modal-small">
                <div class="mp-head"><span class="mp-title">{pw().title}</span></div>
                <div class="mp-body">
                    <div class="modal-text">{pw().label}</div>
                    <input
                        ref={input}
                        type="password"
                        placeholder="输入密码"
                        autocomplete="off"
                        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') resolvePassword(null); }}
                        style={{ height: '32px', padding: '0 10px', 'border-radius': '8px', background: 'var(--field-bg)', color: 'var(--text)', outline: 'none', 'font-size': '13px' }}
                    />
                </div>
                <div class="mp-foot">
                    <button class="btn" onClick={() => resolvePassword(null)}>取消</button>
                    <span class="mp-spacer" />
                    <button class="btn primary" onClick={submit}>连接</button>
                </div>
            </div>
        </div>
    );
}

/* ---------------- 根组件 ---------------- */

export default function App() {
    return (
        <div class="app-shell">
            <div class="app-body">
                <Sidebar />
                <Workspace />
            </div>
            <HostEditor />
            <PasswordDialog />
            <HostContextMenu />
            <NotifyPanelHost />
        </div>
    );
}
