import { cleanError } from './api.js';
import { $, el, errorSetter } from './dom.js';
import { createImageAttachments } from './image-attachments.js';
import { activeKids } from './flow-stages.js';
import { BUG_TITLE_MAX, BUG_REPRO_MAX } from '../../shared/flow-rules.js';

/**
 * 記錄問題 dialog（測試與檢核欄的「🐞 記錄問題」）：
 * 輸入標題、敘述並附上圖片（Ctrl + V / 拖曳 / 選檔），從 Requirement 底下 Task 的指派對象中選擇指派；
 * 確認後由 main process 執行 create_bug.py，在 Requirement 底下建立 Bug（敘述與圖片 = Repro Steps）。
 */
export function createBugDialog() {
  const dialog = $('bug-dialog');
  const form = $('bg-form');
  const reqEl = $('bg-req');
  const titleEl = $('bg-title');
  const assignEl = $('bg-assign');
  const reproEl = $('bg-repro');
  const errorEl = $('bg-error');
  const okBtn = $('bg-ok');
  const cancelBtn = $('bg-cancel');
  const closeBtn = $('bg-close');

  let onCreate = null; // ({ title, assignedTo, repro, images }) => Promise
  let busy = false;

  const showError = errorSetter(errorEl);
  const images = createImageAttachments({
    dialog,
    listEl: $('bg-images'),
    uploadBtn: $('bg-upload'),
    fileInput: $('bg-file'),
    showError,
  });

  titleEl.maxLength = BUG_TITLE_MAX;
  reproEl.maxLength = BUG_REPRO_MAX;

  /** Requirement 底下（未 Removed 的）Task 的指派對象，依 email 去重 */
  function developers(req) {
    const byEmail = new Map();
    for (const c of activeKids(req)) {
      if (c.type !== 'Task' || !c.assignedToEmail) continue;
      const key = c.assignedToEmail.toLowerCase();
      if (!byEmail.has(key)) byEmail.set(key, { email: c.assignedToEmail, name: c.assignedTo || c.assignedToEmail });
    }
    return [...byEmail.values()];
  }

  function fillAssignees(req) {
    const devs = developers(req);
    const options = devs.map((d) => {
      const opt = el('option', null, d.name === d.email ? d.email : `${d.name}（${d.email}）`);
      opt.value = d.email;
      return opt;
    });
    if (devs.length !== 1) {
      const placeholder = el('option', null, devs.length ? '請選擇開發人員…' : '（沒有已指派的 Task，不指派）');
      placeholder.value = '';
      options.unshift(placeholder);
    }
    assignEl.replaceChildren(...options);
    assignEl.required = devs.length > 0;
    assignEl.value = devs.length === 1 ? devs[0].email : '';
  }

  function setBusy(v) {
    busy = v;
    okBtn.disabled = cancelBtn.disabled = closeBtn.disabled = titleEl.disabled = assignEl.disabled = reproEl.disabled = v;
    okBtn.textContent = v ? '建立中…' : '建立 Bug';
    images.setBusy(v);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const title = titleEl.value.replace(/\s+/g, ' ').trim();
    if (!title) {
      showError('請輸入標題');
      titleEl.focus();
      return;
    }
    setBusy(true);
    showError('');
    try {
      await onCreate({ title, assignedTo: assignEl.value, repro: reproEl.value.trim(), images: await images.newImages() });
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
   * @param req Requirement（顯示標題、指派對象來自 req.children 的 Task）
   * @param createFn ({ title, assignedTo, repro, images }) => Promise；成功後關閉 dialog
   */
  function open(req, createFn) {
    onCreate = createFn;
    images.clear();
    setBusy(false);
    showError('');
    reqEl.textContent = `#${req.id} ${req.title}`;
    titleEl.value = '';
    reproEl.value = '';
    fillAssignees(req);
    dialog.showModal();
    titleEl.focus();
  }

  return { open };
}
