/* main.cjs —— XWorkDesk Electron 主进程。
 *
 * 职责：
 *   - 创建应用窗口并加载前端（dev 加载 Vite dev server，prod 加载 dist/index.html）
 *   - 提供系统级能力 IPC：
 *       剪贴板写文本 / 剪贴板轮询(文本+复制文件检测 uri-list)
 *       下载：远程文件自动保存到系统「下载」目录（静默、不弹选择框）
 *       上传：本地文件按服务端分片协议 POST 到远程桌面
 *   - webSecurity:false —— 桌面壳只加载自身打包的 UI，从不加载远端 HTML，
 *     仅连接远端 ws/API；关闭混合内容检查以允许非 localhost 明文 ws（原 Tauri
 *     受 secure-context 限制的痛点）。contextIsolation 仍开启保护 preload。
 */

const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

/* 远程音频会话登录后即播放，需免除“用户手势才能出声”的自动播放限制 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/* 单例窗口（进度事件回推用） */
let win = null;

/* 向渲染层推事件（进度等） */
function sendToUi(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------------- 剪贴板 ---------------- */

function parseUriList(buf) {
    /* Nautilus/Windows 复制文件 -> text/uri-list：每行一个 file:// URI */
    const text = buf.toString('utf8');
    const files = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        let u = t;
        try { u = decodeURIComponent(t); } catch { /* keep */ }
        const m = /^file:\/\/(.+)$/i.exec(u);
        if (!m) continue;
        let p = m[1];
        /* 去掉 host（file://localhost/ 或 file:/// ） */
        if (p.startsWith('localhost/')) p = p.slice('localhost/'.length);
        p = p.replace(/\r$/, '');
        if (process.platform === 'win32') {
            /* file:///C:/x -> C:\x */
            if (/^[a-zA-Z]:\//.test(p)) p = p.replace(/\//g, '\\');
        }
        if (p && fs.existsSync(p)) files.push(p);
    }
    return files;
}

/* 读取剪贴板：返回 { text, files }。files 仅在桌面复制文件场景出现。 */
function clipPoll() {
    let text = '';
    try { text = clipboard.readText() || ''; } catch { text = ''; }
    const files = [];
    try {
        const formats = clipboard.availableFormats();
        if (formats.includes('text/uri-list')) {
            files.push(...parseUriList(clipboard.readBuffer('text/uri-list')));
        }
    } catch { /* 忽略 */ }
    return { text: text || null, files };
}

/* ---------------- 传输工具 ---------------- */

/* 主进程全局 fetch（Node >= 18）。进度回推给渲染层。 */
function sendProgress(p) {
    if (win && !win.isDestroyed()) win.webContents.send('xwd:progress', p);
}

function sanitizeName(name) {
    /* 去路径分隔与非法字符，仅保留 basename 语义 */
    let n = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '');
    n = n.trim() || 'file';
    return n;
}

/* 自动避免重名：a.txt -> a (1).txt */
function uniquePath(p) {
    if (!fs.existsSync(p)) return p;
    const ext = path.extname(p);
    const base = path.basename(p, ext);
    for (let i = 1; i < 10000; i++) {
        const cand = path.join(path.dirname(p), `${base} (${i})${ext}`);
        if (!fs.existsSync(cand)) return cand;
    }
    return p;
}

