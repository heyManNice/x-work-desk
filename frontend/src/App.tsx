/* App.tsx —— XWorkDesk 桌面客户端主界面（SolidJS）。
 *
 * 布局：
 *   自制标题栏（无边框窗口：Win/Linux 右上三按钮、macOS 左上红黄绿；主题切换）
 *   左侧 连接边栏（localStorage 保存多主机，可新建/编辑/删除）
 *   右侧 标签页工作区（每标签一个独立远程连接会话）
 */

import {
    createSignal, createEffect, createMemo, For, Show,
    onMount, onCleanup, type Accessor,
} from 'solid-js';
import {
    Monitor, Plus, Pencil, Trash2, Minus, Copy, Square, X,
    Sun, Moon, LogOut, Unplug, Link, PanelLeftOpen, PanelLeftClose,
    Maximize2, Minimize2, Terminal as TerminalIcon,
} from 'lucide-solid';
import {
    isMac, winMinimize, winToggleMaximize, winClose,
    winIsMaximized, onWinMaximizeChange,
    winSetFullScreen, winIsFullScreen, onWinFullScreenChange,
    platform, clipWriteText, pingHost,
    sshProbeServer, sshStartServer, sshInstallServer, sshOnInstallProgress,
} from './platform';
import { resolveServer, hostEndpoint, type ServerTarget } from './server';
import { showConfirm } from './modal';
import { sshHostOf, resolveActiveConn, type ActiveConn } from './core/conn';
import type { HostConfig, RatioMode } from './core/host';
import {
    loadHosts, saveHosts, upsertHost, removeHost,
    defaultHost, newId, hostDisplay,
} from './core/host';
import { Session, type SessionState, type SessionStatus } from './core/session';
import { TerminalSession } from './core/termSession';
import { FileButton, FilePanelHost, fmSessionEnded, fmTabDeactivated, type FmCtx } from './core/filemgr';
import { activePopup } from './core/popups';
import { SysCpuButton, SysMemButton, SysCpuPanelHost, SysMemPanelHost } from './core/system';
import { AboutButton, AboutPanelHost, setAboutHost, setAboutInstall } from './core/about';
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

/* macOS：红绿灯在标签栏最左的显现时机 —— 边栏收起动画(0.24s)到 50% 后再出现，
 * 避免与边栏头部红绿灯在收缩过程中叠影 */
const [macBarDots, setMacBarDots] = createSignal(false);
let macBarT: ReturnType<typeof setTimeout> | undefined;
createEffect(() => {
    if (macBarT) { clearTimeout(macBarT); macBarT = undefined; }
    if (isMac() && sbCollapsed()) {
        macBarT = setTimeout(() => { macBarT = undefined; setMacBarDots(true); }, 120);
    } else {
        setMacBarDots(false);
    }
});

/* 全屏状态：Electron 窗口级全屏（DOM 全保留，文件面板/通知/确认框在全屏内仍可用） */
const [fsActive, setFsActive] = createSignal(false);
onWinFullScreenChange((fs) => setFsActive(fs));
void winIsFullScreen().then((fs) => { if (fs) setFsActive(true); });

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

/* 当前激活连接的统一视图：顶栏文件/系统监控与“关于”共用（推导见 core/conn） */
const currentConn = createMemo<ActiveConn | null>(() => {
    const t = tabs().find((x) => x.id === activeId());
    if (!t) return null;
    return resolveActiveConn(t.id, pendingMap.get(t.id));
});

/* 全屏切换：窗口级全屏（沉浸模式，DOM 全保留） */
function toggleFullscreen(): void {
    void winSetFullScreen(!fsActive());
}

/* 退出全屏（断开/注销前调用，避免沉浸全屏下已无活动会话） */
function quitFullscreen(): void {
    if (fsActive()) void winSetFullScreen(false);
}

let tabSeq = 0;

function setHosts(h: HostConfig[]): void {
    setHostsSig(h);
    saveHosts(h);
}

