/* core/host.ts —— 已保存连接（主机）的数据模型与 localStorage 持久化 */

import { errText, logWarn } from './log';

export type RatioMode = 'fit' | 'stretch' | 'pixel';

export interface HostConfig {
    id: string;
    name: string;
    host: string;          /* 服务器地址（纯主机名，可带 http(s):// 前缀；不含端口） */
    user: string;
    pass?: string;         /* 可选保存；留空则连接时询问 */
    rdPort?: number;       /* 远程桌面（xworkd 服务）端口，留空/0 按 5268 */
    sshPort?: number;      /* SSH 端口，留空/0 按 22 */
    /* 连接配置 */
    res: string;           /* 'auto' 或 '1920x1080' 等 */
    scale: string;         /* 分辨率倍率 '1/4'..'2'：真实分辨率 = 基础分辨率 × 倍率 */
    ratio: RatioMode;
    bitrate: number;       /* kbps，0 = 自动 */
    fps: number;
    quality: number;       /* CRF 0-28，越小越清晰 */
    audio: boolean;
    clipboard: boolean;
    anim: boolean;
    staticSkip: boolean;
    debug: boolean;
    /** 使用本机输入法：本机 IME 组词，预编辑/提交经会话送到远端引擎上屏
     * （远端需装 xworkd-im 引擎；见 docs/input-method-local.md） */
    localIM?: boolean;
}

const KEY = 'xwd-hosts-v1';

export function defaultHost(): HostConfig {
    return {
        id: '',
        name: '',
        host: '',
        user: '',
        pass: '',
        rdPort: 5268,
        sshPort: 22,
        res: 'auto',
        scale: '1',
        ratio: 'fit',
        bitrate: 0,
        fps: 30,
        quality: 23,
        audio: true,
        clipboard: true,
        anim: true,
        staticSkip: true,
        debug: false,
        localIM: false,
    };
}

export function newId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadHosts(): HostConfig[] {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) {
            logWarn('host', `主机列表格式异常（不是数组）：${raw.slice(0, 120)}`);
            return [];
        }
        return arr.filter((h) => h && typeof h.id === 'string');
    } catch (e) {
        /* 不静默：读失败等于"主机列表突然空了"，必须留线索 */
        logWarn('host', `读取主机列表失败：${errText(e)}`);
        return [];
    }
}

export function saveHosts(hosts: HostConfig[]): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(hosts));
    } catch (e) {
        /* 配额满/被禁用：用户下次打开发现改动没了，日志里要能对上 */
        logWarn('host', `保存主机列表失败（${hosts.length} 项）：${errText(e)}`);
    }
}

/* 新增/更新：有 id 且命中则替换，否则追加 */
export function upsertHost(list: HostConfig[], h: HostConfig): HostConfig[] {
    const i = list.findIndex((x) => x.id === h.id);
    if (i >= 0) {
        const next = list.slice();
        next[i] = h;
        return next;
    }
    return [...list, h];
}

export function removeHost(list: HostConfig[], id: string): HostConfig[] {
    return list.filter((x) => x.id !== id);
}

/* 从 host 串生成展示用地址文本 */
export function hostDisplay(h: HostConfig): string {
    return h.user ? `${h.user}@${h.host || '?'}` : (h.host || '未命名');
}

/* 分辨率倍率字符串 → 数值：'1/4'→0.25、'3/2'→1.5、'2'→2；非法/空 → 1 */
export function scaleFactor(s: string | undefined): number {
    const m = /^(\d+)(?:\s*\/\s*(\d+))?$/.exec((s || '1').trim());
    if (!m) return 1;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : 1;
    return b === 0 ? 1 : a / b;
}
