import { $ } from './dom.js';

let instance = null;

/**
 * 通用確認 dialog：open() 回傳 Promise<boolean>（true = 確定、false = 取消 / Esc / ✕）。
 * 全頁共用同一個 #confirm-dialog，所以只建立一次（多處呼叫拿到同一個實例）。
 */
export function createConfirmDialog() {
  if (instance) return instance;

  const dialog = $('confirm-dialog');
  const titleEl = $('cf-title');
  const reqEl = $('cf-req');
  const msgEl = $('cf-msg');
  const okBtn = $('cf-ok');
  const cancelBtn = $('cf-cancel');

  let resolveOpen = null;

  function finish(result) {
    const r = resolveOpen;
    resolveOpen = null;
    if (dialog.open) dialog.close();
    r?.(result);
  }

  okBtn.addEventListener('click', () => finish(true));
  cancelBtn.addEventListener('click', () => finish(false));
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
   * @param alert true = 純通知，只顯示確定按鈕
   */
  function open({ title = '確認', req, message, okLabel = '確定', alert = false }) {
    finish(false); // 前一次尚未關閉時視為取消
    titleEl.textContent = title;
    reqEl.textContent = req ? `#${req.id} ${req.title}` : '';
    reqEl.hidden = !req;
    msgEl.textContent = message;
    okBtn.textContent = okLabel;
    cancelBtn.hidden = alert;
    dialog.showModal();
    okBtn.focus();
    return new Promise((resolve) => {
      resolveOpen = resolve;
    });
  }

  /** 純通知：只有「確定」，關閉後 resolve。 */
  const alertDialog = (title, message) => open({ title, message, alert: true });

  instance = { open, alert: alertDialog };
  return instance;
}
