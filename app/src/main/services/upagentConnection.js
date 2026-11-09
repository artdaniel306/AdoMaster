const { dialog } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readConfig, updateConfig, CONFIG_LABEL } = require('./appConfig');
const { UPAGENT_CONNECTIONS } = require('../../shared/flow-rules.js');

/**
 * 切換本機 UpAgent 的連線（Local Test / Local Prod / SaaS Test / SaaS Prod）。
 * 做法：刪掉 UpAgent 的設定檔（config.json upagentConnection.configFile），UpAgent 重新開啟後會要求輸入 Activation Code，
 * 再依 Code 自動連到對應的環境；Activation Code 依目標設定在 upagentConnection.activationCodes.<key>。
 *
 * config.json：
 *   "upagentConnection": {
 *     "configFile": "%APPDATA%\\upagent\\config.json",      // 字串或字串陣列；可用 %VAR% 與開頭的 ~
 *     "activationCodes": { "local_test": "...", "local_prod": "...", "saas_test": "...", "saas_prod": "..." }
 *   }
 */
const SECTION = 'upagentConnection';
const hint = (field) => `請從選單「設定 → UpAgent 連線設定…」設定（${CONFIG_LABEL} 的 ${SECTION}.${field}）`;

/** 展開 %VAR% 與開頭的 ~，並要求是絕對路徑 */
function expandPath(p) {
  let missing = null;
  let out = p.replace(/%([^%]+)%/g, (m, name) => {
    const v = process.env[name];
    if (v == null) missing ||= name;
    return v ?? m;
  });
  if (missing) throw new Error(`UpAgent 設定檔路徑中的環境變數 %${missing}% 不存在：${p}`);
  if (/^~(?=$|[\\/])/.test(out)) out = path.join(os.homedir(), out.slice(1));
  if (!path.isAbsolute(out)) throw new Error(`UpAgent 設定檔路徑必須是絕對路徑：${p}`);
  return path.normalize(out);
}

async function loadSection() {
  const section = (await readConfig())?.[SECTION];
  if (!section || typeof section !== 'object') throw new Error(`尚未設定 UpAgent 連線：${hint('configFile / activationCodes')}`);
  const raw = [].concat(section.configFile ?? []).filter((p) => typeof p === 'string' && p.trim());
  if (!raw.length) throw new Error(`尚未設定 UpAgent 設定檔路徑：${hint('configFile')}`);
  const codes = section.activationCodes && typeof section.activationCodes === 'object' ? section.activationCodes : {};
  return { files: raw.map((p) => expandPath(p.trim())), codes };
}

const codeOf = (codes, key) => (typeof codes[key] === 'string' ? codes[key].trim() : '');

/** dialog 開啟時的資訊：要刪除的檔案（是否存在）與各目標是否已設定 Activation Code */
async function connectionStatus() {
  const { files, codes } = await loadSection();
  const exists = await Promise.all(files.map((f) => fs.stat(f).then((s) => s.isFile(), () => false)));
  return {
    files: files.map((f, i) => ({ path: f, exists: exists[i] })),
    targets: UPAGENT_CONNECTIONS.map((t) => ({ ...t, hasCode: !!codeOf(codes, t.key) })),
  };
}

/**
 * 切換到 target：先確認有 Activation Code，再刪掉 UpAgent 設定檔（不存在就略過）。
 * @returns {{ target, label, activationCode, files: [{ path, deleted }] }}
 */
async function switchConnection({ target } = {}) {
  const conn = UPAGENT_CONNECTIONS.find((t) => t.key === target);
  if (!conn) throw new Error(`未知的 UpAgent 連線：${target}`);
  const { files, codes } = await loadSection();
  const activationCode = codeOf(codes, target);
  if (!activationCode) throw new Error(`尚未設定 ${conn.label} 的 Activation Code：${hint(`activationCodes.${target}`)}`);

  const results = [];
  for (const f of files) {
    try {
      await fs.unlink(f); // 只刪檔案；路徑是資料夾時 unlink 會失敗，不會整個資料夾刪掉
      results.push({ path: f, deleted: true });
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`刪除 UpAgent 設定檔失敗（${f}）：${err.message}`);
      results.push({ path: f, deleted: false });
    }
  }
  return { target, label: conn.label, activationCode, files: results };
}

