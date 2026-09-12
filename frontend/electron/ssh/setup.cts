/* ssh/setup.cts —— 服务端「探测 / 启动 / 一键安装 / 关于」。
 *
 * 这些都是一次性动作：经 ssh/pool 的 sshBorrow 借用当前已打开的 SSH 连接
 * （同账户），用完归还；主机上没有任何活跃连接时才临时新建、用完即断。
 */

import fs from 'node:fs';
import path from 'node:path';
import { sendToUi } from '../window.cjs';
import { appRoot } from '../util.cjs';
import { sshBorrow } from './pool.cjs';
import type { SshCred, SshExecResult, ServerStatus } from './types.cjs';

export interface ProbeResult {
    ok: boolean;
    status: ServerStatus;
    msg: string;
}

export interface InstallResult {
    ok: boolean;
    needSudo?: boolean;
    msg: string;
    code?: number;
}

export interface AboutResult {
    ok: boolean;
    os?: string;
    de?: string;
    deVersion?: string;
    shell?: string;
    msg?: string;
}

/** 一键安装进度事件（xwd:ssh:install-progress） */
export interface InstallProgress {
    stage?: 'upload' | 'install';
    pct: number | null;
    label?: string;
}

/** 一次性 exec（借用已有连接；无则临时新建，用完即断） */
export async function sshExecOnce(opt: SshCred, cmd: string, stdinData?: string): Promise<SshExecResult> {
    const b = await sshBorrow(opt);
    if (!b.ok) return { code: -2, out: '', err: b.msg || 'SSH 连接失败' };
    /* 用数组存取消函数：避免「在回调里赋值、finally 里读取」被控制流分析误判为 null */
    const unsub: Array<() => void> = [];
    try {
        return await new Promise<SshExecResult>((resolve) => {
            let done = false;
            const fin = (r: SshExecResult): void => { if (!done) { done = true; resolve(r); } };
            /* 借用的连接可能中途断开：立即返回，避免 IPC 调用永不返回 */
            unsub.push(b.onClose(() => fin({ code: -2, out: '', err: 'SSH 连接已断开' })));
            b.client.exec(cmd, (err, stream) => {
                if (err) { fin({ code: -1, out: '', err: err.message }); return; }
                const chunks: Buffer[] = [];
                let errBuf = '';
                stream.on('data', (d: Buffer) => chunks.push(d));
                stream.stderr.on('data', (d: Buffer) => { errBuf += d.toString(); });
                stream.on('close', (code: number | undefined) => {
                    fin({ code: code == null ? -1 : code, out: Buffer.concat(chunks).toString(), err: errBuf });
                });
                stream.on('error', (e: Error) => {
                    fin({ code: -1, out: Buffer.concat(chunks).toString(), err: (e && e.message) || errBuf });
                });
                if (stdinData) {
                    stream.stdin.write(stdinData);
                    stream.stdin.end();
                }
            });
        });
    } finally {
        unsub.pop()?.();
        b.release();
    }
}

/** 一次性上传单个文件（同样借用连接） */
export async function sftpPutOnce(opt: SshCred, localFile: string, remoteFile: string): Promise<{ ok: boolean; msg?: string }> {
    const b = await sshBorrow(opt);
    if (!b.ok) return { ok: false, msg: b.msg || 'SSH 连接失败' };
    const unsub: Array<() => void> = [];
    try {
        return await new Promise<{ ok: boolean; msg?: string }>((resolve) => {
            let done = false;
            const fin = (r: { ok: boolean; msg?: string }): void => { if (!done) { done = true; resolve(r); } };
            unsub.push(b.onClose(() => fin({ ok: false, msg: 'SSH 连接已断开' })));
            b.client.sftp((err, sftp) => {
                if (err) { fin({ ok: false, msg: 'sftp 打开失败: ' + err.message }); return; }
                sftp.fastPut(localFile, remoteFile, (e) => {
                    fin(e ? { ok: false, msg: '上传失败: ' + e.message } : { ok: true });
                });
            });
        });
    } finally {
        unsub.pop()?.();
        b.release();
    }
}

const SUDO_ERR_RE = /not in the sudoers file|a password is required|no password was provided|incorrect password|authentication failure/i;

/** 探测远端 xworkd 服务状态：running / stopped / not_installed / unreachable */
export async function sshProbeServer(opt: SshCred): Promise<ProbeResult> {
    const cmd = 'o=""; command -v xworkd >/dev/null 2>&1 && o="$o BIN"; if systemctl is-active --quiet xworkd 2>/dev/null; then o="$o ACTIVE"; fi; if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q "[:.]5268 "; then o="$o PORT"; fi; echo "${o:-NONE}";';
    const r = await sshExecOnce(opt, cmd);
    if (r.code === -2) return { ok: false, status: 'unreachable', msg: r.err };
    const o = r.out.trim();
    let status: ServerStatus = 'not_installed';
    if (o.includes('PORT')) status = 'running';
    else if (o.includes('ACTIVE')) status = 'stopped';
    else if (o.includes('BIN')) status = 'stopped';
    return { ok: true, status, msg: o || r.err };
}

