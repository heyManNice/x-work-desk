/* filemgr.tsx —— 远程文件面板（基于 SFTP）。
 *
 * 连接 SSH 终端 / 远程桌面会话时，顶栏出现文件图标：
 *   悬浮/点击展开面板 —— 路径栏、上一级、刷新、上传、新建文件夹、搜索过滤；
 *   列表右键：文件夹(打开/重命名/复制路径/删除)、文件(下载/重命名/复制路径/删除)。
 * SFTP 会话由主进程维护（fileSessions，按 tabId）；本文件负责 UI 与操作编排。
 */

import { createSignal, Show, For, createMemo } from 'solid-js';
import {
    Folder, File as FileIcon, ArrowUp, RefreshCw, Upload, FolderPlus,
    Download, Copy, Pencil, Trash2, Search, X, FolderOpen, Loader2,
} from 'lucide-solid';
import {
    fmOpen, fmList, fmMkdir, fmRename, fmRemove, fmUpload, fmDownload, fmClose,
    clipWriteText,
    type FmEntry,
} from '../platform';
import { notifyInfo, notifySuccess, notifyError } from './notify';
import { showConfirm } from '../modal';
import { isPopup, openPopup, closePopup } from './popups';

export interface FmCtx {
    tabId: number;
    host: string;
    port: number;
    user: string;
    pass?: string;
}

/* ---------------- 会话 / 打开状态 ---------------- */
/* 面板开合由 popups 协调器决定（点击式、互斥、点外部收起）。
 * 关闭面板仅隐藏 UI；SFTP 连接与当前目录/列表保留到标签结束，
 * 因此同一连接内再次打开会回到上次所在目录。 */
const [pos, setPos] = createSignal({ x: 0, y: 0 });
const [ctx, setCtx] = createSignal<FmCtx | null>(null);
const [cwd, setCwd] = createSignal('/');
const [entries, setEntries] = createSignal<FmEntry[]>([]);
const [loading, setLoading] = createSignal(false);
const [q, setQ] = createSignal('');
const [sel, setSel] = createSignal<string | null>(null);
const [fmMenu, setFmMenu] = createSignal<{ x: number; y: number; e: FmEntry } | null>(null);
const [inp, setInp] = createSignal<{ mode: 'newdir' | 'rename'; value: string; entry?: FmEntry } | null>(null);

/* 每个标签记住上次浏览目录（切主机时面板自动收起，目录记忆保留以便回来续用） */
const dirsByTab = new Map<number, string>();

/* 路径工具（posix，服务器端会再做归一化） */
function pjoin(dir: string, name: string): string {
    const d = dir === '/' || dir === '' ? '' : dir.replace(/\/+$/, '');
    return (d ? d + '/' : '/') + name;
}
function pparent(p: string): string {
    const s = p.replace(/\/+$/, '');
    if (!s) return '/';
    const i = s.lastIndexOf('/');
    return i <= 0 ? '/' : s.slice(0, i);
}

const filterKey = () => q().trim().toLowerCase();
const filtered = createMemo(() => {
    const k = filterKey();
    const list = entries();
    if (!k) return list;
    return list.filter((e) => e.name.toLowerCase().includes(k));
});

/* ---------------- 打开 / 刷新 / 导航 ---------------- */

async function connectAndList(c: FmCtx): Promise<void> {
    setLoading(true);
    const r = await fmOpen({ id: c.tabId, host: c.host, port: c.port, user: c.user, pass: c.pass });
    setLoading(false);
    if (r.ok) {
        const pref = dirsByTab.get(c.tabId);
        if (pref && pref !== '/' && pref !== (r.cwd || '/')) {
            /* 该标签上次浏览过其它目录：连上后直接跳回 */
            setCwd(pref);
            setEntries([]);
            void loadPath(pref);
        } else {
            setCwd(r.cwd || '/');
            setEntries(r.entries || []);
        }
        setSel(null);
        setQ('');
        setInp(null);
    } else {
        notifyError('SFTP 连接失败', (r.msg || '无法连接到远程文件服务') + `\n（${c.user}@${c.host}）`);
        closePopup('file');
        setCtx(null);
    }
}

