import { defineConfig } from 'vite';

export default defineConfig({
    base: './',
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