const DEFAULT_CONFIG_FILE = '%APPDATA%\\upagent\\config.json';

/**
 * 給「UpAgent 連線設定」dialog 用：config.json upagentConnection 的原始內容。
 * @returns {{ file, exists, defaultConfigFile, configFile: string[], targets: [{ key, label, code }] }}
 */
async function loadConnectionSettings() {
  const section = (await readConfig())?.[SECTION];
  const ok = section && typeof section === 'object';
  const codes = ok && section.activationCodes && typeof section.activationCodes === 'object' ? section.activationCodes : {};
  return {
    file: CONFIG_LABEL,
    exists: !!ok,
    defaultConfigFile: DEFAULT_CONFIG_FILE,
    configFile: ok ? [].concat(section.configFile ?? []).filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()) : [],
    targets: UPAGENT_CONNECTIONS.map((t) => ({ ...t, code: codeOf(codes, t.key) })),
  };
}

/**
 * 儲存「UpAgent 連線設定」dialog 的內容到 config.json 的 upagentConnection（其他 section 與本 section 的其他欄位保留）。
 * configFile 只有一個時存成字串，多個時存成陣列；Activation Code 空白 = 刪掉該 key。
 * @param configFile string[]；codes { local_test: '...', ... }
 */
async function saveConnectionSettings({ configFile, codes } = {}) {
  const files = [...new Set([].concat(configFile ?? []).map((p) => String(p ?? '').trim()).filter(Boolean))];
  if (!files.length) throw new Error('請至少填入一個 UpAgent 設定檔路徑');
  files.forEach(expandPath); // 路徑格式 / 環境變數檢查，失敗時丟出錯誤、不寫檔
  const clean = {};
  for (const { key, label } of UPAGENT_CONNECTIONS) {
    const v = String(codes?.[key] ?? '').trim();
    if (/[\r\n]/.test(v)) throw new Error(`${label} 的 Activation Code 不能包含換行`);
    if (v) clean[key] = v;
  }
  await updateConfig((cfg) => {
    const prev = cfg[SECTION] && typeof cfg[SECTION] === 'object' ? cfg[SECTION] : {};
    const prevCodes = prev.activationCodes && typeof prev.activationCodes === 'object' ? prev.activationCodes : {};
    // 保留不在 UPAGENT_CONNECTIONS 內的 code（手動加的）
    const extra = Object.fromEntries(Object.entries(prevCodes).filter(([k]) => !UPAGENT_CONNECTIONS.some((t) => t.key === k)));
    cfg[SECTION] = { ...prev, configFile: files.length === 1 ? files[0] : files, activationCodes: { ...extra, ...clean } };
  });
  return loadConnectionSettings();
}

/** 把絕對路徑開頭的使用者資料夾換回 %VAR%（匯出 / 匯入到別台電腦、別的帳號仍然有效）；越具體的變數越先比對 */
const FOLD_VARS = ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE'];
function foldPath(p) {
  for (const name of FOLD_VARS) {
    const base = process.env[name] && path.normalize(process.env[name]);
    if (base && (p.toLowerCase() === base.toLowerCase() || p.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`))) {
      return `%${name}%${p.slice(base.length)}`;
    }
  }
  return p;
}

/**
 * 讓使用者選擇 UpAgent 設定檔（可多選）；取消時回傳 null。
 * 注意：檔案選擇器只能選既有的檔案（切換連線後設定檔會被刪掉，要等 UpAgent 重新產生後才選得到）。
 * @param current 目前的路徑（可含 %VAR%），用來決定開啟的資料夾
 * @returns {Promise<string[] | null>} 已換回 %VAR% 的路徑
 */
async function pickConfigFile(win, current) {
  const dirOf = (p) => {
    try { return path.dirname(expandPath(p)); } catch { return undefined; }
  };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '選擇 UpAgent 設定檔',
    defaultPath: (typeof current === 'string' && current.trim() && dirOf(current.trim())) || dirOf(DEFAULT_CONFIG_FILE),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'JSON', extensions: ['json'] }, { name: '所有檔案', extensions: ['*'] }],
  });
  return canceled || !filePaths?.length ? null : filePaths.map((p) => foldPath(path.normalize(p)));
}

module.exports = { connectionStatus, switchConnection, loadConnectionSettings, saveConnectionSettings, pickConfigFile };
