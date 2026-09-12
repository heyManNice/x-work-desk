/* main.cts —— XWorkDesk Electron 主进程入口。
 *
 * 职责边界：
 *   - 这里只负责应用生命周期（开关、macOS activate）与启动顺序；
 *   - 窗口创建在 window.cts；
 *   - IPC 契约（渲染层 <-> 主进程）在 ipc/index.cts；
 *   - SSH 相关能力在 ssh/（连接池 / 终端 / 监控 / SFTP / 服务端安装引导）。
 *
 * 安全模型：webSecurity:false —— 桌面壳只加载自身打包的 UI，从不加载远端 HTML，
 * 仅连接远端 ws/API；关闭混合内容检查以允许非 localhost 明文 ws（原 Tauri
 * 受 secure-context 限制的痛点）。contextIsolation 仍开启保护 preload。
 */

import { app, BrowserWindow } from 'electron';
import { registerIpc } from './ipc/index.cjs';
import { createWindow } from './window.cjs';

/* 远程音频会话登录后即播放，需免除“用户手势才能出声”的自动播放限制 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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