/* ---------------- 主机连通性（延迟 ms，-1=不通/未测；列表点/表格延迟列） ---------------- */
const [reachMap, setReachMap] = createSignal<Record<string, number>>({});

async function pingOne(id: string, host: string): Promise<void> {
    const ep = hostEndpoint(host);
    const ms = ep ? await pingHost(ep.host, ep.port) : -1;
    setReachMap((m) => (m[id] === ms ? m : { ...m, [id]: ms }));
}

/* 启动：对所有已保存主机各 ping 一次 */
void Promise.all(hosts().map((h) => pingOne(h.id, h.host)));

/* 周期刷新连通状态（延迟列/状态点保持较新） */
window.setInterval(() => {
    const list = hosts();
    if (list.length) void Promise.all(list.map((h) => pingOne(h.id, h.host)));
}, 20000);

/* ---------------- 各主机最近一次成功连接时间 ---------------- */
const LASTSEEN_KEY = 'xwd-lastseen';
function loadLastSeen(): Record<string, number> {
    try {
        const o = JSON.parse(localStorage.getItem(LASTSEEN_KEY) || '{}');
        return o && typeof o === 'object' ? (o as Record<string, number>) : {};
    } catch {
        return {};
    }
}
function persistLastSeen(m: Record<string, number>): void {
    try { localStorage.setItem(LASTSEEN_KEY, JSON.stringify(m)); } catch { /* 忽略 */ }
}
const [lastSeen, setLastSeen] = createSignal<Record<string, number>>(loadLastSeen());
function markLastSeen(id: string): void {
    setLastSeen((m) => {
        if (m[id] && Date.now() - m[id] < 30_000) return m; /* 30s 内去重 */
        const n = { ...m, [id]: Date.now() };
        persistLastSeen(n);
        return n;
    });
}
/* 会话首次进入 running 即记为“最近连接” */
const seenRunning = new Set<string>();
createEffect(() => {
    for (const t of tabs()) {
        if (t.status() === 'running' && !seenRunning.has(t.hostId)) {
            seenRunning.add(t.hostId);
            markLastSeen(t.hostId);
        }
    }
});

function fmtLast(ts?: number): string {
    if (!ts) return '—';
    const now = Date.now();
    const diff = now - ts;
    const d = new Date(ts);
    const cur = new Date();
    const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const p = (n: number) => (n < 10 ? '0' + n : '' + n);
    if (diff < 60_000) return '刚刚';
    if (same(d, cur)) return `${p(d.getHours())}:${p(d.getMinutes())}`;
    if (same(d, new Date(now - 86_400_000))) return '昨天';
    return `${d.getMonth() + 1}月${d.getDate()}日`;
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
    const saved = upsertHost(hosts(), d);
    setHosts(saved);
    setEditorOpen(false); /* 保留 data：让收起动画期间面板仍存在 */
    void pingOne(d.id, d.host); /* 新增/编辑后立即探测连通性 */
}

