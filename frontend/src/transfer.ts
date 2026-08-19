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
    if (!ok && msg) {
        t.text.textContent = msg;
    }
    /* 完成 4 秒后自动移除 */
    setTimeout(() => {
        const idx = tasks.indexOf(t);
        if (idx >= 0) tasks.splice(idx, 1);
        t.el.remove();
    }, 4000);
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
                finishTask(task, false, `HTTP ${resp.status}`);
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
        .catch((e) => finishTask(task, false, String(e)));
}

/* ---------------- 上传 ---------------- */

export function handleUploadRequest(dir: string): void {
    showUploadPicker(dir);
}

/* 上传前先显示确认面板：浏览器禁止无用户手势弹文件选择器（扩展经 WS 触发的
 * 请求不是用户手势），用户点击"选择文件"按钮后即有手势，可正常弹出。 */
function showUploadPicker(dir: string): void {
    let mask = document.getElementById('upload-picker-mask') as HTMLElement | null;
    if (!mask) {
        mask = document.createElement('div');
        mask.id = 'upload-picker-mask';
        mask.className = 'modal-mask';
        mask.innerHTML = `
            <div class="modal-box">
                <div class="modal-title">上传文件</div>
                <div class="modal-text" id="upload-picker-dir"></div>
                <div class="modal-btns">
                    <button class="modal-btn modal-btn-cancel" id="upload-picker-cancel">取消</button>
                    <button class="modal-btn modal-btn-ok" id="upload-picker-ok">选择文件</button>
                </div>
            </div>`;
        document.body.appendChild(mask);
    }
    (document.getElementById('upload-picker-dir') as HTMLElement).textContent =
        `上传到目录：${dir}`;
    mask.hidden = false;
    const ok = document.getElementById('upload-picker-ok') as HTMLButtonElement;
    const cancel = document.getElementById('upload-picker-cancel') as HTMLButtonElement;
    const done = () => {
        mask.hidden = true;
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
    };
    const onOk = () => {
        done();
        /* 用户手势内弹文件选择器 */
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = () => {
            const files = Array.from(input.files || []);
            for (const f of files) uploadFile(f, dir);
        };
        input.click();
    };
    const onCancel = () => done();
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
}

function uploadFile(file: File, dir: string): void {
    const task = addTask('upload', file.name);
    const CHUNK = 1024 * 1024; /* 1MB/片 */
    const total = file.size;
    task.total = total;
    let offset = 0;
    let lastT = performance.now();
    let lastD = 0;
    let speed = 0;

    const sendChunk = (): void => {
        const end = Math.min(offset + CHUNK, total);
        const blob = file.slice(offset, end);
        const xhr = new XMLHttpRequest();
        xhr.open(
            'POST',
            `/api/transfer/upload?token=${encodeURIComponent(token)}` +
            `&dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}&offset=${offset}`,
        );
        xhr.onload = () => {
            if (xhr.status !== 200) {
                finishTask(task, false, `HTTP ${xhr.status}`);
                return;
            }
            offset += blob.size;
            const now = performance.now();
            if (now - lastT > 400) {
                speed = ((offset - lastD) / (now - lastT)) * 1000;
                lastT = now;
                lastD = offset;
            }
            updateTask(task, offset, total, speed);
            if (offset < total) {
                sendChunk();
            } else {
                finishTask(task, true, '');
            }
        };
        xhr.onerror = () => finishTask(task, false, '网络错误');
        xhr.send(blob);
    };
    sendChunk();
}
