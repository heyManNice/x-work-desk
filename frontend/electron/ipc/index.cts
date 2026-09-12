/* ipc/index.cts —— 全部 IPC 通道的注册入口（渲染层 <-> 主进程的唯一契约清单）。
 *
 * 通道名与处理函数的对应关系集中在这里，实现分散在各模块；建议与
 * electron/preload.cts 的暴露面（window.xwd）对照检查两者是否一致。
 */

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { getWin, sendWinFs } from '../window.cjs';
import { pingHost, clipWriteText, clipPoll } from './system.cjs';
import * as term from '../ssh/terminal.cjs';
import * as sysmon from '../ssh/sysmon.cjs';
import * as sftp from '../ssh/sftp.cjs';
import * as setup from '../ssh/setup.cjs';
import * as tun from '../ssh/tun.cjs';
import { mainLogEntries, mlogError, mlogInfo, mlogWarn, merrText } from '../log.cjs';
import { saveLogReport } from './logreport.cjs';

/* 说明：渲染层数据不可信且没有运行时校验，这里统一以 any 收口，
 * 各 handler 实现内部再逐字段 String()/Number() 收敛。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (arg: any) => any;

/** 失败的 IPC 结果顺手记一条：{ok:false} 是本项目所有操作的统一失败口径，
 * 集中在这里记就不用去每个 ssh/sftp 模块里散落日志了（用户取消不算失败）。 */
function logIpcResult(channel: string, r: unknown): void {
    if (!r || typeof r !== 'object') return;
    const o = r as { ok?: unknown; canceled?: unknown; msg?: unknown; status?: unknown };
    if (o.ok !== false || o.canceled === true) return;
    mlogWarn('ipc', `${channel} 失败：${String(o.msg ?? '')}${o.status ? `（status=${String(o.status)}）` : ''}`);
}

function onInvoke(channel: string, fn: AnyFn): void {
    ipcMain.handle(channel, async (_e: IpcMainInvokeEvent, arg: any) => {
        try {
            const r = await fn(arg);
            logIpcResult(channel, r);
            return r;
        } catch (e) {
            /* 未预料的异常（handler 自己没 try/catch）：记下来并原样抛给渲染层 */
            mlogError('ipc', `${channel} 抛出异常：${merrText(e)}`);
            throw e;
        }
    });
}

function onSend(channel: string, fn: (arg: any) => void): void {
    ipcMain.on(channel, (_e: IpcMainEvent, arg: any) => fn(arg));
}

export function registerIpc(): void {
    mlogInfo('ipc', 'IPC 通道注册完成');

    /* ---- 连通性 / 剪贴板 ---- */
    onInvoke('xwd:ping', (opt) => pingHost(opt ?? {}));
    onInvoke('xwd:clipWriteText', (text) => clipWriteText(text));
    onInvoke('xwd:clipPoll', () => clipPoll());

    /* ---- 窗口控制（自制标题栏：无系统边框） ---- */
    onSend('xwd:winMin', () => { getWin()?.minimize(); });
    onSend('xwd:winMaxToggle', () => {
        const w = getWin();
        if (!w) return;
        if (w.isMaximized()) w.unmaximize();
        else w.maximize();
    });
    onSend('xwd:winClose', () => { getWin()?.close(); });
    onInvoke('xwd:winIsMax', () => {
        const w = getWin();
        return !!(w && w.isMaximized());
    });
    /* 窗口级全屏（渲染层沉浸模式；DOM 全保留，弹层/面板仍可用） */
    onInvoke('xwd:winSetFs', (on) => {
        const w = getWin();
        if (!w) return false;
        w.setFullScreen(!!on);
        /* 主动同步一次状态（X11/Windows 无 enter/leave-full-screen，resize 推送可能延迟） */
        if (!w.isDestroyed()) sendWinFs(w.isFullScreen());
        return true;
    });
    onInvoke('xwd:winIsFs', () => {
        const w = getWin();
        return !!(w && w.isFullScreen());
    });

    /* ---- SSH 终端会话 ---- */
    onInvoke('xwd:ssh:connect', (opt) => term.startSshSession(opt));
    onSend('xwd:ssh:input', (opt) => term.sshWrite(opt && opt.id, opt && opt.data));
    onSend('xwd:ssh:resize', (opt) => term.sshResize(opt && opt.id, opt && opt.cols, opt && opt.rows));
    onSend('xwd:ssh:close', (opt) => term.closeSshSession(opt && opt.id));

    /* ---- 服务端探测 / 启动 / 一键安装 / 关于 ---- */
    onInvoke('xwd:ssh:probe', (opt) => setup.sshProbeServer(opt ?? {}));
    onInvoke('xwd:ssh:startServer', (opt) => setup.sshStartServer(opt ?? {}));
    onInvoke('xwd:ssh:installServer', (opt) => setup.sshInstallServer(opt ?? {}));
    onInvoke('xwd:ssh:uninstallServer', (opt) => setup.sshUninstallServer(opt ?? {}));
    onInvoke('xwd:about:hostinfo', (opt) => setup.sshCollectAbout(opt ?? {}));

    /* ---- 系统监控 ---- */
    onInvoke('xwd:sys:open', (opt) => sysmon.sysOpen(opt ?? {}));
    onInvoke('xwd:sys:sample', (id) => sysmon.sysSample(String(id ?? '')));
    onSend('xwd:sys:close', (id) => sysmon.sysClose(String(id ?? '')));

    /* ---- 远程文件面板（SFTP） ---- */
    onInvoke('xwd:file:open', (opt) => sftp.sftpOpen(opt ?? {}));
    onInvoke('xwd:file:list', (opt) => sftp.sftpList(opt ?? {}));
    onInvoke('xwd:file:mkdir', (opt) => sftp.sftpMkdir(opt ?? {}));
    onInvoke('xwd:file:rename', (opt) => sftp.sftpRename(opt ?? {}));
    onInvoke('xwd:file:remove', (opt) => sftp.sftpRemove(opt ?? {}));
    onInvoke('xwd:file:upload', (opt) => sftp.sftpUpload(opt ?? {}));
    onInvoke('xwd:file:download', (opt) => sftp.sftpDownload(opt ?? {}));
    onInvoke('xwd:file:close', (id) => {
        sftp.sftpClose(Number(id));
        return { ok: true };
    });

    /* ---- Tun 代理服务（远端 sing-box，systemd 常驻） ---- */
    onInvoke('xwd:tun:status', (opt) => tun.tunStatus(opt ?? {}));
    onInvoke('xwd:tun:install', (opt) => tun.tunInstall(opt ?? {}));
    onInvoke('xwd:tun:uninstall', (opt) => tun.tunUninstall(opt ?? {}));
    onInvoke('xwd:tun:enable', (opt) => tun.tunEnable(opt ?? {}));
    onInvoke('xwd:tun:disable', (opt) => tun.tunDisable(opt ?? {}));
    onInvoke('xwd:tun:speed', (opt) => tun.tunSpeedtest(opt ?? {}));

    /* ---- 日志：主进程内存日志读取 + 报告落盘（不写常规日志文件） ---- */
    onInvoke('xwd:log:entries', () => mainLogEntries());
    onInvoke('xwd:log:save', (p) => saveLogReport(String(p && p.name ? p.name : ''), String(p && p.text ? p.text : '')));
}
