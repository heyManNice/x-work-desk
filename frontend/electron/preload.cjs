/* preload.cjs —— 通过 contextBridge 向渲染层暴露 window.xwd（最小能力面）。 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xwd', {
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
});
