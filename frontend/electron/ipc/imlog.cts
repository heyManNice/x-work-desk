/* ipc/imlog.cts —— 本机输入法的联调日志（只写文件，不影响功能）。
 *
 * 为什么还留着：本机输入法最典型的故障是"看着能用，打字没反应"——原因多半是
 * 渲染进程根本没接到本机 IME（缺 GTK_IM_MODULE 等）或者组合事件没被分流。
 * 有了这条落盘日志，排查时先看有没有 composition* 行即可定位。
 *
 * 真正的输入通道已经改成会话 WS（见 src/core/localim.ts 与 src/protocol.ts 的
 * MSG_IM_*），这里**不再**有任何 socket/引擎交互。
 */

import fs from 'node:fs';

/** 联调日志文件（渲染层 imLog 经 IPC 写到这里） */
export const IM_DEV_LOG = '/tmp/xworkd-im-ctl.log';

export async function imDevLog(msg: string): Promise<{ ok: boolean }> {
    try {
        const line = String(msg ?? '').replace(/[\r\n]+/g, ' ').slice(0, 400);
        fs.appendFileSync(IM_DEV_LOG, `${new Date().toISOString()} ${line}\n`);
    } catch { /* 写不进去就算了，日志不该影响功能 */ }
    return { ok: true };
}
