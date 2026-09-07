/* platform.ts —— 桌面壳能力桥（原 Tauri invoke 的替代层）。
 *
 * Electron：preload 通过 contextBridge 暴露 window.xwd（主进程实现剪贴板/传输）。
 * 浏览器（同源部署兜底）：文本剪贴板回退 navigator.clipboard；文件传输不可用。
 */

export interface TransferProgress {
    done: number;
    total: number;
    name: string;
}

interface DesktopBridge {
    platform?: string;
    clipWriteText(text: string): Promise<void>;
    clipPoll(): Promise<{ text: string | null; files: string[] }>;
    downloadRemoteFiles(opt: {
        api: string; token: string; paths: string[];
    }): Promise<{ ok: boolean; msg: string }>;
    uploadLocalFiles(opt: {
        api: string; token: string; dir: string; files: string[];
    }): Promise<{ ok: boolean; msg: string }>;
    onTransferProgress(cb: (p: TransferProgress) => void): () => void;
    windowControl?: {
        minimize(): void;
        toggleMaximize(): void;
        close(): void;
        isMaximized(): Promise<boolean>;
        onMaximizeChange(cb: (maxed: boolean) => void): () => void;
    };
    ssh?: {
        connect(opt: { id: string; host: string; port: number; user: string; pass?: string }): Promise<{ ok: boolean; msg?: string }>;
        write(id: string, data: string | Uint8Array): void;
        resize(id: string, cols: number, rows: number): void;
        close(id: string): void;
        onData(id: string, cb: (data: Uint8Array) => void): () => void;
        onClose(id: string, cb: (code: number) => void): () => void;
    };
}

function bridge(): DesktopBridge | null {
    if (typeof window !== 'undefined' && (window as unknown as { xwd?: DesktopBridge }).xwd) {
        return (window as unknown as { xwd: DesktopBridge }).xwd;
    }
    return null;
}

/* 是否运行在桌面壳（Electron）内 */
export function isDesktop(): boolean {
    return bridge() !== null;
}

/* 平台：darwin / win32 / linux / 浏览器返回空串 */
export function platform(): string {
    return bridge()?.platform || '';
}

export function isMac(): boolean {
    return platform() === 'darwin';
}

/* 订阅传输进度；返回取消函数（桌面壳，渲染层调用一次即可） */
export function onTransferProgress(cb: (p: TransferProgress) => void): () => void {
    const b = bridge();
    if (!b) return () => { /* 无桌面壳：无进度事件 */ };
    return b.onTransferProgress(cb);
}

/* ---- 窗口控制（自制标题栏；浏览器内为空操作） ---- */

export function winMinimize(): void {
    bridge()?.windowControl?.minimize();
}

export function winToggleMaximize(): void {
    bridge()?.windowControl?.toggleMaximize();
}

export function winClose(): void {
    bridge()?.windowControl?.close();
}

export async function winIsMaximized(): Promise<boolean> {
    try {
        return await bridge()?.windowControl?.isMaximized() ?? false;
    } catch {
        return false;
    }
}

/* 订阅最大化状态变化，返回取消函数 */
export function onWinMaximizeChange(cb: (maxed: boolean) => void): () => void {
    const b = bridge()?.windowControl;
    if (!b) return () => { /* 忽略 */ };
    return b.onMaximizeChange(cb);
}

/* 写系统剪贴板（桌面壳无 WebView 权限弹窗；浏览器回退 navigator.clipboard） */
export async function clipWriteText(text: string): Promise<void> {
    const b = bridge();
    if (b) { await b.clipWriteText(text); return; }
    await navigator.clipboard.writeText(text);
}

/* 读本地剪贴板：文本 + 检测本地复制的文件（桌面壳）；浏览器无文件检测 */
export async function clipPoll(): Promise<{ text: string | null; files: string[] }> {
    const b = bridge();
    if (b) return b.clipPoll();
    let text: string | null = null;
    try {
        text = await navigator.clipboard.readText();
    } catch { /* 忽略 */ }
    return { text, files: [] };
}

/* 自动下载远程文件到系统下载目录（仅桌面壳；返回 {ok,msg} 给调用方展示） */
export async function downloadRemoteFiles(opt: {
    api: string; token: string; paths: string[];
}): Promise<{ ok: boolean; msg: string }> {
    const b = bridge();
    if (!b) return { ok: false, msg: '浏览器环境不支持自动下载到磁盘' };
    return b.downloadRemoteFiles(opt);
}

/* 自动上传本地文件到远程桌面（仅桌面壳） */
export async function uploadLocalFiles(opt: {
    api: string; token: string; dir: string; files: string[];
}): Promise<{ ok: boolean; msg: string }> {
    const b = bridge();
    if (!b) return { ok: false, msg: '浏览器环境不支持自动上传' };
    return b.uploadLocalFiles(opt);
}

/* ---- SSH 终端（桌面壳主进程 ssh2；浏览器不可用） ---- */

export function sshConnect(opt: {
    id: string; host: string; port: number; user: string; pass?: string;
}): Promise<{ ok: boolean; msg?: string }> {
    const b = bridge();
    if (!b) return Promise.resolve({ ok: false, msg: '桌面壳环境不支持 SSH' });
    return b.ssh ? b.ssh.connect(opt) : Promise.resolve({ ok: false, msg: 'SSH 不可用' });
}

export function sshWrite(id: string, data: string | Uint8Array): void {
    bridge()?.ssh?.write(id, data);
}

export function sshResize(id: string, cols: number, rows: number): void {
    bridge()?.ssh?.resize(id, cols, rows);
}

export function sshClose(id: string): void {
    bridge()?.ssh?.close(id);
}

export function sshOnData(id: string, cb: (data: Uint8Array) => void): () => void {
    const b = bridge()?.ssh;
    return b ? b.onData(id, cb) : () => { /* 忽略 */ };
}

export function sshOnClose(id: string, cb: (code: number) => void): () => void {
    const b = bridge()?.ssh;
    return b ? b.onClose(id, cb) : () => { /* 忽略 */ };
}
