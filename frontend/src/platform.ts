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
    clipWriteText(text: string): Promise<void>;
    clipPoll(): Promise<{ text: string | null; files: string[] }>;
    downloadRemoteFiles(opt: {
        api: string; token: string; paths: string[];
    }): Promise<{ ok: boolean; msg: string }>;
    uploadLocalFiles(opt: {
        api: string; token: string; dir: string; files: string[];
    }): Promise<{ ok: boolean; msg: string }>;
    onTransferProgress(cb: (p: TransferProgress) => void): () => void;
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

/* 订阅传输进度；返回取消函数（桌面壳，渲染层调用一次即可） */
export function onTransferProgress(cb: (p: TransferProgress) => void): () => void {
    const b = bridge();
    if (!b) return () => { /* 无桌面壳：无进度事件 */ };
    return b.onTransferProgress(cb);
}
