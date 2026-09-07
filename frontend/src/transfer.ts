/* transfer.ts —— 文件传输（客户端新方案：复制粘贴 / 拖放，无需浏览器右键菜单）。
 *
 * 上传（本地→远程桌面 ~/Desktop）：
 *   - 把本地文件拖进窗口（Tauri 拿真实路径）或点右上「上传」按钮
 *   - Tauri：Rust 命令 upload_local_files 直连服务端（跨源无 CORS 烦恼、可写盘）
 *   - 浏览器（同源兜底）：input[type=file] + XHR 分片上传（服务端已加 CORS）
 * 下载（远程→本地）：
 *   - 远程文件管理器选中文件 Ctrl+C → 服务端识别 file:// 推送 MSG_CLIPBOARD_FILES
 *   - 客户端右下角出现「已复制 N 个远程文件」卡 → 点保存：Tauri 选目录写盘 / 浏览器 blob
 * 数据面 HTTP：GET /api/transfer/download?token&path；POST /api/transfer/upload（1MB/片）
 */

import { getServer } from './server';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

let token = '';

export function setTransferToken(t: string): void {
    token = t;
}

/* 服务端登录后下发的会话目录（home/desktop），用于上传落点展示 */
let remoteDesktop = '';
let remoteHome = '';
export function setSessionDirs(text: string): void {
    const lines = text.split('\n').filter((s) => s.length > 0);
    for (let i = 0; i + 1 < lines.length; i += 2) {
        if (lines[i] === 'home') remoteHome = lines[i + 1];
        else if (lines[i] === 'desktop') remoteDesktop = lines[i + 1];
    }
    const tip = document.getElementById('xwd-upload-tip');
    if (tip) tip.textContent = remoteDesktop ? `发送到远程桌面 ${remoteDesktop}` : '发送到远程桌面';
}

function isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

interface TransferTask {
    kind: 'download' | 'upload';
    name: string;
    total: number;
    done: number;
    status: 'active' | 'done' | 'error';
    el: HTMLElement;
    bar: HTMLElement;
    text: HTMLElement;
}

let tasks: TransferTask[] = [];
let taskSeq = 0;
/* 当前批次的活跃任务（上传/下载进度事件统一更新它） */
let curTask: TransferTask | null = null;

