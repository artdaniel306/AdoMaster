const fs = require('node:fs/promises');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { CONFIG_FILE, ENV_FILE, LEGACY_ENV_FILE, LEGACY_REPOS_FILE, LEGACY_UPAGENT_CONFIG_FILE } = require('../paths');
const { RELEASE_DB_LABEL } = require('../../shared/flow-rules.js');
const { writeFileAtomic } = require('../atomicWrite');

/**
 * 本機設定只有兩個檔案（都在 data/，不進 git，可由「匯出 / 匯入本地資料」帶到別台電腦）：
 *   - data/config.json：結構化、非機密的設定，每個功能一個 section（repos、upagentRelease …）。
 *     範本：templates/config_example.json
 *   - data/.env：連線身分與機密（扁平 KEY=VALUE；Python / PowerShell 也直接讀）。範本：templates/env_example.txt
 * 新功能只在 config.json 加 section、在 .env 加 key，不另開設定檔。
 *
 * 舊版的 script/.env、data/repos.json、data/upagent_release.config 由 migrateLegacyConfig()（App 啟動時）
 * 或匯入舊的 zip（applyLegacy）自動轉換。
 */
const CONFIG_LABEL = 'data/config.json';
const ENV_LABEL = 'data/.env';

/** upagentRelease.db 的資料庫代號（test_saas …），密碼放在 .env 的 UPAGENT_DB_<代號>_PASSWORD */
const UPAGENT_DB_KEYS = Object.keys(RELEASE_DB_LABEL);
const upagentDbPasswordKey = (db) => `UPAGENT_DB_${db.toUpperCase()}_PASSWORD`;