/* 下载：GET /api/transfer/download?token&path -> 写入本地「下载」目录 */
async function downloadRemoteFiles({ api, token, paths }) {
    const dlDir = app.getPath('downloads');
    let ok = true;
    let msg = '';
    for (const p of paths || []) {
        try {
            const name = sanitizeName(String(p).split('/').pop() || 'file');
            const url = `${api}/api/transfer/download?token=${encodeURIComponent(token)}&path=${encodeURIComponent(p)}`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}${resp.statusText ? ' ' + resp.statusText : ''}`);
            const total = Number(resp.headers.get('content-length') || 0);
            const buf = Buffer.from(await resp.arrayBuffer());
            const dest = uniquePath(path.join(dlDir, name));
            fs.writeFileSync(dest, buf);
            sendProgress({ done: buf.length, total: total || buf.length, name });
        } catch (err) {
            ok = false;
            msg = `${String(p).split('/').pop()}: ${err.message}`;
            break;
        }
    }
    return { ok, msg };
}

/* 上传：按服务端分片协议 POST /api/transfer/upload?token&dir&name&offset，body 为原始分片 */
async function uploadLocalFiles({ api, token, dir, files }) {
    const CHUNK = 1024 * 1024; /* 1 MiB 分片 */
    let ok = true;
    let msg = '';
    for (const f of files || []) {
        const name = sanitizeName(path.basename(f));
        try {
            const st = fs.statSync(f);
            if (!st.isFile()) continue; /* 目录/链接整批跳过 */
            const total = st.size;
            const fd = fs.openSync(f, 'r');
            let offset = 0;
            try {
                for (; ;) {
                    /* 空文件也发一次空 body 让服务端创建文件 */
                    const len = total === 0 ? 0 : Math.min(CHUNK, total - offset);
                    if (total !== 0 && len <= 0) break;
                    const b = Buffer.alloc(len);
                    if (len > 0) fs.readSync(fd, b, 0, len, offset);
                    const qs = new URLSearchParams({
                        token, name, dir: dir || '', offset: String(offset),
                    });
                    const resp = await fetch(`${api}/api/transfer/upload?${qs}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: b,
                    });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    offset += len;
                    if (total === 0) break;
                    sendProgress({ done: offset, total, name });
                }
            } finally {
                fs.closeSync(fd);
            }
        } catch (err) {
            ok = false;
            msg = `${name}: ${err.message}`;
            break;
        }
    }
    return { ok, msg };
}

/* ---------------- IPC 注册 ---------------- */

function registerIpc() {
    ipcMain.handle('xwd:clipWriteText', (_e, text) => {
        clipboard.writeText(String(text ?? ''));
    });
    ipcMain.handle('xwd:clipPoll', () => {
        const r = clipPoll();
        /* 返回前确保全部字段可结构化克隆（IPC），并打印结构便于诊断 */
        const safe = {
            text: typeof r.text === 'string' && r.text.length ? r.text : null,
            files: Array.isArray(r.files) ? r.files.filter((f) => typeof f === 'string') : [],
        };
        return safe;
    });
    ipcMain.handle('xwd:download', (_e, opt) => downloadRemoteFiles(opt || {}));
    ipcMain.handle('xwd:upload', (_e, opt) => uploadLocalFiles(opt || {}));

    /* ---- 窗口控制（自制标题栏：无系统边框） ---- */
    ipcMain.on('xwd:winMin', () => win && win.minimize());
    ipcMain.on('xwd:winMaxToggle', () => {
        if (!win) return;
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
    });
    ipcMain.on('xwd:winClose', () => win && win.close());
    ipcMain.handle('xwd:winIsMax', () => !!(win && win.isMaximized()));
    /* 窗口级全屏（渲染层全屏沉浸模式；DOM 全保留，弹层/面板仍可用） */
    ipcMain.handle('xwd:winSetFs', (_e, on) => {
        if (!win) return false;
        win.setFullScreen(!!on);
        /* 主动同步一次状态（X11/Windows 无 enter/leave-full-screen，resize 推送可能延迟） */
        if (!win.isDestroyed()) sendWinFs(win.isFullScreen());
        return true;
    });
    ipcMain.handle('xwd:winIsFs', () => !!(win && win.isFullScreen()));

    /* ---- SSH 终端会话（ssh2） ---- */
    ipcMain.handle('xwd:ssh:connect', (_e, opt) => startSshSession(opt || {}));
    ipcMain.on('xwd:ssh:input', (_e, opt) => {
        const r = sshSessions.get(opt && opt.id);
        if (r && r.stream) {
            try { r.stream.write(opt.data); } catch { /* 忽略 */ }
        }
    });
    ipcMain.on('xwd:ssh:resize', (_e, opt) => {
        const r = sshSessions.get(opt && opt.id);
        if (r && r.stream) {
            try { r.stream.setWindow(opt.rows, opt.cols); } catch { /* 忽略 */ }
        }
    });
    ipcMain.on('xwd:ssh:close', (_e, opt) => closeSshSession(opt && opt.id));

    /* ---- SSH 服务探测 / 一键安装 ---- */
    ipcMain.handle('xwd:ssh:probe', (_e, opt) => sshProbeServer(opt || {}));
    ipcMain.handle('xwd:ssh:installServer', (_e, opt) => sshInstallServer(opt || {}));

    /* ---- 远程文件面板（SFTP） ---- */
    ipcMain.handle('xwd:file:open', (_e, opt) => sftpOpen(opt || {}));
    ipcMain.handle('xwd:file:list', (_e, opt) => sftpList(opt || {}));
    ipcMain.handle('xwd:file:mkdir', (_e, opt) => sftpMkdir(opt || {}));
    ipcMain.handle('xwd:file:rename', (_e, opt) => sftpRename(opt || {}));
    ipcMain.handle('xwd:file:remove', (_e, opt) => sftpRemove(opt || {}));
    ipcMain.handle('xwd:file:upload', (_e, opt) => sftpUpload(opt || {}));
    ipcMain.handle('xwd:file:download', (_e, opt) => sftpDownload(opt || {}));
    ipcMain.handle('xwd:file:close', (_e, id) => { sftpClose(id); return { ok: true }; });
}

