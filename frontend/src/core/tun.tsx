/* core/tun.tsx —— 顶栏“Tun”代理入口 + 弹窗。
 *
 * 目前仅做 UI（未接入实际 TUN 代理）：服务器地址（带“测速”）、排除地址（预填常用
 * 局域网/保留网段，可一键重置）、底部“安装服务 | 启用”。
 * 与其它工具弹出面板一致：走 popups 的互斥“点击式”模型，面板 fixed 渲染在 App 根部。
 */

import { createSignal, Show } from 'solid-js';
import { Route, X } from 'lucide-solid';
import { activePopup, isPopup, togglePopup } from './popups';

const PW = 300; /* 与 CSS .tun-panel 宽度一致（居中/夹紧换算用） */

/* 排除地址默认值：不走代理的常用局域网 / 保留地址（每行一个网段） */
const DEFAULT_EXCLUDES = [
    '127.0.0.0/8',      /* 本机回环 */
    '10.0.0.0/8',       /* 私有网段 A */
    '172.16.0.0/12',    /* 私有网段 B */
    '192.168.0.0/16',   /* 私有网段 C */
    '169.254.0.0/16',   /* 链路本地（含云元数据） */
    '::1/128',          /* IPv6 回环 */
    'fc00::/7',         /* IPv6 唯一本地地址 */
    'fe80::/10',        /* IPv6 链路本地 */
].join('\n');

const [pos, setPos] = createSignal({ x: 0, y: 0 });
/* 输入项暂存（仅 UI，尚未接入实际代理；重开面板保留上次填写） */
const [server, setServer] = createSignal('');
const [exclude, setExclude] = createSignal(DEFAULT_EXCLUDES);

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
                    <div class="tun-field">
                        <div class="tun-label-row">
                            <span class="tun-label">服务器地址</span>
                        </div>
                        <div class="tun-row">
                            <input
                                class="tun-input"
                                type="text"
                                placeholder="如 1.2.3.4:1080"
                                value={server()}
                                onInput={(e) => setServer(e.currentTarget.value)}
                            />
                            <button class="tun-check" title="测速（测试服务器连接速度）">测速</button>
                        </div>
                    </div>
                    <div class="tun-field">
                        <div class="tun-label-row">
                            <span class="tun-label">排除地址</span>
                            <button
                                class="tun-reset"
                                onClick={() => setExclude(DEFAULT_EXCLUDES)}
                                title="恢复为默认的局域网 / 保留地址"
                            >
                                重置
                            </button>
                        </div>
                        <textarea
                            class="tun-input tun-textarea"
                            rows="8"
                            spellcheck={false}
                            placeholder="每行一个网段，如 10.0.0.0/8"
                            value={exclude()}
                            onInput={(e) => setExclude(e.currentTarget.value)}
                        />
                    </div>
                    <div class="tun-actions">
                        <button class="tun-install" title="在远端安装 Tun 代理服务（功能待接入）">安装服务</button>
                        <button class="tun-enable" title="启用 Tun 代理（功能待接入）">启用</button>
                    </div>
                </div>
            </div>
        </Show>
    );
}
