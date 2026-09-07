/* core/system.tsx —— 远端系统资源监控（CPU 与内存 两个独立按钮/面板）。
 *
 * 数据来源：经 SSH（ssh2 主进程长连接）每 5s 采集一次远端 /proc、ps、df。
 *   - CPU 按钮：显示占用率%，点击展开 CPU 面板（占用曲线图、核数/型号、CPU 占用 Top）
 *   - 内存按钮：显示 已用/总量（>900MB 用 GB），点击展开内存面板
 *     （内存条、可用/缓存/Swap 明细、内存占用 Top 软件、磁盘挂载与占用）
 *
 * 采集以「标签」为单位、模块级单例引用计数：同一标签的顶栏/全屏悬浮条与两个按钮
 * 共用一条 SSH 监控连接，标签结束/最后一个订阅方卸载时才关闭。
 */

import { createSignal, Show, For, onMount, onCleanup } from 'solid-js';
import { Cpu, MemoryStick, HardDrive, X } from 'lucide-solid';
import { sysOpen, sysSample, sysClose } from '../platform';
import { isPopup, togglePopup, closePopup } from './popups';
import type { FmCtx } from './filemgr';

/* ---------------- 面板数据状态（模块级共享） ---------------- */

const [cpuPos, setCpuPos] = createSignal({ x: 0, y: 0 });
const [memPos, setMemPos] = createSignal({ x: 0, y: 0 });
const [cpu, setCpu] = createSignal(0);
const [cores, setCores] = createSignal(0);
const [model, setModel] = createSignal('');
const [cpuProcs, setCpuProcs] = createSignal<Array<{ name: string; cpuPct: number }>>([]);
const [mem, setMem] = createSignal({ total: 0, avail: 0, buffers: 0, cached: 0, swapTotal: 0, swapFree: 0 }); /* kB */
const [procs, setProcs] = createSignal<Array<{ name: string; rss: number }>>([]);
const [disks, setDisks] = createSignal<Array<{ mount: string; totalKB: number; usedKB: number; availKB: number; pct: number }>>([]);
const [hist, setHist] = createSignal<number[]>([]);           /* 最近 CPU 采样（曲线） */
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
        setCores(r.cores || 0);
        setModel(r.model || '');
        setCpuProcs(r.cpuProcs || []);
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

/* 单值容量显示：数值 >=900MB 用 GB */
function cap(kb: number): string {
    if (kb >= 900 * 1024) {
        const g = kb / 1024 / 1024;
        return `${g >= 100 ? g.toFixed(0) : g.toFixed(1)}G`;
    }
    return `${Math.round(kb / 1024)}M`;
}

function usedKB(): number {
    return Math.max(0, mem().total - mem().avail);
}

function live(): boolean {
    return ready() && !failed();
}

const fmtGB = (kb: number) => `${((kb / 1024 / 1024) >= 10 ? (kb / 1024 / 1024).toFixed(0) : (kb / 1024 / 1024).toFixed(1))}G`;

/* ---------------- 顶部按钮：CPU / 内存（各自独立展开） ---------------- */

export function SysCpuButton(props: { ctx: FmCtx }) {
    let btn: HTMLButtonElement | undefined;
    onMount(() => sysAttach(props.ctx));
    onCleanup(() => sysDetach());
    const toggle = () => {
        if (btn) {
            const r = btn.getBoundingClientRect();
            setCpuPos({ x: Math.max(120, r.left + r.width / 2), y: r.bottom + 8 });
        }
        togglePopup('syscpu');
    };
    const label = () => {
        if (failed()) return '—';
        if (!ready()) return '…';
        return `${Math.round(cpu())}%`;
    };
    return (
        <button
            ref={btn}
            data-popup-trigger="syscpu"
            class="tab-btn sys-btn"
            classList={{ active: isPopup('syscpu') }}
            onClick={toggle}
            title={`CPU 占用率：${label()}（点击展开详情）`}
        >
            <Cpu size={13} />
            <span>{label()}</span>
        </button>
    );
}

export function SysMemButton(props: { ctx: FmCtx }) {
    let btn: HTMLButtonElement | undefined;
    onMount(() => sysAttach(props.ctx));
    onCleanup(() => sysDetach());
    const toggle = () => {
        if (btn) {
            const r = btn.getBoundingClientRect();
            setMemPos({ x: Math.max(120, r.left + r.width / 2), y: r.bottom + 8 });
        }
        togglePopup('sysmem');
    };
    const pct = () => {
        const t = mem().total;
        return t > 0 ? Math.min(100, Math.round((usedKB() / t) * 100)) : 0;
    };
    const label = () => {
        if (failed()) return '—';
        if (!ready()) return '…';
        return `${pct()}%`;
    };
    return (
        <button
            ref={btn}
            data-popup-trigger="sysmem"
            class="tab-btn sys-btn"
            classList={{ active: isPopup('sysmem') }}
            onClick={toggle}
            title={`内存使用率：${label()}（已用 ${cap(usedKB())} / ${cap(mem().total)}，点击展开详情）`}
        >
            <MemoryStick size={13} />
            <span>{label()}</span>
        </button>
    );
}

/* ---------------- 详情面板：CPU / 内存 ---------------- */