function ensureQueue(): HTMLElement {
    let q = document.getElementById('transfer-queue');
    if (!q) {
        q = document.createElement('div');
        q.id = 'transfer-queue';
        q.className = 'transfer-queue';
        document.body.appendChild(q);
    }
    return q;
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function addTask(kind: 'download' | 'upload', name: string): TransferTask {
    const q = ensureQueue();
    const el = document.createElement('div');
    el.className = 'transfer-item';
    const icon = kind === 'download' ? '⬇' : '⬆';
    el.innerHTML = `
        <div class="transfer-head">
            <span class="transfer-icon">${icon}</span>
            <span class="transfer-name" title="${name}">${name}</span>
            <span class="transfer-status">等待</span>
        </div>
        <div class="transfer-track"><div class="transfer-bar" style="width:0%"></div></div>
        <div class="transfer-meta"></div>`;
    q.appendChild(el);
    const task: TransferTask = {
        kind,
        name,
        total: 0,
        done: 0,
        status: 'active',
        el,
        bar: el.querySelector('.transfer-bar') as HTMLElement,
        text: el.querySelector('.transfer-meta') as HTMLElement,
    };
    taskSeq++;
    tasks.push(task);
    return task;
}

function updateTask(t: TransferTask, done: number, total: number, speed: number): void {
    t.done = done;
    t.total = total;
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    t.bar.style.width = `${pct}%`;
    const speedTxt = speed > 0 ? `${fmtBytes(speed)}/s` : '';
    const st = t.el.querySelector('.transfer-status') as HTMLElement;
    st.textContent = total > 0 ? `${pct.toFixed(0)}%` : '…';
    t.text.textContent = `${fmtBytes(done)} / ${fmtBytes(total)}${speedTxt ? '　' + speedTxt : ''}`;
}

function finishTask(t: TransferTask, ok: boolean, msg: string): void {
    t.status = ok ? 'done' : 'error';
    const st = t.el.querySelector('.transfer-status') as HTMLElement;
    st.textContent = ok ? '完成' : '失败';
    t.bar.style.width = ok ? '100%' : t.bar.style.width;
    t.el.classList.add(ok ? 'transfer-done' : 'transfer-error');
    if (msg) {
        t.text.textContent = msg;
    }
    /* 成功 4 秒 / 失败 8 秒后自动移除（失败停留更久便于查看原因） */
    const hold = ok ? 4000 : 8000;
    setTimeout(() => {
        const idx = tasks.indexOf(t);
        if (idx >= 0) tasks.splice(idx, 1);
        t.el.remove();
    }, hold);
}

/* ---------------- 下载 ---------------- */

export function handleDownloadRequest(pathsText: string): void {
    /* 服务端 TRANSFER_REQUEST 下载（旧 Nautilus 扩展已移除，兼容保留） */
    void handleClipboardFilesMsg(pathsText);
}

function startDownload(path: string, name: string): void {
    const task = addTask('download', name);
    const api = getServer().apiBase;
    const url = `${api}/api/transfer/download?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`;
    fetch(url)
        .then(async (resp) => {
            if (!resp.ok) {
                let reason = `HTTP ${resp.status} ${resp.statusText || ''}`.trim();
                try {
                    const t = await resp.text();
                    if (t) reason = `${reason}：${t}`;
                } catch { /* 忽略 */ }
                finishTask(task, false, `下载失败：${reason}`);
                return;
            }
            const total = Number(resp.headers.get('Content-Length') || 0);
            task.total = total;
            const reader = resp.body!.getReader();
            const chunks: BlobPart[] = [];
            let done = 0;
            let lastT = performance.now();
            let lastD = 0;
            let speed = 0;
            for (; ;) {
                const { done: d, value } = await reader.read();
                if (d) break;
                chunks.push(value);
                done += value.byteLength;
                const now = performance.now();
                if (now - lastT > 400) {
                    speed = ((done - lastD) / (now - lastT)) * 1000;
                    lastT = now;
                    lastD = done;
                }
                updateTask(task, done, total, speed);
            }
            /* 触发浏览器保存 */
            const blob = new Blob(chunks);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(a.href);
            finishTask(task, true, '');
        })
        .catch((e) => finishTask(task, false, `下载失败：${e}`));
}

/* ---------------- 上传 ---------------- */

export function handleUploadRequest(_dir: string): void {
    /* 旧扩展触发上传（Nautilus 右键已移除）——统一走新上传入口 */
    void pickAndUpload();
}

/* 右下角错误提醒 toast（如路径权限不足被服务端拒绝） */
export function showTransferError(msg: string): void {
    let t = document.getElementById('transfer-toast') as HTMLElement | null;
    if (!t) {
        t = document.createElement('div');
        t.id = 'transfer-toast';
        t.className = 'transfer-toast';
        document.body.appendChild(t);
    }
    t.textContent = '⚠ ' + msg;
    t.classList.remove('transfer-toast-out');
    t.hidden = false;
    /* 重新触发出现动画：先移除再强制重排 */
    void t.offsetWidth;
    window.clearTimeout((t as HTMLElement & { __toast?: number }).__toast);
    (t as HTMLElement & { __toast?: number }).__toast = window.setTimeout(() => {
        t!.classList.add('transfer-toast-out');
        window.setTimeout(() => { if (t) t.hidden = true; }, 300);
    }, 4500);
}

/* 浏览器兜底：直接弹文件选择器选本地文件（Tauri 走 Rust 对话框选真实路径） */
function openFileChooser(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => {
        const files = Array.from(input.files || []);
        if (files.length > 0) uploadFiles(files);
    };
    input.click();
}

/* 多文件上传共用一个进度条：总进度 = 累计已传字节 / 全部文件总大小 */
function uploadFiles(files: File[], dir?: string): void {
    const dest = dir || ''; /* 空 = 服务端默认落到会话用户桌面 */
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    const name = files.length === 1 ? files[0].name : `上传 ${files.length} 个文件`;
    const task = addTask('upload', name);
    task.total = totalSize;
    const CHUNK = 1024 * 1024; /* 1MB/片 */
    let done = 0; /* 跨文件累计已传字节（进度用） */
    let fi = 0;
    let lastT = performance.now();
    let lastD = 0;
    let speed = 0;

    const next = (): void => {
        if (fi >= files.length) {
            finishTask(task, true, '');
            return;
        }
        const file = files[fi];
        let off = 0; /* 当前文件自己的分片偏移（服务端按此写入） */
        const sendChunk = (): void => {
            const end = Math.min(off + CHUNK, file.size);
            const blob = file.slice(off, end);
            const xhr = new XMLHttpRequest();
            xhr.open(
                'POST',
                `${getServer().apiBase}/api/transfer/upload?token=${encodeURIComponent(token)}` +
                `&dir=${encodeURIComponent(dest)}&name=${encodeURIComponent(file.name)}&offset=${off}`,
            );
            xhr.onload = () => {
                if (xhr.status !== 200) {
                    finishTask(task, false,
                        `${file.name} 上传失败：HTTP ${xhr.status} ${xhr.statusText || ''}`.trim());
                    return;
                }
                done += blob.size;
                off += blob.size;
                const now = performance.now();
                if (now - lastT > 400) {
                    speed = ((done - lastD) / (now - lastT)) * 1000;
                    lastT = now;
                    lastD = done;
                }
                updateTask(task, done, totalSize, speed);
                if (off < file.size) {
                    sendChunk();
                } else {
                    fi++;
                    next();
                }
            };
            xhr.onerror = () =>
                finishTask(task, false, `${file.name} 上传失败：网络错误`);
            xhr.send(blob);
        };
        sendChunk();
    };
    next();
}

/* ---------------- 新方案：客户端入口（复制 / 拖放 / 按钮） ---------------- */

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
    )[ch]!);
}

