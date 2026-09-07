/* main.tsx —— Solid 入口：挂载 App 到 #app-root */

import { render } from 'solid-js/web';
import App from './App';
import './style.css';

const root = document.getElementById('app-root');
if (root) render(() => <App />, root);
