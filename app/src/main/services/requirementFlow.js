const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FLOW_STATE_FILE } = require('../paths');
const { runScript } = require('../python');
const { REPOS } = require('./repoConfig');

const UNDERSTAND_KEY = 'understand';
const UNDERSTAND_REPOS_KEY = 'understandRepos';
const UNDERSTAND_MIGRATION_KEY = 'understandMigration';
const UNDERSTAND_NOTE_KEY = 'understandNote';
const NOTE_MAX = 2000;

/** 執行 get_requirement_flow.py 取得指定 Iteration 的 Requirement 與其子項目。 */
async function fetchRequirementFlow({ iterationPath, exact } = {}) {
  if (typeof iterationPath !== 'string' || !iterationPath) throw new Error('缺少 iterationPath');
  // 每次請求用獨立暫存檔，避免同時查詢互相覆寫
  const out = path.join(
    os.tmpdir(),
    `ado-master-flow-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  const args = ['--iteration', iterationPath, '--out', out];
  if (exact) args.push('--exact');
  try {
    await runScript('get_requirement_flow.py', args);
    return JSON.parse(await fs.readFile(out, 'utf-8'));
  } finally {
    fs.rm(out, { force: true }).catch(() => {});
  }
}

/**
 * 流程中尚未串接 ADO 的人工步驟（Manager understand、佈版、測試、發表會…）先以 checkbox 記錄在本機：
 * data/requirement_flow_state.json → { "<requirementId>": { "<checkKey>": true, ... } }
 */
async function loadFlowState() {
  try {
    return JSON.parse(await fs.readFile(FLOW_STATE_FILE, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

let writeQueue = Promise.resolve(); // 序列化讀改寫，避免連續勾選時互相覆蓋

/** 讀出某個 Requirement 的狀態交給 mutate 修改後寫回，回傳該 Requirement 更新後的狀態。 */
function updateRequirementState(id, mutate) {
  const task = writeQueue.then(async () => {
    const state = await loadFlowState();
    const checks = { ...(state[id] || {}) };
    mutate(checks);
    if (Object.keys(checks).length) state[id] = checks;
    else delete state[id];
    await fs.mkdir(path.dirname(FLOW_STATE_FILE), { recursive: true });
    await fs.writeFile(FLOW_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    return checks;
  });
  writeQueue = task.catch(() => {});
  return task;
}

/** 設定某個 Requirement 的一個 checkbox，回傳該 Requirement 更新後的狀態。 */
function setFlowCheck({ id, key, value } = {}) {
  if (!Number.isInteger(id) || typeof key !== 'string' || !/^[\w.]+$/.test(key) || key === UNDERSTAND_KEY) {
    return Promise.reject(new Error('參數錯誤'));
  }
  return updateRequirementState(id, (checks) => {
    if (value) checks[key] = true;
    else delete checks[key];
  });
}

/**
 * Manager understand：確認此需求要在哪些 repository 開發、各自的 feature branch。
 *   repos = { crmapp: 'feature/x', upagent: 'feature/y' } → understand: true、understandRepos: repos
 *   migration = true → understandMigration: true（需要 migration）
 *   note = '...'     → understandNote: '...'（manager 的註解，空白則不存）
 *   repos = null → 取消確認（全部清除）
 */
function setUnderstand({ id, repos, migration, note } = {}) {
  if (!Number.isInteger(id)) return Promise.reject(new Error('參數錯誤'));
  if (note != null && typeof note !== 'string') return Promise.reject(new Error('參數錯誤'));
  note = (note || '').trim();
  if (note.length > NOTE_MAX) return Promise.reject(new Error(`註解最多 ${NOTE_MAX} 字`));
  if (repos != null) {
    const validKeys = new Set(REPOS.map((r) => r.key));
    const entries = typeof repos === 'object' ? Object.entries(repos) : [];
    if (!entries.length) return Promise.reject(new Error('請至少選擇一個 repository'));
    for (const [k, branch] of entries) {
      if (!validKeys.has(k)) return Promise.reject(new Error(`未知的 repository：${k}`));
      if (typeof branch !== 'string' || !branch.trim()) return Promise.reject(new Error(`${k} 尚未選擇 feature branch`));
    }
    repos = Object.fromEntries(entries.map(([k, b]) => [k, b.trim()]));
  }
  return updateRequirementState(id, (checks) => {
    if (repos) {
      checks[UNDERSTAND_KEY] = true;
      checks[UNDERSTAND_REPOS_KEY] = repos;
      if (migration === true) checks[UNDERSTAND_MIGRATION_KEY] = true;
      else delete checks[UNDERSTAND_MIGRATION_KEY];
      if (note) checks[UNDERSTAND_NOTE_KEY] = note;
      else delete checks[UNDERSTAND_NOTE_KEY];
    } else {
      delete checks[UNDERSTAND_KEY];
      delete checks[UNDERSTAND_REPOS_KEY];
      delete checks[UNDERSTAND_MIGRATION_KEY];
      delete checks[UNDERSTAND_NOTE_KEY];
    }
  });
}

module.exports = { fetchRequirementFlow, loadFlowState, setFlowCheck, setUnderstand };
