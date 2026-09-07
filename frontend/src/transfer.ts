/* transfer.ts —— 传输 UI 通用件（非会话绑定）：
 *   - 右下角传输队列（下载/上传进度任务卡片）
 *   - 错误提示 toast
 * 会话层（core/session.ts）通过 transferTask() 句柄驱动队列。
 */

export interface TransferTaskHandle {
    /* 更新进度（字节） */
    set(done: number, total: number, speed?: number): void;
    /* 结束任务；ok=false 显示原因并停留更久 */
    finish(ok: boolean, msg?: string): void;
}

interface TaskRec {
    kind: 'download' | 'upload';
    el: HTMLElement;
    bar: HTMLElement;
    meta: HTMLElement;
    status: HTMLElement;
    doneFlag: boolean;
    holdTimer: number;
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

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

export function transferTask(kind: 'download' | 'upload', name: string): TransferTaskHandle {
    const q = ensureQueue();
    const el = document.createElement('div');
    el.className = 'transfer-item';
    const icon = kind === 'download' ? '⬇' : '⬆';
    el.innerHTML = `
        <div class="transfer-head">
            <span class="transfer-icon">${icon}</span>
            <span class="transfer-name" title="${name.replace(/"/g, '&quot;')}">${name}</span>
            <span class="transfer-status">等待</span>
        </div>
        <div class="transfer-track"><div class="transfer-bar"></div></div>
        <div class="transfer-meta"></div>`;
    q.appendChild(el);
    const rec: TaskRec = {
        kind,
        el,
        bar: el.querySelector('.transfer-bar') as HTMLElement,
        meta: el.querySelector('.transfer-meta') as HTMLElement,
        status: el.querySelector('.transfer-status') as HTMLElement,
        doneFlag: false,
        holdTimer: 0,
    };
    return {
        set(done: number, total: number, speed = 0): void {
            if (rec.doneFlag) return;
            const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
            rec.bar.style.width = `${pct}%`;
            const sp = speed > 0 ? `　${fmtBytes(speed)}/s` : '';
            rec.status.textContent = total > 0 ? `${pct.toFixed(0)}%` : '…';
            rec.meta.textContent = `${fmtBytes(done)} / ${fmtBytes(total)}${sp}`;
        },
        finish(ok: boolean, msg = ''): void {
            if (rec.doneFlag) return;
            rec.doneFlag = true;
            rec.status.textContent = ok ? '完成' : '失败';
            rec.bar.style.width = ok ? '100%' : rec.bar.style.width;
            el.classList.add(ok ? 'transfer-done' : 'transfer-error');
            if (msg) rec.meta.textContent = msg;
            const hold = ok ? 4000 : 8000;
            rec.holdTimer = window.setTimeout(() => el.remove(), hold);
        },
    };
}

/* 右下角错误提醒 toast */
export function showTransferError(msg: string): void {
    let t = document.getElementById('transfer-toast') as HTMLElement | null;
    if (!t) {
        t = document.createElement('div');
        t.id = 'transfer-toast';
        t.className = 'transfer-toast';
        document.body.appendChild(t);
    }
    t.textContent = '⚠ ' + msg;
    t.hidden = false;
    window.clearTimeout((t as unknown as { __t?: number }).__t);
    (t as unknown as { __t?: number }).__t = window.setTimeout(() => {
        t!.hidden = true;
    }, 4500);
}
