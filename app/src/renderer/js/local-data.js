import { api, cleanError } from './api.js';
import { createConfirmDialog } from './confirm-dialog.js';

/**
 * 選單「檔案 → 匯出 / 匯入本地資料」：選檔與讀寫 zip 在 main（services/localData.js），
 * 確認與結果通知用 app 內的 confirm dialog；localStorage 由這裡讀出 / 寫回。
 */
export function initLocalData() {
  const dialog = createConfirmDialog();
  const list = (files) => files.map((f) => `• ${f.name}（${f.label}）`).join('\n');
  let busy = false;

  function readLocalStorage() {
    try {
      return Object.fromEntries(Object.entries(localStorage));
    } catch {
      return {};
    }
  }

  async function exportData() {
    const result = await api.exportLocalData(readLocalStorage());
    if (!result) return; // 取消選檔
    await dialog.alert(
      '匯出完成',
      `已存到 ${result.filePath}\n\n包含：\n${list(result.files)}\n\n⚠ .env 內含 PAT 等機密，請妥善保管。`,
    );
  }

  async function importData() {
    const preview = await api.pickImportZip();
    if (!preview) return; // 取消選檔
    const ok = await dialog.open({
      title: '匯入本地資料',
      message: `以下資料會覆蓋本機現有的內容：\n${list(preview.files)}\n\n匯入後畫面會重新載入（背景中的佈版監看會中斷）。`,
      okLabel: '匯入',
    });
    if (!ok) return;

    const result = await api.applyImport();
    if (result.localStorage) {
      try {
        for (const [k, v] of Object.entries(result.localStorage)) localStorage.setItem(k, String(v));
      } catch { /* 忽略：localStorage 無法寫入時只是介面設定沒還原 */ }
    }
    await dialog.alert('匯入完成', `已匯入：\n${list(result.files)}\n\n按確定後重新載入畫面。`);
    location.reload();
  }

  const actions = { export: [exportData, '匯出失敗'], import: [importData, '匯入失敗'] };

  api.onLocalDataMenu(async (action) => {
    const [run, failTitle] = actions[action] || [];
    if (!run || busy) return;
    busy = true;
    try {
      await run();
    } catch (err) {
      await dialog.alert(failTitle, cleanError(err));
    } finally {
      busy = false;
    }
  });
}