function deleteHostById(id: string): void {
    /* 关闭该主机的所有标签 */
    const victims = tabs().filter((t) => t.hostId === id).map((t) => t.id);
    for (const vid of victims) closeTab(vid);
    setHosts(removeHost(hosts(), id));
    setReachMap((m) => {
        if (!(id in m)) return m;
        const n = { ...m };
        delete n[id];
        return n;
    });
    if (editorOpen() && editorData()?.id === id) setEditorOpen(false);
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

/* “关于”面板的“更新/重新安装”动作：复用 SSH 一键安装服务端流程 */
setAboutInstall((c) => installServerWithProgress({
    host: c.host, port: c.port, user: c.user, pass: c.pass,
}));

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
    fmSessionEnded(id); /* 关闭对应 SFTP 文件会话 */
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

/* “关于”面板上下文：仅当前激活且运行中的会话（桌面/SSH），口径与顶栏一致 */
createEffect(() => {
    const t = tabs().find((x) => x.id === activeId());
    const c = currentConn();
    if (!t || !c || t.status() !== 'running') {
        setAboutHost(null);
        return;
    }
    setAboutHost({
        kind: t.type,
        name: c.name,
        apiBase: c.type === 'desktop' ? c.apiBase : '',
        host: c.sshHost,
        port: c.sshPort,
        user: c.user,
        pass: c.pass,
    });
});

/* 激活标签切换：让文件面板随主机隔离（记住目录并收起旧主机面板） */
let prevActiveTabId: number | null = null;
createEffect(() => {
    const id = activeId();
    if (prevActiveTabId != null && prevActiveTabId !== id) {
        fmTabDeactivated(prevActiveTabId);
    }
    prevActiveTabId = id;
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

/* 主题切换（纯图标，归入纯图标组） */
function ThemeToggle() {
    return (
        <button class="tb-btn" onClick={() => setTheme(theme() === 'dark' ? 'light' : 'dark')} title="切换深色/浅色">
            <Sun class="ico-sun" size={15} />
            <Moon class="ico-moon" size={15} />
        </button>
    );
}

/* macOS 红黄绿灯：展开时在边栏左上角，边栏收起时移到标签栏最左 */
function MacDots() {
    return (
        <div class="tb-macdots">
            <button class="macdot macdot-close" onClick={() => winClose()} title="关闭" />
            <button class="macdot macdot-min" onClick={() => winMinimize()} title="最小化" />
            <button class="macdot macdot-max" onClick={() => winToggleMaximize()} title="最大化" />
        </div>
    );
}

/* 窗口控制：Win/Linux 右上最小化/最大化/关闭（保持现状） */
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
        <div class="tb-winbtns">
            <button class="tb-ctl" onClick={() => onCtl('min')} title="最小化"><Minus size={12} /></button>
            <button class="tb-ctl tb-max-btn" classList={{ 'is-maxed': maxed() }} onClick={() => onCtl('max')} title={maxed() ? '还原' : '最大化'}>
                <Copy class="ico-restore" size={12} />
                <Square class="ico-max" size={11} />
            </button>
            <button class="tb-ctl tb-close" onClick={() => onCtl('close')} title="关闭"><X size={12} /></button>
        </div>
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
                {isMac() ? (
                    <MacDots />
                ) : (
                    <div class="sb-logo" title="XWorkDesk"><Monitor size={16} /><span class="sb-appname">XWorkDesk</span></div>
                )}
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
                            <span class="host-dot" classList={{ up: (reachMap()[h.id] ?? -1) >= 0 }} />
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
    /* 当前活动会话的 SSH 凭据（SFTP 文件面板/系统监控） */
    const fmCtx = (): FmCtx | null => {
        const c = currentConn();
        if (!c) return null;
        return { tabId: c.tabId, host: c.sshHost, port: c.sshPort, user: c.user, pass: c.pass };
    };
    return (
        <div class="tabbar">
            {/* macOS：边栏收起时红绿灯显示在标签栏最左（收起动画约 70% 后再现，避免叠影） */}
            <Show when={isMac() && sbCollapsed() && macBarDots()}>
                <MacDots />
            </Show>
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
            {/* 右侧同排：有文字操作组(最左：文件) + 纯图标组 + 窗口控制（窗口控制固定最右） */}
            <div class="topbar-right">
                <Show when={activeTab()}>
                    {(a) => (
                        <div class="tabbar-actions">
                            <TextActions type={a().type} fm={fmCtx()} />
                        </div>
                    )}
                </Show>
                <div class="tb-icons">
                    <NBell />
                    <AboutButton />
                    <ThemeToggle />
                </div>
                <TopTools />
                {/* macOS：应用名贴标签栏最右（无图标） */}
                <Show when={isMac()}>
                    <div class="tb-applogo" title="XWorkDesk">XWorkDesk</div>
                </Show>
            </div>
        </div>
    );
}

/* 有文字操作组（文件/全屏/断开/注销）：顶栏与全屏悬浮工具栏复用同一组件；
 * 断开/注销前先退出全屏，避免沉浸全屏下已无活动会话。 */
function TextActions(props: { type: ConnKind; fm: FmCtx | null }) {
    return (
        <>
            <Show when={props.fm}>{(c) => <SysCpuButton ctx={c()} />}</Show>
            <Show when={props.fm}>{(c) => <SysMemButton ctx={c()} />}</Show>
            <Show when={props.fm}>{(c) => <FileButton ctx={c()} label="文件" />}</Show>
            <Show when={props.type === 'desktop'}>
                <button class="tab-btn" onClick={toggleFullscreen} title={fsActive() ? '退出全屏' : '全屏显示'}>
                    {fsActive() ? <Minimize2 size={13} /> : <Maximize2 size={13} />} 全屏
                </button>
            </Show>
            <button class="tab-btn" onClick={() => { quitFullscreen(); disconnectActive(); }} title="断开并关闭此标签">
                <Unplug size={13} /> 断开
            </button>
            <Show when={props.type === 'desktop'}>
                <button class="tab-btn danger" onClick={() => { quitFullscreen(); void logoutActive(); }} title="注销远程会话并关闭此标签">
                    <LogOut size={13} /> 注销
                </button>
            </Show>
        </>
    );
}

/* 全屏悬浮工具栏：桌面壳窗口级全屏下，原顶栏/侧栏被隐藏（DOM 全保留），屏幕顶部
 * 常态只露工具栏底部一小截作手柄；hover 手柄展开，文件面板打开期间保持展开不收起。
 * 窗口级全屏不遮断 DOM，点“文件”可直接在全屏里弹出面板，无需退出全屏。 */
function FullscreenBar() {
    const [hovered, setHovered] = createSignal(false);
    const [open, setOpen] = createSignal(false);

    const activeTab = () => tabs().find((x) => x.id === activeId());
    /* 活动会话的 SSH 凭据（SFTP 文件面板/系统监控，与 TabBar 同口径） */
    const fm = (): FmCtx | null => {
        const c = currentConn();
        if (!c) return null;
        return { tabId: c.tabId, host: c.sshHost, port: c.sshPort, user: c.user, pass: c.pass };
    };

    /* 活动标签非桌面会话时兜底退出全屏 */
    createEffect(() => {
        const t = tabs().find((x) => x.id === activeId());
        if (fsActive() && (!t || t.type !== 'desktop')) {
            void winSetFullScreen(false);
        }
    });

    /* 展开态 = hover 工具栏 或 文件面板正打开（点开文件面板期间不收） */
    createEffect(() => {
        setOpen(!!fsActive() && (hovered() || activePopup() === 'file'));
    });

    return (
        <div class="fs-wrap" classList={{ open: open() }}>
            <div class="fs-inner"
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
            >
                <Show when={activeTab()}>
                    {(a) => (
                        <div class="fs-card">
                            <TextActions type={a().type} fm={fm()} />
                        </div>
                    )}
                </Show>
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
                onRequestClose: () => closeTab(props.id),
            });
            sess = s;
            s.connect();
        }
        sessionMap.set(props.id, sess);
        sess.setActive(activeId() === props.id);
    });
    onCleanup(() => {
        const sess = sessionMap.get(props.id);
        if (sess) {
            sess.destroy();
            sessionMap.delete(props.id);
        }
    });
    return (
        <div
            ref={rootEl}
            class="session-view"
            classList={{ active: activeId() === props.id }}
        />
    );
}