/* ---- 一次性 SSH exec / sftp（服务探测与安装） ---- */
function sshExecOnce(opt, cmd, stdinData) {
    return new Promise((resolve) => {
        const client = new Client();
        const chunks = [];
        let errBuf = '';
        client.on('ready', () => {
            client.exec(cmd, (err, stream) => {
                if (err) {
                    client.end();
                    resolve({ code: -1, out: '', err: err.message });
                    return;
                }
                stream.on('data', (d) => chunks.push(d));
                stream.stderr.on('data', (d) => { errBuf += d.toString(); });
                stream.on('close', (code) => {
                    client.end();
                    resolve({ code: code == null ? -1 : code, out: Buffer.concat(chunks).toString(), err: errBuf });
                });
                if (stdinData) {
                    stream.stdin.write(stdinData);
                    stream.stdin.end();
                }
            });
        });
        client.on('error', (e) => resolve({ code: -2, out: '', err: (e && e.message) || String(e) }));
        const p = Number(opt.port) || 22;
        client.connect({
            host: String(opt.host || 'localhost'),
            port: p,
            username: String(opt.user || ''),
            password: opt.pass ? String(opt.pass) : undefined,
            readyTimeout: 12000,
        });
    });
}

function sftpPutOnce(opt, localFile, remoteFile) {
    return new Promise((resolve) => {
        const client = new Client();
        const finish = (r) => { try { client.end(); } catch { /* 忽略 */ } resolve(r); };
        client.on('ready', () => {
            client.sftp((err, sftp) => {
                if (err) return finish({ ok: false, msg: 'sftp 打开失败: ' + err.message });
                sftp.fastPut(localFile, remoteFile, (e) => {
                    finish(e ? { ok: false, msg: '上传失败: ' + e.message } : { ok: true });
                });
            });
        });
        client.on('error', (e) => finish({ ok: false, msg: (e && e.message) || String(e) }));
        const p = Number(opt.port) || 22;
        client.connect({
            host: String(opt.host || 'localhost'),
            port: p,
            username: String(opt.user || ''),
            password: opt.pass ? String(opt.pass) : undefined,
            readyTimeout: 12000,
        });
    });
}

/* 探测远端 xworkd 服务状态：running / stopped / not_installed / unreachable */
async function sshProbeServer(opt) {
    const cmd = 'o=""; command -v xworkd >/dev/null 2>&1 && o="$o BIN"; if systemctl is-active --quiet xworkd 2>/dev/null; then o="$o ACTIVE"; fi; if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q "[:.]5268 "; then o="$o PORT"; fi; echo "${o:-NONE}";';
    const r = await sshExecOnce(opt, cmd);
    if (r.code === -2) return { ok: false, status: 'unreachable', msg: r.err };
    const o = r.out.trim();
    let status = 'not_installed';
    if (o.includes('PORT')) status = 'running';
    else if (o.includes('ACTIVE')) status = 'stopped';
    else if (o.includes('BIN')) status = 'stopped';
    return { ok: true, status, msg: o || r.err };
}

/* 推送内置服务端安装包并远端一键安装（sudo 复用账号密码）
 * 过程事件经 xwd:ssh:install-progress 回推：{stage:'upload'|'install', pct, label} */
