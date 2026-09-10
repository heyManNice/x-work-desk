/* core/tun.tsx —— 顶栏“Tun”代理入口 + 弹窗。
 *
 * 目前仅做 UI（未接入实际 TUN 代理）：标题、服务器 + 检查、排除地址、启用。
 * 与其它工具弹出面板一致：走 popups 的互斥“点击式”模型，面板 fixed 渲染在 App 根部。
 */

import { createSignal, Show } from 'solid-js';
import { Route, X } from 'lucide-solid';
import { activePopup, isPopup, togglePopup } from './popups';

const PW = 300; /* 与 CSS .tun-panel 宽度一致（居中/夹紧换算用） */

const [pos, setPos] = createSignal({ x: 0, y: 0 });
/* 输入项暂存（仅 UI，尚未接入实际代理；重开面板保留上次填写） */
const [server, setServer] = createSignal('');
const [exclude, setExclude] = createSignal('');

/* ---------------- 顶栏按钮 ---------------- */

export function TunButton() {
    let btn: HTMLButtonElement | undefined;
    return (
        <button
            ref={btn}
            data-popup-trigger="tun"
            class="tab-btn"
            classList={{ active: activePopup() === 'tun' }}
            title="Tun 代理"
            onClick={() => {
                const opened = togglePopup('tun');
                if (!opened || !btn) return;
                const r = btn.getBoundingClientRect();
                const m = 14; /* 两侧留边，避免贴边/出界 */
                setPos({
                    x: Math.min(Math.max(PW / 2 + m, r.left + r.width / 2), window.innerWidth - PW / 2 - m),
                    y: r.bottom + 8,
                });
            }}
        >
            <Route size={13} />
            <span>Tun</span>
        </button>
    );
}

/* ---------------- 弹窗（App 根部 fixed 渲染） ---------------- */

export function TunPanelHost() {
    return (
        <Show when={isPopup('tun')}>
            <div class="tun-panel popup-panel" style={{ left: `${pos().x}px`, top: `${pos().y}px` }}>
                <div class="sys-head">
                    <span class="sys-title"><Route size={13} /> Tun</span>
                    <button class="sys-x" onClick={() => togglePopup('tun')} title="关闭"><X size={13} /></button>
                </div>
                <div class="tun-body">
                    <div class="tun-row">
                        <input
                            class="tun-input"
                            type="text"
                            placeholder="服务器地址，如 1.2.3.4:1080"
                            value={server()}
                            onInput={(e) => setServer(e.currentTarget.value)}
                        />
                        <button class="tun-check" title="检查服务器连通性">检查</button>
                    </div>
                    <input
                        class="tun-input"
                        type="text"
                        placeholder="排除地址，如 10.0.0.0/8, 192.168.0.0/16"
                        value={exclude()}
                        onInput={(e) => setExclude(e.currentTarget.value)}
                    />
                    <button class="tun-enable">启用</button>
                </div>
            </div>
        </Show>
    );
}
