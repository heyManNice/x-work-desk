/* preload.cts —— 通过 contextBridge 向渲染层暴露 window.xwd（最小能力面）。
 *
 * 类型复用主进程各模块导出的定义（一律 import type，编译后完全擦除，
 * 不会把主进程代码带进 preload）；通道名须与 electron/ipc/index.cts 保持一致。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { PingOpt, ClipData } from './ipc/system.cjs';
import type { SshCred, SshResult, SftpOpenResult, SftpListResult } from './ssh/types.cjs';
import type { SshTermOpt } from './ssh/terminal.cjs';
import type { SysOpenOpt, SysSample } from './ssh/sysmon.cjs';
import type {
    SftpOpenOpt, SftpPathOpt, SftpRenameOpt, SftpRemoveOpt, SftpUploadOpt,
    SftpUploadResult, SftpDownloadResult,
} from './ssh/sftp.cjs';
import type { ProbeResult, InstallResult, AboutResult, InstallProgress } from './ssh/setup.cjs';

contextBridge.exposeInMainWorld('xwd', {
    /* 平台：darwin / win32 / linux */
    platform: process.platform,
    /* TCP 连通性探测（主机列表状态点） */
    ping: (opt: PingOpt): Promise<number> => ipcRenderer.invoke('xwd:ping', opt),
    /* “关于”：SSH 采集远端系统 / 桌面环境版本 */
    aboutHostInfo: (opt: SshCred): Promise<AboutResult> => ipcRenderer.invoke('xwd:about:hostinfo', opt),
    /* 剪贴板 */
    clipWriteText: (text: string): Promise<void> => ipcRenderer.invoke('xwd:clipWriteText', text),
    clipPoll: (): Promise<ClipData> => ipcRenderer.invoke('xwd:clipPoll'),
    /* 窗口控制（自制标题栏） */
    windowControl: {
        minimize: (): void => ipcRenderer.send('xwd:winMin'),
        toggleMaximize: (): void => ipcRenderer.send('xwd:winMaxToggle'),
        close: (): void => ipcRenderer.send('xwd:winClose'),
        isMaximized: (): Promise<boolean> => ipcRenderer.invoke('xwd:winIsMax'),
        onMaximizeChange: (cb: (maxed: boolean) => void): (() => void) => {
            const listener = (_e: IpcRendererEvent, maxed: boolean): void => cb(maxed);
            ipcRenderer.on('xwd:win-max', listener);
            return () => ipcRenderer.removeListener('xwd:win-max', listener);
        },
        /* 窗口级全屏 */
        setFullScreen: (on: boolean): Promise<boolean> => ipcRenderer.invoke('xwd:winSetFs', on),
        isFullScreen: (): Promise<boolean> => ipcRenderer.invoke('xwd:winIsFs'),
        onFullScreenChange: (cb: (fs: boolean) => void): (() => void) => {
            const listener = (_e: IpcRendererEvent, fs: boolean): void => cb(fs);
            ipcRenderer.on('xwd:win-fs', listener);
            return () => ipcRenderer.removeListener('xwd:win-fs', listener);
        },
    },
    /* SSH 终端会话（ssh2） */
    ssh: {
        connect: (opt: SshTermOpt): Promise<SshResult> => ipcRenderer.invoke('xwd:ssh:connect', opt),
        write: (id: string, data: string | Uint8Array): void => ipcRenderer.send('xwd:ssh:input', { id, data }),
        resize: (id: string, cols: number, rows: number): void => ipcRenderer.send('xwd:ssh:resize', { id, cols, rows }),
        close: (id: string): void => ipcRenderer.send('xwd:ssh:close', { id }),
        onData: (id: string, cb: (data: Uint8Array) => void): (() => void) => {
            const listener = (_e: IpcRendererEvent, p: { id: string; data: Uint8Array }): void => {
                if (p && p.id === id) cb(p.data);
            };
            ipcRenderer.on('xwd:ssh:data', listener);
            return () => ipcRenderer.removeListener('xwd:ssh:data', listener);
        },
        onClose: (id: string, cb: (code: number) => void): (() => void) => {
            const listener = (_e: IpcRendererEvent, p: { id: string; code: number }): void => {
                if (p && p.id === id) cb(p.code || 0);
            };
            ipcRenderer.on('xwd:ssh:close', listener);
            return () => ipcRenderer.removeListener('xwd:ssh:close', listener);
        },
        probe: (opt: SshCred): Promise<ProbeResult> => ipcRenderer.invoke('xwd:ssh:probe', opt),
        startServer: (opt: SshCred): Promise<InstallResult> => ipcRenderer.invoke('xwd:ssh:startServer', opt),
        installServer: (opt: SshCred): Promise<InstallResult> => ipcRenderer.invoke('xwd:ssh:installServer', opt),
        onInstallProgress: (cb: (p: InstallProgress) => void): (() => void) => {
            const listener = (_e: IpcRendererEvent, p: InstallProgress): void => cb(p);
            ipcRenderer.on('xwd:ssh:install-progress', listener);
            return () => ipcRenderer.removeListener('xwd:ssh:install-progress', listener);
        },
    },
    /* 系统监控（SSH 采集远端 CPU/内存/进程/磁盘） */
    sys: {
        open: (opt: SysOpenOpt): Promise<SshResult> => ipcRenderer.invoke('xwd:sys:open', opt),
        sample: (id: string): Promise<SysSample> => ipcRenderer.invoke('xwd:sys:sample', id),
        close: (id: string): void => ipcRenderer.send('xwd:sys:close', id),
    },
    /* 远程文件面板（SFTP） */
    file: {
        open: (opt: SftpOpenOpt): Promise<SftpOpenResult> => ipcRenderer.invoke('xwd:file:open', opt),
        list: (id: number, path: string): Promise<SftpListResult> => ipcRenderer.invoke('xwd:file:list', { id, path } satisfies SftpPathOpt),
        mkdir: (id: number, path: string): Promise<SshResult> => ipcRenderer.invoke('xwd:file:mkdir', { id, path } satisfies SftpPathOpt),
        rename: (id: number, from: string, to: string): Promise<SshResult> => ipcRenderer.invoke('xwd:file:rename', { id, from, to } satisfies SftpRenameOpt),
        remove: (id: number, path: string, isDir: boolean): Promise<SshResult> => ipcRenderer.invoke('xwd:file:remove', { id, path, isDir } satisfies SftpRemoveOpt),
        upload: (id: number, dir: string): Promise<SftpUploadResult> => ipcRenderer.invoke('xwd:file:upload', { id, dir } satisfies SftpUploadOpt),
        download: (id: number, path: string): Promise<SftpDownloadResult> => ipcRenderer.invoke('xwd:file:download', { id, path } satisfies SftpPathOpt),
        close: (id: number): Promise<SshResult> => ipcRenderer.invoke('xwd:file:close', id),
    },
});
