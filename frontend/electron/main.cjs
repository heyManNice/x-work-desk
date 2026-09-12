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
const net = require('net');
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

/* 读取剪贴板：返回 { text, files }。files 仅在桌面复制文件场景出现。
 * 注：当前 Electron 的 clipboard 已改为 Promise/W3C API（readText/writeText 异步，
 * availableFormats/readBuffer 已移除，改用 read() 的 ClipboardItem.types/getType）。 */
async function clipPoll() {
    let text = '';
    try {
        text = (await clipboard.readText()) || '';
    } catch { /* 读取失败按空处理 */ }
    const files = [];
    try {
        const items = await clipboard.read();
        for (const it of items || []) {
            const types = (it && it.types) || [];
            if (types.includes('text/uri-list') || types.includes('text/uri-list;charset=utf-8')) {
                const blob = await it.getType('text/uri-list');
                files.push(...parseUriList(Buffer.from(await blob.arrayBuffer())));
            }
        }
    } catch { /* 非文件场景无 files */ }
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
    /* TCP 连通性探测（主机状态/延迟）：返回连接耗时毫秒；失败 -1 */
    ipcMain.handle('xwd:ping', (_e, opt) => new Promise((resolve) => {
        const host = String((opt && opt.host) || '').trim();
        const port = Number((opt && opt.port) || 5268);
        if (!host) { resolve(-1); return; }
        const t0 = Date.now();
        const sock = net.connect({ host, port });
        let settled = false;
        const done = (ok) => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch { /* 忽略 */ }
            resolve(ok ? Date.now() - t0 : -1);
        };
        sock.setTimeout(2000);
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
    }));
    /* “关于”信息：经 SSH 采集远端系统版本 / 桌面环境版本 */
    ipcMain.handle('xwd:about:hostinfo', (_e, opt) => sshCollectAbout(opt || {}));
    ipcMain.handle('xwd:clipWriteText', async (_e, text) => {
        try { await clipboard.writeText(String(text ?? '')); } catch { /* 忽略 */ }
    });
    ipcMain.handle('xwd:clipPoll', async () => {
        const r = await clipPoll();
        /* 返回前确保全部字段可结构化克隆（IPC） */
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

/* ---- 一次性 SSH exec / sftp（服务探测、启动与安装） ----
 * 经 sshBorrow 复用当前已打开的 SSH 连接（同账户）：主机上已有终端/监控/文件
 * 面板在用时不再重新做一遍 TCP + 认证；无活跃连接时才临时新建、用完即断。 */
async function sshExecOnce(opt, cmd, stdinData) {
    const b = await sshBorrow(opt);
    if (!b.ok) return { code: -2, out: '', err: b.msg || 'SSH 连接失败' };
    let off = null;
    try {
        return await new Promise((resolve) => {
            let done = false;
            const fin = (r) => { if (!done) { done = true; resolve(r); } };
            /* 借用的连接可能中途断开：立即返回，避免 IPC 调用永不返回 */
            off = b.onClose(() => fin({ code: -2, out: '', err: 'SSH 连接已断开' }));
            b.client.exec(cmd, (err, stream) => {
                if (err) { fin({ code: -1, out: '', err: err.message }); return; }
                const chunks = [];
                let errBuf = '';
                stream.on('data', (d) => chunks.push(d));
                stream.stderr.on('data', (d) => { errBuf += d.toString(); });
                stream.on('close', (code) => {
                    fin({ code: code == null ? -1 : code, out: Buffer.concat(chunks).toString(), err: errBuf });
                });
                stream.on('error', (e) => {
                    fin({ code: -1, out: Buffer.concat(chunks).toString(), err: (e && e.message) || errBuf });
                });
                if (stdinData) {
                    stream.stdin.write(stdinData);
                    stream.stdin.end();
                }
            });
        });
    } finally {
        if (off) off();
        b.release();
    }
}

async function sftpPutOnce(opt, localFile, remoteFile) {
    const b = await sshBorrow(opt);
    if (!b.ok) return { ok: false, msg: b.msg || 'SSH 连接失败' };
    let off = null;
    try {
        return await new Promise((resolve) => {
            let done = false;
            const fin = (r) => { if (!done) { done = true; resolve(r); } };
            off = b.onClose(() => fin({ ok: false, msg: 'SSH 连接已断开' }));
            b.client.sftp((err, sftp) => {
                if (err) { fin({ ok: false, msg: 'sftp 打开失败: ' + err.message }); return; }
                sftp.fastPut(localFile, remoteFile, (e) => {
                    fin(e ? { ok: false, msg: '上传失败: ' + e.message } : { ok: true });
                });
            });
        });
    } finally {
        if (off) off();
        b.release();
    }
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
/* “关于”：经 SSH 采集远端系统版本 / 桌面环境版本（一次命令，容忍缺失） */
async function sshCollectAbout(opt) {
    const cmd = [
        'PRETTY=$(awk -F= \'/^PRETTY_NAME=/{print $2}\' /etc/os-release 2>/dev/null | tr -d \'"\')',
        'echo "OS=${PRETTY:-Linux}"',
        'DE=${XDG_CURRENT_DESKTOP:-}',
        'if [ -z "$DE" ]; then for d in gnome-shell plasmashell xfce4-session mate-session cinnamon-session budgie-desktop; do if pgrep -x "$d" >/dev/null 2>&1; then DE=$d; break; fi; done; fi',
        'case "$DE" in gnome-shell) DE="GNOME";; plasmashell) DE="KDE Plasma";; xfce4-session) DE="XFCE";; mate-session) DE="MATE";; cinnamon-session) DE="Cinnamon";; budgie-desktop) DE="Budgie";; esac',
        'DEV=""',
        'if command -v gnome-shell >/dev/null 2>&1; then DEV=$(gnome-shell --version 2>/dev/null | awk \'{print $3}\'); fi',
        'echo "DE=${DE:-unknown}"',
        'echo "DEV=${DEV:-}"',
        'SHL=""',
        'if [ -n "${BASH_VERSION:-}" ]; then SHL="bash ${BASH_VERSION%%(*}"; elif [ -n "${ZSH_VERSION:-}" ]; then SHL="zsh $ZSH_VERSION"; else SB=$(basename "$(readlink -f /proc/$$/exe 2>/dev/null)" 2>/dev/null); [ -n "$SB" ] && SHL="$SB"; fi',
        'echo "SH=${SHL:-unknown}"',
    ].join('; ');
    const r = await sshExecOnce(opt, cmd);
    if (r.code === -2) return { ok: false, msg: r.err };
    const out = r.out || '';
    const grab = (k) => {
        const m = new RegExp('(?:^|\\n|; )' + k + '=(.*?)(?:\\n|$)', 'm').exec(out);
        return m ? m[1].trim() : '';
    };
    return { ok: true, os: grab('OS'), de: grab('DE'), deVersion: grab('DEV'), shell: grab('SH') };
}

/* ---------------- SSH 连接池（同一账户复用一条连接） ----------------
 * 对「同一个账户」只建立一条 TCP + 一次 SSH 认证的连接：终端 shell、系统监控
 * exec、文件 SFTP 各自在这条连接上开自己的 channel（SSH 协议原生支持一条连接
 * 多 channel），避免每启用一个功能就重做一遍 TCP 握手 + KEX + 密码认证
 * （密码认证在广域网上往往是秒级开销）。
 *
 * 复用键：user@host:port；持有者（holder）为 ssh:<tabId> / sys:<tabId> /
 * file:<tabId> / once:<n>，引用计数归零才真正断开。因此关闭某个标签只关掉它
 * 自己的 channel，不影响同一主机上其它标签/面板。
 *
 * 与「全局连接池」的区别：不做跨主机的空闲连接驻留，条目随最后一个使用者
 * 释放而销毁；连接意外断开时会把挂在其上的各功能逐一清理并通知前端。
 */
const sshPool = new Map();    /* key -> entry */
const sshHolders = new Map(); /* holder -> entry（按持有者释放用） */
let sshOnceSeq = 0;

function sshKeyOf(o) {
    return `${String((o && o.user) || '')}@${String((o && o.host) || 'localhost')}:${Number((o && o.port) || 0) || 22}`;
}

function sshConnectClient(opt) {
    const client = new Client();
    client.connect({
        host: String(opt.host || 'localhost'),
        port: Number(opt.port) || 22,
        username: String(opt.user || ''),
        password: opt.pass ? String(opt.pass) : undefined,
        readyTimeout: 12000,
    });
    return client;
}

/* 建池条目：处理「就绪 / 连接失败 / 断开」三种结局 */
function sshPoolOpen(key, opt) {
    const entry = {
        key,
        opt: { ...opt },
        client: null,
        refs: 0,
        holders: new Set(),
        ready: false,
        dead: false,
        readyCbs: [],
        failCbs: [],
        closedCbs: new Map(), /* holder -> cb（一次性借用者关心断开，避免调用永不返回） */
    };
    sshPool.set(key, entry);

    const client = sshConnectClient(opt);
    entry.client = client;
    let settled = false;

    client.on('ready', () => {
        settled = true;
        entry.ready = true;
        const cbs = entry.readyCbs;
        entry.readyCbs = [];
        entry.failCbs = [];
        for (const cb of cbs) cb({ ok: true, conn: entry });
    });
    client.on('error', (e) => {
        if (settled) return; /* 就绪后的错误由 close 统一处置 */
        settled = true;
        entry.dead = true;
        if (sshPool.get(key) === entry) sshPool.delete(key);
        const msg = (e && e.message) || String(e);
        const cbs = entry.failCbs;
        entry.readyCbs = [];
        entry.failCbs = [];
        for (const cb of cbs) cb({ ok: false, msg });
    });
    client.on('close', () => {
        entry.dead = true;
        if (sshPool.get(key) === entry) sshPool.delete(key);
        if (!settled) {
            settled = true;
            const cbs = entry.failCbs;
            entry.readyCbs = [];
            entry.failCbs = [];
            for (const cb of cbs) cb({ ok: false, msg: 'SSH 连接已断开' });
        }
        sshPoolClosed(entry);
    });
    return entry;
}

/* 获取（必要时建立）到某账户的连接；holder 作为使用者标识参与引用计数 */
function sshAcquire(opt, holder) {
    const key = sshKeyOf(opt);
    let entry = sshPool.get(key);
    if (entry && entry.dead) entry = undefined;
    if (!entry) entry = sshPoolOpen(key, opt);
    entry.refs += 1;
    entry.holders.add(holder);
    sshHolders.set(holder, entry);
    if (entry.ready) return Promise.resolve({ ok: true, conn: entry });
    return new Promise((resolve) => {
        entry.readyCbs.push(() => resolve({ ok: true, conn: entry }));
        entry.failCbs.push((r) => {
            sshHolders.delete(holder);
            entry.holders.delete(holder);
            entry.refs = Math.max(0, entry.refs - 1);
            resolve({ ok: false, msg: r.msg });
        });
    });
}

/* 释放一个使用者；最后一个使用者退出时才真正断开连接 */
function sshRelease(holder) {
    const entry = sshHolders.get(holder);
    if (!entry) return;
    sshHolders.delete(holder);
    entry.holders.delete(holder);
    entry.closedCbs.delete(holder);
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    if (sshPool.get(entry.key) === entry) sshPool.delete(entry.key);
    entry.dead = true;
    try { entry.client.end(); } catch { /* 忽略 */ }
}

/* 连接断开（对端关闭/网络中断）：清理挂在它上面的各功能并通知前端，
 * 避免面板继续停留在“已连接”的假象 */
function sshPoolClosed(entry) {
    for (const holder of Array.from(entry.holders)) {
        entry.holders.delete(holder);
        sshHolders.delete(holder);
        const m = /^([a-z]+):(.*)$/.exec(holder);
        if (!m) continue;
        const kind = m[1];
        const id = m[2];
        if (kind === 'ssh') {
            if (sshSessions.has(id)) sendSshClose(id, 0); /* 终端：提示“连接已关闭” */
        } else if (kind === 'sys') {
            sysClients.delete(id); /* 监控：下次采样失败 → 面板显示采集失败 */
        } else if (kind === 'file') {
            const r = fileSessions.get(id);
            if (r) {
                try { r.sftp.end(); } catch { /* 忽略 */ }
                fileSessions.delete(id); /* 文件面板：后续操作提示未连接 */
            }
        }
    }
    const cbs = Array.from(entry.closedCbs.values());
    entry.closedCbs.clear();
    entry.refs = 0;
    for (const cb of cbs) { try { cb(); } catch { /* 忽略 */ } }
}

/* 借一条连接做一次性任务（探测/启动/安装/关于）：
 *   - 池中已有该账户的活跃连接 → 直接借用，用完归还（不再重新认证）；
 *   - 没有 → 临时新建一条独立连接，用完即断（不进池，避免空闲连接驻留）。 */
function sshBorrow(opt) {
    const key = sshKeyOf(opt);
    const entry = sshPool.get(key);
    if (entry && entry.ready && !entry.dead) {
        const holder = `once:${++sshOnceSeq}`;
        entry.refs += 1;
        entry.holders.add(holder);
        sshHolders.set(holder, entry);
        return Promise.resolve({
            ok: true,
            client: entry.client,
            onClose: (cb) => { entry.closedCbs.set(holder, cb); return () => entry.closedCbs.delete(holder); },
            release: () => sshRelease(holder),
        });
    }
    return new Promise((resolve) => {
        const client = sshConnectClient(opt);
        let done = false;
        const fin = (r) => { if (!done) { done = true; resolve(r); } };
        client.on('ready', () => fin({
            ok: true,
            client,
            onClose: (cb) => { client.once('close', cb); return () => { /* 临时连接随用随断 */ }; },
            release: () => { try { client.end(); } catch { /* 忽略 */ } },
        }));
        client.on('error', (e) => fin({ ok: false, msg: (e && e.message) || String(e) }));
        client.on('close', () => fin({ ok: false, msg: 'SSH 连接已断开' }));
    });
}

/* ---------------- SSH 终端（在复用连接上开 shell channel） ---------------- */
const sshSessions = new Map(); /* id -> { id, conn, stream, cancelled } */

function closeSshSession(id) {
    const r = sshSessions.get(id);
    sshSessions.delete(id);
    if (r) {
        r.cancelled = true; /* 仍在建连中的会话：就绪后自行放弃 */
        try { if (r.stream) r.stream.close(); } catch { /* 忽略 */ }
    }
    /* 只释放本会话占用的引用：连接上还有监控/文件等使用者时不会被断开 */
    sshRelease(`ssh:${id}`);
}

function sendSshClose(id, code) {
    if (win && !win.isDestroyed()) win.webContents.send('xwd:ssh:close', { id, code });
    closeSshSession(id);
}

/* 建立 SSH 连接（复用同账户连接）并打开伪终端通道；返回 {ok} 或 {ok:false,msg} */
function startSshSession({ id, host, port, user, pass }) {
    const holder = `ssh:${id}`;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
        const fail = (msg) => { closeSshSession(id); finish({ ok: false, msg }); };

        const rec = { id, conn: null, stream: null, cancelled: false };
        sshSessions.set(id, rec);

        void sshAcquire({ host, port, user, pass }, holder).then((res) => {
            if (rec.cancelled) { finish({ ok: false, msg: '连接已取消' }); return; }
            if (!res.ok) {
                sshSessions.delete(id);
                finish({ ok: false, msg: 'SSH 连接失败: ' + (res.msg || '未知错误') });
                return;
            }
            rec.conn = res.conn;
            res.conn.client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
                if (err) { fail('打开远程 shell 失败: ' + err.message); return; }
                if (rec.cancelled) {
                    try { stream.close(); } catch { /* 忽略 */ }
                    finish({ ok: false, msg: '连接已取消' });
                    return;
                }
                rec.stream = stream;
                finish({ ok: true });
                stream.on('data', (d) => {
                    if (win && !win.isDestroyed()) win.webContents.send('xwd:ssh:data', { id, data: d });
                });
                stream.on('close', () => sendSshClose(id, 0));
                stream.on('error', () => { /* close 统一处理 */ });
            });
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
/* id -> { conn }：连接本体由 sshPool 持有并复用，这里只记录使用者 */
const sysClients = new Map();

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

/* 订阅某 id 的监控（幂等）：连接取自（或复用）该账户的池化连接 */
function sysOpen(opt) {
    const id = String((opt && opt.id) || '');
    if (!id) return Promise.resolve({ ok: false, msg: '缺少 id' });
    if (sysClients.has(id)) return Promise.resolve({ ok: true });
    const holder = `sys:${id}`;
    return sshAcquire({ host: opt.host, port: opt.port, user: opt.user, pass: opt.pass }, holder)
        .then((res) => {
            if (!res.ok) return { ok: false, msg: res.msg };
            if (!sshHolders.has(holder)) return { ok: false, msg: '已取消' }; /* 建连期间标签已关闭 */
            sysClients.set(id, { conn: res.conn });
            return { ok: true };
        });
}

function sysClose(id) {
    sysClients.delete(id);
    sshRelease(`sys:${id}`);
}

/* 解析快照输出 → 结构化样本 */
function parseSysOut(out) {
    const s = {
        cpu: 0, cores: 0, model: '',
        mem: { total: 0, avail: 0, buffers: 0, cached: 0, swapTotal: 0, swapFree: 0 },
        cpuProcs: [], procs: [], disks: [],
    };
    const memKeys = { MemTotal: 'total', MemAvailable: 'avail', Buffers: 'buffers', Cached: 'cached', SwapTotal: 'swapTotal', SwapFree: 'swapFree' };
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

/* 快照一次：脚本内含 sleep 1 采 CPU 近 1s 平均，同一连接上开一个新的 exec channel */
function sysSample(id) {
    return new Promise((resolve) => {
        const rec = sysClients.get(id);
        if (!rec) return resolve({ ok: false, msg: '未连接' });
        rec.conn.client.exec(SYS_SCRIPT, (err, stream) => {
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

/* ---------------- 远程文件面板（基于 SFTP，复用同账户 SSH 连接） ---------------- */
const fileSessions = new Map(); /* id -> { conn, sftp } */

function sftpGet(id) {
    const r = fileSessions.get(id);
    return r && r.sftp ? r.sftp : null;
}

/* 只关闭 SFTP channel，不释放连接引用（同一标签重新打开面板时用） */
function sftpDropChannel(id) {
    const r = fileSessions.get(id);
    if (!r) return;
    fileSessions.delete(id);
    try { r.sftp.end(); } catch { /* 忽略 */ }
}

function sftpClose(id) {
    sftpDropChannel(id);
    sshRelease(`file:${id}`);
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

/* 打开（复用/建立连接 → 开 SFTP channel → 定位到用户主目录并列出） */
async function sftpOpen(opt) {
    const id = opt.id;
    const holder = `file:${id}`;
    /* 先取得连接引用（同账户已有连接则直接复用），再丢弃旧的 SFTP channel，
     * 保证同一标签反复打开面板不会把连接断开重建。 */
    const res = await sshAcquire({ host: opt.host, port: opt.port, user: opt.user, pass: opt.pass }, holder);
    if (!res.ok) return { ok: false, msg: '连接失败: ' + (res.msg || '未知错误') };
    if (!sshHolders.has(holder)) return { ok: false, msg: '已取消' }; /* 建连期间标签已关闭 */
    sftpDropChannel(id);
    const client = res.conn.client;

    /* 远端 $HOME：文件面板初始目录 */
    const home = await new Promise((resolve) => {
        client.exec('printf %s "$HOME"', (err, stream) => {
            if (err) return resolve('/');
            const ch = [];
            stream.on('data', (d) => ch.push(d));
            stream.on('close', () => resolve(Buffer.concat(ch).toString().trim() || '/'));
            stream.on('error', () => resolve('/'));
        });
    });

    const got = await new Promise((resolve) => client.sftp((err2, sftp) => resolve(err2 || sftp)));
    if (got instanceof Error) { sftpClose(id); return { ok: false, msg: 'sftp 打开失败: ' + got.message }; }
    const sftp = got;
    if (!sshHolders.has(holder)) { /* 打开 channel 期间标签被关闭 */
        try { sftp.end(); } catch { /* 忽略 */ }
        return { ok: false, msg: '已取消' };
    }
    fileSessions.set(id, { conn: res.conn, sftp });

    const start = home && home.startsWith('/') ? home : '/';
    const rows = await new Promise((resolve) => readdirEntries(sftp, start, (e, r) => resolve(e || r)));
    if (rows instanceof Error) { sftpClose(id); return { ok: false, msg: '读取目录失败: ' + rows.message }; }
    return { ok: true, cwd: start, entries: rows };
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

    /* 禁用整个应用的缩放：
     *  - 默认应用菜单的 View→Zoom In/Out/Reset 加速键（Ctrl + / - / 0）
     *  - Ctrl + 鼠标滚轮造成的页面缩放
     * before-input-event 里 preventDefault 可同时拦截菜单加速键与页面按键。 */
    win.webContents.on('before-input-event', (e, input) => {
        if (!input.control && !input.meta) return;
        const k = input.key;
        const code = input.code;
        if (k === '+' || k === '=' || k === '-' || k === '_' || k === '0'
            || code === 'NumpadAdd' || code === 'NumpadSubtract') {
            e.preventDefault();
        }
    });
    /* Ctrl+滚轮 兜底：一旦缩放被改动立即复位 */
    win.webContents.on('zoom-changed', () => {
        if (!win || win.isDestroyed()) return;
        if (Math.abs(win.webContents.getZoomFactor() - 1) > 1e-6) win.webContents.setZoomFactor(1);
    });
    win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => { /* 忽略 */ });

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
