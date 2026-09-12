/* ipc/logreport.cts —— 日志报告落盘（全客户端**唯一**写日志文件的地方，且由用户显式触发）。
 *
 * 流程：渲染层把内存日志格式化成文本 → 这里弹出系统"另存为"框 → 写到用户选的路径。
 * 默认目录优先"桌面"（Electron 会按平台/XDG 解析，Linux 中文环境会自动落到 ~/桌面），
 * 拿不到则回退家目录。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { app, dialog } from 'electron';
import { getWin } from '../window.cjs';
import { merrText, mlogInfo, mlogWarn } from '../log.cjs';

export interface SaveLogResult {
    ok: boolean;
    /** 用户取消（不是错误，界面不该报错） */
    canceled?: boolean;
    path?: string;
    msg?: string;
}

/** 文件名消毒：去掉各平台非法字符，并限长 */
function safeName(name: string): string {
    const s = String(name || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 120);
    return s || 'xworkd-log.txt';
}

/** 默认目录：桌面（不存在则家目录） */
async function defaultDir(): Promise<string> {
    try {
        const desk = app.getPath('desktop');
        if (desk) {
            await fs.access(desk);
            return desk;
        }
    } catch { /* 桌面目录不存在 → 落到下面 */ }
    return app.getPath('home');
}

export async function saveLogReport(name: string, text: string): Promise<SaveLogResult> {
    const dir = await defaultDir();
    const opts = {
        title: '保存日志报告',
        defaultPath: path.join(dir, safeName(name)),
        filters: [
            { name: '文本文件', extensions: ['txt'] },
            { name: '全部文件', extensions: ['*'] },
        ],
    };
    const win = getWin();
    const res = win && !win.isDestroyed()
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts);

    if (res.canceled || !res.filePath) return { ok: false, canceled: true };

    try {
        await fs.writeFile(res.filePath, String(text ?? ''), 'utf8');
    } catch (e) {
        const msg = merrText(e);
        mlogWarn('log', `日志报告写入失败（${res.filePath}）：${msg}`);
        return { ok: false, msg };
    }
    mlogInfo('log', `日志报告已保存：${res.filePath}`);
    return { ok: true, path: res.filePath };
}
