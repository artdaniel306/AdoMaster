const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { app, dialog } = require('electron');
const { ROOT_DIR, DATA_DIR, FLOW_STATE_FILE, TEST_RECORDS_DIR, LOCAL_DEPLOY_ENV_DIR } = require('../paths');
const { replaceFlowState } = require('./flowState');
const { writeFileAtomic } = require('../atomicWrite');
const { TEST_IMAGE_RE } = require('../../shared/flow-rules.js');
const { parseConfig, applyLegacy } = require('./appConfig');

/**
 * 匯出 / 匯入「不進 git、也無法從 API 取回」的本地資料。
 * 這裡只負責選檔與讀寫 zip；確認 / 通知的 dialog 由 renderer（local-data.js）顯示。
 * zip 內的檔名就是相對專案根目錄的路徑（data/ 開頭的實際位置是 DATA_DIR，安裝版在使用者資料夾）；匯入時只接受下列白名單內的檔名，其他一律忽略（避免 zip slip）。
 * validate：匯入前檢查內容（丟錯 = 整批不寫）。
 */
// devOnly：安裝版不含 feature/，不匯出也不匯入
const FILES = [
  { name: 'data/.env', label: '連線帳號與機密（ADO / Azure / GitHub / 資料庫密碼）' },
  { name: 'data/config.json', label: '本機設定（Repository、UpAgent 發佈…）', validate: (text) => parseConfig(text) },
  { name: 'data/requirement_flow_state.json', label: 'Requirement 流程勾選狀態', validate: (text) => JSON.parse(text) },
  { name: 'feature/restore_workitem/.env', label: 'restore_workitem 腳本設定', devOnly: true },
].filter((f) => !(f.devOnly && app.isPackaged));
// 舊版匯出的設定檔：只接受匯入，不直接寫回原位置，而是經 appConfig.applyLegacy 轉換到 data/config.json / data/.env
const LEGACY_FILES = [
  { name: 'script/.env', kind: 'env', label: '舊版 script/.env（轉換到 data/.env）' },
  { name: 'data/repos.json', kind: 'repos', label: '舊版 Repository 設定（轉換到 data/config.json）', validate: (text) => JSON.parse(text) },
  { name: 'data/upagent_release.config', kind: 'upagent', label: '舊版 UpAgent 發佈設定（轉換到 data/config.json + data/.env）' },
];
// renderer 的 localStorage（固定的 Iteration、側欄收合狀態）不在檔案系統上，由 renderer 傳進來 / 交回去
const LOCAL_STORAGE = { name: 'localStorage.json', label: '固定的 Iteration 等介面設定' };
// 測試記錄的圖片：data/test_records/<requirementId>/<檔名>，匯入時只接受符合這個格式的路徑
const TEST_IMAGES = { name: 'data/test_records/', label: '測試記錄圖片' };
const TEST_IMAGE_ENTRY = (name) => {
  const m = /^data\/test_records\/(\d+)\/([^/]+)$/.exec(name);
  return !!m && TEST_IMAGE_RE.test(m[2]);
};
const imagesInfo = (n) => ({ ...TEST_IMAGES, label: `${TEST_IMAGES.label}（${n} 張）` });
// Local 佈版各環境的 env 檔（含機密）：data/local_deploy_env/<檔名>，只收第一層、檔名限安全字元
const DEPLOY_ENVS = { name: 'data/local_deploy_env/', label: 'Local 佈版的環境 env 檔' };
const DEPLOY_ENV_ENTRY = (name) => /^data\/local_deploy_env\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name);
const deployEnvsInfo = (n) => ({ ...DEPLOY_ENVS, label: `${DEPLOY_ENVS.label}（${n} 個）` });

