const { dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readSection, updateSection, isObj, str, assertSingleLine, CONFIG_LABEL } = require('./appConfig');
const { UPAGENT_CONNECTIONS } = require('../../shared/flow-rules.js');
const { runPowerShellJson } = require('../powershell');

/**
 * 切換本機 UpAgent 的連線（Local Test / Local Prod / SaaS Test / SaaS Prod）。
 * 做法：刪掉 UpAgent 的設定檔（config.json upagentConnection.configFile），UpAgent 重新開啟後會要求輸入 Activation Code，
 * 再依 Code 自動連到對應的環境；Activation Code 依目標設定在 upagentConnection.activationCodes.<key>。
 * 有設定 exePath 時：刪檔前先關閉正在執行的 UpAgent（shell/Stop-UpAgent.ps1，等它完全結束——關閉時可能寫回設定檔），
 * 刪檔後再重新開啟；沒設定（或空字串）= 只刪檔，由使用者自己重開。
 *
 * config.json：
 *   "upagentConnection": {
 *     "configFile": "%APPDATA%\\upagent\\config.json",      // 字串或字串陣列；可用 %VAR% 與開頭的 ~
 *     "exePath": "%LOCALAPPDATA%\\Programs\\UpAgent\\UpAgent.exe",   // 選填；可用 %VAR% 與開頭的 ~
 *     "activationCodes": { "local_test": "...", "local_prod": "...", "saas_test": "...", "saas_prod": "..." }
 *   }
 */
const SECTION = 'upagentConnection';
const hint = (field) => `請從選單「設定 → UpAgent 連線設定…」設定（${CONFIG_LABEL} 的 ${SECTION}.${field}）`;

/** 展開 %VAR% 與開頭的 ~，並要求是絕對路徑 */
function expandPath(p, what = '設定檔') {
  let missing = null;
  let out = p.replace(/%([^%]+)%/g, (m, name) => {
    const v = process.env[name];
    if (v == null) missing ||= name;
    return v ?? m;
  });
  if (missing) throw new Error(`UpAgent ${what}路徑中的環境變數 %${missing}% 不存在：${p}`);
  if (/^~(?=$|[\\/])/.test(out)) out = path.join(os.homedir(), out.slice(1));
  if (!path.isAbsolute(out)) throw new Error(`UpAgent ${what}路徑必須是絕對路徑：${p}`);
  return path.normalize(out);
}

/** configFile（字串或字串陣列）→ 去空白、非空的路徑陣列（尚未展開 %VAR%） */
const configFiles = (section) => [].concat(section?.configFile ?? []).filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
const activationCodes = (section) => (isObj(section?.activationCodes) ? section.activationCodes : {});
/** exePath（未展開）；沒設定 = ''（不自動關閉 / 重新開啟） */
const exePathOf = (section) => str(section?.exePath);
const isFile = (f) => fs.stat(f).then((s) => s.isFile(), () => false);

async function loadSection() {
  const section = await readSection(SECTION);
  if (!section) throw new Error(`尚未設定 UpAgent 連線：${hint('configFile / activationCodes')}`);
  const raw = configFiles(section);
  if (!raw.length) throw new Error(`尚未設定 UpAgent 設定檔路徑：${hint('configFile')}`);
  const exe = exePathOf(section);
  return { files: raw.map((p) => expandPath(p)), codes: activationCodes(section), exe: exe ? expandPath(exe, '執行檔') : null };
}

const codeOf = (codes, key) => (typeof codes[key] === 'string' ? codes[key].trim() : '');

/** dialog 開啟時的資訊：要刪除的檔案（是否存在）、UpAgent 執行檔（沒設定 = null）與各目標是否已設定 Activation Code */
async function connectionStatus() {
  const { files, codes, exe } = await loadSection();
  const exists = await Promise.all(files.map(isFile));
  return {
    files: files.map((f, i) => ({ path: f, exists: exists[i] })),
    exe: exe && { path: exe, exists: await isFile(exe) },
    targets: UPAGENT_CONNECTIONS.map((t) => ({ ...t, hasCode: !!codeOf(codes, t.key) })),
  };
}

/** 關閉正在執行的 UpAgent（以完整路徑比對程序），等全部結束後回傳 { running, forced } */
async function stopUpagent(exe) {
  const r = await runPowerShellJson('Stop-UpAgent.ps1', ['-ExePath', exe], { timeout: 60_000 });
  return { running: !!r.running, forced: !!r.forced };
}

/**
 * 啟動 UpAgent（detached：與 AdoMaster 無關，AdoMaster 關閉也不影響）。
 * 去掉 ELECTRON_* 環境變數：UpAgent 也是 Electron 程式，繼承 ELECTRON_RUN_AS_NODE 等會改變它的行為。
 */
