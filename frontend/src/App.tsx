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
    isMac, winMinimize, winToggleMaximize, winClose,
    winIsMaximized, onWinMaximizeChange, platform,
} from './platform';
import { resolveServer, type ServerTarget } from './server';
import type { HostConfig, RatioMode } from './core/host';
import {
    loadHosts, saveHosts, upsertHost, removeHost,
    defaultHost, newId, hostDisplay,
} from './core/host';
import { Session, type SessionState, type SessionStatus } from './core/session';

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

interface TabRec {
    id: number;
    hostId: string;
    title: string;
    sub: string;
    status: Accessor<SessionState>;
    setStatus: (s: SessionState) => void;
}

const [hosts, setHostsSig] = createSignal<HostConfig[]>(loadHosts());
const [tabs, setTabsSig] = createSignal<TabRec[]>([]);
const [activeId, setActiveId] = createSignal<number | null>(null);

const sessionMap = new Map<number, Session>();
const pendingMap = new Map<number, {
    host: HostConfig; target: ServerTarget; user: string; pass: string;
}>();

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

const [editor, setEditor] = createSignal<{ open: boolean; editing: HostConfig | null }>({
    open: false, editing: null,
});

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
    setPw({ open: false, title: '', label: '' });
}

/* ---------------- 动作 ---------------- */

function openEditorForNew(): void {
    setEditor({ open: true, editing: defaultHost() });
}

function openEditorEdit(h: HostConfig): void {
    setEditor({ open: true, editing: { ...h } });
}

function saveEditor(d: HostConfig): void {
    const editing = editor().editing;
    if (!editing) return;
    if (!d.name.trim()) d.name = d.host || '未命名主机';
    d.id = editing.id || newId();
    setHosts(upsertHost(hosts(), d));
    setEditor({ open: false, editing: null });
}

function deleteHostById(id: string): void {
    /* 关闭该主机的所有标签 */
    const victims = tabs().filter((t) => t.hostId === id).map((t) => t.id);
    for (const vid of victims) closeTab(vid);
    setHosts(removeHost(hosts(), id));
    if (editor().open && editor().editing?.id === id) setEditor({ open: false, editing: null });
}