async function sshInstallServer(opt) {
    const local = path.join(__dirname, '..', 'server-bundle', 'xworkd-server.tar.gz');
    if (!fs.existsSync(local)) return { ok: false, msg: '缺少内置服务端安装包(server-bundle)' };
    const remote = '/tmp/xworkd-server.tar.gz';
    sendToUi('xwd:ssh:install-progress', { stage: 'upload', pct: 0.1, label: '通过 SSH 上传安装包…' });
    const up = await sftpPutOnce(opt, local, remote);
    if (!up.ok) return up;
    sendToUi('xwd:ssh:install-progress', { stage: 'install', pct: null, label: '远端安装中：下载依赖、写入系统服务（约 1 分钟）…' });
    const run = 'sudo -S -p \'\' bash -c "rm -rf /tmp/xworkd-server && mkdir -p /tmp/xworkd-server && tar -C /tmp/xworkd-server -xzf /tmp/xworkd-server.tar.gz && cd /tmp/xworkd-server/xworkd-server && bash install.sh"';
    const r = await sshExecOnce(opt, run, opt.pass ? String(opt.pass) + '\n' : '');
    const needSudo = /not in the sudoers file|a password is required|no password was provided|incorrect password|authentication failure/i.test(r.err || '');
    const ok = r.out.includes('XWORKD_INSTALL_OK') || r.code === 0;
    return { ok, needSudo, msg: ((r.out || '') + (r.err || '')).trim().slice(-1000), code: r.code };
}
const sshSessions = new Map();

function closeSshSession(id) {
    const r = sshSessions.get(id);
    if (!r) return;
    try { r.client.end(); } catch { /* 忽略 */ }
    sshSessions.delete(id);
}

function sendSshClose(id, code) {
    if (win && !win.isDestroyed()) win.webContents.send('xwd:ssh:close', { id, code });
    closeSshSession(id);
}

/* 建立 SSH 连接并打开伪终端通道；返回 {ok} 或 {ok:false,msg} */
function startSshSession({ id, host, port, user, pass }) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
        const fail = (msg) => { closeSshSession(id); finish({ ok: false, msg }); };

        const client = new Client();
        const rec = { id, client, stream: null };
        sshSessions.set(id, rec);

        client.on('ready', () => {
            client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
                if (err) return fail('打开远程 shell 失败: ' + err.message);
                rec.stream = stream;
                finish({ ok: true });
                stream.on('data', (d) => {
                    if (win && !win.isDestroyed()) win.webContents.send('xwd:ssh:data', { id, data: d });
                });
                stream.on('close', () => sendSshClose(id, 0));
                stream.on('error', () => { /* close 统一处理 */ });
            });
        });
        client.on('error', (err) => fail('SSH 连接失败: ' + (err && err.message ? err.message : String(err))));

        const p = Number(port) || 22;
        client.connect({
            host: String(host || 'localhost'),
            port: p,
            username: String(user || ''),
            password: pass ? String(pass) : undefined,
            readyTimeout: 12000,
        });
    });
}

/* 远端重启（已安装但停止）xworkd 服务 */
async function sshStartServer(opt) {
    const r = await sshExecOnce(opt, 'sudo -S -p \'\' systemctl restart xworkd', opt.pass ? String(opt.pass) + '\n' : '');
    const needSudo = /not in the sudoers file|a password is required|no password was provided|incorrect password|authentication failure/i.test(r.err || '');
    return { ok: r.code === 0, needSudo, msg: ((r.out || '') + (r.err || '')).trim().slice(-600), code: r.code };
}
ipcMain.handle('xwd:ssh:startServer', (_e, opt) => sshStartServer(opt || {}));

/* ---------------- 系统监控（SSH 采集远端 CPU/内存/进程/磁盘） ---------------- */
const sysClients = new Map(); /* id -> ssh2 Client（长连接，周期快照） */

