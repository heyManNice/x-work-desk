/* preload.cjs —— 通过 contextBridge 向渲染层暴露 window.xwd（最小能力面）。 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xwd', {
    /* 平台：darwin / win32 / linux */
    platform: process.platform,
    /* 剪贴板 */
    clipWriteText: (text) => ipcRenderer.invoke('xwd:clipWriteText', text),
    clipPoll: () => ipcRenderer.invoke('xwd:clipPoll'),
    /* 传输（文件自动下载到系统下载目录 / 本地文件自动上传远程桌面） */
    downloadRemoteFiles: (opt) => ipcRenderer.invoke('xwd:download', opt),
    uploadLocalFiles: (opt) => ipcRenderer.invoke('xwd:upload', opt),
    /* 传输进度订阅，返回取消函数 */
    onTransferProgress: (cb) => {
        const listener = (_e, p) => cb(p);
        ipcRenderer.on('xwd:progress', listener);
        return () => ipcRenderer.removeListener('xwd:progress', listener);
    },
    /* 窗口控制（自制标题栏） */
    windowControl: {
        minimize: () => ipcRenderer.send('xwd:winMin'),
        toggleMaximize: () => ipcRenderer.send('xwd:winMaxToggle'),
        close: () => ipcRenderer.send('xwd:winClose'),
        isMaximized: () => ipcRenderer.invoke('xwd:winIsMax'),
        onMaximizeChange: (cb) => {
            const listener = (_e, maxed) => cb(maxed);
            ipcRenderer.on('xwd:win-max', listener);
            return () => ipcRenderer.removeListener('xwd:win-max', listener);
        },
        /* 窗口级全屏 */
        setFullScreen: (on) => ipcRenderer.invoke('xwd:winSetFs', on),
        isFullScreen: () => ipcRenderer.invoke('xwd:winIsFs'),
        onFullScreenChange: (cb) => {
            const listener = (_e, fs) => cb(fs);
            ipcRenderer.on('xwd:win-fs', listener);
            return () => ipcRenderer.removeListener('xwd:win-fs', listener);
        },
    },
    /* SSH 终端会话（ssh2） */
    ssh: {
        connect: (opt) => ipcRenderer.invoke('xwd:ssh:connect', opt),
        write: (id, data) => ipcRenderer.send('xwd:ssh:input', { id, data }),
        resize: (id, cols, rows) => ipcRenderer.send('xwd:ssh:resize', { id, cols, rows }),
        close: (id) => ipcRenderer.send('xwd:ssh:close', { id }),
        onData: (id, cb) => {
            const listener = (_e, p) => { if (p && p.id === id) cb(p.data); };
            ipcRenderer.on('xwd:ssh:data', listener);
            return () => ipcRenderer.removeListener('xwd:ssh:data', listener);
        },
        onClose: (id, cb) => {
            const listener = (_e, p) => { if (p && p.id === id) cb(p.code || 0); };
            ipcRenderer.on('xwd:ssh:close', listener);
            return () => ipcRenderer.removeListener('xwd:ssh:close', listener);
        },
        probe: (opt) => ipcRenderer.invoke('xwd:ssh:probe', opt),
        startServer: (opt) => ipcRenderer.invoke('xwd:ssh:startServer', opt),
        installServer: (opt) => ipcRenderer.invoke('xwd:ssh:installServer', opt),
        onInstallProgress: (cb) => {
            const listener = (_e, p) => cb(p);
            ipcRenderer.on('xwd:ssh:install-progress', listener);
            return () => ipcRenderer.removeListener('xwd:ssh:install-progress', listener);
        },
    },
    /* 远程文件面板（SFTP） */
    file: {
        open: (opt) => ipcRenderer.invoke('xwd:file:open', opt),
        list: (id, path) => ipcRenderer.invoke('xwd:file:list', { id, path }),
        mkdir: (id, path) => ipcRenderer.invoke('xwd:file:mkdir', { id, path }),
        rename: (id, from, to) => ipcRenderer.invoke('xwd:file:rename', { id, from, to }),
        remove: (id, path, isDir) => ipcRenderer.invoke('xwd:file:remove', { id, path, isDir }),
        upload: (id, dir) => ipcRenderer.invoke('xwd:file:upload', { id, dir }),
        download: (id, path) => ipcRenderer.invoke('xwd:file:download', { id, path }),
        close: (id) => ipcRenderer.invoke('xwd:file:close', id),
    },
});