async function loadPath(p: string): Promise<void> {
    const id = ctx()?.tabId;
    if (id == null) return;
    setLoading(true);
    const r = await fmList(id, p);
    setLoading(false);
    if (r.ok) {
        setCwd(r.cwd || p);
        setEntries(r.entries || []);
        setSel(null);
    } else {
        notifyError('读取目录失败', r.msg || '未知错误');
    }
}

/** 文件面板当前是否正为该标签会话打开（顶栏/全屏悬浮工具栏图标态复用） */
export function isFmOpen(tabId: number): boolean {
    return isPopup('file') && ctx()?.tabId === tabId;
}

export function openFmAt(btn: HTMLElement | null | undefined, c: FmCtx): void {
    if (btn) {
        const rect = btn.getBoundingClientRect();
        setPos({ x: rect.left + rect.width / 2, y: rect.bottom + 8 });
    }
    openPopup('file');
    if (!ctx() || ctx()!.tabId !== c.tabId) {
        /* 首次使用该会话：建立 SFTP 连接并列出主目录 */
        setCtx(c);
        setCwd('/');
        setEntries([]);
        void connectAndList(c);
    }
}

/** 关闭面板：仅收起 UI，保留连接；记住当前目录（再次打开回到上次目录） */
function doCloseFm(): void {
    const c = ctx();
    if (c) dirsByTab.set(c.tabId, cwd() || '/');
    closePopup('file');
    setFmMenu(null);
    setInp(null);
}

/** 激活标签离开某会话（切到别的主机/标签）时调用：记住目录；若文件面板正显示
 * 该会话则收起，避免面板残留上一台主机的列表（与顶栏工具按激活标签一致）。 */
export function fmTabDeactivated(tabId: number): void {
    const c = ctx();
    if (c && c.tabId === tabId) {
        dirsByTab.set(tabId, cwd() || '/');
        if (isPopup('file')) closePopup('file');
    }
}

/** 外部（关闭标签/断开）通知会话真正结束：回收 SFTP 连接并清空面板 */
export function fmSessionEnded(tabId: number): void {
    if (ctx()?.tabId === tabId) {
        closePopup('file');
        setCtx(null);
        setCwd('/');
        setEntries([]);
    }
    void fmClose(tabId);
}

/* ---------------- 操作 ---------------- */

function enterDir(e: FmEntry): void {
    setFmMenu(null);
    if (e.isDir) void loadPath(pjoin(cwd(), e.name));
}

function goUp(): void {
    void loadPath(pparent(cwd()));
}

async function doUpload(): Promise<void> {
    const id = ctx()?.tabId;
    if (id == null) return;
    setLoading(true);
    const r = await fmUpload(id, cwd());
    setLoading(false);
    if (r.ok) {
        const n = (r.uploaded || []).length;
        if (n) notifySuccess('上传完成', `${n} 个文件已上传到 ${cwd()}`);
    } else if (r.canceled) {
        /* 用户取消选择框 */
    } else {
        notifyError('上传失败', r.msg || '未知错误');
    }
    void loadPath(cwd());
}

async function doDownload(e: FmEntry): Promise<void> {
    const id = ctx()?.tabId;
    if (id == null) return;
    setFmMenu(null);
    setLoading(true);
    const r = await fmDownload(id, pjoin(cwd(), e.name));
    setLoading(false);
    if (r.ok) notifySuccess('下载完成', `${e.name} → ${r.dest || '下载目录'}`);
    else notifyError('下载失败', r.msg || '未知错误');
}

async function copyPath(e: FmEntry): Promise<void> {
    setFmMenu(null);
    const full = pjoin(cwd(), e.name);
    try {
        await clipWriteText(full);
        notifyInfo('已复制路径', full);
    } catch { /* 忽略 */ }
}