const SYS_SCRIPT = [
    "c1=$(awk '/^cpu /{print $2+$3+$4, $5}' /proc/stat)",
    'sleep 1',
    "c2=$(awk '/^cpu /{print $2+$3+$4, $5}' /proc/stat)",
    "awk -v a=\"$c1\" -v b=\"$c2\" 'BEGIN{split(a,A,\" \");split(b,B,\" \");u=B[1]-A[1];i=B[2]-A[2];t=u+i;if(t<1)t=1;printf \"CPU %d\\n\",u*100/t}'",
    "awk -F: '/MemTotal|MemAvailable/{gsub(/[^0-9]/,\"\",$2);printf \"MEM %s %s\\n\",$1,$2}' /proc/meminfo",
    'echo PSLIST',
    "ps -eo comm,rss --no-headers --sort=-rss | awk '!seen[$1]++' | head -8",
    'echo DFLIST',
    "df -P -x tmpfs -x devtmpfs -x overlay -x squashfs -x proc -x sysfs -x cgroup -x cgroup2 -x securityfs -x debugfs -x tracefs -x fusectl -x configfs -x pstore -x efivarfs -x selinuxfs -x mqueue -x hugetlbfs -x binfmt_misc 2>/dev/null | awk 'NR>1{print $6\"|\"$2\"|\"$3\"|\"$4\"|\"$5}'",
].join('\n');

/* 建立监控长连接（同一 id 幂等） */
function sysOpen(opt) {
    return new Promise((resolve) => {
        const id = String((opt && opt.id) || '');
        if (!id) return resolve({ ok: false, msg: '缺少 id' });
        if (sysClients.has(id)) return resolve({ ok: true });
        const client = new Client();
        client.on('ready', () => { sysClients.set(id, client); resolve({ ok: true }); });
        client.on('error', (e) => { sysClients.delete(id); resolve({ ok: false, msg: (e && e.message) || String(e) }); });
        client.on('close', () => { if (sysClients.get(id) === client) sysClients.delete(id); });
        const p = Number(opt.port) || 22;
        client.connect({
            host: String(opt.host || 'localhost'),
            port: p,
            username: String(opt.user || ''),
            password: opt.pass ? String(opt.pass) : undefined,
            readyTimeout: 12000,
        });
    });
}

function sysClose(id) {
    const c = sysClients.get(id);
    if (c) { try { c.end(); } catch { /* 忽略 */ } sysClients.delete(id); }
}

