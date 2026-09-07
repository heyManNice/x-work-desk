/* popups.tsx —— 顶栏弹出面板协调器。
 *
 * 铃铛(通知)与文件面板统一走「点击式」模型：
 *   - 同时最多只展开一个面板（哪个 open 由 active 决定，天然互斥）
 *   - 点击触发器开/关；点击面板外任意处收起
 */

import { createSignal } from 'solid-js';

export type PopupName = 'notify' | 'file' | 'syscpu' | 'sysmem';

const [active, setActive] = createSignal<PopupName | null>(null);

export const activePopup = active;

export function isPopup(n: PopupName): boolean {
    return active() === n;
}

/** 切换：面板开着→关掉返回 false；否则打开(覆盖其它)并返回 true */
export function togglePopup(n: PopupName): boolean {
    if (active() === n) {
        setActive(null);
        return false;
    }
    setActive(n);
    return true;
}

export function openPopup(n: PopupName): void {
    setActive(n);
}

export function closePopup(n: PopupName): void {
    if (active() === n) setActive(null);
}

export function closeAll(): void {
    setActive(null);
}

/* 点击任意非「面板 / 触发器 / 气泡」处 → 收起当前面板 */
if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', (e) => {
        if (active() === null) return;
        const el = e.target as Element | null;
        if (!el) { setActive(null); return; }
        if (el.closest('.popup-panel') || el.closest('[data-popup-trigger]') || el.closest('.toast-host')) return;
        setActive(null);
    });
}
