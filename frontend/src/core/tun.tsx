/* core/tun.tsx —— 顶栏“Tun”代理入口 + 弹窗。
 *
 * 实际功能：在**远端主机**上以内置的 sing-box 提供 tun 代理，由 systemd 常驻。
 *   - 安装服务 / 卸载服务：上传内置包 + 装 systemd 单元（不启动） / 停服务并清理
 *   - 启用 / 停用：生成配置（含排除规则）→ 推送 → sing-box check → enable --now / disable --now
 *   - 测速：在远端**经上游代理**访问 Google 的 generate_204，返回耗时，用于先验证上游可用
 *
 * 服务是远端 systemd 系统服务，与客户端进程、SSH 会话无关：关掉软件、断开 SSH 都不影响
 * 代理运行，且开机自启。tun 的 auto_route 是系统级的 —— 该主机所有用户都走同一个上游。
 *
 * 上下文取当前激活连接（与文件/监控按钮同口径），无活动连接时两个按钮禁用。
 */

import { createSignal, createEffect, Show } from 'solid-js';
import { Route, X } from 'lucide-solid';
import { activePopup, isPopup, togglePopup } from './popups';
import { notifyError, notifyInfo, startTask, patchTask, finishTask } from './notify';
import { showConfirm } from '../modal';
import {
    tunStatus, tunInstall, tunUninstall, tunEnable, tunDisable, tunSpeedtest,
    sshOnInstallProgress,
} from '../platform';
import type { FmCtx } from './filemgr';

const PW = 300; /* 与 CSS .tun-panel 宽度一致（居中/夹紧换算用） */

/* 排除地址默认值：不走代理的常用局域网 / 保留地址（每行一个网段） */
const DEFAULT_EXCLUDES = [
    '127.0.0.0/8',      /* 本机回环 */
    '10.0.0.0/8',       /* 私有网段 A */
    '172.16.0.0/12',    /* 私有网段 B */
    '192.168.0.0/16',   /* 私有网段 C */
    '169.254.0.0/16',   /* 链路本地（含云元数据） */
    '::1/128',          /* IPv6 回环 */
    'fc00::/7',         /* IPv6 唯一本地地址 */
    'fe80::/10',        /* IPv6 链路本地 */
].join('\n');

const [pos, setPos] = createSignal({ x: 0, y: 0 });
/* 当前作用的主机（打开面板时由按钮写入） */
const [ctx, setCtx] = createSignal<FmCtx | null>(null);
/* 输入项暂存：重开面板保留上次填写 */
const [server, setServer] = createSignal('');
const [exclude, setExclude] = createSignal(DEFAULT_EXCLUDES);
const [installed, setInstalled] = createSignal(false);
const [running, setRunning] = createSignal(false);
const [version, setVersion] = createSignal('');
const [statusErr, setStatusErr] = createSignal('');
const [busy, setBusy] = createSignal(false);
const [stage, setStage] = createSignal('');
const [speed, setSpeed] = createSignal('');

/* ---------------- 每主机记忆（localStorage） ----------------
 *
 *  服务器地址与排除地址都按主机分别记忆：键与 SSH 连接池同口径（用户@主机:SSH 端口），
 *  这样切标签/重开软件回来还在，换一台主机也不会报错串用别的主机的上游。
 *  不随「停用 / 卸载」清除——重填一次上游地址太琐碎。 */

const PREF_KEY = 'xwd-tun-v1';

interface TunPref {
    /** 上游代理地址（socks5:// 或 http:// 前缀可省） */
    server: string;
    /** 排除地址多行文本 */
    exclude: string;
}

function prefKey(c: FmCtx | null): string {
    return c ? `${c.user}@${c.host}:${c.port}` : '';
}

/** 读取本机记忆；没有记录时给出默认值（空地址 + 默认排除列表） */
function loadPref(c: FmCtx | null): TunPref {
    const k = prefKey(c);
    if (k) {
        try {
            const all = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') as Record<string, Partial<TunPref> | undefined>;
            const p = all[k];
            if (p) {
                return {
                    server: typeof p.server === 'string' ? p.server : '',
                    exclude: typeof p.exclude === 'string' && p.exclude ? p.exclude : DEFAULT_EXCLUDES,
                };
            }
        } catch { /* 忽略：解析失败按未记忆处理 */ }
    }
    return { server: '', exclude: DEFAULT_EXCLUDES };
}

/** 保存当前输入项到本机记忆（输入时调用，值已由 setXxx 同步写入信号） */
function savePref(c: FmCtx | null): void {
    const k = prefKey(c);
    if (!k) return;
    try {
        const all = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') as Record<string, TunPref>;
        all[k] = { server: server(), exclude: exclude() };
        localStorage.setItem(PREF_KEY, JSON.stringify(all));
    } catch { /* 忽略：存满等 */ }
}

/* ---------------- 操作 ---------------- */

