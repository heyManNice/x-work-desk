/* util.cts —— 主进程通用小工具。 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

/** 系统「下载」目录 */
export function downloadsDir(): string {
    return app.getPath('downloads');
}

/** 随包资源与前端产物所在的应用根目录
 *  （dev 为 frontend/，打包后为 resources/app.asar；避免依赖 __dirname 的层级） */
export function appRoot(): string {
    return app.getAppPath();
}

/** 文件名净化：去路径分隔与非法字符，仅保留 basename 语义 */
export function sanitizeName(name: string): string {
    const n = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').trim();
    return n || 'file';
}

/** 自动避免重名：a.txt -> a (1).txt */
export function uniquePath(p: string): string {
    if (!fs.existsSync(p)) return p;
    const ext = path.extname(p);
    const base = path.basename(p, ext);
    for (let i = 1; i < 10000; i++) {
        const cand = path.join(path.dirname(p), `${base} (${i})${ext}`);
        if (!fs.existsSync(cand)) return cand;
    }
    return p;
}