/** 远端重启（已安装但停止）xworkd 服务 */
export async function sshStartServer(opt: SshCred): Promise<InstallResult> {
    const r = await sshExecOnce(opt, 'sudo -S -p \'\' systemctl restart xworkd', opt.pass ? String(opt.pass) + '\n' : '');
    const needSudo = SUDO_ERR_RE.test(r.err || '');
    return { ok: r.code === 0, needSudo, msg: ((r.out || '') + (r.err || '')).trim().slice(-600), code: r.code };
}

/** 推送内置服务端安装包并远端一键安装（sudo 复用账号密码）。
 *  过程事件经 xwd:ssh:install-progress 回推：{stage:'upload'|'install', pct, label} */
export async function sshInstallServer(opt: SshCred): Promise<InstallResult> {
    const local = path.join(appRoot(), 'server-bundle', 'xworkd-server.tar.gz');
    if (!fs.existsSync(local)) return { ok: false, msg: '缺少内置服务端安装包(server-bundle)' };
    const remote = '/tmp/xworkd-server.tar.gz';
    sendToUi('xwd:ssh:install-progress', { stage: 'upload', pct: 0.1, label: '通过 SSH 上传安装包…' } satisfies InstallProgress);
    const up = await sftpPutOnce(opt, local, remote);
    if (!up.ok) return { ok: false, msg: up.msg || '上传安装包失败' };
    sendToUi('xwd:ssh:install-progress', { stage: 'install', pct: null, label: '远端安装中：下载依赖、写入系统服务（约 1 分钟）…' } satisfies InstallProgress);
    const run = 'sudo -S -p \'\' bash -c "rm -rf /tmp/xworkd-server && mkdir -p /tmp/xworkd-server && tar -C /tmp/xworkd-server -xzf /tmp/xworkd-server.tar.gz && cd /tmp/xworkd-server/xworkd-server && bash install.sh"';
    const r = await sshExecOnce(opt, run, opt.pass ? String(opt.pass) + '\n' : '');
    const needSudo = SUDO_ERR_RE.test(r.err || '');
    const ok = r.out.includes('XWORKD_INSTALL_OK') || r.code === 0;
    return { ok, needSudo, msg: ((r.out || '') + (r.err || '')).trim().slice(-1000), code: r.code };
}

/** “关于”：经 SSH 采集远端系统版本 / 桌面环境版本（一次命令，容忍缺失） */
export async function sshCollectAbout(opt: SshCred): Promise<AboutResult> {
    const cmd = [
        'PRETTY=$(awk -F= \'/^PRETTY_NAME=/{print $2}\' /etc/os-release 2>/dev/null | tr -d \'"\')',
        'echo "OS=${PRETTY:-Linux}"',
        'DE=${XDG_CURRENT_DESKTOP:-}',
        'if [ -z "$DE" ]; then for d in gnome-shell plasmashell xfce4-session mate-session cinnamon-session budgie-desktop; do if pgrep -x "$d" >/dev/null 2>&1; then DE=$d; break; fi; done; fi',
        'case "$DE" in gnome-shell) DE="GNOME";; plasmashell) DE="KDE Plasma";; xfce4-session) DE="XFCE";; mate-session) DE="MATE";; cinnamon-session) DE="Cinnamon";; budgie-desktop) DE="Budgie";; esac',
        'DEV=""',
        'if command -v gnome-shell >/dev/null 2>&1; then DEV=$(gnome-shell --version 2>/dev/null | awk \'{print $3}\'); fi',
        'echo "DE=${DE:-unknown}"',
        'echo "DEV=${DEV:-}"',
        'SHL=""',
        'if [ -n "${BASH_VERSION:-}" ]; then SHL="bash ${BASH_VERSION%%(*}"; elif [ -n "${ZSH_VERSION:-}" ]; then SHL="zsh $ZSH_VERSION"; else SB=$(basename "$(readlink -f /proc/$$/exe 2>/dev/null)" 2>/dev/null); [ -n "$SB" ] && SHL="$SB"; fi',
        'echo "SH=${SHL:-unknown}"',
    ].join('; ');
    const r = await sshExecOnce(opt, cmd);
    if (r.code === -2) return { ok: false, msg: r.err };
    const out = r.out || '';
    const grab = (k: string): string => {
        const m = new RegExp('(?:^|\\n|; )' + k + '=(.*?)(?:\\n|$)', 'm').exec(out);
        return m ? m[1].trim() : '';
    };
    return { ok: true, os: grab('OS'), de: grab('DE'), deVersion: grab('DEV'), shell: grab('SH') };
}
