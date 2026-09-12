/* ssh/sysmon.cts —— 远端系统资源采集（CPU / 内存 / 进程 / 磁盘）。
 *
 * 每 5s 在池化连接上开一个 exec channel 跑一次快照脚本（脚本内含 sleep 1
 * 采近 1s 的 CPU 均值）；连接本体由 ssh/pool 复用，这里只记录使用者。
 */

import { sshAcquire, sshRelease, hasHolder, onConnClosed, type ConnEntry } from './pool.cjs';
import type { SshCred, SshResult } from './types.cjs';

export interface SysMem {
    total: number;
    avail: number;
    buffers: number;
    cached: number;
    swapTotal: number;
    swapFree: number;
}

export interface SysSampleData {
    cpu: number;
    cores: number;
    model: string;
    cpuProcs: Array<{ name: string; cpuPct: number }>;
    mem: SysMem;
    procs: Array<{ name: string; rss: number }>;
    disks: Array<{ mount: string; totalKB: number; usedKB: number; availKB: number; pct: number }>;
}

export interface SysSample extends SysSampleData {
    ok: boolean;
    msg?: string;
}

export interface SysOpenOpt extends SshCred {
    id: string;
}

const clients = new Map<string, { conn: ConnEntry }>();

const SYS_SCRIPT = [
    "c1=$(awk '/^cpu /{print $2+$3+$4, $5}' /proc/stat)",
    'sleep 1',
    "c2=$(awk '/^cpu /{print $2+$3+$4, $5}' /proc/stat)",
    "awk -v a=\"$c1\" -v b=\"$c2\" 'BEGIN{split(a,A,\" \");split(b,B,\" \");u=B[1]-A[1];i=B[2]-A[2];t=u+i;if(t<1)t=1;printf \"CPU %d\\n\",u*100/t}'",
    "awk -F: '/MemTotal|MemAvailable|Buffers|^Cached|SwapTotal|SwapFree|SReclaimable|Shmem/{gsub(/[^0-9]/,\"\",$2);printf \"MEM %s %s\\n\",$1,$2}' /proc/meminfo",
    'echo PSLIST',
    "ps -eo comm,rss --no-headers --sort=-rss | awk '!seen[$1]++' | head -8",
    'echo DFLIST',
    "df -P -x tmpfs -x devtmpfs -x overlay -x squashfs -x proc -x sysfs -x cgroup -x cgroup2 -x securityfs -x debugfs -x tracefs -x fusectl -x configfs -x pstore -x efivarfs -x selinuxfs -x mqueue -x hugetlbfs -x binfmt_misc 2>/dev/null | awk 'NR>1{print $6\"|\"$2\"|\"$3\"|\"$4\"|\"$5}'",
    "echo \"MODEL $(awk -F: '/model name/{print $2; exit}' /proc/cpuinfo)\"",
    'echo "CORES $(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"',
    'echo CPUTOP',
    "ps -eo comm,%cpu --no-headers --sort=-%cpu | awk '!seen[$1]++' | head -6",
].join('\n');

/** 订阅某 id 的监控（幂等）：连接取自（或复用）该账户的池化连接 */
export function sysOpen(opt: SysOpenOpt): Promise<SshResult> {
    const id = String((opt && opt.id) || '');
    if (!id) return Promise.resolve({ ok: false, msg: '缺少 id' });
    if (clients.has(id)) return Promise.resolve({ ok: true });
    const holder = `sys:${id}`;
    return sshAcquire({ host: opt.host, port: opt.port, user: opt.user, pass: opt.pass }, holder)
        .then((res) => {
            if (!res.ok) return { ok: false, msg: res.msg };
            if (!hasHolder(holder)) return { ok: false, msg: '已取消' }; /* 建连期间标签已关闭 */
            clients.set(id, { conn: res.conn });
            return { ok: true };
        });
}

export function sysClose(id: string): void {
    clients.delete(id);
    sshRelease(`sys:${id}`);
}