/** 主进程 IPC 的凭据（host 已剥成纯地址） */
function cred(): { host: string; port: number; user: string; pass?: string } | null {
    const c = ctx();
    if (!c) return null;
    return { host: c.host, port: c.port, user: c.user, pass: c.pass };
}

async function refreshStatus(): Promise<void> {
    const o = cred();
    if (!o) {
        setInstalled(false);
        setRunning(false);
        setVersion('');
        setStatusErr('');
        return;
    }
    setStage('查询远端状态…');
    const r = await tunStatus(o);
    setStage('');
    if (!r.ok) {
        setStatusErr(r.msg || '状态查询失败');
        setInstalled(false);
        setRunning(false);
        return;
    }
    setStatusErr('');
    setInstalled(r.installed);
    setRunning(r.running);
    setVersion(r.version || '');
}

/** 统一执行入口：通知中心进度条 + 面板内联状态 + 结果提示 + 状态刷新。
 *
 *  长任务（上传 30MB 包等）在通知中心以「进行中」气泡 + 面板列表进度条呈现：
 *  `taskTitle` 是进行中通知的标题，阶段文案/百分比由主进程的 install-progress
 *  事件通过 patchTask 实时刷新，结束后 finishTask 收敛为成功/失败通知。 */
async function run(
    taskTitle: string,
    startLabel: string,
    fn: () => Promise<{ ok: boolean; needSudo?: boolean; msg?: string }>,
    doneTitle: string,
): Promise<boolean> {
    if (busy()) return false;
    setBusy(true);
    setStage(startLabel);
    const id = startTask(taskTitle, startLabel);
    const off = sshOnInstallProgress((p) => {
        if (p.label) setStage(p.label);
        patchTask(id, { pct: p.pct ?? null, label: p.label });
    });
    try {
        const r = await fn();
        const hint = r.needSudo && !r.ok ? '远端账号缺少 sudo 权限。\n' : '';
        finishTask(id, r.ok, {
            title: r.ok ? doneTitle : doneTitle + '失败',
            body: hint + String(r.msg || (r.ok ? '操作完成' : '未知错误')),
        });
        await refreshStatus();
        return r.ok;
    } catch (e) {
        const em = e instanceof Error ? e.message : String(e);
        finishTask(id, false, { title: doneTitle + '失败', body: em });
        return false;
    } finally {
        off();
        setStage('');
        setBusy(false);
    }
}

async function doInstall(): Promise<void> {
    const o = cred();
    if (!o) return;
    const go = await showConfirm(
        '安装 Tun 服务',
        '将向远端主机上传内置的 sing-box（约 30MB）并安装为 systemd 服务：\n'
        + '· 安装依赖（nftables、curl）\n'
        + '· 解包到 /opt/xworkd-tun，写入 xworkd-tun.service\n'
        + '· 暂不启动（配置与启动由「启用」完成）',
    );
    if (!go) return;
    await run('安装 Tun 服务', '连接远端并上传安装包…', () => tunInstall(o), 'Tun 服务已安装');
}

async function doUninstall(): Promise<void> {
    const o = cred();
    if (!o) return;
    const go = await showConfirm(
        '卸载 Tun 服务',
        '将从远端移除 Tun 代理服务：\n'
        + '· 停止并删除 systemd 服务 xworkd-tun\n'
        + '· 删除 /opt/xworkd-tun 与 /etc/xworkd-tun\n\n'
        + '注意：若代理正在运行，该主机的网络出口会立即恢复直连。',
    );
    if (!go) return;
    await run('卸载 Tun 服务', '停止服务并清理远端文件…', () => tunUninstall(o), 'Tun 服务已卸载');
}

async function doEnable(): Promise<void> {
    const o = cred();
    if (!o) return;
    if (!server().trim()) {
        notifyInfo('请先填写服务器地址', '上游代理地址，如 socks5://1.2.3.4:1080');
        return;
    }
    if (!installed()) {
        notifyInfo('请先安装服务', '先点「安装服务」把 sing-box 装到远端主机');
        return;
    }
    const c = ctx()!;
    await run('启用 Tun 代理', '按当前填写生成配置…', () => tunEnable({
        ...o,
        server: server(),
        exclude: exclude(),
        sshPort: c.port,
        rdPort: c.rdPort,
    }), 'Tun 已启用');
}

async function doDisable(): Promise<void> {
    const o = cred();
    if (!o) return;
    const go = await showConfirm(
        '停用 Tun 代理',
        '将停止远端代理并取消开机自启（配置保留，下次可直接启用）。\n\n'
        + '注意：该主机所有用户的网络出口会立即恢复直连。',
    );
    if (!go) return;
    await run('停用 Tun 代理', '停止服务并取消开机自启…', () => tunDisable(o), 'Tun 已停用');
}

