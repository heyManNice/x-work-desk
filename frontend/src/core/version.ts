/* core/version.ts —— 版本号常量与比较工具。
 * 客户端版本号为编译期固定常量（vite define 注入 __APP_VERSION__）。
 * 内置（随客户端分发的）服务端版本与客户端同发布包、取同一版本号，
 * 作为“关于”面板里“更新 / 重新安装”的判断基准。 */

export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
export const BUNDLED_SERVER_VERSION: string = APP_VERSION;

/* 简单 semver 比较：a<b → -1，a==b → 0，a>b → 1 */
export function cmpVer(a: string, b: string): number {
    const pa = String(a || '0').split('.').map((x) => Number(x) || 0);
    const pb = String(b || '0').split('.').map((x) => Number(x) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}
