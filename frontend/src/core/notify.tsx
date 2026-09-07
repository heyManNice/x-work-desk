/* notify.tsx —— 统一通知中心（铃铛 + 未读红点 + 气泡 + 悬浮面板，支持进度）。
 *
 * 所有状态提示/进度/结果都经由此处：
 *   notifyInfo/Success/Error   —— 一次性消息：进气泡 + 面板列表（未读）
 *   startTask/patchTask/finish —— 长任务进度：面板内进度条（pct=null 为不确定进度），
 *                                 完成后转 success/error 并弹气泡
 *
 * 铃铛按钮放在顶栏（TabBar.topbar-right）；面板/气泡因 .tabbar overflow:hidden
 * 需脱离裁切，故由 NotifyPanelHost 在 App 根部以 fixed 渲染（按钮测距后定位）。
 */

import { createSignal, Show, For } from 'solid-js';
import { Bell, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-solid';

export type NotifKind = 'info' | 'success' | 'error' | 'progress';

export interface XwNotif {
    id: number;
    kind: NotifKind;
    title: string;
    body?: string;
    /** 0..1；null = 不确定进度（跑动画） */
    pct: number | null;
    /** 进度阶段文案 */
    label?: string;
    ts: number;
    unread: boolean;
}

interface Toast {
    id: number;
    kind: Exclude<NotifKind, 'progress'>;
    title: string;
    body?: string;
}

let seq = 1;
const MAX_NOTIF = 80;

const [notifs, setNotifs] = createSignal<XwNotif[]>([]);
const [toasts, setToasts] = createSignal<Toast[]>([]);

/* 面板开关 + 定位（fixed 由 NotifyPanelHost 渲染） */
const [panelOpen, setPanelOpen] = createSignal(false);
const [panelPos, setPanelPos] = createSignal({ x: 0, y: 0 });
let closeTimer: number | undefined;

function addNotif(n: { title: string; body?: string; kind?: NotifKind; pct?: number | null; label?: string }) {
    const rec: XwNotif = {
        id: seq++,
        kind: n.kind ?? 'info',
        title: n.title,
        body: n.body,
        pct: n.pct === undefined ? null : n.pct,
        label: n.label,
        ts: Date.now(),
        unread: true,
    };
    setNotifs((l) => [rec, ...l].slice(0, MAX_NOTIF));
    return rec;
}

function addToast(t: { kind: Exclude<NotifKind, 'progress'>; title: string; body?: string }) {
    const id = seq++;
    setToasts((l) => [...l, { id, ...t }]);
    window.setTimeout(() => setToasts((l) => l.filter((x) => x.id !== id)), t.kind === 'error' ? 6000 : 4000);
}

/* ---------------- 公共 API ---------------- */

export function notifyInfo(title: string, body?: string): void {
    addNotif({ kind: 'info', title, body });
    addToast({ kind: 'info', title, body });
}

export function notifySuccess(title: string, body?: string): void {
    addNotif({ kind: 'success', title, body });
    addToast({ kind: 'success', title, body });
}

export function notifyError(title: string, body?: string): void {
    addNotif({ kind: 'error', title, body });
    addToast({ kind: 'error', title, body });
}

/** 开启一个进度任务，返回任务 id；完成后用 finishTask 收敛 */
export function startTask(title: string, label?: string): number {
    return addNotif({ kind: 'progress', title, label, pct: 0 }).id;
}

export function patchTask(id: number, p: { pct?: number | null; label?: string; title?: string; body?: string }): void {
    setNotifs((l) => l.map((x) => (x.id === id ? { ...x, ...p } : x)));
}

export function finishTask(id: number, ok: boolean, o?: { title?: string; body?: string }): void {
    setNotifs((l) => l.map((x) => {
        if (x.id !== id) return x;
        const title = o?.title ?? x.title;
        const body = o?.body ?? x.body;
        return { ...x, kind: ok ? 'success' : 'error', pct: ok ? 1 : 0, label: undefined, title, body, unread: true };
    }));
    const cur = notifs().find((x) => x.id === id);
    if (cur) addToast({ kind: ok ? 'success' : 'error', title: o?.title ?? cur.title, body: o?.body ?? cur.body });
}

export function dismissNotif(id: number): void {
    setNotifs((l) => l.filter((x) => x.id !== id));
}

export function clearNotifs(): void {
    setNotifs([]);
}

export function markAllRead(): void {
    if (notifs().some((n) => n.unread)) setNotifs((l) => l.map((n) => (n.unread ? { ...n, unread: false } : n)));
}

export const unreadCount = () => notifs().filter((n) => n.unread).length;

/* ---------------- 铃铛（顶栏按钮） ---------------- */

function scheduleClose(): void {
    if (closeTimer) window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => setPanelOpen(false), 220);
}

