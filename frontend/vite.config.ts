import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
    base: './',
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