async function readText(file) {
  try {
    return (await fs.readFile(file, 'utf-8')).replace(/^\uFEFF/, '');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** 解析 config.json 的內容（最外層必須是物件），格式錯誤時丟出帶檔名的錯誤 */
function parseConfig(text, label = CONFIG_LABEL) {
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`${label} 格式錯誤：${err.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${label} 最外層必須是物件`);
  return data;
}

/** 讀取 data/config.json；檔案不存在時回傳 null */
async function readConfig() {
  const text = await readText(CONFIG_FILE);
  return text == null ? null : parseConfig(text);
}

let configQueue = Promise.resolve(); // 序列化 config.json 的讀改寫

/**
 * 讀出 config.json（不存在時為 {}）交給 mutate 修改，再原子寫回；mutate 丟錯時不寫檔。
 * @param mutate (config) => void | config | Promise
 * @returns {Promise<object>} 寫入後的內容
 */
function updateConfig(mutate) {
  const run = configQueue.then(async () => {
    const cfg = (await readConfig()) || {};
    const next = (await mutate(cfg)) ?? cfg;
    await writeFileAtomic(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
  configQueue = run.catch(() => {});
  return run;
}

/** .env 的值含空白、# 或引號時加上引號（Python / Node / PowerShell 的讀取方式都會去掉成對的引號） */
function envValue(v) {
  if (!/[\s#'"]/.test(v)) return v;
  return v.includes('"') ? `'${v}'` : `"${v}"`;
}

/**
 * 在 .env 文字中設定 key（已有則取代該行，否則加在最後），保留其他行與註解。
 * 空值預設略過；removeEmpty = true 時改成刪掉該 key 的設定行（註解掉的範例行不動）。
 */
function setEnvKeys(text, values, { removeEmpty = false } = {}) {
  let lines = text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    if (value == null || value === '') {
      if (removeEmpty) lines = lines.filter((l) => !re.test(l));
      continue;
    }
    const line = `${key}=${envValue(String(value))}`;
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  }
  return `${lines.join('\n')}\n`;
}

let envQueue = Promise.resolve(); // 序列化 .env 的讀改寫

/** 依序執行 .env 的讀改寫（fn 丟錯不影響後續） */
function withEnvLock(fn) {
  const run = envQueue.then(fn);
  envQueue = run.catch(() => {});
  return run;
}

/**
 * 讀取 .env 的 KEY=VALUE，規則與 script/ado/config.py 的 load_env、shell 的 Read-DotEnv 相同：
 * # 開頭為註解、可加 export 前綴、成對引號去掉、未加引號時去掉行尾「 #」之後的註解。
 * 不用 node:util 的 parseEnv：它的引號 / 註解處理和 Python / PowerShell 不完全一樣，這裡要顯示腳本實際讀到的值。
 */
function readEnvValues(text) {
  const env = {};
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq < 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if (q !== "'" && q !== '"') value = value.split(' #')[0].trim();
    if (value.length >= 2 && (q === "'" || q === '"') && value.at(-1) === q) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

/**
 * 「設定 → 連線與機密設定」dialog 可編輯的 .env key（範本：templates/env_example.txt）。
 * 不在清單中的 key（例如 OUTPUT_CSV）與註解會原樣保留；新增 .env key 時也要加到這裡。
 */
const ENV_GROUPS = [
  {
    title: 'Azure DevOps',
    fields: [
      { key: 'AZDO_ORG', label: 'Organization', required: true, placeholder: 'my-org' },
      { key: 'AZDO_PROJECT', label: 'Project', required: true, placeholder: 'MyProject' },
      { key: 'AZDO_PAT', label: 'Personal Access Token', required: true, secret: true },
      { key: 'AZDO_BASE_URL', label: 'Base URL', placeholder: 'https://dev.azure.com' },
      { key: 'AZDO_API_VERSION', label: 'API version', placeholder: '7.1' },
    ],
  },
  {
    title: 'UpAgent 發佈',
    fields: [
      { key: 'GITHUB_TOKEN', label: 'GitHub Token', secret: true },
      ...UPAGENT_DB_KEYS.map((db) => ({ key: upagentDbPasswordKey(db), label: `${RELEASE_DB_LABEL[db]} 資料庫密碼`, secret: true })),
    ],
  },
];
const ENV_FIELD_KEYS = ENV_GROUPS.flatMap((g) => g.fields.map((f) => f.key));

/** 給「連線與機密設定」dialog 用：欄位定義 + 目前 .env 的值；envOverride = 同名環境變數已設定（腳本會優先用它） */
async function loadEnvSettings() {
  const text = await readText(ENV_FILE);
  const values = readEnvValues(text);
  return {
    file: ENV_FILE,
    exists: text != null,
    groups: ENV_GROUPS.map((g) => ({
      ...g,
      fields: g.fields.map((f) => ({ ...f, value: values[f.key] ?? '', envOverride: !!process.env[f.key] })),
    })),
  };
}

/**
 * 儲存「連線與機密設定」dialog 的內容到 data/.env：只改清單內的 key，空值 = 刪掉該行，其他行與註解保留（暫存檔 + rename）。
 * @param values { [key]: string }
 */
async function saveEnvSettings({ values } = {}) {
  if (!values || typeof values !== 'object') throw new Error('values 必須是物件');
  const clean = {};
  for (const key of ENV_FIELD_KEYS) {
    if (!(key in values)) continue;
    const v = values[key] == null ? '' : String(values[key]).trim();
    if (/[\r\n]/.test(v)) throw new Error(`${key} 不能包含換行`);
    clean[key] = v;
  }
  if (clean.AZDO_BASE_URL && !/^https?:\/\//i.test(clean.AZDO_BASE_URL)) {
    throw new Error('AZDO_BASE_URL 必須是 http:// 或 https:// 開頭的網址');
  }
  await writeEnvKeys(clean);
  return loadEnvSettings();
}

/** 目前 data/.env 的 KEY=VALUE（檔案不存在時為 {}；不含環境變數） */
async function readEnvFile() {
  return readEnvValues(await readText(ENV_FILE));
}

/**
 * 寫入 data/.env 的指定 key（空值 = 刪掉該行），其他行與註解保留；檔案不存在時建立（暫存檔 + rename，序列化）。
 * 呼叫端負責驗證 key 與值（不能含換行）。
 */
function writeEnvKeys(values) {
  return withEnvLock(async () => {
    const text = (await readText(ENV_FILE))
      ?? `# 連線身分與機密（扁平 KEY=VALUE）。本檔含有存取憑證，請勿提交到版控或外流。同名的環境變數優先於本檔。\n`;
    await writeFileAtomic(ENV_FILE, setEnvKeys(text, values, { removeEmpty: true }));
  });
}

/**
 * 讀取舊版 upagent_release.config。刻意不用 npm 的 ini 套件：它會把值中的 # / ; 當成行尾註解截掉
 * （密碼可能含這些字元），這裡必須和舊的 PowerShell 讀法完全一致：只有整行 # / ; 開頭才是註解，
 * key = value 取等號後整段，區段與 key 不分大小寫。
 */
function parseLegacyIni(text) {
  const ini = {};
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const s = /^\[(.+)\]$/.exec(line);
    if (s) {
      section = s[1].trim().toLowerCase();
      ini[section] ??= {};
      continue;
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (section && kv) ini[section][kv[1].toLowerCase()] = kv[2].trim();
  }
  return ini;
}

/** 從物件取出有值的欄位並改名：map = { 新名稱: 舊名稱 } */
const pick = (obj = {}, map) => Object.fromEntries(Object.entries(map).filter(([, from]) => obj[from]).map(([to, from]) => [to, obj[from]]));

/** 舊版 upagent_release.config → { upagentRelease（給 config.json）, secrets（給 .env） } */
function convertLegacyUpagent(text) {
  const ini = parseLegacyIni(text);
  const db = Object.fromEntries(UPAGENT_DB_KEYS.map((k) => {
    const d = pick(ini[`upagent_db_${k}`], { psql: 'psql', host: 'host', port: 'port', dbname: 'dbname', user: 'user', sslmode: 'sslmode' });
    if (/^\d+$/.test(d.port || '')) d.port = Number(d.port);
    return [k, d];
  }));
  return {
    upagentRelease: {
      ...pick(ini.upagent_release, { storageAccount: 'storage_account', container: 'container', stagingFolder: 'staging_folder', releaseFolder: 'release_folder' }),
      github: pick(ini.github, { owner: 'owner', repo: 'repo', workflowFile: 'workflow_file' }),
      codesign: pick(ini.codesign, { signtool: 'signtool', certSubject: 'cert_subject', timestampUrl: 'timestamp_url' }),
      db,
    },
    secrets: {
      GITHUB_TOKEN: ini.github?.token,
      ...Object.fromEntries(UPAGENT_DB_KEYS.map((k) => [upagentDbPasswordKey(k), ini[`upagent_db_${k}`]?.password])),
    },
  };
}

/** 舊版 repos.json（{ repos: [...] } 或直接是陣列）→ repos 陣列 */
function convertLegacyRepos(text) {
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`data/repos.json 格式錯誤：${err.message}`);
  }
  const repos = Array.isArray(data) ? data : data?.repos;
  if (!Array.isArray(repos)) throw new Error('data/repos.json 需要 "repos" 陣列');
  return repos;
}

/**
 * 把舊格式的內容併進 data/config.json / data/.env（對應的 section / key 以舊檔為準覆寫，其他保留）。
 * @param legacy { env?: string（舊 script/.env）, repos?: string（舊 repos.json）, upagent?: string（舊 upagent_release.config） }
 */
async function applyLegacy({ env, repos, upagent } = {}) {
  // 先全部轉換完（有錯就整批不寫）
  const reposArr = repos != null ? convertLegacyRepos(repos) : null;
  const up = upagent != null ? convertLegacyUpagent(upagent) : null;

  if (reposArr || up) {
    await updateConfig((cfg) => {
      if (reposArr) cfg.repos = reposArr;
      if (up) cfg.upagentRelease = up.upagentRelease;
    });
  }
  if (env != null || up) {
    await withEnvLock(async () => {
      let text = await readText(ENV_FILE);
      if (env != null) text = text == null ? env : setEnvKeys(text, parseEnv(env)); // 沒有 data/.env 時整檔沿用（保留註解）
      if (up) text = setEnvKeys(text, up.secrets);
      await writeFileAtomic(ENV_FILE, text);
    });
  }
}

/** 舊檔改名為 *.bak（已有 .bak 時加上時間） */
async function backupLegacy(file) {
  let bak = `${file}.bak`;
  if (await fs.access(bak).then(() => true, () => false)) bak = `${file}.${Date.now()}.bak`;
  await fs.rename(file, bak);
  return bak;
}

const LEGACY_FILES = [
  { kind: 'env', file: LEGACY_ENV_FILE },
  { kind: 'repos', file: LEGACY_REPOS_FILE },
  { kind: 'upagent', file: LEGACY_UPAGENT_CONFIG_FILE },
];

/**
 * App 啟動時呼叫：有舊版設定檔就轉換到 data/config.json / data/.env，再把舊檔改名為 *.bak。
 * @returns {Promise<string[]>} 轉換過的舊檔（相對專案根目錄）
 */
async function migrateLegacyConfig() {
  const found = [];
  for (const f of LEGACY_FILES) {
    const text = await readText(f.file);
    if (text != null) found.push({ ...f, text });
  }
  if (!found.length) return [];
  await applyLegacy(Object.fromEntries(found.map((f) => [f.kind, f.text])));
  for (const f of found) await backupLegacy(f.file);
  const root = path.dirname(path.dirname(CONFIG_FILE));
  return found.map((f) => path.relative(root, f.file).split(path.sep).join('/'));
}

module.exports = {
  CONFIG_LABEL,
  ENV_LABEL,
  parseConfig,
  readConfig,
  updateConfig,
  UPAGENT_DB_KEYS,
  upagentDbPasswordKey,
  loadEnvSettings,
  saveEnvSettings,
  readEnvFile,
  writeEnvKeys,
  applyLegacy,
  migrateLegacyConfig,
};
