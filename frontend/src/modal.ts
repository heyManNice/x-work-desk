/* modal.ts —— 自制确认弹窗（替代浏览器原生 confirm）
 * 遮罩对话框显示标题/正文，返回用户选择（确定/取消/点遮罩空白=取消）。 */

const $ = <T extends HTMLElement = HTMLElement>(s: string): T =>
    document.querySelector(s) as T;

export function showConfirm(title: string, text: string): Promise<boolean> {
    return new Promise((resolve) => {
        const mask = $('#modal-mask');
        const titleEl = $('#modal-title');
        const textEl = $('#modal-text');
        const okBtn = $('#modal-ok');
        const cancelBtn = $('#modal-cancel');
        titleEl.textContent = title;
        textEl.textContent = text;
        mask.classList.add('show'); /* 背景淡入 + 面板 Y 轴缩放 */
        const finish = (v: boolean) => {
            mask.classList.remove('show'); /* 播放关闭动画后由 CSS visibility 延迟隐藏 */
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            mask.removeEventListener('click', onMaskClick);
            resolve(v);
        };
        const onOk = () => finish(true);
        const onCancel = () => finish(false);
        const onMaskClick = (e: MouseEvent) => {
            if (e.target === mask) onCancel(); /* 点击遮罩空白处等同取消 */
        };
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        mask.addEventListener('click', onMaskClick);
    });
}
