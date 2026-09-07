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
const path = require('path');
const fs = require('fs');

/* 单例窗口（进度事件回推用） */
let win = null;

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
        try {
            console.log('[clipPoll] ->', JSON.stringify({ textLen: safe.text ? safe.text.length : 0, files: safe.files }));
        } catch { /* 忽略 */ }
        return safe;
    });
    ipcMain.handle('xwd:download', (_e, opt) => downloadRemoteFiles(opt || {}));
    ipcMain.handle('xwd:upload', (_e, opt) => uploadLocalFiles(opt || {}));
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
    win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        title: 'XWorkDesk 远程桌面',
        backgroundColor: '#1e1f22',
        autoHideMenuBar: true,
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
