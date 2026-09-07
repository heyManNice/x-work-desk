/* platform.ts —— Electron 桌面壳能力桥（原 Tauri invoke 的替代层）。
 * preload 通过 contextBridge 暴露 window.xwd（主进程实现剪贴板/传输/窗口控制/SSH/SFTP）。
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
        setFullScreen(on: boolean): Promise<boolean>;
        isFullScreen(): Promise<boolean>;
        onFullScreenChange(cb: (fs: boolean) => void): () => void;
    };
    ssh?: {
        connect(opt: { id: string; host: string; port: number; user: string; pass?: string }): Promise<{ ok: boolean; msg?: string }>;
        write(id: string, data: string | Uint8Array): void;
        resize(id: string, cols: number, rows: number): void;
        close(id: string): void;
        onData(id: string, cb: (data: Uint8Array) => void): () => void;
        onClose(id: string, cb: (code: number) => void): () => void;
        probe(opt: { host: string; port: number; user: string; pass?: string }): Promise<{ ok: boolean; status: string; msg?: string }>;
        startServer(opt: { host: string; port: number; user: string; pass?: string }): Promise<{ ok: boolean; needSudo?: boolean; msg?: string }>;
        installServer(opt: { host: string; port: number; user: string; pass?: string }): Promise<{ ok: boolean; needSudo?: boolean; msg?: string }>;
        onInstallProgress?(cb: (p: { stage?: string; pct: number | null; label?: string }) => void): () => void;
    };
    file?: {
        open(c: FmCred): Promise<FmOpenRes>;
        list(id: number, path: string): Promise<FmListRes>;
        mkdir(id: number, path: string): Promise<FmSimple>;
        rename(id: number, from: string, to: string): Promise<FmSimple>;
        remove(id: number, path: string, isDir: boolean): Promise<FmSimple>;
        upload(id: number, dir: string): Promise<FmUploadRes>;
        download(id: number, path: string): Promise<FmDownRes>;
        close(id: number): Promise<FmSimple>;
    };
}

function bridge(): DesktopBridge | null {
    if (typeof window !== 'undefined' && (window as unknown as { xwd?: DesktopBridge }).xwd) {
        return (window as unknown as { xwd: DesktopBridge }).xwd;
    }
    return null;
}

/* 平台：darwin / win32 / linux */
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

/* ---- 窗口控制（自制标题栏） ---- */

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

/* 窗口级全屏（沉浸模式）：Electron setFullScreen，DOM 全保留，弹层/面板仍可用 */
export async function winSetFullScreen(on: boolean): Promise<void> {
    try { await bridge()?.windowControl?.setFullScreen(on); } catch { /* 忽略 */ }
}

export async function winIsFullScreen(): Promise<boolean> {
    try { return await bridge()?.windowControl?.isFullScreen() ?? false; } catch { return false; }
}

export function onWinFullScreenChange(cb: (fs: boolean) => void): () => void {
    const b = bridge()?.windowControl;
    if (!b) return () => { /* 忽略 */ };
    return b.onFullScreenChange(cb);
}

/* 写系统剪贴板 */
export async function clipWriteText(text: string): Promise<void> {
    await bridge()?.clipWriteText(text);
}

/* 读本地剪贴板：文本 + 检测本地复制的文件 */
export async function clipPoll(): Promise<{ text: string | null; files: string[] }> {
    return (await bridge()?.clipPoll()) ?? { text: null, files: [] };
}

/* 自动下载远程文件到系统下载目录（返回 {ok,msg} 给调用方展示） */
export async function downloadRemoteFiles(opt: {
    api: string; token: string; paths: string[];
}): Promise<{ ok: boolean; msg: string }> {
    const b = bridge();
    if (!b) return { ok: false, msg: '桌面桥不可用' };
    return b.downloadRemoteFiles(opt);
}

/* 自动上传本地文件到远程桌面 */
export async function uploadLocalFiles(opt: {
    api: string; token: string; dir: string; files: string[];
}): Promise<{ ok: boolean; msg: string }> {
    const b = bridge();
    if (!b) return { ok: false, msg: '桌面桥不可用' };
    return b.uploadLocalFiles(opt);
}

