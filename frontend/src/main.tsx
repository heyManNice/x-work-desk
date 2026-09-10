/* main.tsx —— Solid 入口：挂载 App 到 #app-root */

import { render } from 'solid-js/web';
import App from './App';
/* 终端字体：Maple Mono CN（成对设计的等宽字体，含中文，中英严格 2:1） */
import '@automann/maple-mono-cn/regular.css';
import './style.css';
import '@xterm/xterm/css/xterm.css';

const root = document.getElementById('app-root');
if (root) render(() => <App />, root);
