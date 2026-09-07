/* server.ts —— 目标 xworkd 服务器地址管理。
 * 浏览器同源部署模式：登录框不填 host（纯用户名），自动用当前 location。
 * Tauri/跨机模式：登录框输入 user@host[:port]，解析后连接远程服务器。
 * 协议默认 http，端口默认 5268（xworkd 默认端口）；可显式写 http(s)://host。 */

export interface ServerTarget {
    origin: string;   /* 如 http://192.168.1.10:5268 */
    wsUrl: string;    /* 如 ws://192.168.1.10:5268/ws */
    apiBase: string;  /* 如 http://192.168.1.10:5268 */
}

const DEFAULT_PORT = 5268;

let current: ServerTarget | null = null;

export function setServer(s: ServerTarget): void {
    current = s;
}

/* 取当前服务器；未配置时抛错（调用方应保证先解析并 setServer） */
export function getServer(): ServerTarget {
    if (!current) throw new Error('服务器未配置');
    return current;
}

/* 是否已有可用服务器（登录前探测用） */
export function hasServer(): boolean {
    return current !== null;
}

/* 解析 host[:port]（可带 http(s):// 前缀）。返回 ServerTarget 或 null。
 * hostPort 为空串时走浏览器同源模式。 */
export function resolveServer(hostPort: string): ServerTarget | null {
    let hp = hostPort.trim();

    let scheme = 'http';
    const protoMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(hp);
    if (protoMatch) {
        scheme = protoMatch[1].toLowerCase();
        if (scheme !== 'http' && scheme !== 'https') scheme = 'http';
        hp = hp.slice(protoMatch[0].length);
    }
    hp = hp.replace(/\/+$/, '');

    if (!hp) {
        /* 同源模式：浏览器环境且有 host 才可用（Tauri 里 location.host 无效） */
        if (typeof location !== 'undefined' && location.host) {
            const s = location.protocol === 'https:' ? 'https' : 'http';
            const origin = `${s}://${location.host}`;
            return {
                origin,
                wsUrl: `${s === 'https' ? 'wss' : 'ws'}://${location.host}/ws`,
                apiBase: origin,
            };
        }
        return null;
    }

    /* 分离 host 与端口：末尾冒号后为纯数字视为端口 */
    let host = hp;
    let port = '';
    const colon = hp.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(hp.slice(colon + 1))) {
        host = hp.slice(0, colon);
        port = hp.slice(colon + 1);
    }
    if (!host) return null;
    const effPort = port || String(DEFAULT_PORT);
    const wsScheme = scheme === 'https' ? 'wss' : 'ws';
    const origin = `${scheme}://${host}:${effPort}`;
    const hostPart = `${host}:${effPort}`;
    return {
        origin,
        wsUrl: `${wsScheme}://${hostPart}/ws`,
        apiBase: origin,
    };
}

/* 解析登录框 "user@host[:port]"，返回 {user, hostPort}；无 @ 时 hostPort=''（同源） */
export function splitUserHost(input: string): { user: string; hostPort: string } {
    const raw = input.trim();
    const at = raw.indexOf('@');
    if (at < 0) return { user: raw, hostPort: '' };
    return { user: raw.slice(0, at).trim(), hostPort: raw.slice(at + 1).trim() };
}
