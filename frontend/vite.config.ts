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
        target: 'es2020',
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
