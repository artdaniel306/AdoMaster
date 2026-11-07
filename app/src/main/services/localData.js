const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { dialog } = require('electron');
const { ROOT_DIR, FLOW_STATE_FILE } = require('../paths');
const { replaceFlowState, writeFileAtomic } = require('./requirementFlow');

/**
 * 匯出 / 匯入「不進 git、也無法從 API 取回」的本地資料。
 * 這裡只負責選檔與讀寫 zip；確認 / 通知的 dialog 由 renderer（local-data.js）顯示。
 * zip 內的檔名就是相對專案根目錄的路徑；匯入時只接受下列白名單內的檔名，其他一律忽略（避免 zip slip）。
 */
const FILES = [
  { name: 'script/.env', label: 'Python 腳本設定（ADO / Azure 連線）' },
  { name: 'app/.env', label: 'App 設定（repo 路徑、branch、pipeline）' },
  { name: 'data/requirement_flow_state.json', label: 'Requirement 流程勾選狀態', json: true },
  { name: 'feature/restore_workitem/.env', label: 'restore_workitem 腳本設定' },
];
// renderer 的 localStorage（固定的 Iteration、側欄收合狀態）不在檔案系統上，由 renderer 傳進來 / 交回去
const LOCAL_STORAGE = { name: 'localStorage.json', label: '固定的 Iteration 等介面設定' };

const DEFAULT_ZIP_NAME = 'adomaster.zip';
const ZIP_FILTERS = [{ name: 'Zip', extensions: ['zip'] }];

const absPath = (name) => path.join(ROOT_DIR, ...name.split('/'));
const describe = ({ name, label }) => ({ name, label });

async function readIfExists(file) {
  try {
    return await fs.readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 讓使用者選存檔位置（預設 adomaster.zip），只打包存在的檔案 + renderer 傳來的 localStorage。
 * @returns {Promise<null | { filePath, files: [{ name, label }] }>} 取消時為 null
 */
async function exportLocalData(win, localStorageItems = {}) {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '匯出本地資料',
    defaultPath: DEFAULT_ZIP_NAME,
    filters: ZIP_FILTERS,
  });
  if (canceled || !filePath) return null;

  const zip = new AdmZip();
  const files = [];
  for (const f of FILES) {
    const buf = await readIfExists(absPath(f.name));
    if (!buf) continue;
    zip.addFile(f.name, buf);
    files.push(describe(f));
  }
  zip.addFile(LOCAL_STORAGE.name, Buffer.from(JSON.stringify(localStorageItems, null, 2), 'utf-8'));
  files.push(describe(LOCAL_STORAGE));

  await zip.writeZipPromise(filePath);
  return { filePath, files };
}

/** 解出 zip 中白名單內的檔案並檢查格式；有任何一個壞掉就丟錯（整批都不寫）。 */
function readImportZip(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = new Map(zip.getEntries().filter((e) => !e.isDirectory).map((e) => [e.entryName, e]));

  const files = FILES.filter((f) => entries.has(f.name)).map((f) => {
    const buf = entries.get(f.name).getData();
    if (f.json) JSON.parse(buf.toString('utf-8'));
    return { ...f, buf };
  });

  let localStorage = null;
  if (entries.has(LOCAL_STORAGE.name)) {
    localStorage = JSON.parse(entries.get(LOCAL_STORAGE.name).getData().toString('utf-8'));
    if (!localStorage || typeof localStorage !== 'object' || Array.isArray(localStorage)) {
      throw new Error(`${LOCAL_STORAGE.name} 格式不正確`);
    }
  }

  if (!files.length && !localStorage) {
    throw new Error('這個 zip 裡沒有可匯入的本地資料（請選擇由「匯出本地資料」產生的檔案）。');
  }
  return { files, localStorage };
}

let pendingImport = null; // 使用者選好、但還沒確認匯入的 zip 路徑（只留在 main，不讓 renderer 指定路徑）

/**
 * 第一步：選 zip、檢查內容，回傳會覆蓋哪些資料讓 renderer 確認。
 * @returns {Promise<null | { zipPath, files: [{ name, label }] }>} 取消時為 null
 */
async function pickImportZip(win) {
  pendingImport = null;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '匯入本地資料',
    filters: ZIP_FILTERS,
    properties: ['openFile'],
  });
  if (canceled || !filePaths?.length) return null;

  const zipPath = filePaths[0];
  const { files, localStorage } = readImportZip(zipPath);
  pendingImport = zipPath;
  return { zipPath, files: [...files, ...(localStorage ? [LOCAL_STORAGE] : [])].map(describe) };
}

/**
 * 第二步（使用者確認後）：寫入檔案，localStorage 的內容交回 renderer 自己寫。
 * @returns {Promise<{ files: [{ name, label }], localStorage: object | null }>}
 */
async function applyImport() {
  if (!pendingImport) throw new Error('請先選擇要匯入的 zip 檔');
  const zipPath = pendingImport;
  pendingImport = null;

  const { files, localStorage } = readImportZip(zipPath); // 重新讀一次，確認後檔案若被換掉也不會寫入壞資料
  for (const f of files) {
    const file = absPath(f.name);
    if (file === FLOW_STATE_FILE) await replaceFlowState(f.buf.toString('utf-8'));
    else await writeFileAtomic(file, f.buf);
  }
  return {
    files: [...files, ...(localStorage ? [LOCAL_STORAGE] : [])].map(describe),
    localStorage,
  };
}

module.exports = { exportLocalData, pickImportZip, applyImport };
