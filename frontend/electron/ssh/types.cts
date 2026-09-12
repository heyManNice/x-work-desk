/* ssh/types.cts —— SSH / SFTP 共享类型（仅类型，无运行时代码）。
 * 渲染层不可信：所有字段在使用处照旧逐项 String()/Number() 收敛。
 */

/** 连接凭据：池内以 user@host:port 为键复用一条连接 */
export interface SshCred {
    host: string;
    port?: number;
    user: string;
    pass?: string;
}

/** 通用结果 */
export interface SshResult {
    ok: boolean;
    msg?: string;
}

/** 一次性 exec 的结果 */
export interface SshExecResult {
    code: number;
    out: string;
    err: string;
}

/** 远端 xworkd 服务端状态 */
export type ServerStatus = 'running' | 'stopped' | 'not_installed' | 'unreachable';

/** SFTP 目录项（与渲染层 filemgr 的 FmEntry 对应） */
export interface SftpEntry {
    name: string;
    isDir: boolean;
    size: number;
    mtime: number;
}

/** SFTP 打开结果 */
export interface SftpOpenResult {
    ok: boolean;
    cwd?: string;
    entries?: SftpEntry[] | null;
    msg?: string;
}

/** SFTP 列目录结果 */
export interface SftpListResult {
    ok: boolean;
    cwd?: string;
    entries?: SftpEntry[] | null;
    msg?: string;
}