/* 点击主机：建立/激活连接 */
async function connectHost(h: HostConfig): Promise<void> {
    /* 已打开的标签里有同主机正在跑 → 直接激活 */
    const ex = tabs().find((t) => t.hostId === h.id);
    if (ex) {
        setActiveId(ex.id);
        return;
    }
    const target = resolveServer(h.host);
    if (!target) {
        setEditor({ open: true, editing: { ...h } }); /* 地址无效：打开编辑 */
        return;
    }
    let pass = h.pass || '';
    if (!pass) {
        const p = await askPassword(
            `连接 ${hostDisplay(h)}`,
            `请输入 ${h.user || ''} 的密码（此主机未保存密码）：`,
        );
        if (p === null) return; /* 用户取消 */
        pass = p;
    }
    /* 再次检查（等待期间可能已打开） */
    const ex2 = tabs().find((t) => t.hostId === h.id);
    if (ex2) { setActiveId(ex2.id); return; }

    const id = ++tabSeq;
    const [st, setSt] = createSignal<SessionState>('connecting');
    const rec: TabRec = {
        id,
        hostId: h.id,
        title: h.name || hostDisplay(h),
        sub: hostDisplay(h),
        status: st,
        setStatus: (s: SessionState) => setSt(s),
    };
    pendingMap.set(id, { host: { ...h }, target, user: h.user, pass });
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

/* ---------------- 图标 ---------------- */

const IconPlay = () => (<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>);
const IconEdit = () => (<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>);
const IconTrash = () => (<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6M10 11v6M14 11v6" /></svg>);
const IconPlus = () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>);
const IconClose = () => (<svg viewBox="0 0 12 12" width="11" height="11"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /></svg>);
const IconDesktop = () => (<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2.5" /><path d="M8 21h8M12 17v4" /></svg>);

/* ---------------- 组件：标题栏 ---------------- */

function TitleBar() {
    const [maxed, setMaxed] = createSignal(false);
    onMount(() => {
        void winIsMaximized().then(setMaxed);
        return onWinMaximizeChange((m) => setMaxed(m));
    });
    const cur = () => {
        const t = tabs().find((x) => x.id === activeId());
        return t ? t.sub : '';
    };
    const onCtl = (act: string) => {
        if (act === 'min') winMinimize();
        else if (act === 'max') winToggleMaximize();
        else if (act === 'close') winClose();
    };
    return (
        <header class="titlebar">
            <div class="tb-group tb-left">
                <div class="tb-macdots">
                    <button class="macdot macdot-close" onClick={() => winClose()} title="关闭" />
                    <button class="macdot macdot-min" onClick={() => winMinimize()} title="最小化" />
                    <button class="macdot macdot-max" onClick={() => winToggleMaximize()} title="最大化" />
                </div>
                <div class="tb-logo"><IconDesktop /></div>
                <span class="tb-appname">XWorkDesk</span>
            </div>
            <div class="tb-group tb-center"><span class="tb-current">{cur()}</span></div>
            <div class="tb-group tb-right">
                <button class="tb-btn" onClick={() => setTheme(theme() === 'dark' ? 'light' : 'dark')} title="切换深色/浅色">
                    <svg class="ico-sun" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.5" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
                    <svg class="ico-moon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
                </button>
                <div class="tb-winbtns">
                    <button class="tb-ctl" onClick={() => onCtl('min')} title="最小化">
                        <svg viewBox="0 0 12 12" width="11" height="11"><path d="M1 6h10" stroke="currentColor" stroke-width="1.1" /></svg>
                    </button>
                    <button class="tb-ctl tb-max-btn" classList={{ 'is-maxed': maxed() }} onClick={() => onCtl('max')} title={maxed() ? '还原' : '最大化'}>
                        <svg class="ico-restore" viewBox="0 0 12 12" width="11" height="11"><path d="M4 2.5h5.5V8M2.5 4h5.5v5.5" fill="none" stroke="currentColor" stroke-width="1.1" /></svg>
                        <svg class="ico-max" viewBox="0 0 12 12" width="11" height="11"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.1" /></svg>
                    </button>
                    <button class="tb-ctl tb-close" onClick={() => onCtl('close')} title="关闭">
                        <IconClose />
                    </button>
                </div>
            </div>
        </header>
    );
}

/* ---------------- 组件：左侧边栏 ---------------- */

function Sidebar() {
    const activeHostId = () => {
        const id = activeId();
        return id == null ? null : tabs().find((t) => t.id === id)?.hostId ?? null;
    };
    return (
        <aside class="sidebar">
            <div class="sidebar-head">
                <span class="sidebar-title">连接</span>
                <button class="icon-btn" onClick={openEditorForNew} title="新建主机"><IconPlus /></button>
            </div>
            <ul class="host-list">
                <For each={hosts()}>
                    {(h) => (
                        <li
                            class="host-item"
                            classList={{ active: activeHostId() === h.id }}
                            onClick={() => void connectHost(h)}
                        >
                            <span class="host-dot" />
                            <div class="host-meta">
                                <div class="host-name">{h.name || hostDisplay(h)}</div>
                                <div class="host-addr">{hostDisplay(h)}</div>
                            </div>
                            <div class="host-ops">
                                <button class="host-op" title="连接" onClick={(e) => { e.stopPropagation(); void connectHost(h); }}><IconPlay /></button>
                                <button class="host-op" title="编辑" onClick={(e) => { e.stopPropagation(); openEditorEdit(h); }}><IconEdit /></button>
                                <button class="host-op del" title="删除" onClick={(e) => { e.stopPropagation(); deleteHostById(h.id); }}><IconTrash /></button>
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
                <span>{hosts().length} 台主机</span>
                <button class="btn" style={{ padding: '3px 10px', 'font-size': '11px' }} onClick={openEditorForNew}>新建</button>
            </div>
        </aside>
    );
}

/* ---------------- 组件：标签 + 会话视图 ---------------- */

function TabBar() {
    return (
        <div class="tabbar">
            <div class="tab-list">
                <For each={tabs()}>
                    {(t) => (
                        <div
                            class="tab"
                            classList={{ active: t.id === activeId() }}
                            onClick={() => activateTab(t.id)}
                        >
                            <span class="tab-state" classList={{ [t.status()]: true }} />
                            <span class="tab-label" title={t.sub}>{t.title}</span>
                            <button
                                class="tab-close"
                                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                                title="关闭标签"
                            >
                                <IconClose />
                            </button>
                        </div>
                    )}
                </For>
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
        const sess = new Session(String(props.id), {
            root: rootEl,
            host: pend.host,
            target: pend.target,
            user: pend.user,
            pass: pend.pass,
            onStatus: (s: SessionStatus) => rec.setStatus(s.state),
        });
        sessionMap.set(props.id, sess);
        sess.setActive(activeId() === props.id);
        sess.connect();
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

function Workspace() {
    return (
        <section class="main">
            <TabBar />
            <div class="workspace">
                <Show when={tabs().length === 0} fallback={<For each={tabs()}>{(t) => <SessionPane id={t.id} />}</For>}>
                    <div class="empty">
                        <div class="empty-logo">
                            <svg viewBox="0 0 24 24" width="62" height="62" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2.5" /><path d="M8 22h8M12 18v4" /></svg>
                        </div>
                        <p class="empty-hint">从左侧选择一个主机开始连接，或新建一个</p>
                        <button class="btn primary" onClick={openEditorForNew}>＋ 新建主机</button>
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
    const editing = () => editor().editing;
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
        <Show when={editor().open && editing()}>
            {(h) => (
                <div class="modal-layer" onClick={(e) => { if (e.target === e.currentTarget) setEditor({ open: false, editing: null }); }}>
                    <div class="modal-panel" onClick={(e) => e.stopPropagation()}>
                        <div class="mp-head">
                            <span class="mp-title">{isNew() ? '新建主机' : '编辑主机'}</span>
                            <button class="mp-x" onClick={() => setEditor({ open: false, editing: null })}><IconClose /></button>
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
                            <button class="btn" onClick={() => setEditor({ open: false, editing: null })}>取消</button>
                            <button class="btn primary" onClick={submit}>保存</button>
                        </div>
                    </div>
                </div>
            )}
        </Show>
    );
}

/* ---------------- 组件：密码询问 ---------------- */

function PasswordDialog() {
    let input!: HTMLInputElement;
    const submit = () => {
        const v = input.value;
        resolvePassword(v.length ? v : null);
    };
    return (
        <Show when={pw().open}>
            <div class="modal-layer">
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
                            style={{ height: '32px', padding: '0 10px', 'border-radius': '7px', border: '1px solid var(--border)', background: 'var(--bg-elev-2)', color: 'var(--text)', outline: 'none', 'font-size': '13px' }}
                        />
                    </div>
                    <div class="mp-foot">
                        <button class="btn" onClick={() => resolvePassword(null)}>取消</button>
                        <span class="mp-spacer" />
                        <button class="btn primary" onClick={submit}>连接</button>
                    </div>
                </div>
            </div>
        </Show>
    );
}

/* ---------------- 根组件 ---------------- */

export default function App() {
    return (
        <div class="app-shell">
            <TitleBar />
            <div class="app-body">
                <Sidebar />
                <Workspace />
            </div>
            <HostEditor />
            <PasswordDialog />
        </div>
    );
}
