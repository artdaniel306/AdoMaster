import { api, cleanError } from './api.js';
import { $, el, errorSetter } from './dom.js';

/** 支援的圖片格式（與 main/services/testRecord.js 一致） */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGES_MAX = 30;

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
  const uploadBtn = $('tr-upload');
  const fileInput = $('tr-file');
  const viewer = $('image-viewer');
  const viewerImg = $('iv-img');

  // 既有圖片 { name, url }（url 為 null 代表檔案遺失）；新增圖片 { blob, url }
  let items = [];
  let onSave = null; // ({ note, keep, images }) => Promise
  let okLabel = '';
  let busy = false;
  let openSeq = 0; // 讀取圖片較慢時，避免舊的結果寫進新開啟的 dialog

  const showError = errorSetter(errorEl);

  function setBusy(v) {
    busy = v;
    okBtn.disabled = cancelBtn.disabled = closeBtn.disabled = uploadBtn.disabled = noteEl.disabled = v;
    okBtn.textContent = v ? '儲存中…' : okLabel;
    renderImages();
  }

  function releaseUrls() {
    for (const it of items) if (it.url) URL.revokeObjectURL(it.url);
    items = [];
  }

  function renderImages() {
    if (!items.length) {
      imagesEl.replaceChildren(el('span', 'muted', '尚無圖片'));
      return;
    }
    imagesEl.replaceChildren(
      ...items.map((it) => {
        const box = el('div', `tr-thumb${it.url ? '' : ' missing'}`);
        if (it.url) {
          const img = el('img');
          img.src = it.url;
          img.alt = it.name || '貼上的圖片';
          img.title = '點擊放大';
          img.addEventListener('click', () => {
            viewerImg.src = it.url;
            viewer.showModal();
          });
          box.append(img);
        } else {
          box.append(document.createTextNode(`圖片檔案遺失\n${it.name}`));
        }
        if (!busy) {
          const rm = el('button', 'tr-remove', '✕');
          rm.type = 'button';
          rm.title = '移除這張圖片';
          rm.addEventListener('click', () => {
            if (it.url) URL.revokeObjectURL(it.url);
            items = items.filter((x) => x !== it);
            renderImages();
          });
          box.append(rm);
        }
        return box;
      })
    );
  }

  /** 加入新圖片（貼上 / 拖曳 / 選檔），不支援的格式或太大的圖片略過並提示 */
  function addFiles(files) {
    if (busy) return;
    const skipped = [];
    for (const f of files) {
      if (!IMAGE_TYPES.has(f.type)) skipped.push(`${f.name || '圖片'}：不支援的格式`);
      else if (f.size > IMAGE_MAX_BYTES) skipped.push(`${f.name || '圖片'}：超過 ${IMAGE_MAX_BYTES / 1024 / 1024} MB`);
      else if (items.length >= IMAGES_MAX) skipped.push(`最多 ${IMAGES_MAX} 張圖片`);
      else items.push({ blob: f, url: URL.createObjectURL(f) });
    }
    showError(skipped.length ? `部分圖片未加入：${[...new Set(skipped)].join('；')}` : '');
    renderImages();
  }

  // Ctrl + V：剪貼簿中有圖片就加入。
  // 在文字框中貼上同時含文字的內容（例如從 Excel / Word 複製）時，只貼文字，不把它的預覽圖也加進來。
  dialog.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    const hasText = !!e.clipboardData.getData('text/plain');
    if (hasText && e.target === noteEl) return;
    e.preventDefault();
    addFiles(files);
  });

  // 拖曳圖片到 dialog
  dialog.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    dialog.classList.add('drag-over');
  });
  dialog.addEventListener('dragleave', (e) => {
    if (!dialog.contains(e.relatedTarget)) dialog.classList.remove('drag-over');
  });
  dialog.addEventListener('drop', (e) => {
    dialog.classList.remove('drag-over');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });

  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles([...fileInput.files]);
    fileInput.value = '';
  });

  viewer.addEventListener('click', () => viewer.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    showError('');
    try {
      const keep = items.filter((it) => it.name).map((it) => it.name);
      const images = await Promise.all(
        items
          .filter((it) => it.blob)
          .map(async (it) => ({ type: it.blob.type, data: new Uint8Array(await it.blob.arrayBuffer()) }))
      );
      await onSave({ note: noteEl.value.trim(), keep, images });
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
  dialog.addEventListener('close', () => {
    openSeq++;
    releaseUrls();
    dialog.classList.remove('drag-over');
  });
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
    releaseUrls();
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
      items = [
        ...saved.map(({ name, type, data }) => ({ name, url: data ? URL.createObjectURL(new Blob([data], { type })) : null })),
        ...items, // 讀取期間就貼上的新圖片
      ];
      renderImages();
    } catch (err) {
      if (seq !== openSeq) return;
      imagesEl.replaceChildren();
      showError(`讀取圖片失敗：${cleanError(err)}`);
    }
  }

  return { open };
}
