const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FLOW_STATE_FILE } = require('../paths');
const { runScript } = require('../python');
const { REPOS, loadRepoConfig } = require('./repoConfig');
const { checkCommit, checkMerged, mergeNoFf, COMMIT_RE } = require('./gitCommit');

const UNDERSTAND_KEY = 'understand';
const UNDERSTAND_REPOS_KEY = 'understandRepos';
const UNDERSTAND_MIGRATION_KEY = 'understandMigration';
const UNDERSTAND_NOTE_KEY = 'understandNote';
const NOTE_MAX = 2000;
/** 佈版前要先 Confirm Commit 的階段；commit 存在 `<stage>.commits`，勾選 SaaS / Local 前必須先確認 */
const COMMIT_STAGES = ['testDeploy', 'prodDeploy'];
const commitsKey = (stage) => `${stage}.commits`;
const deployStageOf = (key) => COMMIT_STAGES.find((s) => key.startsWith(`${s}.`));

/** 已確認的 commit 是否涵蓋 Manager understand 選的每個 repository */
function commitsConfirmed(checks, stage) {
  const repos = Object.keys(checks[UNDERSTAND_REPOS_KEY] || {});
  const commits = checks[commitsKey(stage)] || {};
  return !!checks[UNDERSTAND_KEY] && repos.length > 0 && repos.every((r) => commits[r]);
}

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

const DESCRIPTION_MAX = 8000;
const tempFile = (tag, ext) =>
  path.join(os.tmpdir(), `ado-master-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);

/**
 * Pending：在 Requirement 底下建立預設 Task（標題與 Requirement 相同），回傳新 Task（欄位同 children）。
 * Description 透過暫存檔傳給 create_task.py，避免命令列長度 / 換行 / 引號問題。
 */
async function createDefaultTask({ id, description } = {}) {
  if (!Number.isInteger(id) || id <= 0) throw new Error('參數錯誤');
  if (description != null && typeof description !== 'string') throw new Error('參數錯誤');
  description = (description || '').trim();
  if (description.length > DESCRIPTION_MAX) throw new Error(`Description 最多 ${DESCRIPTION_MAX} 字`);
  const descFile = tempFile('desc', 'txt');
  const out = tempFile('task', 'json');
  try {
    await fs.writeFile(descFile, description, 'utf-8');
    await runScript('create_task.py', ['--parent', String(id), '--description-file', descFile, '--out', out]);
    return JSON.parse(await fs.readFile(out, 'utf-8'));
  } finally {
    fs.rm(descFile, { force: true }).catch(() => {});
    fs.rm(out, { force: true }).catch(() => {});
  }
}

/** 點擊 Requirement 狀態 chip 時可更新成的狀態（renderer 依 Task 指派 / Implement / 流程進度決定） */
const SYNC_STATES = ['Active', 'Resolved', 'Closed'];

/** 更新 Requirement 在 ADO 的狀態（update_state.py），回傳更新後的 Work Item（欄位同 requirements，不含 children）。 */
async function updateRequirementStateInAdo({ id, state } = {}) {
  if (!Number.isInteger(id) || id <= 0 || !SYNC_STATES.includes(state)) throw new Error('參數錯誤');
  const out = tempFile('state', 'json');
  try {
    await runScript('update_state.py', ['--id', String(id), '--state', state, '--out', out]);
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

/**
 * 佈版階段：Confirm Commit 的每個 commit 是否已進到該 repository 的環境 branch
 * （app/.env 的 `<REPO>_TEST_BRANCH` / `<REPO>_PROD_BRANCH`）。
 * @returns {{ stage, commits, items: [{ repo, commit, envBranch, merged, canMerge, conflicts, message }], allMerged }}
 */
async function deployMergeStatus({ id, stage, fetch = true } = {}) {
  if (!Number.isInteger(id) || !COMMIT_STAGES.includes(stage)) throw new Error('參數錯誤');
  const checks = (await loadFlowState())[id] || {};
  if (!commitsConfirmed(checks, stage)) throw new Error('請先完成 Confirm Commit');
  const commits = checks[commitsKey(stage)];
  const config = await loadRepoConfig();
  const repos = Object.keys(checks[UNDERSTAND_REPOS_KEY]);
  const targets = repos.map((repo) => {
    const r = config.repos.find((x) => x.key === repo);
    if (!r) throw new Error(`未知的 repository：${repo}`);
    const envBranch = r.deployBranches[stage];
    if (!envBranch) throw new Error(`尚未設定 ${repo} 的環境 branch，請在 app/.env 設定 ${r.deployEnvKeys[stage]}`);
    return { repo, commit: commits[repo], envBranch };
  });
  const items = await Promise.all(targets.map((t) => checkMerged({ ...t, fetch })));
  return { stage, commits, items, allMerged: items.every((x) => x.merged) };
}

/** 把尚未 merge 的 commit 以 merge commit（--no-ff）merge 進環境 branch，回傳最新的 deployMergeStatus。 */
async function mergeDeploy({ id, stage } = {}) {
  const status = await deployMergeStatus({ id, stage });
  const blocked = status.items.filter((x) => !x.merged && !x.canMerge);
  if (blocked.length) throw new Error(blocked.map((x) => `${x.repo}：${x.message}`).join('；'));
  const featureBranches = (await loadFlowState())[id]?.[UNDERSTAND_REPOS_KEY] || {};
  await Promise.all(
    status.items
      .filter((x) => !x.merged)
      .map((x) => {
        const from = featureBranches[x.repo] ? `${featureBranches[x.repo]} (${x.full.slice(0, 10)})` : x.full.slice(0, 10);
        return mergeNoFf({ ...x, message: `Merge ${from} into ${x.envBranch}\n\nRequirement #${id}` });
      })
  );
  return deployMergeStatus({ id, stage, fetch: false });
}