/* 解析快照输出 → 结构化样本 */
function parseSysOut(out) {
    const s = { cpu: 0, mem: { total: 0, avail: 0 }, procs: [], disks: [] };
    let sec = '';
    for (const raw of String(out || '').split('\n')) {
        const t = raw.trim();
        if (!t) continue;
        const cpuM = /^CPU\s+(\d+)$/.exec(t);
        if (cpuM) { s.cpu = Number(cpuM[1]); continue; }
        const memM = /^MEM\s+(\w+)\s+(\d+)$/.exec(t);
        if (memM) {
            const kb = Number(memM[2]);
            if (memM[1] === 'MemTotal') s.mem.total = kb;
            else if (memM[1] === 'MemAvailable') s.mem.avail = kb;
            continue;
        }
        if (t === 'PSLIST') { sec = 'ps'; continue; }
        if (t === 'DFLIST') { sec = 'df'; continue; }
        if (sec === 'ps') {
            const sp = t.split(/\s+/);
            const rss = Number(sp[sp.length - 1]) || 0;
            const name = sp.slice(0, sp.length - 1).join(' ');
            if (name) s.procs.push({ name, rss });
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

/* 快照一次：脚本内含 sleep 1 采 CPU 近 1s 平均，单连接串行 */
function sysSample(id) {
    return new Promise((resolve) => {
        const client = sysClients.get(id);
        if (!client) return resolve({ ok: false, msg: '未连接' });
        client.exec(SYS_SCRIPT, (err, stream) => {
            if (err) return resolve({ ok: false, msg: err.message });
            let out = '';
            stream.on('data', (d) => { out += d.toString(); });
            stream.on('close', () => { resolve({ ok: true, ...parseSysOut(out) }); });
            stream.on('error', (e) => resolve({ ok: false, msg: (e && e.message) || '执行失败' }));
        });
    });
}

ipcMain.handle('xwd:sys:open', (_e, opt) => sysOpen(opt || {}));
ipcMain.handle('xwd:sys:sample', (_e, id) => sysSample(String(id || '')));
ipcMain.on('xwd:sys:close', (_e, id) => sysClose(String(id || '')));

/* ---------------- 远程文件面板（基于 SFTP） ---------------- */
const fileSessions = new Map(); /* id -> { client, sftp } */

function sftpGet(id) {
    const r = fileSessions.get(id);
    return r && r.sftp ? r.sftp : null;
}

function sftpClose(id) {
    const r = fileSessions.get(id);
    if (!r) return;
    try { r.client.end(); } catch { /* 忽略 */ }
    fileSessions.delete(id);
}

function sftpJoin(dir, name) {
    const d = dir == null || dir === '' ? '' : String(dir);
    const n = String(name).replace(/^\/+/, '');
    if (d === '/' || d === '') return '/' + n;
    return d.replace(/\/+$/, '') + '/' + n;
}

function readdirEntries(sftp, p, cb) {
    sftp.readdir(p, (err, list) => {
        if (err) return cb(err, null);
        const rows = (list || [])
            .filter((f) => f && f.filename && f.filename !== '.' && f.filename !== '..')
            .map((f) => {
                const a = f.attrs || {};
                const isDir = (a.mode & 0o040000) === 0o040000;
                return {
                    name: String(f.filename),
                    isDir: !!isDir,
                    size: a.size || 0,
                    mtime: a.mtime != null ? a.mtime * 1000 : 0,
                };
            });
        rows.sort((x, y) => {
            if (x.isDir !== y.isDir) return x.isDir ? -1 : 1;
            return x.name.localeCompare(y.name);
        });
        cb(null, rows);
    });
}

/* 打开（建连 + 定位到用户主目录并列出） */
function sftpOpen(opt) {
    const id = opt.id;
    sftpClose(id);
    return new Promise((resolve) => {
        const client = new Client();
        const fail = (msg) => {
            try { client.end(); } catch { /* 忽略 */ }
            resolve({ ok: false, msg });
        };
        client.on('ready', () => {
            const goSftp = (home) => {
                client.sftp((err2, sftp) => {
                    if (err2) return fail('sftp 打开失败: ' + err2.message);
                    fileSessions.set(id, { client, sftp });
                    const start = home && home.startsWith('/') ? home : '/';
                    readdirEntries(sftp, start, (err3, rows) => {
                        if (err3) { sftpClose(id); return resolve({ ok: false, msg: '读取目录失败: ' + err3.message }); }
                        resolve({ ok: true, cwd: start, entries: rows });
                    });
                });
            };
            let called = false;
            const onHome = (home) => { if (!called) { called = true; goSftp(home); } };
            client.exec('printf %s "$HOME"', (err, stream) => {
                if (err) return onHome('/');
                const ch = [];
                stream.on('data', (d) => ch.push(d));
                stream.on('close', () => onHome(Buffer.concat(ch).toString().trim() || '/'));
                stream.on('error', () => onHome('/'));
            });
        });
        client.on('error', (e) => resolve({ ok: false, msg: '连接失败: ' + ((e && e.message) || String(e)) }));
        const p = Number(opt.port) || 22;
        client.connect({
            host: String(opt.host || 'localhost'),
            port: p,
            username: String(opt.user || ''),
            password: opt.pass ? String(opt.pass) : undefined,
            readyTimeout: 12000,
        });
    });
}

function sftpList(opt) {
    return new Promise((resolve) => {
        const sftp = sftpGet(opt.id);
        const p = String(opt.path || '/');
        if (!sftp) return resolve({ ok: false, msg: '未连接' });
        readdirEntries(sftp, p, (err, rows) => {
            if (err) return resolve({ ok: false, msg: (err && err.message) || String(err) });
            resolve({ ok: true, cwd: p, entries: rows });
        });
    });
}

function sftpMkdir(opt) {
    return new Promise((resolve) => {
        const sftp = sftpGet(opt.id);
        if (!sftp) return resolve({ ok: false, msg: '未连接' });
        sftp.mkdir(String(opt.path || ''), (e) => resolve(e ? { ok: false, msg: e.message } : { ok: true }));
    });
}

function sftpRename(opt) {
    return new Promise((resolve) => {
        const sftp = sftpGet(opt.id);
        if (!sftp) return resolve({ ok: false, msg: '未连接' });
        sftp.rename(String(opt.from || ''), String(opt.to || ''), (e) => resolve(e ? { ok: false, msg: e.message } : { ok: true }));
    });
}

/* 递归删除目录 */
function rmrf(sftp, p, done) {
    sftp.readdir(p, (e, list) => {
        if (e) return sftp.rmdir(p, done);
        let i = 0;
        const next = () => {
            if (i >= (list || []).length) return sftp.rmdir(p, (er) => done(er));
            const f = (list || [])[i++];
            const fp = sftpJoin(p, f.filename);
            const isDir = (f.attrs.mode & 0o040000) === 0o040000;
            if (isDir) rmrf(sftp, fp, () => next());
            else sftp.unlink(fp, () => next()); /* 单项失败不阻断整体 */
        };
        next();
    });
}

function sftpRemove(opt) {
    return new Promise((resolve) => {
        const sftp = sftpGet(opt.id);
        const p = String(opt.path || '');
        if (!sftp) return resolve({ ok: false, msg: p ? '未连接' : '路径为空' });
        if (!opt.isDir) {
            sftp.unlink(p, (e) => resolve(e ? { ok: false, msg: e.message } : { ok: true }));
            return;
        }
        rmrf(sftp, p, (e) => resolve(e ? { ok: false, msg: e.message } : { ok: true }));
    });
}

/* 上传：弹本地文件选择框，fastPut 到当前目录 */
async function sftpUpload(opt) {
    const sftp = sftpGet(opt.id);
    const dir = String(opt.dir || '/');
    if (!sftp) return { ok: false, msg: '未连接' };
    let paths = [];
    try {
        const r = await dialog.showOpenDialog(win, {
            title: '选择要上传的文件',
            properties: ['openFile', 'multiSelections'],
        });
        if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
        paths = r.filePaths;
    } catch (err) {
        return { ok: false, msg: '选择文件失败: ' + ((err && err.message) || String(err)) };
    }
    const done = [];
    for (const lp of paths) {
        const name = path.basename(lp);
        await new Promise((res) => {
            sftp.fastPut(lp, sftpJoin(dir, name), (e) => { if (!e) done.push(name); res(); });
        });
    }
    return { ok: true, uploaded: done };
}

/* 下载：静默保存到系统「下载」目录（自动避免重名） */
function sftpDownload(opt) {
    return new Promise((resolve) => {
        const sftp = sftpGet(opt.id);
        const rp = String(opt.path || '');
        if (!sftp) return resolve({ ok: false, msg: !rp ? '路径为空' : '未连接' });
        if (!rp) return resolve({ ok: false, msg: '路径为空' });
        const name = sanitizeName(String(rp).split('/').pop() || 'file');
        const dlDir = app.getPath('downloads');
        const dest = uniquePath(path.join(dlDir, name));
        sftp.fastGet(rp, dest, (e) => {
            resolve(e ? { ok: false, msg: e.message } : { ok: true, dest, name });
        });
    });
}

function sendWinMax(maxed) {
    if (win && !win.isDestroyed()) win.webContents.send('xwd:win-max', maxed);
}

function sendWinFs(fs) {
    if (win && !win.isDestroyed()) win.webContents.send('xwd:win-fs', fs);
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
    win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        title: 'XWorkDesk',
        backgroundColor: '#1e1f22',
        autoHideMenuBar: true,
        /* 无系统边框：UI 自绘标题栏（自制最小化/最大化/关闭） */
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: false,
            /* 桌面壳只运行自身打包的受信前端，不加载任何远端页面；
             * 关闭安全上下文限制以直连非 localhost 明文 ws/wss。 */
            webSecurity: false,
        },
    });

    win.setMenuBarVisibility(false);
    win.on('maximize', () => sendWinMax(true));
    win.on('unmaximize', () => sendWinMax(false));
    /* 全屏状态变化同步给渲染层（X11/Windows 无 enter/leave-full-screen 事件，靠 resize 兜底检测） */
    let lastFs = false;
    const pushFs = () => {
        if (!win) return;
        const fs = win.isFullScreen();
        if (fs !== lastFs) { lastFs = fs; sendWinFs(fs); }
    };
    win.on('resize', pushFs);
    win.on('enter-full-screen', () => sendWinFs(true)); /* macOS */
    win.on('leave-full-screen', () => sendWinFs(false));

    const devUrl = process.env.XWD_DEV_URL;
    if (devUrl) {
        void win.loadURL(devUrl);
    } else {
        void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    }

    /* 站内新窗口（如有）一律交给系统浏览器 */
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) require('electron').shell.openExternal(url);
        return { action: 'deny' };
    });

    win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
    registerIpc();
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
