/* core/conn.ts —— 与连接/主机相关的纯工具与类型。
 *
 * 供 App 顶栏（文件/系统监控/“关于”）统一推导“当前激活连接”的信息，
 * 也承载主机串（host[:port]，可带 http(s)://）解析，避免各处重复。
 */

export type ConnKind = 'desktop' | 'terminal';

/** 从保存的主机地址解析出纯主机名（剥 scheme/端口），SSH 走 22 端口 */
export function sshHostOf(h: { host: string }): string {
    let hp = (h.host || '').trim();
    const s = /^[a-z][a-z0-9+.-]*:\/\//i.exec(hp);
    if (s) hp = hp.slice(s[0].length);
    hp = hp.replace(/\/+$/, '');
    const c = hp.lastIndexOf(':');
    if (c > 0 && /^\d+$/.test(hp.slice(c + 1))) hp = hp.slice(0, c);
    return hp || 'localhost';
}

/** 未做类型强绑定的“进行中连接”记录（App.pendingMap 结构匹配即可） */
export interface PendingConnLike {
    type: ConnKind;
    host: { name?: string; host: string };
    target: { apiBase: string } | null;
    sshHost?: string;
    sshPort?: number;
    user: string;
    pass: string;
}

/** 某标签连接的统一视图：顶栏文件/系统监控与“关于”共用 */
export interface ActiveConn {
    tabId: number;
    type: ConnKind;
    name: string;
    sshHost: string;
    sshPort: number;
    user: string;
    pass: string;
    apiBase: string; /* 桌面会话的 xworkd 地址；SSH 终端为空 */
}

export function resolveActiveConn(tabId: number, p: PendingConnLike | undefined): ActiveConn | null {
    if (!p) return null;
    const hh = sshHostOf(p.host);
    return {
        tabId,
        type: p.type,
        name: (p.host.name || '').trim() || p.host.host || hh || '未命名',
        sshHost: (p.sshHost || '').trim() || hh,
        sshPort: p.sshPort || 22,
        user: p.user,
        pass: p.pass,
        apiBase: p.target ? p.target.apiBase : '',
    };
}