/** 設定某個 Requirement 的一個 checkbox，回傳該 Requirement 更新後的狀態。 */
async function setFlowCheck({ id, key, value } = {}) {
  if (
    !Number.isInteger(id) ||
    typeof key !== 'string' ||
    !/^[\w.]+$/.test(key) ||
    key === UNDERSTAND_KEY ||
    key.endsWith('.commits')
  ) {
    throw new Error('參數錯誤');
  }
  const stage = deployStageOf(key);
  let verifiedCommits = null;
  if (value && stage) {
    // 勾 SaaS / Local 前，commit 必須已進到環境 branch。
    // renderer 勾選前已呼叫 deployMergeStatus（含 git fetch）或 mergeDeploy，這裡不再 fetch，只用本機的 remote 狀態再確認
    const status = await deployMergeStatus({ id, stage, fetch: false });
    const pending = status.items.filter((x) => !x.merged);
    if (pending.length) throw new Error(`尚未 merge 進環境 branch：${pending.map((x) => `${x.repo} → ${x.envBranch}`).join('、')}`);
    verifiedCommits = JSON.stringify(status.commits);
  }
  return updateRequirementState(id, (checks) => {
    if (value && stage) {
      if (!commitsConfirmed(checks, stage)) throw new Error('請先完成 Confirm Commit');
      if (JSON.stringify(checks[commitsKey(stage)]) !== verifiedCommits) throw new Error('Confirm Commit 已變更，請重新勾選');
    }
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

/**
 * Confirm Commit（Test deploy / Prod deploy 佈版前）：manager 填入 Manager understand 所選每個 repository
 * 的測試通過版 commit（縮寫即可），存檔前逐一到 repository 確認 commit 存在。
 *   commits = { crmapp: 'abc1234', ... } → `<stage>.commits`: commits
 *   commits = null → 取消確認（連同該階段已勾的 SaaS / Local 一併清除）
 */
async function setCommits({ id, stage, commits } = {}) {
  if (!Number.isInteger(id) || !COMMIT_STAGES.includes(stage)) throw new Error('參數錯誤');
  if (commits == null) {
    return updateRequirementState(id, (checks) => {
      for (const k of Object.keys(checks)) if (k.startsWith(`${stage}.`)) delete checks[k];
    });
  }
  const current = (await loadFlowState())[id] || {};
  const repos = current[UNDERSTAND_KEY] ? current[UNDERSTAND_REPOS_KEY] || {} : {};
  if (!Object.keys(repos).length) throw new Error('請先完成 Manager understand（選擇要開發的 repository）');
  if (typeof commits !== 'object') throw new Error('參數錯誤');

  const normalized = {};
  for (const repo of Object.keys(repos)) {
    const c = typeof commits[repo] === 'string' ? commits[repo].trim().toLowerCase() : '';
    if (!c) throw new Error(`請填入 ${repo} 的 commit`);
    if (!COMMIT_RE.test(c)) throw new Error(`${repo} 的 commit 格式錯誤（需為 4～40 碼的十六進位 hash）`);
    normalized[repo] = c;
  }
  // 存檔前再確認一次，避免沒按「檢查」或檢查後又修改
  const results = await Promise.all(
    Object.entries(normalized).map(([repo, commit]) => checkCommit({ repo, commit, branch: repos[repo] }))
  );
  const missing = results.filter((r) => !r.ok);
  if (missing.length) throw new Error(missing.map((r) => r.message).join('；'));

  return updateRequirementState(id, (checks) => {
    if (JSON.stringify(checks[UNDERSTAND_REPOS_KEY] || {}) !== JSON.stringify(repos)) {
      throw new Error('Manager understand 的 repository 已變更，請重新開啟後再確認');
    }
    checks[commitsKey(stage)] = normalized;
  });
}

module.exports = {
  fetchRequirementFlow,
  createDefaultTask,
  updateRequirementStateInAdo,
  loadFlowState,
  setFlowCheck,
  setUnderstand,
  setCommits,
  deployMergeStatus,
  mergeDeploy,
};