/* 延迟格：可达显示绿色毫秒，否则灰色 “—”。
 * 注意：必须在 JSX 响应式位置以 getter 读取 reachMap，
 * 不能在 For 项内先 `const ms = reachMap()[...]` 存快照，否则编译器只执行一次、永不再更新。 */
function LatCell(props: { id: string }) {
    const ms = () => reachMap()[props.id] ?? -1;
    return (
        <span class="hlat" classList={{ up: ms() >= 0 }}>
            {ms() >= 0 ? `${ms()} ms` : '—'}
        </span>
    );
}

/* 收起侧栏时主页的主机列表表格：延迟/名字/用户名/地址/上次连接/操作 */
function HostTable() {
    return (
        <div class="htable-wrap">
            <Show
                when={hosts().length > 0}
                fallback={<div class="htable-empty">还没有保存的主机 —— 点“新建主机”添加一台</div>}
            >
                <table class="htable">
                    <thead>
                        <tr>
                            <th class="hcol-lat">延迟</th>
                            <th>名字</th>
                            <th>用户名</th>
                            <th>地址</th>
                            <th>上次连接</th>
                            <th class="hcol-ops">操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        <For each={hosts()}>
                            {(h) => (
                                <tr
                                    class="hrow"
                                    onClick={() => void connectHost(h)}
                                    onContextMenu={(e) => openHostMenu(e, h)}
                                    title={`连接 ${hostDisplay(h)}`}
                                >
                                    <td class="hcol-lat"><LatCell id={h.id} /></td>
                                    <td class="hcol-name">{h.name || hostDisplay(h)}</td>
                                    <td>{h.user || '—'}</td>
                                    <td class="hcol-addr">{h.host}</td>
                                    <td class="hcol-last">{fmtLast(lastSeen()[h.id])}</td>
                                    <td class="hcol-ops" onClick={(e) => e.stopPropagation()}>
                                        <span class="ht-ops">
                                            <button class="host-op" title="SSH 终端连接" onClick={() => void connectHost(h, 'terminal')}><TerminalIcon size={14} /></button>
                                            <button
                                                class="host-op"
                                                classList={{ disabled: isInstalling(h.id) }}
                                                disabled={isInstalling(h.id)}
                                                title={isInstalling(h.id) ? '正在安装远程桌面服务端…' : '连接远程桌面'}
                                                onClick={() => { if (!isInstalling(h.id)) void connectHost(h, 'desktop'); }}
                                            ><Monitor size={14} /></button>
                                        </span>
                                    </td>
                                </tr>
                            )}
                        </For>
                    </tbody>
                </table>
            </Show>
        </div>
    );
}

