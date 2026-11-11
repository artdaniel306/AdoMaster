export const $ = (id) => document.getElementById(id);

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** 錯誤訊息元素 → showError(msg)：有訊息時顯示，空字串 / null 時隱藏 */
export function errorSetter(errorEl) {
  return (msg) => {
    errorEl.textContent = msg || '';
    errorEl.hidden = !msg;
  };
}

/** 視窗不在前景時跳系統通知（背景工作結束用） */
export function notify(title, body) {
  if (!document.hasFocus() && 'Notification' in window) new Notification(title, { body });
}
