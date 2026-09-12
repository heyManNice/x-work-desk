/* platform.ts —— Electron 桌面壳能力桥（原 Tauri invoke 的替代层）。
 * preload 通过 contextBridge 暴露 window.xwd（主进程实现剪贴板/窗口控制/SSH/SFTP）。
 * 注：文件传输只走 SFTP 面板，不经 HTTP（服务端已不提供传输接口）。
 */

interface DesktopBridge {
    platform?: string;
    ping?(opt: { host: string; port?: number }): Promise<number>;
    aboutHostInfo?(opt: SshServerOpt): Promise<{ ok: boolean; msg?: string; os?: string; de?: string; deVersion?: string; shell?: string }>;
    clipWriteText(text: string): Promise<void>;
    clipPoll(): Promise<{ text: string | null }>;
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
    sys?: {
        open(opt: { id: string; host: string; port: number; user: string; pass?: string }): Promise<{ ok: boolean; msg?: string }>;
        sample(id: string): Promise<SysSample>;
        close(id: string): void;
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

/* TCP 连通性探测：返回连接耗时毫秒；不可达/无桌面壳返回 -1 */
export async function pingHost(host: string, port?: number): Promise<number> {
    const b = bridge();
    if (b && typeof b.ping === 'function') {
        try { return await b.ping({ host, port }); } catch { /* 忽略 */ }
    }
    return -1;
}

export function isMac(): boolean {
    return platform() === 'darwin';
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

/* 读本地剪贴板文本 */
export async function clipPoll(): Promise<{ text: string | null }> {
    return (await bridge()?.clipPoll()) ?? { text: null };
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

export interface AboutHostInfo {
    os?: string;
    de?: string;
    deVersion?: string;
    shell?: string;
}

/* “关于”：SSH 采集远端系统 / 桌面环境 / shell 版本 */
export async function sshHostAboutInfo(opt: SshServerOpt): Promise<AboutHostInfo> {
    const b = bridge();
    if (b && typeof b.aboutHostInfo === 'function') {
        try {
            const r = await b.aboutHostInfo(opt);
            if (r && r.ok) return { os: r.os, de: r.de, deVersion: r.deVersion, shell: r.shell };
        } catch { /* 忽略 */ }
    }
    return {};
}

/* ---- 系统监控（SSH 采集远端资源，浏览器无桥为空实现） ---- */

export interface SysSample {
    ok: boolean;
    msg?: string;
    cpu: number;                    /* 使用率 % */
    cores: number;                  /* 逻辑核数 */
    model: string;                  /* CPU 型号 */
    cpuProcs: Array<{ name: string; cpuPct: number }>;   /* CPU 占用 Top */
    mem: {
        total: number; avail: number;   /* kB */
        buffers: number; cached: number;
        swapTotal: number; swapFree: number;
    };
    procs: Array<{ name: string; rss: number }>;  /* rss: kB，内存占用 Top */
    disks: Array<{ mount: string; totalKB: number; usedKB: number; availKB: number; pct: number }>;
}

export async function sysOpen(opt: { id: string; host: string; port: number; user: string; pass?: string }): Promise<{ ok: boolean; msg?: string }> {
    const b = bridge()?.sys;
    if (!b) return { ok: false, msg: '桌面桥不可用' };
    return b.open(opt);
}

export async function sysSample(id: string): Promise<SysSample> {
    const b = bridge()?.sys;
    if (!b) return {
        ok: false, cpu: 0, cores: 0, model: '', cpuProcs: [],
        mem: { total: 0, avail: 0, buffers: 0, cached: 0, swapTotal: 0, swapFree: 0 },
        procs: [], disks: [],
    };
    return b.sample(id);
}

export function sysClose(id: string): void {
    bridge()?.sys?.close(id);
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
