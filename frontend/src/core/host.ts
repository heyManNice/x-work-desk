/* core/host.ts —— 已保存连接（主机）的数据模型与 localStorage 持久化 */

export type RatioMode = 'fit' | 'stretch' | 'pixel';

export interface HostConfig {
    id: string;
    name: string;
    host: string;          /* host[:port]，可带 http(s):// 前缀 */
    user: string;
    pass?: string;         /* 可选保存；留空则连接时询问 */
    /* 连接配置 */
    res: string;           /* 'auto' 或 '1920x1080' 等 */
    ratio: RatioMode;
    bitrate: number;       /* kbps，0 = 自动 */
    fps: number;
    quality: number;       /* CRF 0-28，越小越清晰 */
    audio: boolean;
    clipboard: boolean;
    anim: boolean;
    staticSkip: boolean;
    debug: boolean;
}

const KEY = 'xwd-hosts-v1';

export function defaultHost(): HostConfig {
    return {
        id: '',
        name: '',
        host: '',
        user: '',
        pass: '',
        res: 'auto',
        ratio: 'fit',
        bitrate: 0,
        fps: 30,
        quality: 23,
        audio: true,
        clipboard: true,
        anim: false,
        staticSkip: false,
        debug: false,
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
        if (!Array.isArray(arr)) return [];
        return arr.filter((h) => h && typeof h.id === 'string');
    } catch {
        return [];
    }
}

export function saveHosts(hosts: HostConfig[]): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(hosts));
    } catch { /* 忽略：存满等 */ }
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
