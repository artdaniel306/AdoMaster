const { dialog } = require('electron');
const { CONFIG_LABEL, readConfig, updateConfig } = require('./appConfig');

/**
 * Repository 設定放在 data/config.json 的 repos（見 appConfig.js；範本 templates/config_example.json）。
 * 每次使用都重新讀取，修改後不用重開 App：
 *   { "repos": [{
 *       "key": "crmapp", "label": "crmapp", "color": "#2f6feb",
 *       "path": "C:\\source\\crmapp",
 *       "branches": ["feature/xxx"],
 *       "testBranch": "test", "prodBranch": "master",
 *       "testPipeline": "", "prodPipeline": "",
 *       "testAppService": "", "testResourceGroup": ""
 *   }, ...] }
 *   - key：存進流程狀態（data/requirement_flow_state.json）的識別名稱，改名會讓既有紀錄對不上
 *   - label：畫面顯示名稱（預設 = key）；color：代表色（任何 CSS 顏色，選填）
 *   - path：本機 clone 的路徑（Confirm Commit 確認 commit、merge / push 用）
 *   - branches：規劃 時可選的 feature branch（陣列，也接受逗號分隔字串）
 *   - testBranch / prodBranch：環境 branch（勾 SaaS / Local 前確認 commit 已進到該 branch）
 *   - testPipeline / prodPipeline：環境 branch push 後自動佈版的 Pipeline 名稱（可寫「資料夾\名稱」；空白 = 沒有自動佈版）
 *   - testAppService / testResourceGroup：測試環境 Pipeline Run 成功後要重啟的 App Service（afterDeploy.js；
 *     空白 = 不重啟；Resource Group 空白時自動查詢）。正式環境刻意沒有對應欄位（不自動重啟）
 *   - backMergeKeepPaths（選填，設定 dialog 不編輯）：{ "peach_101": ["tenant_db/migrations"] }
 *     正式環境反向 merge 回 feature branch 時，這些路徑保留該 branch 原本的內容（見 deployMerge.mergeBackToFeatures）
 */
const FILE_LABEL = `${CONFIG_LABEL} 的 repos`;
const KEY_RE = /^[A-Za-z0-9_.-]+$/;

/** 佈版階段 → repos 各 repository 的欄位名稱 */
const DEPLOY_BRANCH_FIELDS = { testDeploy: 'testBranch', prodDeploy: 'prodBranch' };
const PIPELINE_FIELDS = { testDeploy: 'testPipeline', prodDeploy: 'prodPipeline' };
/** 佈版後要重啟的 App Service：只有測試環境（正式環境有客戶在用，不自動重啟） */
const APP_SERVICE_FIELDS = { testDeploy: { name: 'testAppService', resourceGroup: 'testResourceGroup' } };

/** 錯誤訊息用：指出要去哪裡設定 */
const fieldHint = (key, field) => `${FILE_LABEL} 中 ${key} 的 "${field}"`;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[,\r\n]/)).map(str).filter(Boolean))];

/** 讀取 config.json 的 repos 陣列；尚未設定且 missingOk 時回傳 null */
async function readRepoFile({ missingOk = false } = {}) {
  const repos = (await readConfig())?.repos;
  if (repos == null) {
    if (missingOk) return null;
    throw new Error(`尚未設定 ${FILE_LABEL}（可從選單「設定 → Repository 設定…」建立，或參考 templates/config_example.json）`);
  }
  if (!Array.isArray(repos)) throw new Error(`${FILE_LABEL} 必須是陣列`);
  return repos;
}

/** 每次呼叫都重新讀取 repos 設定，回傳 { repos: [{ key, label, color, path, branches, deployBranches, pipelines, appServices }] } */
async function loadRepoConfig() {
  return { repos: normalizeRepos(await readRepoFile()) };
}

/** 依 key 找 repository（整理後的結構）；沒有時回傳 null */
async function findRepo(key) {
  return (await loadRepoConfig()).repos.find((r) => r.key === key) || null;
}

/** 同 findRepo，但找不到時丟錯 */
async function requireRepo(key) {
  const r = await findRepo(key);
  if (!r) throw new Error(`未知的 repository：${key}`);
  return r;
}

/** 檢查 key（格式、重複）並整理成 App 使用的結構 */
function normalizeRepos(repos) {
  const seen = new Set();
  const pick = (r, fields) => Object.fromEntries(Object.entries(fields).map(([stage, f]) => [stage, str(r[f])]));
  return repos.map((r, i) => {
    const key = str(r?.key);
    if (!KEY_RE.test(key)) throw new Error(`${FILE_LABEL} 第 ${i + 1} 個 repository 的 key 不正確（只能用英數字與 _ . -）`);
    if (seen.has(key)) throw new Error(`${FILE_LABEL} 的 key 重複：${key}`);
    seen.add(key);
    return {
      key,
      label: str(r.label) || key,
      color: str(r.color),
      path: str(r.path),
      branches: list(r.branches),
      deployBranches: pick(r, DEPLOY_BRANCH_FIELDS),
      pipelines: pick(r, PIPELINE_FIELDS),
      appServices: Object.fromEntries(
        Object.entries(APP_SERVICE_FIELDS).map(([stage, f]) => [stage, { name: str(r[f.name]), resourceGroup: str(r[f.resourceGroup]) }])
      ),
      backMergeKeepPaths: keepPaths(r.backMergeKeepPaths),
    };
  });
}