/** 解析快照输出 → 结构化样本 */
function parseSysOut(out: string): SysSampleData {
    const s: SysSampleData = {
        cpu: 0, cores: 0, model: '',
        mem: { total: 0, avail: 0, buffers: 0, cached: 0, swapTotal: 0, swapFree: 0 },
        cpuProcs: [], procs: [], disks: [],
    };
    const memKeys: Record<string, keyof SysMem> = {
        MemTotal: 'total', MemAvailable: 'avail', Buffers: 'buffers',
        Cached: 'cached', SwapTotal: 'swapTotal', SwapFree: 'swapFree',
    };
    let sec = '';
    for (const raw of String(out || '').split('\n')) {
        const t = raw.trim();
        if (!t) continue;
        const cpuM = /^CPU\s+(\d+)$/.exec(t);
        if (cpuM) { s.cpu = Number(cpuM[1]); continue; }
        const coresM = /^CORES\s+(\d+)$/.exec(t);
        if (coresM) { s.cores = Number(coresM[1]); continue; }
        if (t.startsWith('MODEL ')) { s.model = t.slice(6).trim(); continue; }
        const memM = /^MEM\s+(\w+)\s+(\d+)$/.exec(t);
        if (memM) {
            const k = memKeys[memM[1]];
            if (k) s.mem[k] = Number(memM[2]);
            continue;
        }
        if (t === 'PSLIST') { sec = 'ps'; continue; }
        if (t === 'DFLIST') { sec = 'df'; continue; }
        if (t === 'CPUTOP') { sec = 'cpu'; continue; }
        if (sec === 'ps') {
            const sp = t.split(/\s+/);
            const rss = Number(sp[sp.length - 1]) || 0;
            const name = sp.slice(0, sp.length - 1).join(' ');
            if (name) s.procs.push({ name, rss });
            continue;
        }
        if (sec === 'cpu') {
            const sp = t.split(/\s+/);
            const cpuPct = Number(sp[sp.length - 1]) || 0;
            const name = sp.slice(0, sp.length - 1).join(' ');
            if (name) s.cpuProcs.push({ name, cpuPct });
            continue;
        }
        if (sec === 'df') {
            const p = t.split('|');
            if (p.length >= 5 && p[0].startsWith('/')) {
                s.disks.push({
                    mount: p[0],
                    totalKB: Number(p[1]) || 0,
                    usedKB: Number(p[2]) || 0,
                    availKB: Number(p[3]) || 0,
                    pct: Number(String(p[4] || '0').replace('%', '')) || 0,
                });
            }
        }
    }
    return s;
}

/** 失败样本：渲染层只看 ok/msg，其余字段仅为满足返回结构 */
function failSample(msg: string): SysSample {
    return {
        ok: false, msg, cpu: 0, cores: 0, model: '', cpuProcs: [],
        mem: { total: 0, avail: 0, buffers: 0, cached: 0, swapTotal: 0, swapFree: 0 },
        procs: [], disks: [],
    };
}

/** 快照一次：脚本内含 sleep 1 采 CPU 近 1s 平均，同连接上开一个新的 exec channel */
export function sysSample(id: string): Promise<SysSample> {
    return new Promise<SysSample>((resolve) => {
        const rec = clients.get(id);
        if (!rec) return resolve(failSample('未连接'));
        rec.conn.client.exec(SYS_SCRIPT, (err, stream) => {
            if (err) return resolve(failSample(err.message));
            let out = '';
            stream.on('data', (d: Buffer) => { out += d.toString(); });
            stream.on('close', () => { resolve({ ok: true, ...parseSysOut(out) }); });
            stream.on('error', (e: Error) => resolve(failSample((e && e.message) || '执行失败')));
        });
    });
}

/* 连接意外断开：清掉使用者记录（下次采样失败 → 面板显示采集失败） */
onConnClosed('sys', (id) => {
    clients.delete(id);
});
