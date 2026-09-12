/* ssh/tun.cts —— 远端 Tun 代理服务（内置 sing-box）的安装 / 启停 / 测速。
 *
 * 分工（与面板的两个按钮对应）：
 *   安装服务 → 上传内置 sing-box 包 + 执行 install-tun.sh（装依赖、解包、写 unit，**不启动**）
 *   启用     → 生成配置（含排除规则）→ 推送 → sing-box check → systemctl enable --now
 *   停用     → systemctl disable --now（配置保留）
 *   卸载服务 → 停服务 + 删 unit、程序目录与配置
 *
 * 服务是远端的 systemd 系统服务，与客户端进程 / SSH 会话无关：关掉客户端、断开 SSH
 * 都不影响代理继续运行，且开机自启（enable）。tun 的 auto_route 是系统级的，即该主机
 * 上所有用户、所有流量都按同一套规则走——这是本功能的既定语义。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appRoot } from '../util.cjs';
import { sendToUi } from '../window.cjs';
import { sshExecOnce, sftpPutOnce, SUDO_ERR_RE, type InstallResult } from './setup.cjs';
import type { SshCred } from './types.cjs';

/* ---------------- 常量 ---------------- */

/** 内置包文件名：升级 sing-box 时改这里 + tun-bundle/README.md 的版本与哈希 */
const SING_BOX_TGZ = 'sing-box-1.14.0-linux-amd64.tar.gz';
const PREFIX = '/opt/xworkd-tun';
const CONF_DIR = '/etc/xworkd-tun';
const UNIT = 'xworkd-tun';
const REMOTE_INSTALL_SCRIPT = 'install-tun.sh';

/* tun 内部地址（v4+v6 都给，避免只代理 v4） */
const TUN_ADDRESS = ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'];

/* ---------------- 类型 ---------------- */

export interface TunProxyOpt extends SshCred {
    /** 上游代理：`host:port`，可带 `socks5://` / `http://` 前缀（缺省 socks5） */
    server: string;
    /** 直连排除列表：每行一个 CIDR / IP */
    exclude: string;
    /** 当前 SSH 端口（用于 source_port 排除，防代理把管理连接断掉） */
    sshPort: number;
    /** 远程桌面端口（同上） */
    rdPort: number;
}

export interface TunStatus {
    ok: boolean;
    installed: boolean;
    running: boolean;
    version?: string;
    msg?: string;
}

export interface TunSpeedResult {
    ok: boolean;
    ms?: number;
    httpCode?: number;
    msg?: string;
}

export interface Upstream {
    type: 'socks' | 'http';
    host: string;
    port: number;
}

/* ---------------- 解析与配置生成（纯逻辑，便于单测） ---------------- */

/** 解析上游代理地址；非法返回 null。支持 `[v6]:port` 与可选协议前缀。 */
export function parseUpstream(raw: string): Upstream | null {
    const m = /^(?:(socks5|socks|http):\/\/)?(\[[0-9a-fA-F:]+\]|[^:\s/]+):(\d{1,5})$/i.exec(String(raw || '').trim());
    if (!m) return null;
    const port = Number(m[3]);
    if (!(port > 0 && port < 65536)) return null;
    const scheme = (m[1] || 'socks5').toLowerCase();
    const host = m[2].startsWith('[') ? m[2].slice(1, -1) : m[2];
    if (!host) return null;
    return { type: scheme === 'http' ? 'http' : 'socks', host, port };
}

/** 归一化 CIDR 列表：去空行/注释、去重、裸 IP 补全掩码；明显非法的条目丢弃 */
export function normalizeCidrs(text: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const line of String(text || '').split(/[\n,]+/)) {
        let t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const slash = t.indexOf('/');
        const addr = slash >= 0 ? t.slice(0, slash) : t;
        const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(addr) && addr.split('.').every((n) => Number(n) <= 255);
        const v6 = addr.includes(':') && /^[0-9a-fA-F:]+$/.test(addr);
        if (!v4 && !v6) continue;
        if (slash < 0) t = `${addr}/${v4 ? 32 : 128}`;
        else if (!/^\d{1,3}$/.test(t.slice(slash + 1))) continue;
        if (!seen.has(t)) {
            seen.add(t);
            out.push(t);
        }
    }
    return out;
}

export interface TunConfigInput {
    upstream: Upstream;
    /** 用户填的直连排除网段 */
    excludes: string[];
    /** 远端看到的客户端 IP（取自 SSH_CLIENT）；拿不到时省略该规则 */
    clientIp?: string;
    sshPort: number;
    rdPort: number;
}