async function doDelete(e: FmEntry): Promise<void> {
    setFmMenu(null);
    const id = ctx()?.tabId;
    if (id == null) return;
    const tip = e.isDir
        ? `将递归删除文件夹及其内容：\n${pjoin(cwd(), e.name)}\n\n此操作不可恢复！`
        : `确定删除文件：\n${pjoin(cwd(), e.name)} ？`;
    const ok = await showConfirm('删除确认', tip);
    if (!ok) return;
    const r = await fmRemove(id, pjoin(cwd(), e.name), e.isDir);
    if (r.ok) notifyInfo('已删除', e.name);
    else notifyError('删除失败', r.msg || '未知错误');
    void loadPath(cwd());
}

async function submitInput(): Promise<void> {
    const v = (inp()?.value || '').trim();
    const mode = inp()?.mode;
    const entry = inp()?.entry;
    const id = ctx()?.tabId;
    setInp(null);
    if (!v || id == null) return;
    if (mode === 'newdir') {
        const r = await fmMkdir(id, pjoin(cwd(), v));
        if (r.ok) notifyInfo('已新建文件夹', v);
        else notifyError('新建失败', r.msg || '未知错误');
    } else if (mode === 'rename' && entry) {
        if (v === entry.name) return;
        const r = await fmRename(id, pjoin(cwd(), entry.name), pjoin(cwd(), v));
        if (r.ok) notifyInfo('已重命名', `${entry.name} → ${v}`);
        else notifyError('重命名失败', r.msg || '未知错误');
    }
    void loadPath(cwd());
}