function launchUpagent(exe) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ELECTRON_/i.test(k)));
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { cwd: path.dirname(exe), env, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * 切換到 target：先確認有 Activation Code（與執行檔存在），關閉 UpAgent → 刪掉 UpAgent 設定檔（不存在就略過）→ 重新開啟 UpAgent。
 * 重新開啟失敗不算切換失敗（設定檔已刪，仍要顯示 Activation Code），以 app.startError 回傳。
 * @returns {{ target, label, activationCode, files: [{ path, deleted }],
 *             app: null | { path, running, forced, started, startError } }}  app = null：沒設定 exePath
 */
async function switchConnection({ target } = {}) {
  const conn = UPAGENT_CONNECTIONS.find((t) => t.key === target);
  if (!conn) throw new Error(`未知的 UpAgent 連線：${target}`);
  const { files, codes, exe } = await loadSection();
  const activationCode = codeOf(codes, target);
  if (!activationCode) throw new Error(`尚未設定 ${conn.label} 的 Activation Code：${hint(`activationCodes.${target}`)}`);
  if (exe && !(await isFile(exe))) throw new Error(`找不到 UpAgent 執行檔：${exe}（${hint('exePath')}）`);

  const app = exe ? { path: exe, ...(await stopUpagent(exe)), started: false, startError: null } : null;

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

  if (app) {
    try {
      await launchUpagent(exe);
      app.started = true;
    } catch (err) {
      app.startError = err.message;
    }
  }
  return { target, label: conn.label, activationCode, files: results, app };
}

const DEFAULT_CONFIG_FILE = '%APPDATA%\\upagent\\config.json';
const DEFAULT_EXE_PATH = '%LOCALAPPDATA%\\Programs\\UpAgent\\UpAgent.exe';

/**
 * 給「UpAgent 連線設定」dialog 用：config.json upagentConnection 的原始內容。
 * exePath：從未設定過（沒有這個 key）且預設安裝路徑有 UpAgent.exe 時帶入預設路徑；儲存為空字串 = 不自動關閉 / 重新開啟。
 * @returns {{ file, exists, defaultConfigFile, configFile: string[], exePath, targets: [{ key, label, code }] }}
 */
async function loadConnectionSettings() {
  const section = await readSection(SECTION);
  const codes = activationCodes(section);
  let exePath = exePathOf(section);
  if (section?.exePath === undefined && (await isFile(expandPath(DEFAULT_EXE_PATH, '執行檔')))) exePath = DEFAULT_EXE_PATH;
  return {
    file: CONFIG_LABEL,
    exists: !!section,
    defaultConfigFile: DEFAULT_CONFIG_FILE,
    configFile: configFiles(section),
    exePath,
    targets: UPAGENT_CONNECTIONS.map((t) => ({ ...t, code: codeOf(codes, t.key) })),
  };
}

/**
 * 儲存「UpAgent 連線設定」dialog 的內容到 config.json 的 upagentConnection（其他 section 與本 section 的其他欄位保留）。
 * configFile 只有一個時存成字串，多個時存成陣列；Activation Code 空白 = 刪掉該 key；exePath 空白 = 存成空字串（不自動關閉 / 重新開啟）。
 * @param configFile string[]；exePath string；codes { local_test: '...', ... }
 */
async function saveConnectionSettings({ configFile, exePath, codes } = {}) {
  const files = [...new Set([].concat(configFile ?? []).map((p) => String(p ?? '').trim()).filter(Boolean))];
  if (!files.length) throw new Error('請至少填入一個 UpAgent 設定檔路徑');
  files.forEach((p) => expandPath(p)); // 路徑格式 / 環境變數檢查，失敗時丟出錯誤、不寫檔
  const exe = str(exePath);
  assertSingleLine(exe, 'UpAgent 執行檔路徑');
  if (exe) expandPath(exe, '執行檔');
  const clean = {};
  for (const { key, label } of UPAGENT_CONNECTIONS) {
    const v = str(codes?.[key]);
    assertSingleLine(v, `${label} 的 Activation Code`);
    if (v) clean[key] = v;
  }
  await updateSection(SECTION, (section) => {
    // 保留不在 UPAGENT_CONNECTIONS 內的 code（手動加的）
    const extra = Object.fromEntries(Object.entries(activationCodes(section)).filter(([k]) => !UPAGENT_CONNECTIONS.some((t) => t.key === k)));
    section.configFile = files.length === 1 ? files[0] : files;
    section.exePath = exe;
    section.activationCodes = { ...extra, ...clean };
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

/**
 * 讓使用者選擇 UpAgent 執行檔；取消時回傳 null。
 * @param current 目前的路徑（可含 %VAR%），用來決定開啟的資料夾
 * @returns {Promise<string | null>} 已換回 %VAR% 的路徑
 */
async function pickExeFile(win, current) {
  const dirOf = (p) => {
    try { return path.dirname(expandPath(p, '執行檔')); } catch { return undefined; }
  };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '選擇 UpAgent 執行檔',
    defaultPath: (typeof current === 'string' && current.trim() && dirOf(current.trim())) || dirOf(DEFAULT_EXE_PATH),
    properties: ['openFile'],
    filters: [{ name: '執行檔', extensions: ['exe'] }, { name: '所有檔案', extensions: ['*'] }],
  });
  return canceled || !filePaths?.length ? null : foldPath(path.normalize(filePaths[0]));
}

module.exports = { connectionStatus, switchConnection, loadConnectionSettings, saveConnectionSettings, pickConfigFile, pickExeFile };