/** 生成 sing-box 配置。规则顺序：sniff → 劫持 DNS → 直连排除 → 其余走上游。
 *
 *  排除规则里有两条防"代理把自己连接断掉"：
 *   - source_ip_cidr：来自客户端 IP 的流量全部直连（含桌面 WS 与后续连接）
 *   - source_port：从 SSH / 远程桌面服务端口发出的**回包**直连。
 *     注意必须用 source_port：远端回包的目标端口是客户端的随机高位端口，
 *     写 port（目标端口）挡不住。 */
export function buildTunConfig(inp: TunConfigInput): string {
    const ports = Array.from(new Set([Number(inp.sshPort) || 22, Number(inp.rdPort) || 5268]))
        .filter((p) => p > 0 && p < 65536);
    const rules: unknown[] = [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
    ];
    if (inp.excludes.length) {
        rules.push({ ip_cidr: inp.excludes, action: 'route', outbound: 'direct' });
    }
    if (inp.clientIp) {
        rules.push({ source_ip_cidr: [`${inp.clientIp}/32`], action: 'route', outbound: 'direct' });
    }
    if (ports.length) {
        rules.push({ source_port: ports, action: 'route', outbound: 'direct' });
    }

    const up = inp.upstream;
    const outbound = up.type === 'http'
        ? { type: 'http', tag: 'proxy', server: up.host, server_port: up.port }
        : { type: 'socks', tag: 'proxy', server: up.host, server_port: up.port, version: '5' };

    const cfg = {
        log: { level: 'warn', timestamp: true },
        /* DNS 走 DoH-over-代理：TCP 443 是任何 HTTP/SOCKS 上游都支持的路径，
         * 不用 UDP 是因为多数 socks5/http 代理不支持 UDP ASSOCIATE */
        dns: {
            servers: [{ type: 'https', tag: 'dns-proxy', server: '1.1.1.1', detour: 'proxy' }],
            final: 'dns-proxy',
        },
        inbounds: [{
            type: 'tun',
            tag: 'tun-in',
            address: TUN_ADDRESS,
            mtu: 9000,
            stack: 'mixed',
            auto_route: true,
            strict_route: true,
        }],
        outbounds: [outbound, { type: 'direct', tag: 'direct' }],
        route: {
            rules,
            final: 'proxy',
            auto_detect_interface: true,
        },
    };
    return JSON.stringify(cfg, null, 2);
}

/* ---------------- 远端操作 ---------------- */

/** 每次操作新建的远端私有临时目录（mktemp 唯一命名 + 700），用完即删。
 *
 *  不用固定路径（如 /tmp/xworkd-tun-install.sh）的原因：同一个 /tmp 上若已有别的
 *  用户（或历史上 root 执行留下）的同名文件，SFTP 覆写会被服务端拒绝，报
 *  “上传失败: Permission denied”。唯一目录还能避免同名并发互相覆盖。
 *  默认放在 $TMPDIR 或 /tmp，不可写时退到 $HOME。 */
