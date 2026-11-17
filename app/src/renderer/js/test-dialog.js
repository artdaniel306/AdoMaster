import { api, cleanError } from './api.js';
import { $, el, errorSetter } from './dom.js';
import { createImageAttachments } from './image-attachments.js';

/**
 * 測試 / 檢核記錄 dialog（勾「測試 / 檢核完成」時開啟，也可從流程表中的記錄連結開啟編輯）：
 * 一格文字記錄測試場景（時間、地點、人員、溝通管道、裝置、連線、資料…）或驗證方式，
 * 圖片可用 Ctrl + V 貼上截圖 / 複製的圖片、拖曳，或按「上傳圖片…」選檔。
 * 存檔由 main process 寫入 data/test_records/<id>/ 與流程狀態檔的 testRecord。
 */
export function createTestDialog() {
  const dialog = $('test-dialog');
  const form = $('tr-form');
  const reqEl = $('tr-req');
  const noteEl = $('tr-note');
  const imagesEl = $('tr-images');
  const errorEl = $('tr-error');
  const okBtn = $('tr-ok');
  const cancelBtn = $('tr-cancel');
  const closeBtn = $('tr-close');

  let onSave = null; // ({ note, keep, images }) => Promise
  let okLabel = '';
  let busy = false;
  let openSeq = 0; // 讀取圖片較慢時，避免舊的結果寫進新開啟的 dialog

  const showError = errorSetter(errorEl);
  const images = createImageAttachments({
    dialog,
    listEl: imagesEl,
    uploadBtn: $('tr-upload'),
    fileInput: $('tr-file'),
    showError,
  });

  function setBusy(v) {
    busy = v;
    okBtn.disabled = cancelBtn.disabled = closeBtn.disabled = noteEl.disabled = v;
    okBtn.textContent = v ? '儲存中…' : okLabel;
    images.setBusy(v);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    showError('');
    try {
      await onSave({ note: noteEl.value.trim(), keep: images.keptNames(), images: await images.newImages() });
      dialog.close();
    } catch (err) {
      showError(`儲存失敗：${cleanError(err)}`);
    } finally {
      setBusy(false);
    }
  });
  // 儲存中不允許關閉
  dialog.addEventListener('cancel', (e) => {
    if (busy) e.preventDefault();
  });
  dialog.addEventListener('close', () => openSeq++);
  cancelBtn.addEventListener('click', () => dialog.close());
  closeBtn.addEventListener('click', () => dialog.close());

  /**
   * 開啟 dialog。
   * @param req Requirement（顯示標題用；req.id 用來讀取既有圖片）
   * @param record 既有的測試記錄 { note, images: [檔名] }，沒有時為 undefined
   * @param confirm true = 儲存時同時勾起「測試 / 檢核完成」（按鈕顯示「確認完成」）
   * @param saveFn ({ note, keep, images }) => Promise；成功後關閉 dialog
   */
  async function open({ req, record, confirm, saveFn }) {
    onSave = saveFn;
    okLabel = confirm ? '確認完成' : '儲存';
    images.clear();
    setBusy(false);
    showError('');
    reqEl.textContent = `#${req.id} ${req.title}`;
    noteEl.value = record?.note || '';
    dialog.showModal();
    noteEl.focus();

    if (!record?.images?.length) return;
    const seq = ++openSeq;
    imagesEl.replaceChildren(el('span', 'muted', '讀取圖片中…'));
    okBtn.disabled = true; // 讀完既有圖片前不能儲存（否則會被當成已移除而刪掉）
    try {
      const saved = await api.loadTestImages(req.id);
      if (seq !== openSeq) return;
      okBtn.disabled = false;
      images.addSaved(saved); // 讀取期間就貼上的新圖片排在後面
    } catch (err) {
      if (seq !== openSeq) return;
      imagesEl.replaceChildren();
      showError(`讀取圖片失敗：${cleanError(err)}`);
    }
  }

  return { open };
}
