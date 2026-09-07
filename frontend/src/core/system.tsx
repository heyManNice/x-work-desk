/* core/system.tsx —— 远端系统资源监控（CPU / 内存 / Top 进程 / 磁盘）。
 *
 * 数据来源：经 SSH（ssh2 主进程长连接）每 5s 采集一次远端 /proc、ps、df，
 * 顶部按钮实时显示「CPU% 内存used/内存total」（>900MB 用 GB）；点击展开详情面板：
 * CPU 占用折线图、内存占用、内存占用最大的几个软件、磁盘挂载与占用。
 *
 * 采集以「标签」为单位、模块级单例引用计数：同一标签的顶栏/全屏悬浮条共用一条
 * SSH 监控连接，标签结束/最后一个订阅方卸载时才关闭。
 */

import { createSignal, Show, For, onMount, onCleanup } from 'solid-js';
import { Cpu, X, HardDrive } from 'lucide-solid';
import { sysOpen, sysSample, sysClose } from '../platform';
import { isPopup, togglePopup, closePopup } from './popups';
import type { FmCtx } from './filemgr';

/* ---------------- 面板数据状态 ---------------- */

const [pos, setPos] = createSignal({ x: 0, y: 0 });
const [cpu, setCpu] = createSignal(0);
const [mem, setMem] = createSignal({ total: 0, avail: 0 });   /* kB */
const [procs, setProcs] = createSignal<Array<{ name: string; rss: number }>>([]);
const [disks, setDisks] = createSignal<Array<{ mount: string; totalKB: number; usedKB: number; availKB: number; pct: number }>>([]);
const [hist, setHist] = createSignal<number[]>([]);           /* 最近 CPU 采样（折线图） */
const [ready, setReady] = createSignal(false);
const [failed, setFailed] = createSignal(false);

/* ---------------- 采集控制器（单例 + 引用计数） ---------------- */

let monKey = '';
let monRefs = 0;
let monTimer: ReturnType<typeof setInterval> | undefined;
let sampling = false;

function stopMon(): void {
    if (monTimer) { clearInterval(monTimer); monTimer = undefined; }
    sampling = false;
    if (monKey) sysClose(monKey);
    monKey = '';
    setReady(false);
    setFailed(false);
}

async function sampleOnce(key: string): Promise<void> {
    if (sampling || monKey !== key) return;
    sampling = true;
    try {
        const r = await sysSample(key);
        if (monKey !== key) return;
        if (!r.ok) { setFailed(true); return; }
        setCpu(r.cpu);
        setMem(r.mem);
        setProcs(r.procs || []);
        setDisks(r.disks || []);
        setReady(true);
        setFailed(false);
        setHist((h) => [...h.slice(-59), r.cpu]);
    } catch {
        setFailed(true);
    } finally {
        sampling = false;
    }
}

/** 挂载一个订阅方（ctx 提供 SSH 凭据）；首个订阅方建立连接并开始 5s 采集 */
export function sysAttach(ctx: FmCtx): void {
    const key = `sys-${ctx.tabId}`;
    if (monKey !== key) stopMon();
    monKey = key;
    monRefs += 1;
    if (monRefs !== 1) return;
    setReady(false);
    setFailed(false);
    setHist([]);
    void sysOpen({ id: key, host: ctx.host, port: ctx.port, user: ctx.user, pass: ctx.pass }).then((r) => {
        if (monKey !== key) return;
        if (!r.ok) { setFailed(true); return; }
        void sampleOnce(key);
        monTimer = setInterval(() => void sampleOnce(key), 5000);
    });
}

/** 订阅方卸载 */
export function sysDetach(): void {
    monRefs = Math.max(0, monRefs - 1);
    if (monRefs === 0) stopMon();
}

/* ---------------- 工具 ---------------- */

/* 使用内存超过 900MB → GB 单位（used 与 total 统一用同单位展示） */
function fmtPair(usedKb: number, totalKb: number): string {
    const gb = usedKb >= 900 * 1024;
    const one = (kb: number) => {
        if (!gb) return `${Math.round(kb / 1024)}M`;
        const g = kb / 1024 / 1024;
        return `${g >= 100 ? g.toFixed(0) : g.toFixed(1)}G`;
    };
    return `${one(usedKb)}/${one(totalKb)}`;
}

function usedKB(): number {
    return Math.max(0, mem().total - mem().avail);
}

const fmtGB = (kb: number) => `${((kb / 1024 / 1024) >= 10 ? (kb / 1024 / 1024).toFixed(0) : (kb / 1024 / 1024).toFixed(1))}G`;

/* ---------------- 顶部按钮（有文字，工具栏最左） ---------------- */