/* 右下角下载提示卡：远程剪贴板复制了文件（Nautilus Ctrl+C 等） */
function showClipboardDownloadCard(paths: string[]): void {
    removeClipCard();
    const card = document.createElement('div');
    card.id = 'clip-dl-card';
    card.className = 'clip-dl-card';
    const n = paths.length;
    const label = n === 1 ? (paths[0].split('/').pop() || '文件') : `${n} 个文件`;
    card.innerHTML = `
        <div class="clip-dl-head">
            <span class="clip-dl-icon">📋</span>
            <span class="clip-dl-text">已从远程复制 <b>${escapeHtml(label)}</b></span>
        </div>
        <button class="clip-dl-btn" type="button">保存到本地…</button>`;
    (card.querySelector('.clip-dl-btn') as HTMLButtonElement).onclick = () => {
        card.remove();
        void saveRemoteFiles(paths);
    };
    document.body.appendChild(card);
}
function removeClipCard(): void {
    const c = document.getElementById('clip-dl-card');
    if (c) c.remove();
}

/* 服务端推来远程复制文件列表（MSG_CLIPBOARD_FILES） */
export function handleClipboardFilesMsg(pathsText: string): void {
    const paths = pathsText.split('\n').filter((s) => s.length > 0);
    if (paths.length === 0) return;
    showClipboardDownloadCard(paths);
}

/* 保存远程文件到本地：Tauri 选目录写盘；浏览器逐文件触发下载 */
async function saveRemoteFiles(paths: string[]): Promise<void> {
    if (isTauri()) {
        let dir: string | null = null;
        try {
            dir = await invoke<string | null>('pick_save_dir');
        } catch { /* dialog 取消/异常都视为放弃 */ }
        if (!dir) return;
        await downloadRemoteToDir(paths, dir);
    } else {
        for (const p of paths) startDownload(p, p.split('/').pop() || 'file');
    }
}

/* Tauri：Rust 命令逐文件流式下载到指定本地目录 */
async function downloadRemoteToDir(paths: string[], dir: string): Promise<void> {
    const label = paths.length === 1
        ? (paths[0].split('/').pop() || 'file')
        : `下载 ${paths.length} 个文件`;
    const task = addTask('download', label);
    curTask = task;
    try {
        const res = await invoke<{ ok: boolean; msg: string }>('download_remote_files', {
            api: getServer().apiBase, token, paths, dir,
        });
        finishTask(task, res.ok, res.ok ? '已保存' : res.msg);
    } catch (e) {
        finishTask(task, false, `下载失败：${String(e)}`);
    } finally {
        if (curTask === task) curTask = null;
    }
}