export function SysCpuPanelHost() {
    const pts = () => {
        const h = hist();
        const n = h.length;
        if (n < 2) return '';
        return h.map((v, i) => {
            const x = (i / (n - 1)) * 340;
            const y = 92 - Math.min(100, Math.max(0, v)) * 0.86;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
    };
    return (
        <Show when={isPopup('syscpu')}>
            <div
                class="sys-panel popup-panel"
                style={{ left: `${cpuPos().x}px`, top: `${cpuPos().y}px` }}
            >
                <div class="sys-head">
                    <span class="sys-title"><Cpu size={13} /> CPU</span>
                    <span class="sys-upd">每 5 秒刷新</span>
                    <button class="sys-x" onClick={() => closePopup('syscpu')} title="关闭"><X size={13} /></button>
                </div>
                <div class="sys-body">
                    <Show when={!ready() && !failed()}>
                        <div class="sys-empty">正在读取远端系统资源…</div>
                    </Show>
                    <Show when={failed()}>
                        <div class="sys-empty">无法通过 SSH 读取系统资源</div>
                    </Show>
                    <Show when={live()}>
                        <div class="sys-sec">
                            <div class="sys-cap">{Math.round(cpu())}%<small>使用率</small></div>
                            <Show when={cores() || model()}>
                                <div class="sys-subline">{cores() ? `${cores()} 核` : ''}{model() ? ` · ${model()}` : ''}</div>
                            </Show>
                        </div>
                        <div class="sys-sec">
                            <div class="sys-label"><span>占用曲线</span><b>{Math.round(cpu())}%</b></div>
                            <svg class="sys-plot big" viewBox="0 0 340 100" preserveAspectRatio="none">
                                <line x1="0" y1="8" x2="340" y2="8" class="sys-grid" />
                                <line x1="0" y1="34" x2="340" y2="34" class="sys-grid" />
                                <line x1="0" y1="60" x2="340" y2="60" class="sys-grid" />
                                <line x1="0" y1="86" x2="340" y2="86" class="sys-grid" />
                                <polyline points={pts()} class="sys-line" />
                            </svg>
                        </div>
                        <div class="sys-sec">
                            <div class="sys-label"><span>CPU 占用 Top</span></div>
                            <For each={cpuProcs().slice(0, 6)}>
                                {(p) => (
                                    <div class="sys-row">
                                        <span class="sys-row-name" title={p.name}>{p.name}</span>
                                        <span class="sys-row-val">{p.cpuPct.toFixed(1)}%</span>
                                    </div>
                                )}
                            </For>
                        </div>
                    </Show>
                </div>
            </div>
        </Show>
    );
}

export function SysMemPanelHost() {
    const memPct = () => {
        const t = mem().total;
        return t > 0 ? Math.min(100, Math.round((usedKB() / t) * 100)) : 0;
    };
    const swapUsed = () => Math.max(0, mem().swapTotal - mem().swapFree);
    const swapPct = () => {
        const t = mem().swapTotal;
        return t > 0 ? Math.min(100, Math.round((swapUsed() / t) * 100)) : 0;
    };
    return (
        <Show when={isPopup('sysmem')}>
            <div
                class="sys-panel popup-panel"
                style={{ left: `${memPos().x}px`, top: `${memPos().y}px` }}
            >
                <div class="sys-head">
                    <span class="sys-title"><MemoryStick size={13} /> 内存</span>
                    <span class="sys-upd">每 5 秒刷新</span>
                    <button class="sys-x" onClick={() => closePopup('sysmem')} title="关闭"><X size={13} /></button>
                </div>
                <div class="sys-body">
                    <Show when={!ready() && !failed()}>
                        <div class="sys-empty">正在读取远端系统资源…</div>
                    </Show>
                    <Show when={failed()}>
                        <div class="sys-empty">无法通过 SSH 读取系统资源</div>
                    </Show>
                    <Show when={live()}>
                        <div class="sys-sec">
                            <div class="sys-cap">{cap(usedKB())}<small> / {cap(mem().total)}</small></div>
                            <div class="sys-bar"><div class="sys-bar-fill mem" style={{ width: `${memPct()}%` }} /></div>
                            <div class="sys-label"><span>内存使用</span><b>{memPct()}%</b></div>
                        </div>
                        <div class="sys-sec">
                            <div class="sys-label"><span>明细</span></div>
                            <div class="sys-kv"><span>可用</span><b>{cap(mem().avail)}</b></div>
                            <div class="sys-kv"><span>缓存</span><b>{cap((mem().buffers || 0) + (mem().cached || 0))}</b></div>
                            <div class="sys-kv"><span>交换分区</span><b>{mem().swapTotal > 0 ? `${cap(swapUsed())} / ${cap(mem().swapTotal)}` : '未启用'}</b></div>
                            <Show when={mem().swapTotal > 0}>
                                <div class="sys-bar thin"><div class="sys-bar-fill disk" style={{ width: `${swapPct()}%` }} /></div>
                            </Show>
                        </div>
                        <div class="sys-sec">
                            <div class="sys-label"><span>内存占用 Top</span></div>
                            <For each={procs().slice(0, 6)}>
                                {(p) => (
                                    <div class="sys-row">
                                        <span class="sys-row-name" title={p.name}>{p.name}</span>
                                        <span class="sys-row-val">{Math.round(p.rss / 1024)}M<em>{mem().total > 0 ? ((p.rss / mem().total) * 100).toFixed(1) : '0'}%</em></span>
                                    </div>
                                )}
                            </For>
                        </div>
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
