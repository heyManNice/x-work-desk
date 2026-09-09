#!/usr/bin/env node
/* tools/check-versions.mjs —— 构建期一致性校验：
 * 客户端版本（frontend/package.json version）应与服务端编译期版本
 * （src/config.h 的 XWORKD_VERSION）保持一致（两者同包发布）。
 * 用法: node tools/check-versions.mjs   （接入 frontend 的 npm prebuild）
 * 任一来源缺失时仅提示不阻断（便于在不同目录/CI 下构建前端）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function tryRead(p) {
    try { return readFileSync(p, 'utf8'); } catch { return null; }
}

const pkgRaw = tryRead(join(ROOT, 'frontend', 'package.json'));
const cfgRaw = tryRead(join(ROOT, 'src', 'config.h'));

if (!pkgRaw || !cfgRaw) {
    console.log('[check-versions] 未找到客户端 package.json 或服务端 config.h，跳过校验。');
    process.exit(0);
}

let clientVer = '';
try { clientVer = String(JSON.parse(pkgRaw).version || ''); } catch { /* ignore */ }
const m = /#define\s+XWORKD_VERSION\s+"([^"]+)"/.exec(cfgRaw);
const serverVer = m ? m[1] : '';

console.log(`[check-versions] 客户端 v${clientVer || '(空)'}  服务端 v${serverVer || '(空)'}`);
if (!clientVer || !serverVer) {
    console.log('[check-versions] 版本号缺失（无法解析），跳过校验。');
    process.exit(0);
}
if (clientVer !== serverVer) {
    console.error(`[check-versions] 版本不一致：客户端 ${clientVer} ≠ 服务端 ${serverVer}。`);
    console.error('  请同步修改 frontend/package.json 的 version 与 src/config.h 的 XWORKD_VERSION 后再构建。');
    process.exit(1);
}
console.log('[check-versions] OK：前后端版本一致。');
