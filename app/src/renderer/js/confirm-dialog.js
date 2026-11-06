import { $ } from './dom.js';

/** 通用確認 dialog：open() 回傳 Promise<boolean>（true = 確定、false = 取消 / Esc / ✕）。 */
export function createConfirmDialog() {
  const dialog = $('confirm-dialog');
  const titleEl = $('cf-title');
  const reqEl = $('cf-req');
  const msgEl = $('cf-msg');
  const okBtn = $('cf-ok');

  let resolveOpen = null;

  function finish(result) {
    const r = resolveOpen;
    resolveOpen = null;
    if (dialog.open) dialog.close();
    r?.(result);
  }

  okBtn.addEventListener('click', () => finish(true));
  $('cf-cancel').addEventListener('click', () => finish(false));
  $('cf-close').addEventListener('click', () => finish(false));
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    finish(false);
  });

  /**
   * @param title dialog 標題
   * @param req Requirement（顯示標題用，可省略）
   * @param message 說明文字（可含換行）
   * @param okLabel 確定按鈕文字
   */
  function open({ title = '確認', req, message, okLabel = '確定' }) {
    finish(false); // 前一次尚未關閉時視為取消
    titleEl.textContent = title;
    reqEl.textContent = req ? `#${req.id} ${req.title}` : '';
    reqEl.hidden = !req;
    msgEl.textContent = message;
    okBtn.textContent = okLabel;
    dialog.showModal();
    okBtn.focus();
    return new Promise((resolve) => {
      resolveOpen = resolve;
    });
  }

  return { open };
}