/** 列出 data/local_deploy_env 第一層的檔案（zip 內路徑） */
async function listDeployEnvs() {
  let entries;
  try {
    entries = await fs.readdir(LOCAL_DEPLOY_ENV_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((e) => e.isFile()).map((e) => `${DEPLOY_ENVS.name}${e.name}`).filter(DEPLOY_ENV_ENTRY);
}

/** 列出 data/test_records 下所有圖片（相對專案根目錄、以 / 分隔的路徑） */
async function listTestImages() {
  let entries;
  try {
    entries = await fs.readdir(TEST_RECORDS_DIR, { recursive: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .map((rel) => `${TEST_IMAGES.name}${rel.split(path.sep).join('/')}`)
    .filter(TEST_IMAGE_ENTRY);
}

const DEFAULT_ZIP_NAME = 'adomaster.zip';
const ZIP_FILTERS = [{ name: 'Zip', extensions: ['zip'] }];

const absPath = (name) => {
  const [first, ...rest] = name.split('/');
  return first === 'data' ? path.join(DATA_DIR, ...rest) : path.join(ROOT_DIR, first, ...rest);
};
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
  const images = await listTestImages();
  for (const name of images) {
    const buf = await readIfExists(absPath(name));
    if (buf) zip.addFile(name, buf);
  }
  if (images.length) files.push(imagesInfo(images.length));
  const deployEnvs = await listDeployEnvs();
  for (const name of deployEnvs) {
    const buf = await readIfExists(absPath(name));
    if (buf) zip.addFile(name, buf);
  }
  if (deployEnvs.length) files.push(deployEnvsInfo(deployEnvs.length));
  zip.addFile(LOCAL_STORAGE.name, Buffer.from(JSON.stringify(localStorageItems, null, 2), 'utf-8'));
  files.push(describe(LOCAL_STORAGE));

  await zip.writeZipPromise(filePath);
  return { filePath, files };
}

/** 解出 zip 中白名單內的檔案並檢查格式；有任何一個壞掉就丟錯（整批都不寫）。 */
function readImportZip(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = new Map(zip.getEntries().filter((e) => !e.isDirectory).map((e) => [e.entryName, e]));

  const read = (list) => list.filter((f) => entries.has(f.name)).map((f) => {
    const buf = entries.get(f.name).getData();
    if (f.validate) {
      try {
        f.validate(buf.toString('utf-8').replace(/^\uFEFF/, ''));
      } catch (err) {
        throw new Error(`${f.name} 格式不正確：${err.message}`);
      }
    }
    return { ...f, buf };
  });
  const files = read(FILES);
  const legacy = read(LEGACY_FILES);
  const images = [...entries.keys()].filter(TEST_IMAGE_ENTRY).map((name) => ({ name, buf: entries.get(name).getData() }));
  const deployEnvs = [...entries.keys()].filter(DEPLOY_ENV_ENTRY).map((name) => ({ name, buf: entries.get(name).getData() }));

  let localStorage = null;
  if (entries.has(LOCAL_STORAGE.name)) {
    localStorage = JSON.parse(entries.get(LOCAL_STORAGE.name).getData().toString('utf-8'));
    if (!localStorage || typeof localStorage !== 'object' || Array.isArray(localStorage)) {
      throw new Error(`${LOCAL_STORAGE.name} 格式不正確`);
    }
  }

  if (!files.length && !legacy.length && !images.length && !deployEnvs.length && !localStorage) {
    throw new Error('這個 zip 裡沒有可匯入的本地資料（請選擇由「匯出本地資料」產生的檔案）。');
  }
  return { files, legacy, images, deployEnvs, localStorage };
}

/** 給 renderer 顯示的匯入項目清單 */
const importList = ({ files, legacy, images, deployEnvs, localStorage }) => [
  ...legacy.map(describe),
  ...files.map(describe),
  ...(images.length ? [imagesInfo(images.length)] : []),
  ...(deployEnvs.length ? [deployEnvsInfo(deployEnvs.length)] : []),
  ...(localStorage ? [describe(LOCAL_STORAGE)] : []),
];

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
  const content = readImportZip(zipPath);
  pendingImport = zipPath;
  return { zipPath, files: importList(content) };
}

/**
 * 第二步（使用者確認後）：寫入檔案，localStorage 的內容交回 renderer 自己寫。
 * @returns {Promise<{ files: [{ name, label }], localStorage: object | null }>}
 */
async function applyImport() {
  if (!pendingImport) throw new Error('請先選擇要匯入的 zip 檔');
  const zipPath = pendingImport;
  pendingImport = null;

  const content = readImportZip(zipPath); // 重新讀一次，確認後檔案若被換掉也不會寫入壞資料
  // 舊版 zip 的設定檔先轉換（applyLegacy 會先全部轉換完才寫檔）；新格式的檔案之後寫入，兩者都有時以新格式為準
  if (content.legacy.length) {
    await applyLegacy(Object.fromEntries(content.legacy.map((f) => [f.kind, f.buf.toString('utf-8').replace(/^\uFEFF/, '')])));
  }
  // 先寫圖片，再寫流程狀態（狀態中的 testRecord 才找得到圖片）
  for (const img of content.images) await writeFileAtomic(absPath(img.name), img.buf);
  for (const f of content.deployEnvs) await writeFileAtomic(absPath(f.name), f.buf);
  for (const f of content.files) {
    const file = absPath(f.name);
    if (file === FLOW_STATE_FILE) await replaceFlowState(f.buf.toString('utf-8'));
    else await writeFileAtomic(file, f.buf);
  }
  return { files: importList(content), localStorage: content.localStorage };
}

module.exports = { exportLocalData, pickImportZip, applyImport };
