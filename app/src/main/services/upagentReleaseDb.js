const { dialog } = require('electron');
const path = require('node:path');
const {
  CONFIG_LABEL, ENV_LABEL, UPAGENT_DB_KEYS, upagentDbPasswordKey, readSection, updateSection, readEnvFile, writeEnvKeys,
  str, isObj, assertSingleLine,
} = require('./appConfig');
const { RELEASE_DB_LABEL } = require('../../shared/flow-rules.js');

/**
 * 「設定 → UpAgent 發佈資料庫設定…」：UpAgent 發佈最後一步（Database）寫入 public.public_db_upagentrelease 的 4 個資料庫。
 *   - 連線資訊：config.json 的 upagentRelease.db.<test|prod>_<saas|local>（psql / host / port / dbname / user / sslmode）
 *   - 密碼：.env 的 UPAGENT_DB_<代號>_PASSWORD（機密不放 config.json）
 * 預設值與 shell/Release-UpAgent.ps1 一致：psql = PATH 上的 psql、port = 5432、sslmode = require；
 * 欄位留空 = 從 config.json 刪掉該欄位（腳本改用預設值），host / dbname / user 沒有預設值，發佈時必填。
 * upagentRelease 的其他欄位（storageAccount、github、codesign …）與本 section 的其他資料庫欄位都保留不動。
 */
const SECTION = 'upagentRelease';
const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'];
const DEFAULTS = { psql: 'psql', port: 5432, sslmode: 'require' };
const TEXT_FIELDS = ['psql', 'host', 'dbname', 'user'];

/**
 * @returns {{ file, envFile, exists, defaults, sslModes,
 *   dbs: [{ key, label, psql, host, port, dbname, user, sslmode, passwordKey, password, envOverride }] }}
 */
async function loadReleaseDbSettings() {
  const section = await readSection(SECTION);
  const db = isObj(section?.db) ? section.db : {};
  const env = await readEnvFile();
  return {
    file: CONFIG_LABEL,
    envFile: ENV_LABEL,
    exists: !!section,
    defaults: DEFAULTS,
    sslModes: SSL_MODES,
    dbs: UPAGENT_DB_KEYS.map((key) => {
      const d = isObj(db[key]) ? db[key] : {};
      const passwordKey = upagentDbPasswordKey(key);
      return {
        key,
        label: RELEASE_DB_LABEL[key],
        ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, str(d[f])])),
        port: str(d.port),
        sslmode: str(d.sslmode),
        passwordKey,
        password: env[passwordKey] ?? '',
        envOverride: !!process.env[passwordKey],
      };
    }),
  };
}

/** 驗證並整理一個資料庫的輸入；回傳 { conn: 要寫進 config.json 的欄位（空的不含）, password } */
function cleanDb(key, input) {
  const label = RELEASE_DB_LABEL[key];
  const v = Object.fromEntries([...TEXT_FIELDS, 'port', 'sslmode', 'password'].map((f) => [f, str(input?.[f])]));
  for (const [f, value] of Object.entries(v)) assertSingleLine(value, `${label} 的 ${f}`);
  const conn = {};
  for (const f of TEXT_FIELDS) if (v[f]) conn[f] = v[f];
  if (v.port) {
    const port = Number(v.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} 的 port 必須是 1 ~ 65535 的整數`);
    conn.port = port;
  }
  if (v.sslmode) {
    if (!SSL_MODES.includes(v.sslmode)) throw new Error(`${label} 的 sslmode 必須是 ${SSL_MODES.join(' / ')} 其中之一`);
    conn.sslmode = v.sslmode;
  }
  return { conn, password: v.password };
}

/**
 * 儲存：連線資訊寫進 config.json upagentRelease.db，密碼寫進 .env（空白 = 刪掉該 key）。
 * 全部驗證通過才寫檔；先寫 config.json 再寫 .env。
 * @param dbs { test_saas: { psql, host, port, dbname, user, sslmode, password }, ... }
 */
async function saveReleaseDbSettings({ dbs } = {}) {
  if (!isObj(dbs)) throw new Error('dbs 必須是物件');
  const cleaned = Object.fromEntries(UPAGENT_DB_KEYS.filter((k) => k in dbs).map((k) => [k, cleanDb(k, dbs[k])]));
  await updateSection(SECTION, (section) => {
    const db = isObj(section.db) ? { ...section.db } : {};
    for (const [key, { conn }] of Object.entries(cleaned)) {
      // 保留這個資料庫中不是由本 dialog 管理的欄位（手動加的）
      const prev = isObj(db[key]) ? db[key] : {};
      const extra = Object.fromEntries(Object.entries(prev).filter(([f]) => ![...TEXT_FIELDS, 'port', 'sslmode'].includes(f)));
      db[key] = { ...extra, ...conn };
    }
    section.db = db;
  });
  await writeEnvKeys(Object.fromEntries(Object.entries(cleaned).map(([key, { password }]) => [upagentDbPasswordKey(key), password])));
  return loadReleaseDbSettings();
}

/** 選擇 psql 執行檔；取消時回傳 null */
async function pickPsql(win, current) {
  const cur = str(current);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '選擇 psql 執行檔',
    defaultPath: cur && path.isAbsolute(cur) ? path.dirname(cur) : undefined,
    properties: ['openFile'],
    filters: [{ name: 'psql', extensions: ['exe'] }, { name: '所有檔案', extensions: ['*'] }],
  });
  return canceled || !filePaths?.length ? null : path.normalize(filePaths[0]);
}

module.exports = { loadReleaseDbSettings, saveReleaseDbSettings, pickPsql };
