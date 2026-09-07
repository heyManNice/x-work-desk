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

const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
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

function sendWinMax(maxed) {
    if (win && !win.isDestroyed()) win.webContents.send('xwd:win-max', maxed);
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
