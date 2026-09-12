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
import { isMac } from '../platform';
import { activePopup, togglePopup, openPopup } from './popups';
import { logError, logInfo } from './log';

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
    kind: NotifKind;
    title: string;
    body?: string;
    /** 关联的通知记录 id（进度任务气泡：patchTask 刷新 / finishTask 收敛移除） */
    notifId?: number;
    /** 进度 0..1；null = 不确定进度 */
    pct?: number | null;
    /** 进度阶段文案 */
    label?: string;
}

let seq = 1;
const MAX_NOTIF = 80;

const [notifs, setNotifs] = createSignal<XwNotif[]>([]);
const [toasts, setToasts] = createSignal<Toast[]>([]);

/* 面板定位（fixed 由 NotifyPanelHost 渲染）；开关由 popups 协调器统一管理 */
const [panelPos, setPanelPos] = createSignal({ x: 0, y: 0 });

const NPANEL_W = 320; /* 与 .npanel 宽度保持一致 */

function setPanelPosAt(btn: HTMLElement | null | undefined): void {
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    if (isMac()) {
        /* macOS：面板不与铃铛居中对齐，改贴窗口右缘留 12px（配合面板 -50% 锚点换算） */
        setPanelPos({ x: Math.max(NPANEL_W / 2 + 8, window.innerWidth - NPANEL_W / 2 - 12), y: r.bottom + 8 });
    } else {
        setPanelPos({ x: r.left + r.width / 2, y: r.bottom + 8 });
    }
}

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

/* 通知是"用户看得见的结果"的统一口径，所以对外 API 处顺手记一条内存日志：
 * 用户反馈"刚才报错了"时，日志里一定有对应条目（含成功/失败任务）。 */

function brief(title: string, body?: string): string {
    return `${title}${body ? `：${body.replace(/\n+/g, ' / ')}` : ''}`;
}

export function notifyInfo(title: string, body?: string): void {
    logInfo('notify', brief(title, body));
    addNotif({ kind: 'info', title, body });
    addToast({ kind: 'info', title, body });
}

export function notifySuccess(title: string, body?: string): void {
    logInfo('notify', brief(title, body));
    addNotif({ kind: 'success', title, body });
    addToast({ kind: 'success', title, body });
}

export function notifyError(title: string, body?: string): void {
    logError('notify', brief(title, body));
    addNotif({ kind: 'error', title, body });
    addToast({ kind: 'error', title, body });
}

/** 开启一个进度任务，返回任务 id；完成后用 finishTask 收敛。
 * 同步挂一个"进行中"气泡（不自动消失），让后台任务在界面角落可见：
 * patchTask 刷新气泡进度，finishTask 收敛为结果气泡。 */
export function startTask(title: string, label?: string): number {
    logInfo('notify', `任务开始：${title}${label ? `（${label}）` : ''}`);
    const rec = addNotif({ kind: 'progress', title, label, pct: 0 });
    setToasts((l) => [...l, { id: rec.id, kind: 'progress', title, label, pct: 0, notifId: rec.id }]);
    return rec.id;
}

export function patchTask(id: number, p: { pct?: number | null; label?: string; title?: string; body?: string }): void {
    setNotifs((l) => l.map((x) => (x.id === id ? { ...x, ...p } : x)));
    /* 同步刷新关联的进行中气泡 */
    setToasts((l) => l.map((t) =>
        t.notifId !== id ? t : {
            ...t,
            title: p.title ?? t.title,
            body: p.body ?? t.body,
            pct: p.pct !== undefined ? p.pct : t.pct,
            label: p.label !== undefined ? p.label : t.label,
        }));
}

export function finishTask(id: number, ok: boolean, o?: { title?: string; body?: string }): void {
    /* 任务结果也留一条（成功 info / 失败 error），便于事后对齐"什么任务在什么时候失败了" */
    const done = o?.title ?? notifs().find((x) => x.id === id)?.title ?? `#${id}`;
    if (ok) logInfo('notify', `任务完成：${done}${o?.body ? `（${o.body}）` : ''}`);
    else logError('notify', `任务失败：${done}${o?.body ? `（${o.body}）` : ''}`);
    setNotifs((l) => l.map((x) => {
        if (x.id !== id) return x;
        const title = o?.title ?? x.title;
        const body = o?.body ?? x.body;
        return { ...x, kind: ok ? 'success' : 'error', pct: ok ? 1 : 0, label: undefined, title, body, unread: true };
    }));
    setToasts((l) => l.filter((t) => t.notifId !== id)); /* 收起进行中气泡，交由下方结果气泡接管 */
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

/* ---------------- 铃铛（顶栏按钮，点击展开/收起） ---------------- */

/** 点击气泡 → 展开通知面板（定位到铃铛处） */
export function openNotifyFromToast(): void {
    openPopup('notify');
    setPanelPosAt(document.querySelector<HTMLElement>('[data-popup-trigger="notify"]'));
    markAllRead();
}

export function NBell() {
    let btn: HTMLButtonElement | undefined;
    const count = unreadCount;
    return (
        <button
            ref={btn}
            data-popup-trigger="notify"
            class="tb-btn nbell-btn"
            classList={{ active: activePopup() === 'notify' }}
            title={count() > 0 ? `通知中心（${count()} 条未读）` : '通知中心'}
            onClick={() => {
                const opened = togglePopup('notify');
                if (opened) { setPanelPosAt(btn); markAllRead(); }
            }}
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
            <Show when={activePopup() === 'notify'}>
                <div
                    class="npanel popup-panel"
                    style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
                >
                    <div class="npanel-head">
                        <span class="npanel-title">通知</span>
                        <span class="npanel-head-right">
                            <button class="npanel-clear" onClick={clearNotifs}>清空</button>
                            <button class="npanel-x" onClick={() => togglePopup('notify')} title="关闭"><X size={13} /></button>
                        </span>
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
                        <div class="toast" classList={{ [`k-${t.kind}`]: true }} onClick={openNotifyFromToast} title="查看通知">
                            <span class="toast-ico" classList={{ spin: t.kind === 'progress' }}>
                                {t.kind === 'success' ? <CheckCircle2 size={15} /> : t.kind === 'error' ? <XCircle size={15} /> : t.kind === 'progress' ? <Loader2 size={15} /> : <Info size={15} />}
                            </span>
                            <div class="toast-main">
                                <div class="toast-title">{t.title}</div>
                                <Show when={t.kind === 'progress'}>
                                    <div class="nbar"><div class="nbar-fill" classList={{ indet: t.pct === null }} style={{ width: t.pct == null ? undefined : `${Math.round(t.pct! * 100)}%` }} /></div>
                                    <Show when={t.label}><div class="toast-label">{t.label}</div></Show>
                                </Show>
                                <Show when={t.kind !== 'progress' && t.body}><div class="toast-body">{t.body}</div></Show>
                            </div>
                            <button class="toast-x" onClick={(e) => { e.stopPropagation(); setToasts((l) => l.filter((x) => x.id !== t.id)); }} title="移除"><X size={11} /></button>
                        </div>
                    )}
                </For>
            </div>
        </>
    );
}