export function SysButton(props: { ctx: FmCtx }) {
    let btn: HTMLButtonElement | undefined;
    onMount(() => sysAttach(props.ctx));
    onCleanup(() => sysDetach());

    const toggle = () => {
        if (btn) {
            const r = btn.getBoundingClientRect();
            setPos({ x: Math.max(120, r.left + r.width / 2), y: r.bottom + 8 });
        }
        togglePopup('sys');
    };

    const label = () => {
        if (failed()) return '资源不可用';
        if (!ready()) return '读取中…';
        return `${Math.round(cpu())}% ${fmtPair(usedKB(), mem().total)}`;
    };

    return (
        <button
            ref={btn}
            data-popup-trigger="sys"
            class="tab-btn sys-btn"
            classList={{ active: isPopup('sys') }}
            onClick={toggle}
            title="系统资源（点击展开：CPU/内存/进程/磁盘）"
        >
            <Cpu size={13} />
            <span>{label()}</span>
        </button>
    );
}

/* ---------------- 详情面板 ---------------- */

export function SysPanelHost() {
    const pts = () => {
        const h = hist();
        const n = h.length;
        if (n < 2) return '';
        return h.map((v, i) => {
            const x = (i / (n - 1)) * 280;
            const y = 66 - Math.min(100, Math.max(0, v)) * 0.62;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
    };
    const memPct = () => {
        const t = mem().total;
        return t > 0 ? Math.min(100, Math.round((usedKB() / t) * 100)) : 0;
    };
    return (
        <Show when={isPopup('sys')}>
            <div
                class="sys-panel popup-panel"
                style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
            >
                <div class="sys-head">
                    <span class="sys-title"><Cpu size={13} /> 系统资源</span>
                    <span class="sys-upd">每 5 秒刷新</span>
                    <button class="sys-x" onClick={() => closePopup('sys')} title="关闭"><X size={13} /></button>
                </div>
                <div class="sys-body">
                    <Show when={!ready() && !failed()}>
                        <div class="sys-empty">正在读取远端系统资源…</div>
                    </Show>
                    <Show when={failed()}>
                        <div class="sys-empty">无法通过 SSH 读取系统资源</div>
                    </Show>
                    <Show when={ready()}>
                        {/* CPU 折线图 */}
                        <div class="sys-sec">
                            <div class="sys-label"><span>CPU 占用</span><b>{Math.round(cpu())}%</b></div>
                            <svg class="sys-plot" viewBox="0 0 280 70" preserveAspectRatio="none">
                                <line x1="0" y1="6" x2="280" y2="6" class="sys-grid" />
                                <line x1="0" y1="29" x2="280" y2="29" class="sys-grid" />
                                <line x1="0" y1="52" x2="280" y2="52" class="sys-grid" />
                                <polyline points={pts()} class="sys-line" />
                            </svg>
                        </div>

                        {/* 内存 */}
                        <div class="sys-sec">
                            <div class="sys-label">
                                <span>内存 {fmtPair(usedKB(), mem().total)}</span>
                                <b>{memPct()}%</b>
                            </div>
                            <div class="sys-bar"><div class="sys-bar-fill mem" style={{ width: `${memPct()}%` }} /></div>
                            <div class="sys-sub">可用 {fmtPair(mem().avail, mem().total)}</div>
                        </div>

                        {/* Top 进程 */}
                        <div class="sys-sec">
                            <div class="sys-label"><span>内存占用 Top</span></div>
                            <For each={procs().slice(0, 6)}>
                                {(p) => (
                                    <div class="sys-row">
                                        <span class="sys-row-name" title={p.name}>{p.name}</span>
                                        <span class="sys-row-val">
                                            {Math.round(p.rss / 1024)}M
                                            <em>{mem().total > 0 ? ((p.rss / mem().total) * 100).toFixed(1) : '0'}%</em>
                                        </span>
                                    </div>
                                )}
                            </For>
                        </div>

                        {/* 磁盘 */}
                        <div class="sys-sec">
                            <div class="sys-label"><span><HardDrive size={11} /> 磁盘</span></div>
                            <For each={disks()}>
                                {(d) => (
                                    <div class="sys-disk">
                                        <div class="sys-row">
                                            <span class="sys-row-name" title={d.mount}>{d.mount}</span>
                                            <span class="sys-row-val">{fmtGB(d.usedKB)} / {fmtGB(d.totalKB)} · {d.pct}%</span>
                                        </div>
                                        <div class="sys-bar thin"><div class="sys-bar-fill disk" style={{ width: `${Math.min(100, d.pct)}%` }} /></div>
                                    </div>
                                )}
                            </For>
                            <Show when={disks().length === 0}>
                                <div class="sys-empty">未检测到磁盘挂载</div>
                            </Show>
                        </div>
                    </Show>
                </div>
            </div>
        </Show>
    );
}