async function doSpeedtest(): Promise<void> {
    const o = cred();
    if (!o) return;
    if (!server().trim()) {
        notifyInfo('请先填写服务器地址', '上游代理地址，如 socks5://1.2.3.4:1080');
        return;
    }
    setSpeed('测速中…');
    const r = await tunSpeedtest({ ...o, server: server() });
    setSpeed(r.ok ? `${r.ms} ms` : '失败');
    if (!r.ok) notifyError('测速失败', r.msg || '未知错误');
}


/* ---------------- 顶栏按钮 ---------------- */

export function TunButton(props: { ctx: FmCtx | null }) {
    let btn: HTMLButtonElement | undefined;
    return (
        <button
            ref={btn}
            data-popup-trigger="tun"
            class="tab-btn"
            classList={{ active: activePopup() === 'tun' }}
            title="Tun 代理（在远端主机以 systemd 服务运行 sing-box）"
            onClick={() => {
                setCtx(props.ctx);
                const opened = togglePopup('tun');
                if (!opened || !btn) return;
                const r = btn.getBoundingClientRect();
                const m = 14; /* 两侧留边，避免贴边/出界 */
                setPos({
                    x: Math.min(Math.max(PW / 2 + m, r.left + r.width / 2), window.innerWidth - PW / 2 - m),
                    y: r.bottom + 8,
                });
            }}
        >
            <Route size={13} />
            <span>Tun</span>
        </button>
    );
}

/* ---------------- 弹窗（App 根部 fixed 渲染） ---------------- */

export function TunPanelHost() {
    /* 打开面板或切换主机时：先回填本机记忆，再查询远端服务状态 */
    createEffect(() => {
        if (!isPopup('tun')) return;
        const c = ctx();
        if (c) {
            const p = loadPref(c);
            setServer(p.server);
            setExclude(p.exclude);
        }
        void refreshStatus();
    });

    const statusText = (): string => {
        if (!ctx()) return '未连接主机（先在左侧连接一台主机）';
        if (statusErr()) return statusErr();
        if (!installed()) return '未安装';
        return `已安装${version() ? ' v' + version() : ''} · ${running() ? '运行中' : '已停止'}`;
    };

    return (
        <Show when={isPopup('tun')}>
            <div class="tun-panel popup-panel" style={{ left: `${pos().x}px`, top: `${pos().y}px` }}>
                <div class="sys-head">
                    <span class="sys-title"><Route size={13} /> Tun</span>
                    <button class="sys-x" onClick={() => togglePopup('tun')} title="关闭"><X size={13} /></button>
                </div>
                <div class="tun-body">
                    <div class="tun-field">
                        <div class="tun-label-row">
                            <span class="tun-label">服务器地址</span>
                            <Show when={speed()}><span class="tun-speed">{speed()}</span></Show>
                        </div>
                        <div class="tun-row">
                            <input
                                class="tun-input"
                                type="text"
                                placeholder="socks5://1.2.3.4:1080 或 http://1.2.3.4:8080"
                                value={server()}
                                onInput={(e) => { setServer(e.currentTarget.value); savePref(ctx()); }}
                            />
                            <button
                                class="tun-check"
                                disabled={busy() || !ctx()}
                                onClick={() => void doSpeedtest()}
                                title="经上游代理访问 Google，测量出口延迟"
                            >
                                测速
                            </button>
                        </div>
                    </div>
                    <div class="tun-field">
                        <div class="tun-label-row">
                            <span class="tun-label">排除地址</span>
                            <button
                                class="tun-reset"
                                onClick={() => { setExclude(DEFAULT_EXCLUDES); savePref(ctx()); }}
                                title="恢复为默认的局域网 / 保留地址"
                            >
                                重置
                            </button>
                        </div>
                        <textarea
                            class="tun-input tun-textarea"
                            rows="8"
                            spellcheck={false}
                            placeholder="每行一个网段，如 10.0.0.0/8"
                            value={exclude()}
                            onInput={(e) => { setExclude(e.currentTarget.value); savePref(ctx()); }}
                        />
                    </div>
                    <div class="tun-status" title="远端主机的服务状态">
                        {stage() || statusText()}
                    </div>
                    <div class="tun-actions">
                        <button
                            class="tun-install"
                            classList={{ 'act-danger': installed() }}
                            disabled={busy() || !ctx()}
                            onClick={() => { void (installed() ? doUninstall() : doInstall()); }}
                            title={installed()
                                ? '停止并删除远端的 XWorkDesk Tun 服务'
                                : '上传内置 sing-box 并安装为远端 systemd 服务（不启动）'}
                        >
                            {installed() ? '卸载服务' : '安装服务'}
                        </button>
                        <button
                            class="tun-enable"
                            disabled={busy() || !ctx()}
                            onClick={() => { void (running() ? doDisable() : doEnable()); }}
                            title={running()
                                ? '停止代理并取消开机自启（配置保留）'
                                : '按当前填写生成配置并启动（设置为开机自启）'}
                        >
                            {running() ? '停用' : '启用'}
                        </button>
                    </div>
                </div>
            </div>
        </Show>
    );
}