function fmtSize(e: FmEntry): string {
    if (e.isDir) return '';
    const b = e.size || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
function fmtTime(m: number): string {
    if (!m) return '';
    const d = new Date(m);
    const p = (x: number) => (x < 10 ? '0' + x : '' + x);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------- 工具栏按钮 ---------------- */

export function FileButton(props: { ctx: FmCtx; label?: string }) {
    let btn: HTMLButtonElement | undefined;
    const c = () => props.ctx;
    const hasLabel = () => !!props.label;
    const isThisOpen = () => isFmOpen(c().tabId);
    const toggle = () => {
        if (isThisOpen()) { doCloseFm(); return; }
        openFmAt(btn, c());
    };
    return (
        <button
            ref={btn}
            data-popup-trigger="file"
            class="fm-btn"
            classList={{ 'tab-btn': hasLabel(), 'tb-btn': !hasLabel(), active: isThisOpen() }}
            title="远程文件（SFTP）"
            onClick={toggle}
        >
            {isThisOpen() ? <FolderOpen size={hasLabel() ? 13 : 15} /> : <Folder size={hasLabel() ? 13 : 15} />}
            {hasLabel() && <span>文件</span>}
        </button>
    );
}

/* ---------------- 面板 / 右键菜单 ---------------- */

export function FilePanelHost() {
    const p = () => pos();
    return (
        <>
            <Show when={isPopup('file')}>
                <div
                    class="fmpanel popup-panel"
                    style={{ left: `${p().x}px`, top: `${p().y}px` }}
                    onClick={() => setFmMenu(null)}
                >
                    {/* 顶部：路径 + 操作 */}
                    <div class="fmp-head">
                        <div class="fmp-path" title={cwd()}>
                            <Show when={ctx()}>
                                <span class="fmp-host">{ctx()!.user}@{ctx()!.host}</span>
                            </Show>
                            <span class="fmp-cwd">{cwd()}</span>
                        </div>
                        <button class="fmp-x" onClick={doCloseFm} title="关闭"><X size={13} /></button>
                    </div>
                    <div class="fmp-actions">
                        <button class="fmp-btn" onClick={goUp} title="上一级" disabled={pparent(cwd()) === cwd()}><ArrowUp size={14} /></button>
                        <button class="fmp-btn" onClick={() => void loadPath(cwd())} title="刷新"><RefreshCw size={13} /></button>
                        <button class="fmp-btn" onClick={() => { setInp({ mode: 'newdir', value: '' }); }} title="新建文件夹"><FolderPlus size={14} /></button>
                        <button class="fmp-btn" onClick={() => void doUpload()} title="上传文件到此目录"><Upload size={14} /></button>
                        <div class="fmp-search">
                            <Search size={12} />
                            <input
                                value={q()}
                                onInput={(e) => setQ(e.currentTarget.value)}
                                placeholder="搜索当前目录…"
                                spellcheck={false}
                            />
                            <Show when={q()}><button class="fmp-qclear" onClick={() => setQ('')} title="清除"><X size={11} /></button></Show>
                        </div>
                    </div>

                    {/* 行内输入（新建/重命名） */}
                    <Show when={inp()}>
                        <div class="fmp-inline">
                            <input
                                value={inp()!.value}
                                placeholder={inp()!.mode === 'newdir' ? '文件夹名称' : '新名称'}
                                autofocus
                                onInput={(e) => setInp({ ...inp()!, value: e.currentTarget.value })}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') void submitInput();
                                    if (e.key === 'Escape') setInp(null);
                                }}
                            />
                            <button class="btn primary" onClick={() => void submitInput()} style={{ 'font-size': '12px', padding: '0 10px', height: '26px' }}>确定</button>
                            <button class="btn" onClick={() => setInp(null)} style={{ 'font-size': '12px', padding: '0 10px', height: '26px' }}>取消</button>
                        </div>
                    </Show>

                    {/* 列表 */}
                    <div class="fmp-body">
                        <Show when={filtered().length === 0 && !loading()}>
                            <div class="fmp-empty">{q() ? '无匹配项' : '空目录'}</div>
                        </Show>
                        <Show when={loading() && entries().length === 0}>
                            <div class="fmp-empty"><Loader2 size={16} class="spin" /> 载入中…</div>
                        </Show>
                        <For each={filtered()}>
                            {(e) => (
                                <div
                                    class="fmp-row"
                                    classList={{ dir: e.isDir, sel: sel() === e.name }}
                                    onClick={() => setSel(e.name)}
                                    onDblClick={() => enterDir(e)}
                                    onContextMenu={(ev) => {
                                        ev.preventDefault();
                                        setSel(e.name);
                                        const w = 210, h = e.isDir ? 190 : 190;
                                        const x = Math.min(ev.clientX, window.innerWidth - w - 8);
                                        const y = Math.min(ev.clientY, window.innerHeight - h - 8);
                                        setFmMenu({ x, y, e });
                                    }}
                                >
                                    <span class="fmp-row-ico">{e.isDir ? <Folder size={14} /> : <FileIcon size={14} />}</span>
                                    <span class="fmp-row-name" title={e.name}>{e.name}</span>
                                    <span class="fmp-row-size">{fmtSize(e)}</span>
                                    <span class="fmp-row-time">{fmtTime(e.mtime)}</span>
                                </div>
                            )}
                        </For>
                        <Show when={loading() && entries().length > 0}>
                            <div class="fmp-loading"><Loader2 size={13} class="spin" /> 刷新中…</div>
                        </Show>
                    </div>
                </div>
            </Show>

            {/* 右键菜单 */}
            <Show when={fmMenu()}>
                {(m) => (
                    <div class="ctx-menu fm-ctx" style={{ left: `${m().x}px`, top: `${m().y}px` }}>
                        <div class="ctx-arrow" />
                        <Show when={m().e.isDir}>
                            <button class="ctx-item" onClick={() => enterDir(m().e)}><FolderOpen size={13} /> 打开</button>
                        </Show>
                        <Show when={!m().e.isDir}>
                            <button class="ctx-item" onClick={() => void doDownload(m().e)}><Download size={13} /> 下载</button>
                        </Show>
                        <button class="ctx-item" onClick={() => { setInp({ mode: 'rename', value: m().e.name, entry: m().e }); setFmMenu(null); }}><Pencil size={13} /> 重命名</button>
                        <div class="ctx-sep" />
                        <button class="ctx-item" onClick={() => void copyPath(m().e)}><Copy size={13} /> 复制路径</button>
                        <div class="ctx-sep" />
                        <button class="ctx-item danger" onClick={() => void doDelete(m().e)}><Trash2 size={13} /> 删除</button>
                    </div>
                )}
            </Show>
        </>
    );
}