/**
 * backMergeKeepPaths：{ "<feature branch>": ["<路徑>", ...] } → 反向 merge 時保留該 branch 原本內容的路徑。
 * 路徑一律相對 repository 根目錄、改成 `/` 分隔、去掉前後的 `/`（接受 `tenant_db\migrations`）。
 */
function keepPaths(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [branch, paths] of Object.entries(v)) {
    const cleaned = list(paths).map((p) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter((p) => p && p !== '.' && !p.split('/').includes('..'));
    if (str(branch) && cleaned.length) out[str(branch)] = cleaned;
  }
  return out;
}

/** 設定 dialog 編輯的欄位（其餘欄位原樣保留） */
const EDIT_FIELDS = ['key', 'label', 'color', 'path', 'branches', 'testBranch', 'prodBranch', 'testPipeline', 'prodPipeline', 'testAppService', 'testResourceGroup'];

/**
 * 給「Repository 設定」dialog 用：回傳 repos 的原始內容（branches 一律轉成陣列）。
 * @returns {Promise<{ exists: boolean, repos: object[] }>}
 */
async function loadRepoSettings() {
  const repos = await readRepoFile({ missingOk: true });
  if (!repos) return { exists: false, repos: [] };
  return {
    exists: true,
    repos: repos.map((r) => ({
      ...Object.fromEntries(EDIT_FIELDS.map((f) => [f, str(r?.[f])])),
      branches: list(r?.branches),
      origKey: str(r?.key),
    })),
  };
}

/**
 * 儲存「Repository 設定」dialog 的內容到 config.json 的 repos（暫存檔 + rename；其他 section 不動）。
 * 以原本的 key（origKey）對回檔案中的原始物件，保留 dialog 沒編輯的額外欄位。
 * @param repos [{ origKey?, key, label, color, path, branches: string[] | string, testBranch, ... }]
 */
async function saveRepoSettings({ repos } = {}) {
  if (!Array.isArray(repos)) throw new Error('repos 必須是陣列');
  const cfg = await updateConfig((c) => {
    const original = Array.isArray(c.repos) ? c.repos : [];
    const byKey = new Map(original.filter((r) => r && typeof r === 'object').map((r) => [str(r.key), r]));
    const out = repos.map((r) => {
      const entry = { ...(byKey.get(str(r?.origKey)) || {}) };
      for (const f of EDIT_FIELDS) entry[f] = f === 'branches' ? list(r?.branches) : str(r?.[f]);
      return entry;
    });
    normalizeRepos(out); // key 格式 / 重複檢查，失敗時丟出錯誤、不寫檔
    c.repos = out;
    const renames = repos
      .map((r) => [str(r?.origKey), str(r?.key)])
      .filter(([from, to]) => from && to && from !== to && byKey.has(from));
    renameRepoKeys(c, renames);
  });
  return { repos: normalizeRepos(cfg.repos) };
}

/**
 * 其他 section 中以 repo key 為索引的設定：改 repos[].key 時一併改名，避免設定悄悄失效。
 * 新增「以 repo key 為索引」的 section 時也要加到這裡。
 */
function repoKeyedMaps(c) {
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const maps = [c.localDeploy?.repos, c.prodRestart?.repos];
  for (const target of Object.values(isObj(c.customerDeploy) ? c.customerDeploy : {})) {
    for (const customer of Object.values(isObj(target) ? target : {})) maps.push(isObj(customer) ? customer.repos : null);
  }
  return maps.filter(isObj);
}

/** 依 renames（[[舊 key, 新 key]]）改名；先全部取出再放回（a↔b 互換也正確），新 key 已有設定時保留原狀不覆蓋 */
function renameRepoKeys(c, renames) {
  if (!renames.length) return;
  for (const map of repoKeyedMaps(c)) {
    const moving = renames.filter(([from]) => from in map).map(([from, to]) => [from, to, map[from]]);
    for (const [from] of moving) delete map[from];
    for (const [from, to, value] of moving) {
      if (to in map) map[from] = value;
      else map[to] = value;
    }
  }
}

/** 讓使用者選擇本機 clone 的資料夾；取消時回傳 null */
async function pickRepoFolder(win, defaultPath) {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '選擇 repository 的本機資料夾',
    defaultPath: str(defaultPath) || undefined,
    properties: ['openDirectory'],
  });
  return canceled || !filePaths?.length ? null : filePaths[0];
}

module.exports = { loadRepoConfig, findRepo, requireRepo, loadRepoSettings, saveRepoSettings, pickRepoFolder, fieldHint, DEPLOY_BRANCH_FIELDS };