/* 上传入口：Tauri 弹系统文件选择；浏览器兜底 input[type=file] */
async function pickAndUpload(): Promise<void> {
    if (isTauri()) {
        let paths: string[] = [];
        try {
            paths = await invoke<string[]>('pick_upload_files');
        } catch (e) {
            showTransferError(`选择文件失败：${String(e)}`);
            return;
        }
        if (!paths || paths.length === 0) return; /* 用户取消 */
        await uploadLocalToRemote(paths);
    } else {
        openFileChooser();
    }
}

async function uploadLocalToRemote(paths: string[]): Promise<void> {
    const label = paths.length === 1
        ? (paths[0].split('/').pop() || 'file')
        : `上传 ${paths.length} 个文件`;
    const task = addTask('upload', label);
    curTask = task;
    try {
        const res = await invoke<{ ok: boolean; msg: string }>('upload_local_files', {
            api: getServer().apiBase, token, dir: remoteDesktop, files: paths,
        });
        finishTask(task, res.ok, res.ok
            ? (res.msg ? `已上传${res.msg ? '到 ' + res.msg : ''}` : '完成')
            : res.msg);
    } catch (e) {
        finishTask(task, false, `上传失败：${String(e)}`);
    } finally {
        if (curTask === task) curTask = null;
    }
}

/* 拖放高亮遮罩 */
function showDropOverlay(on: boolean): void {
    let ov = document.getElementById('drop-overlay') as HTMLElement | null;
    if (on) {
        if (!ov) {
            ov = document.createElement('div');
            ov.id = 'drop-overlay';
            ov.className = 'drop-overlay';
            ov.innerHTML = '<div class="drop-inner"><div class="drop-icon">⬇</div>' +
                '<div>松开以发送文件到远程桌面</div></div>';
            document.body.appendChild(ov);
        }
        ov.classList.add('show');
    } else if (ov) {
        ov.classList.remove('show');
    }
}

let progressUnlisten: UnlistenFn | null = null;
let dragUnlisten: UnlistenFn | null = null;
/* Tauri：订阅 Rust 侧事件（传输进度 + 窗口拖放），仅绑定一次 */
async function bindTauriEvents(): Promise<void> {
    if (!isTauri()) return;
    try {
        if (!progressUnlisten) {
            progressUnlisten = await listen<{ done: number; total: number }>(
                'xwd-transfer-progress',
                (e) => {
                    if (curTask) updateTask(curTask, e.payload.done, e.payload.total, 0);
                },
            );
        }
        if (!dragUnlisten) {
            /* Tauri 框架内置拖放事件（tauri://drag-enter/over/drop/leave） */
            dragUnlisten = await getCurrentWebview().onDragDropEvent((e) => {
                const p = e.payload;
                if (p.type === 'enter' || p.type === 'over') {
                    showDropOverlay(true);
                } else if (p.type === 'leave') {
                    showDropOverlay(false);
                } else if (p.type === 'drop') {
                    showDropOverlay(false);
                    const paths = p.paths.filter((s) => s.length > 0);
                    if (paths.length > 0) void uploadLocalToRemote(paths);
                }
            });
        }
    } catch { /* 非 Tauri 或事件系统异常：忽略 */ }
}

let transferUiInited = false;
/* 登录成功后调用：显示上传按钮与拖放区（只建一次 DOM） */
export function initTransferUi(): void {
    if (!transferUiInited) {
        transferUiInited = true;
        const bar = document.createElement('div');
        bar.id = 'xwd-upload-ui';
        bar.innerHTML =
            '<button id="xwd-upload-btn" type="button" title="选择本地文件上传到远程桌面">⬆ 上传</button>' +
            '<div id="xwd-upload-tip"></div>';
        (bar.querySelector('#xwd-upload-btn') as HTMLButtonElement).onclick = () => { void pickAndUpload(); };
        document.body.appendChild(bar);
        void bindTauriEvents();
    }
    const tip = document.getElementById('xwd-upload-tip');
    if (tip) tip.textContent = remoteDesktop ? `发送到远程桌面 ${remoteDesktop}` : '发送到远程桌面';
}
