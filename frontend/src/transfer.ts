/* transfer.ts —— 文件传输（HTTP 数据面）+ 右下角传输队列进度条。
 * 控制面由服务端经 WS 推送（MSG_TRANSFER_TOKEN / MSG_TRANSFER_REQUEST），
 * 数据面走 HTTP：
 *   下载：GET /api/transfer/download?token&path（fetch + ReadableStream 流式）
 *   上传：POST /api/transfer/upload?token&dir&name&offset（XHR 分片，1MB/片）
 */

let token = '';

export function setTransferToken(t: string): void {
    token = t;
}

/* 记录最近一次真实用户交互时间：浏览器要求用户激活才能弹文件选择器。
 * 用户在远程桌面右键触发上传时，WS 推送返回通常仍在激活窗口（约 5s）内，
 * 据此决定是直接弹选择器还是先显示右下角提示条。 */
let lastGestureAt = 0;
window.addEventListener('pointerdown', () => { lastGestureAt = performance.now(); }, { passive: true });
window.addEventListener('pointerup', () => { lastGestureAt = performance.now(); }, { passive: true });
window.addEventListener('keydown', () => { lastGestureAt = performance.now(); }, { passive: true });

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
    const paths = pathsText.split('\n').filter((s) => s.length > 0);
    for (const p of paths) {
        const name = p.split('/').pop() || 'file';
        startDownload(p, name);
    }
}

function startDownload(path: string, name: string): void {
    const task = addTask('download', name);
    const url = `/api/transfer/download?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`;
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

export function handleUploadRequest(dir: string): void {
    openFileChooser(dir);
}

function openFileChooser(dir: string): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => {
        const files = Array.from(input.files || []);
        if (files.length > 0) uploadFiles(files, dir);
    };
    /* 浏览器要求用户激活才能弹文件选择器：用户在远程桌面右键触发上传时，
     * 距最近一次真实交互（pointerdown 等）通常仍在激活窗口（约 5s）内，
     * 直接 click 即可弹出，无需中间弹窗。超出窗口则显示右下角轻量提示条，
     * 点击后再弹（点击本身提供激活）。 */
    if (performance.now() - lastGestureAt < 3000) {
        input.click();
    } else {
        showChooserHint(dir, input);
    }
}

/* 右下角轻量提示条（非居中弹窗），点击后弹文件选择器 */
function showChooserHint(dir: string, input: HTMLInputElement): void {
    let hint = document.getElementById('upload-hint') as HTMLElement | null;
    if (!hint) {
        hint = document.createElement('div');
        hint.id = 'upload-hint';
        hint.className = 'upload-hint';
        document.body.appendChild(hint);
    }
    hint.textContent = `点击选择文件上传到 ${dir}`;
    hint.hidden = false;
    const close = () => {
        hint.hidden = true;
        hint.removeEventListener('click', onClick);
    };
    const onClick = () => {
        close();
        input.click(); /* 用户手势内弹选择器 */
    };
    hint.addEventListener('click', onClick);
    setTimeout(close, 10000); /* 10s 自动消失 */
}

/* 多文件上传共用一个进度条：总进度 = 累计已传字节 / 全部文件总大小 */
function uploadFiles(files: File[], dir: string): void {
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
                `/api/transfer/upload?token=${encodeURIComponent(token)}` +
                `&dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}&offset=${off}`,
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
