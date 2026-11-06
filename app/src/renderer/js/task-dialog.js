import { cleanError } from './api.js';
import { $ } from './dom.js';

/**
 * 安排預設 Task dialog（Pending 階段、尚未展開 Task 時）：
 * 輸入 Description 後由 main process 執行 create_task.py，在 Requirement 底下建立同名的 Task。
 */
export function createTaskDialog() {
  const dialog = $('task-dialog');
  const form = $('tk-form');
  const reqEl = $('tk-req');
  const descEl = $('tk-desc');
  const errorEl = $('tk-error');
  const okBtn = $('tk-ok');
  const cancelBtn = $('tk-cancel');
  const closeBtn = $('tk-close');

  let onCreate = null; // (description) => Promise
  let busy = false;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function setBusy(v) {
    busy = v;
    okBtn.disabled = cancelBtn.disabled = closeBtn.disabled = descEl.disabled = v;
    okBtn.textContent = v ? '建立中…' : '建立 Task';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    showError('');
    try {
      await onCreate(descEl.value.trim());
      dialog.close();
    } catch (err) {
      showError(`建立失敗：${cleanError(err)}`);
    } finally {
      setBusy(false);
    }
  });
  // 建立中不允許關閉（避免使用者以為沒建立而重複建立）
  dialog.addEventListener('cancel', (e) => {
    if (busy) e.preventDefault();
  });
  cancelBtn.addEventListener('click', () => dialog.close());
  closeBtn.addEventListener('click', () => dialog.close());

  /**
   * @param req Requirement（顯示標題用）
   * @param createFn (description) => Promise；成功後關閉 dialog
   */
  function open(req, createFn) {
    onCreate = createFn;
    showError('');
    reqEl.textContent = `#${req.id} ${req.title}`;
    descEl.value = '';
    dialog.showModal();
    descEl.focus();
  }

  return { open };
}
