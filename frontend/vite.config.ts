import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { readFileSync } from 'node:fs';

/* 客户端版本号编译期固定（与 package.json version 同步） */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
    base: './',
    define: {
        __APP_VERSION__: JSON.stringify(String(pkg.version || '0.0.0')),
    },
    plugins: [solid()],
    build: {
        outDir: 'dist',
        /* es2022：避免把依赖里的 `||=`（ES2021）降级重写。
         * es2020 目标会对 xterm 6 已压缩产物再做一次 esbuild 降级/压缩，
         * 导致 `requestMode` 里 `let r; (…)(r||={})` 的声明被删，
         * 变成给未声明变量赋值 → 终端解析 DECRQM 时抛 ReferenceError（vim 启动即卡死）。 */
        target: 'es2022',
        assetsDir: 'assets',
    },
    server: {
        port: 5173,
        proxy: {
            '/ws': {
                target: 'ws://localhost:5268',
                ws: true,
            },
        },
    },
});