function Workspace() {
    return (
        <section class="main">
            <TabBar />
            <div class="workspace">
                <Show when={tabs().length === 0} fallback={<For each={tabs()}>{(t) => <SessionPane id={t.id} />}</For>}>
                    {sbCollapsed() ? (
                        <div class="landing">
                            <div class="empty-logo"><Monitor size={56} /></div>
                            <p class="empty-hint">从左侧选择一个主机开始连接，或新建一个</p>
                            <button class="btn primary" onClick={openEditorForNew}><Plus size={15} /> 新建主机</button>
                            <HostTable />
                        </div>
                    ) : (
                        <div class="empty">
                            <div class="empty-logo"><Monitor size={56} /></div>
                            <p class="empty-hint">从左侧选择一个主机开始连接，或新建一个</p>
                            <button class="btn primary" onClick={openEditorForNew}><Plus size={15} /> 新建主机</button>
                        </div>
                    )}
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
/* 分辨率倍率：真实分辨率 = 所选基础分辨率 × 该倍率（如 1920×1080 × 1/2 → 960×540） */
const SCALE_OPTIONS: string[] = ['1/4', '1/3', '1/2', '2/3', '1', '4/3', '3/2', '2'];
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
    let rScale!: HTMLSelectElement;
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
            scale: rScale.value || '1',
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
        <div class="modal-layer" classList={{ show: editorOpen() }} onPointerDown={(e) => { if (e.target === e.currentTarget) closeEditor(); }}>
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
                                    <label class="field"><span>分辨率倍率</span>
                                        <select ref={rScale} value={h().scale || '1'}>
                                            {SCALE_OPTIONS.map((v) => <option value={v}>{v}</option>)}
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
        <div class="app-shell" classList={{ 'xwd-fs': fsActive() }}>
            <div class="app-body">
                <Sidebar />
                <Workspace />
            </div>
            <Show when={fsActive()}><FullscreenBar /></Show>
            <HostEditor />
            <PasswordDialog />
            <HostContextMenu />
            <NotifyPanelHost />
            <FilePanelHost />
            <SysCpuPanelHost />
            <SysMemPanelHost />
            <AboutPanelHost />
        </div>
    );
}
