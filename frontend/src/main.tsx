/* main.tsx —— Solid 入口：挂载 App 到 #app-root */

import { render } from 'solid-js/web';
import App from './App';
import { installLogCapture, logInfo } from './core/log';
import { platform } from './platform';
import { APP_VERSION } from './core/version';
/* 终端字体：Maple Mono CN（成对设计的等宽字体，含中文，中英严格 2:1） */
import '@automann/maple-mono-cn/regular.css';
import './style.css';
import '@xterm/xterm/css/xterm.css';

/* 先挂日志捕获，再渲染：启动早期的报错（含第三方库只 console.error 的那种）也能
 * 落进内存日志，用户可在「关于」面板一键导出（见 core/log.ts）。 */
installLogCapture();
logInfo('app', `客户端启动：v${APP_VERSION} 平台=${platform() || navigator.platform || '未知'} `
    + `窗口=${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}x`);

const root = document.getElementById('app-root');
if (root) render(() => <App />, root);