async function remoteWorkDir(opt: SshCred): Promise<string> {
    const cmd =
        'd=$(mktemp -d "${TMPDIR:-/tmp}/xworkd-tun.XXXXXX" 2>/dev/null) '
        + '|| d=$(mktemp -d "$HOME/.xworkd-tun.XXXXXX" 2>/dev/null) '
        + '|| exit 1; chmod 700 "$d" && printf "XWD_DIR=%s\\n" "$d"';
    const r = await sshExecOnce(opt, cmd);
    const m = /XWD_DIR=(.+)/.exec(r.out || '');
    const dir = m ? m[1].trim() : '';
    /* 目录名会被拼进后续 sudo 命令，做一次白名单校验以防注入 */
    if (!dir || !/^[^\s'"`;$]+$/.test(dir)) {
        const detail = ((r.out || '') + (r.err || '')).trim().slice(-200);
        throw new Error('无法在远端创建临时目录（' + (detail || '无输出') + '）');
    }
    return dir;
}

/** 查询远端状态：是否已装、是否运行中、版本 */
export async function tunStatus(opt: SshCred): Promise<TunStatus> {
    const cmd = [
        `if [ -x ${PREFIX}/sing-box ] && [ -f /etc/systemd/system/${UNIT}.service ]; then echo INSTALLED=1; else echo INSTALLED=0; fi`,
        `if systemctl is-active --quiet ${UNIT} 2>/dev/null; then echo RUNNING=1; else echo RUNNING=0; fi`,
        `if [ -x ${PREFIX}/sing-box ]; then echo VER=$(${PREFIX}/sing-box version 2>/dev/null | head -1 | awk '{print $3}'); fi`,
    ].join('; ');
    const r = await sshExecOnce(opt, cmd);
    if (r.code !== 0) return { ok: false, installed: false, running: false, msg: r.err || 'SSH 查询失败' };
    const out = r.out || '';
    const installed = /INSTALLED=1/.test(out);
    const running = /RUNNING=1/.test(out);
    const ver = /VER=(\S+)/.exec(out);
    return { ok: true, installed, running, version: ver ? ver[1] : undefined };
}

/** 安装（上传内置包 + 执行安装脚本；不生成配置、不启动） */
export async function tunInstall(opt: SshCred): Promise<InstallResult> {
    const tgz = path.join(appRoot(), 'tun-bundle', SING_BOX_TGZ);
    const sh = path.join(appRoot(), 'tun-bundle', REMOTE_INSTALL_SCRIPT);
    if (!fs.existsSync(tgz) || !fs.existsSync(sh)) {
        return { ok: false, msg: '缺少内置安装包（tun-bundle）' };
    }
    let dir: string;
    try {
        dir = await remoteWorkDir(opt);
    } catch (e) {
        return { ok: false, msg: e instanceof Error ? e.message : String(e) };
    }
    const remoteTgz = `${dir}/${SING_BOX_TGZ}`;
    const remoteSh = `${dir}/${REMOTE_INSTALL_SCRIPT}`;
    sendToUi('xwd:ssh:install-progress', { stage: 'upload', pct: 0.1, label: '上传 sing-box 安装包（约 30MB）…' });
    const up1 = await sftpPutOnce(opt, tgz, remoteTgz);
    if (!up1.ok) {
        await sshExecOnce(opt, `rm -rf ${dir}`);
        return { ok: false, msg: up1.msg || '上传 sing-box 安装包失败' };
    }
    const up2 = await sftpPutOnce(opt, sh, remoteSh);
    if (!up2.ok) {
        await sshExecOnce(opt, `rm -rf ${dir}`);
        return { ok: false, msg: up2.msg || '上传安装脚本失败' };
    }

    sendToUi('xwd:ssh:install-progress', { stage: 'install', pct: 0.7, label: '远端安装：装依赖、解包、写入 systemd 服务…' });
    const r = await sshExecOnce(
        opt,
        `sudo -S -p '' bash ${remoteSh} ${remoteTgz}`,
        opt.pass ? String(opt.pass) + '\n' : '',
    );
    /* 无论成败都清掉本次的 30MB 临时包 */
    await sshExecOnce(opt, `rm -rf ${dir}`);
    const needSudo = SUDO_ERR_RE.test(r.err || '');
    const ok = r.out.includes('XWORKD_TUN_INSTALL_OK');
    return { ok, needSudo, msg: ((r.out || '') + (r.err || '')).trim().slice(-1200) };
}

/** 卸载（停服务 + 删 unit、程序目录与配置） */
export async function tunUninstall(opt: SshCred): Promise<InstallResult> {
    sendToUi('xwd:ssh:install-progress', { stage: 'uninstall', pct: null, label: '停止服务并删除远端程序与配置…' });
    const script = [
        `systemctl disable --now ${UNIT} >/dev/null 2>&1 || true`,
        `rm -f /etc/systemd/system/${UNIT}.service`,
        'systemctl daemon-reload >/dev/null 2>&1 || true',
        `rm -rf ${PREFIX} ${CONF_DIR}`,
    ].join('; ');
    const r = await sshExecOnce(opt, `sudo -S -p '' bash -c "${script}"`, opt.pass ? String(opt.pass) + '\n' : '');
    const needSudo = SUDO_ERR_RE.test(r.err || '');
    return { ok: r.code === 0, needSudo, msg: ((r.out || '') + (r.err || '')).trim().slice(-1000) };
}

/** 启用：生成配置 → 推送 → check → enable --now（开机自启，独立于客户端） */
export async function tunEnable(opt: TunProxyOpt): Promise<InstallResult> {
    const upstream = parseUpstream(opt.server);
    if (!upstream) {
        return { ok: false, msg: '服务器地址格式不正确（应形如 socks5://1.2.3.4:1080 或 http://1.2.3.4:8080）' };
    }
    const excludes = normalizeCidrs(opt.exclude);

    /* 远端看到的客户端 IP：SSH 会话环境里的 SSH_CLIENT（拿不到就退化为不写该规则） */
    let clientIp: string | undefined;
    const probe = await sshExecOnce(opt, 'echo "XWD_SSH_CLIENT=${SSH_CLIENT:-}"');
    const m = /XWD_SSH_CLIENT=(\S+)/.exec(probe.out || '');
    if (m && /^[0-9a-fA-F.:]+$/.test(m[1])) clientIp = m[1];

    const cfg = buildTunConfig({
        upstream,
        excludes,
        clientIp,
        sshPort: Number(opt.sshPort) || 22,
        rdPort: Number(opt.rdPort) || 5268,
    });
    const localCfg = path.join(os.tmpdir(), `xworkd-tun-${process.pid}.json`);
    try {
        fs.writeFileSync(localCfg, cfg);
    } catch (e) {
        return { ok: false, msg: '写入本地临时配置失败: ' + (e instanceof Error ? e.message : String(e)) };
    }

    sendToUi('xwd:ssh:install-progress', { stage: 'enable', pct: 0.6, label: '推送配置、校验并启动服务…' });
    let dir: string;
    try {
        dir = await remoteWorkDir(opt);
    } catch (e) {
        try { fs.unlinkSync(localCfg); } catch { /* 忽略 */ }
        return { ok: false, msg: e instanceof Error ? e.message : String(e) };
    }
    const remoteCfg = `${dir}/config.json`;
    const up = await sftpPutOnce(opt, localCfg, remoteCfg);
    try { fs.unlinkSync(localCfg); } catch { /* 忽略 */ }
    if (!up.ok) {
        await sshExecOnce(opt, `rm -rf ${dir}`);
        return { ok: false, msg: up.msg || '推送配置失败' };
    }

    /* 先 check 再启用：配置不合法时不要动服务 */
    const script = [
        `${PREFIX}/sing-box check -c ${remoteCfg}`,
        `install -m 0644 ${remoteCfg} ${CONF_DIR}/config.json`,
        `systemctl enable --now ${UNIT}`,
    ].join(' && ');
    const r = await sshExecOnce(opt, `sudo -S -p '' bash -c "${script}"`, opt.pass ? String(opt.pass) + '\n' : '');
    await sshExecOnce(opt, `rm -rf ${dir}`);
    const needSudo = SUDO_ERR_RE.test(r.err || '');
    const active = await sshExecOnce(opt, `systemctl is-active ${UNIT} 2>/dev/null`);
    const running = (active.out || '').trim() === 'active';
    if (r.code !== 0 || !running) {
        const log = await sshExecOnce(opt, `journalctl -u ${UNIT} -n 30 --no-pager 2>/dev/null`);
        const detail = ((r.out || '') + (r.err || '')).trim().slice(-600);
        const tail = (log.out || '').trim().slice(-800);
        return {
            ok: false,
            needSudo,
            msg: [detail, tail].filter(Boolean).join('\n---\n') || '启动失败（无日志输出）',
        };
    }
    const note = clientIp
        ? `已排除客户端 ${clientIp}（来自 SSH 会话）`
        : '未取到客户端 IP：若从公网连接且桌面断开，请检查排除规则';
    return { ok: true, msg: `已启用并设置为开机自启；${note}` };
}

/** 停用（保留配置，便于下次直接启用） */
export async function tunDisable(opt: SshCred): Promise<InstallResult> {
    sendToUi('xwd:ssh:install-progress', { stage: 'disable', pct: null, label: '停止服务并取消开机自启…' });
    const r = await sshExecOnce(opt, `sudo -S -p '' bash -c "systemctl disable --now ${UNIT}"`, opt.pass ? String(opt.pass) + '\n' : '');
    const needSudo = SUDO_ERR_RE.test(r.err || '');
    return { ok: r.code === 0, needSudo, msg: ((r.out || '') + (r.err || '')).trim().slice(-600) };
}

/** 测速：在远端**经上游代理**访问 Google 的 generate_204，返回耗时（毫秒）。
 *  不依赖 tun 是否已启用，因此可用于"填完地址先验证上游是否可用"。 */
export async function tunSpeedtest(opt: SshCred & { server: string }): Promise<TunSpeedResult> {
    const up = parseUpstream(opt.server);
    if (!up) return { ok: false, msg: '服务器地址格式不正确' };
    const hostForUrl = up.host.includes(':') ? `[${up.host}]` : up.host;
    const proxy = `${up.type === 'http' ? 'http' : 'socks5h'}://${hostForUrl}:${up.port}`;
    const cmd = `curl -s -o /dev/null --max-time 8 -x ${proxy} -w '%{http_code} %{time_total}' https://www.google.com/generate_204`;
    const r = await sshExecOnce(opt, cmd);
    const out = (r.out || '').trim();
    const m = /^(\d{3})\s+([\d.]+)$/.exec(out);
    if (!m) {
        const detail = ((r.out || '') + (r.err || '')).trim().slice(-200);
        return {
            ok: false,
            msg: detail ? `测速失败: ${detail}` : '测速失败（远端可能没有 curl，请先「安装服务」）',
        };
    }
    const httpCode = Number(m[1]);
    const ms = Math.round(Number(m[2]) * 1000);
    if (httpCode !== 204) return { ok: false, httpCode, ms, msg: `上游返回 HTTP ${httpCode}（预期 204）` };
    return { ok: true, httpCode, ms };
}