/* ---- SSH 终端（ssh2 由桌面壳主进程承载） ---- */

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

/* 服务探测 / 启动 / 一键安装（桌面连接前引导） */
export interface SshServerOpt {
    host: string; port: number; user: string; pass?: string;
}

export async function sshProbeServer(opt: SshServerOpt): Promise<{ ok: boolean; status: string; msg?: string }> {
    const b = bridge()?.ssh;
    if (!b) return { ok: false, status: 'unsupported', msg: '桌面壳环境不支持 SSH' };
    return b.probe(opt);
}

export async function sshStartServer(opt: SshServerOpt): Promise<{ ok: boolean; needSudo?: boolean; msg?: string }> {
    const b = bridge()?.ssh;
    if (!b) return { ok: false, msg: '桌面壳环境不支持 SSH' };
    return b.startServer(opt);
}

export async function sshInstallServer(opt: SshServerOpt): Promise<{ ok: boolean; needSudo?: boolean; msg?: string }> {
    const b = bridge()?.ssh;
    if (!b) return { ok: false, msg: '桌面壳环境不支持 SSH' };
    return b.installServer(opt);
}

export interface SshInstallProgress {
    stage?: string;
    pct: number | null;
    label?: string;
}

export function sshOnInstallProgress(cb: (p: SshInstallProgress) => void): () => void {
    const b = bridge()?.ssh;
    return b && b.onInstallProgress ? b.onInstallProgress(cb) : () => { /* 忽略 */ };
}

/* ---------------- 远程文件面板（SFTP） ---------------- */

export interface FmCred {
    id: number;
    host: string;
    port: number;
    user: string;
    pass?: string;
}

export interface FmEntry {
    name: string;
    isDir: boolean;
    size: number;
    mtime: number;
}

export interface FmOpenRes { ok: boolean; cwd?: string; entries?: FmEntry[]; msg?: string; }
export interface FmListRes { ok: boolean; cwd?: string; entries?: FmEntry[]; msg?: string; }
export interface FmSimple { ok: boolean; msg?: string; }
export interface FmUploadRes { ok: boolean; canceled?: boolean; uploaded?: string[]; msg?: string; }
export interface FmDownRes { ok: boolean; dest?: string; name?: string; msg?: string; }

export async function fmOpen(c: FmCred): Promise<FmOpenRes> {
    const b = bridge()?.file;
    if (!b) return { ok: false, msg: '桌面壳环境不支持远程文件' };
    return b.open(c);
}
export async function fmList(id: number, path: string): Promise<FmListRes> {
    const b = bridge()?.file;
    if (!b) return { ok: false, msg: '桌面壳环境不支持远程文件' };
    return b.list(id, path);
}
export async function fmMkdir(id: number, path: string): Promise<FmSimple> {
    const b = bridge()?.file;
    if (!b) return { ok: false, msg: '桌面壳环境不支持远程文件' };
    return b.mkdir(id, path);
}
export async function fmRename(id: number, from: string, to: string): Promise<FmSimple> {
    const b = bridge()?.file;
    if (!b) return { ok: false, msg: '桌面壳环境不支持远程文件' };
    return b.rename(id, from, to);
}
export async function fmRemove(id: number, path: string, isDir: boolean): Promise<FmSimple> {
    const b = bridge()?.file;
    if (!b) return { ok: false, msg: '桌面壳环境不支持远程文件' };
    return b.remove(id, path, isDir);
}
export async function fmUpload(id: number, dir: string): Promise<FmUploadRes> {
    const b = bridge()?.file;
    if (!b) return { ok: false, msg: '桌面壳环境不支持远程文件' };
    return b.upload(id, dir);
}
export async function fmDownload(id: number, path: string): Promise<FmDownRes> {
    const b = bridge()?.file;
    if (!b) return { ok: false, msg: '桌面壳环境不支持远程文件' };
    return b.download(id, path);
}
export async function fmClose(id: number): Promise<FmSimple> {
    const b = bridge()?.file;
    if (!b) return { ok: false, msg: '桌面壳环境不支持远程文件' };
    return b.close(id);
}
