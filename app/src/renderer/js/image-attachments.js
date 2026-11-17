import { $, el } from './dom.js';
import { IMAGE_EXT_BY_TYPE, IMAGE_MAX_BYTES, IMAGES_MAX } from '../../shared/flow-rules.js';

/**
 * Dialog 中的圖片附件區（測試 / 檢核記錄、記錄問題共用）：
 * Ctrl + V 貼上截圖 / 複製的圖片、拖曳到 dialog，或按「上傳圖片…」選檔；縮圖點擊放大（#image-viewer）、✕ 移除。
 * dialog 關閉時自動釋放縮圖的 object URL 並清空。
 *
 * @param dialog 所在的 <dialog>（paste / 拖曳的範圍）
 * @param listEl 縮圖容器（.tr-images）
 * @param uploadBtn 「上傳圖片…」按鈕
 * @param fileInput 隱藏的 <input type="file">
 * @param showError (text) => void
 */
export function createImageAttachments({ dialog, listEl, uploadBtn, fileInput, showError }) {
  const viewer = $('image-viewer');
  const viewerImg = $('iv-img');

  // 既有圖片 { name, url }（url 為 null 代表檔案遺失）；新增圖片 { blob, url }
  let items = [];
  let busy = false;

  function clear() {
    for (const it of items) if (it.url) URL.revokeObjectURL(it.url);
    items = [];
    render();
  }

  function render() {
    if (!items.length) {
      listEl.replaceChildren(el('span', 'muted', '尚無圖片'));
      return;
    }
    listEl.replaceChildren(
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
            render();
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
      if (!IMAGE_EXT_BY_TYPE[f.type]) skipped.push(`${f.name || '圖片'}：不支援的格式`);
      else if (f.size > IMAGE_MAX_BYTES) skipped.push(`${f.name || '圖片'}：超過 ${IMAGE_MAX_BYTES / 1024 / 1024} MB`);
      else if (items.length >= IMAGES_MAX) skipped.push(`最多 ${IMAGES_MAX} 張圖片`);
      else items.push({ blob: f, url: URL.createObjectURL(f) });
    }
    showError(skipped.length ? `部分圖片未加入：${[...new Set(skipped)].join('；')}` : '');
    render();
  }

  // Ctrl + V：剪貼簿中有圖片就加入。
  // 在文字框中貼上同時含文字的內容（例如從 Excel / Word 複製）時，只貼文字，不把它的預覽圖也加進來。
  dialog.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    const hasText = !!e.clipboardData.getData('text/plain');
    if (hasText && (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) return;
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

  dialog.addEventListener('close', () => {
    clear();
    dialog.classList.remove('drag-over');
  });

  return {
    clear,
    render,
    /** 儲存 / 建立中：不能新增或移除圖片 */
    setBusy(v) {
      busy = v;
      uploadBtn.disabled = v;
      render();
    },
    /** 放入已存檔的圖片 [{ name, type, data }]（data 為 null = 檔案遺失），排在讀取期間就新增的圖片前面 */
    addSaved(saved) {
      items = [...saved.map(({ name, type, data }) => ({ name, url: data ? URL.createObjectURL(new Blob([data], { type })) : null })), ...items];
      render();
    },
    /** 保留的既有圖片檔名 */
    keptNames: () => items.filter((it) => it.name).map((it) => it.name),
    /** 新增的圖片 [{ type, data: Uint8Array }]（傳給 main process） */
    newImages: () =>
      Promise.all(
        items.filter((it) => it.blob).map(async (it) => ({ type: it.blob.type, data: new Uint8Array(await it.blob.arrayBuffer()) }))
      ),
  };
}
