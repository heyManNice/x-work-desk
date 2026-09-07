/* transfer.ts —— 剪贴板驱动传输（纯自动：无上传按钮、无拖拽、无弹窗/授权框）。
 *
 * 剪贴板共享 = 文本与文件的唯一传输通道，全程自动：
 *   - 远程复制文件 → 服务端推送 MSG_CLIPBOARD_FILES → 自动下载到本地下载目录
 *   - 远程剪贴板文本 → 自动写入本地系统剪贴板（Tauri 插件，无 WebView 权限弹窗）
 *   - 本地复制文件 → Tauri 检测系统剪贴板 uri-list → 自动上传远程桌面
 *   - 本地复制文本 → 自动同步到远程剪贴板
 * 浏览器（同源兜底）：文本回退 navigator.clipboard；下载回退 blob 保存
 */

import { getServer } from './server';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

let token = '';

export function setTransferToken(t: string): void {
    token = t;
}

/* 服务端下发的会话桌面目录（本地文件上传自动落点；空则服务端默认 ~/Desktop） */
let remoteDesktop = '';
export function setSessionDirs(text: string): void {
    const lines = text.split('\n').filter((s) => s.length > 0);
    for (let i = 0; i + 1 < lines.length; i += 2) {
        if (lines[i] === 'desktop') remoteDesktop = lines[i + 1];
    }
}

export function isTauri(): boolean {
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

/* ---------------- 上传（仅由本地剪贴板检测自动触发，无显式入口） ---------------- */

/* 旧协议上传请求（Nautilus 右键扩展已移除）——无来源，保留空实现防误调 */
export function handleUploadRequest(_dir: string): void {
    /* 忽略 */
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

/* 浏览器兜底上传不再需要：上传仅由本地剪贴板检测自动触发（Tauri）。 */

/* ---------------- 剪贴板自动传输（无按钮/拖拽/对话框） ---------------- */

/* ---------------- 剪贴板自动传输（无按钮/拖拽/对话框） ---------------- */

/* 服务端推来远程复制文件列表（MSG_CLIPBOARD_FILES）→ 自动下载到本地下载目录 */
export function handleClipboardFilesMsg(pathsText: string): void {
    const paths = pathsText.split('\n').filter((s) => s.length > 0);
    if (paths.length === 0) return;
    if (isTauri()) {
        void downloadRemoteAuto(paths);
    } else {
        for (const p of paths) startDownload(p, p.split('/').pop() || 'file');
    }
}

/* Tauri：自动下载到系统下载目录（不弹任何选择框） */
async function downloadRemoteAuto(paths: string[]): Promise<void> {
    const label = paths.length === 1
        ? (paths[0].split('/').pop() || 'file')
        : `下载 ${paths.length} 个文件`;
    const task = addTask('download', label);
    curTask = task;
    try {
        const res = await invoke<{ ok: boolean; msg: string }>('download_remote_files', {
            api: getServer().apiBase, token, paths,
        });
        finishTask(task, res.ok, res.msg);
    } catch (e) {
        finishTask(task, false, `下载失败：${String(e)}`);
    } finally {
        if (curTask === task) curTask = null;
    }
}

/* 本地复制文件（Tauri 检测到系统剪贴板 uri-list）→ 自动上传远程桌面 */
let lastUploadSig = '';
export function uploadLocalFiles(paths: string[]): void {
    if (!paths || paths.length === 0) return;
    const sig = [...paths].sort().join('\u0000');
    if (sig === lastUploadSig) return; /* 同一批不重复触发 */
    lastUploadSig = sig;
    const label = paths.length === 1
        ? (paths[0].split('/').pop() || 'file')
        : `上传 ${paths.length} 个文件`;
    const task = addTask('upload', label);
    curTask = task;
    invoke<{ ok: boolean; msg: string }>('upload_local_files', {
        api: getServer().apiBase, token, dir: remoteDesktop, files: paths,
    })
        .then((res) => finishTask(task, res.ok, res.msg))
        .catch((e) => finishTask(task, false, `上传失败：${String(e)}`))
        .finally(() => { if (curTask === task) curTask = null; });
}

/* Tauri：订阅传输进度事件（登录成功后调用一次即可） */
let progressUnlisten: UnlistenFn | null = null;
let tauriBound = false;
export function initTransferUi(): void {
    if (!isTauri() || tauriBound) return;
    tauriBound = true;
    void listen<{ done: number; total: number }>(
        'xwd-transfer-progress',
        (e) => { if (curTask) updateTask(curTask, e.payload.done, e.payload.total, 0); },
    ).then((u) => { progressUnlisten = u; }).catch(() => { /* 忽略 */ });
}
