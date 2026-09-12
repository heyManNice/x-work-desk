/* server.ts —— 目标 xworkd 服务器地址管理（跨机连接）。
 * 服务器地址 = 纯主机名（可带 http(s):// 前缀），端口由 HostConfig.rdPort 单独承载
 * （默认 5268）；为兼容旧配置，地址里若仍带有 `:端口` 也会被识别（显式 port 优先）。 */

export interface ServerTarget {
    origin: string;   /* 如 http://192.168.1.10:5268 */
    wsUrl: string;    /* 如 ws://192.168.1.10:5268/ws */
    apiBase: string;  /* 如 http://192.168.1.10:5268 */
}

const DEFAULT_PORT = 5268;

/* 端口合法性：1..65535 */
function validPort(n: unknown): number | null {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 && v < 65536 ? Math.floor(v) : null;
}

/* 取地址中显式写的端口（没有则 null） */
export function addrPort(addr: string): number | null {
    let a = (addr || '').trim().replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/\/+$/, '');
    const c = a.lastIndexOf(':');
    if (c > 0 && /^\d+$/.test(a.slice(c + 1))) return validPort(a.slice(c + 1));
    return null;
}

/* 归一化服务器地址：只保留（可选）scheme + 主机名，剥掉端口与末尾斜杠。
 * 端口统一由「远程桌面端口」字段承载，避免两种写法并存。 */
export function normalizeHost(addr: string): string {
    let a = (addr || '').trim();
    let scheme = '';
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(a);
    if (m) { scheme = m[0]; a = a.slice(m[0].length); }
    a = a.replace(/\/+$/, '');
    const c = a.lastIndexOf(':');
    if (c > 0 && /^\d+$/.test(a.slice(c + 1))) a = a.slice(0, c);
    return scheme + a;
}

/* 解析地址（+ 可选端口）→ ServerTarget；host 为空返回 null。
 * 端口优先级：显式传入 > 地址里写的（兼容旧配置）> 5268。 */
export function resolveServer(addr: string, port?: number): ServerTarget | null {
    let hp = (addr || '').trim();

    let scheme = 'http';
    const protoMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(hp);
    if (protoMatch) {
        scheme = protoMatch[1].toLowerCase();
        if (scheme !== 'http' && scheme !== 'https') scheme = 'http';
        hp = hp.slice(protoMatch[0].length);
    }
    hp = hp.replace(/\/+$/, '');

    if (!hp) return null;

    /* 分离 host 与端口：末尾冒号后为纯数字视为端口（旧配置兼容） */
    let host = hp;
    let embedded = 0;
    const colon = hp.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(hp.slice(colon + 1))) {
        host = hp.slice(0, colon);
        embedded = Number(hp.slice(colon + 1));
    }
    if (!host) return null;
    const effPort = String(validPort(port) || validPort(embedded) || DEFAULT_PORT);
    const wsScheme = scheme === 'https' ? 'wss' : 'ws';
    const origin = `${scheme}://${host}:${effPort}`;
    const hostPart = `${host}:${effPort}`;
    return {
        origin,
        wsUrl: `${wsScheme}://${hostPart}/ws`,
        apiBase: origin,
    };
}

/* 取地址中的主机名与端口（端口缺省 5268），供连通性探测 */
export function hostEndpoint(addr: string, port?: number): { host: string; port: number } | null {
    const t = resolveServer(addr, port);
    if (!t) return null;
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/:]+)(?::(\d+))?$/i.exec(t.origin);
    if (!m || !m[1]) return null;
    return { host: m[1], port: Number(m[2] || DEFAULT_PORT) };
}