function cancelClose(): void {
    if (closeTimer) { window.clearTimeout(closeTimer); closeTimer = undefined; }
}

export function openPanelAt(btn: HTMLElement | null | undefined): void {
    if (btn) {
        const r = btn.getBoundingClientRect();
        setPanelPos({ x: r.left + r.width / 2, y: r.bottom + 8 });
    }
    setPanelOpen(true);
    markAllRead();
}

export function NBell() {
    let btn: HTMLButtonElement | undefined;
    const count = unreadCount;
    return (
        <button
            ref={btn}
            class="tb-btn nbell-btn"
            title={count() > 0 ? `通知中心（${count()} 条未读）` : '通知中心'}
            onClick={() => openPanelAt(btn)}
            onMouseEnter={() => openPanelAt(btn)}
            onMouseLeave={scheduleClose}
        >
            <Bell size={15} />
            <Show when={count() > 0}><span class="nbell-dot" /></Show>
        </button>
    );
}

/* ---------------- 面板 / 气泡（App 根部 fixed 渲染） ---------------- */

function fmtTime(ts: number): string {
    const d = new Date(ts);
    const p = (x: number) => (x < 10 ? '0' + x : '' + x);
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function kindIcon(k: NotifKind) {
    if (k === 'success') return <CheckCircle2 size={14} />;
    if (k === 'error') return <XCircle size={14} />;
    if (k === 'progress') return <Loader2 size={14} />;
    return <Info size={14} />;
}

function NotifRow(props: { n: XwNotif }) {
    const n = () => props.n;
    return (
        <div class="nitem" classList={{ [`k-${n().kind}`]: true }}>
            <span class="nitem-ico" classList={{ spin: n().kind === 'progress' }}>
                {kindIcon(n().kind)}
            </span>
            <div class="nitem-main">
                <div class="nitem-title">{n().title}</div>
                <Show when={n().body && n().kind !== 'progress'}><div class="nitem-body">{n().body}</div></Show>
                <Show when={n().kind === 'progress'}>
                    <div class="nbar"><div class="nbar-fill" classList={{ indet: n().pct === null }} style={{ width: n().pct == null ? undefined : `${Math.round(n().pct! * 100)}%` }} /></div>
                    <Show when={n().label}><div class="nitem-label">{n().label}</div></Show>
                </Show>
            </div>
            <div class="nitem-meta">
                <span class="nitem-time">{fmtTime(n().ts)}</span>
                <button class="nitem-x" onClick={() => dismissNotif(n().id)} title="移除"><X size={11} /></button>
            </div>
        </div>
    );
}

export function NotifyPanelHost() {
    const pos = () => panelPos();
    return (
        <>
            <Show when={panelOpen()}>
                <div
                    class="npanel"
                    style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
                    onMouseEnter={cancelClose}
                    onMouseLeave={scheduleClose}
                >
                    <div class="npanel-head">
                        <span class="npanel-title">通知</span>
                        <button class="npanel-clear" onClick={clearNotifs}>清空</button>
                    </div>
                    <div class="npanel-body">
                        <Show when={notifs().length === 0} fallback={<For each={notifs()}>{(n) => <NotifRow n={n} />}</For>}>
                            <div class="npanel-empty">暂无通知</div>
                        </Show>
                    </div>
                </div>
            </Show>
            <div class="toast-host">
                <For each={toasts()}>
                    {(t) => (
                        <div class="toast" classList={{ [`k-${t.kind}`]: true }}>
                            <span class="toast-ico">{t.kind === 'success' ? <CheckCircle2 size={15} /> : t.kind === 'error' ? <XCircle size={15} /> : <Info size={15} />}</span>
                            <div class="toast-main">
                                <div class="toast-title">{t.title}</div>
                                <Show when={t.body}><div class="toast-body">{t.body}</div></Show>
                            </div>
                            <button class="toast-x" onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))}><X size={11} /></button>
                        </div>
                    )}
                </For>
            </div>
        </>
    );
}
