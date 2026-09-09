/* server.ts —— 目标 xworkd 服务器地址管理（跨机连接）。
 * 登录时输入 user@host[:port]，解析后连接远程服务器。
 * 协议默认 http，端口默认 5268（xworkd 默认端口）；可显式写 http(s)://host。 */

export interface ServerTarget {
    origin: string;   /* 如 http://192.168.1.10:5268 */
    wsUrl: string;    /* 如 ws://192.168.1.10:5268/ws */
    apiBase: string;  /* 如 http://192.168.1.10:5268 */
}

const DEFAULT_PORT = 5268;

/* 解析 host[:port]（可带 http(s):// 前缀），返回 ServerTarget 或 null；host 为空返回 null。 */
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

    if (!hp) return null;

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

/* 取 host[:port]（可带 http(s):// 前缀）中的主机名与端口（默认 5268），供连通性探测 */
export function hostEndpoint(hostPort: string): { host: string; port: number } | null {
    const t = resolveServer(hostPort);
    if (!t) return null;
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/:]+)(?::(\d+))?$/i.exec(t.origin);
    if (!m || !m[1]) return null;
    return { host: m[1], port: Number(m[2] || 5268) };
}
