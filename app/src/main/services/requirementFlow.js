const fs = require('node:fs/promises');
const path = require('node:path');
const { FLOW_STATE_FILE } = require('../paths');
const { runScriptJson, tempFile, removeTemp } = require('../python');
const { REPOS, loadRepoConfig } = require('./repoConfig');
const { checkCommit, checkMerged, mergeNoFf } = require('./gitCommit');
const {
  UNDERSTAND_KEY,
  UNDERSTAND_REPOS_KEY,
  UNDERSTAND_MIGRATION_KEY,
  UNDERSTAND_NOTE_KEY,
  UNDERSTAND_KEYS,
  COMMIT_STAGES,
  COMMIT_RE,
  COMMIT_FORMAT_HINT,
  commitsKey,
  commitsForcedKey,
  commitsCover,
  commitsConfirmed,
} = require('../../shared/flow-rules.js');

const NOTE_MAX = 2000;
const deployStageOf = (key) => COMMIT_STAGES.find((s) => key.startsWith(`${s}.`));

/** 執行 get_requirement_flow.py 取得指定 Iteration 的 Requirement 與其子項目。 */
async function fetchRequirementFlow({ iterationPath, exact } = {}) {
  if (typeof iterationPath !== 'string' || !iterationPath) throw new Error('缺少 iterationPath');
  const args = ['--iteration', iterationPath];
  if (exact) args.push('--exact');
  return runScriptJson('get_requirement_flow.py', args);
}

const DESCRIPTION_MAX = 8000;

/**
 * Pending：在 Requirement 底下建立預設 Task（標題與 Requirement 相同），回傳新 Task（欄位同 children）。
 * Description 透過暫存檔傳給 create_task.py，避免命令列長度 / 換行 / 引號問題。
 */
async function createDefaultTask({ id, description } = {}) {
  if (!Number.isInteger(id) || id <= 0) throw new Error('參數錯誤');
  if (description != null && typeof description !== 'string') throw new Error('參數錯誤');
  description = (description || '').trim();
  if (description.length > DESCRIPTION_MAX) throw new Error(`Description 最多 ${DESCRIPTION_MAX} 字`);
  const descFile = tempFile('txt');
  try {
    await fs.writeFile(descFile, description, 'utf-8');
    return await runScriptJson('create_task.py', ['--parent', String(id), '--description-file', descFile]);
  } finally {
    removeTemp(descFile);
  }
}

/** 點擊 Requirement 狀態 chip 時可更新成的狀態（renderer 依 Task 指派 / Implement / 流程進度決定） */
const SYNC_STATES = ['Active', 'Resolved', 'Closed'];

/** 更新 Requirement 在 ADO 的狀態（update_state.py），回傳更新後的 Work Item（欄位同 requirements，不含 children）。 */
async function updateRequirementStateInAdo({ id, state } = {}) {
  if (!Number.isInteger(id) || id <= 0 || !SYNC_STATES.includes(state)) throw new Error('參數錯誤');
  return runScriptJson('update_state.py', ['--id', String(id), '--state', state]);
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

/** 先寫到同資料夾的暫存檔再 rename 覆蓋：寫到一半中斷也不會留下壞掉的 JSON */
async function writeFileAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, text, 'utf-8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
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
    await writeFileAtomic(FLOW_STATE_FILE, JSON.stringify(state, null, 2));
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
  const repos = Object.keys(checks[UNDERSTAND_REPOS_KEY] || {});
  const commits = checks[commitsKey(stage)] || {};
  // 不需修改 repository（Confirm Commit 自動完成），或跳階段勾起 Confirm Commit 而沒有 commit 可檢查
  if (!repos.length || !checks[UNDERSTAND_KEY] || !commitsCover(checks, stage)) {
    return { stage, commits, items: [], allMerged: true };
  }
  const config = await loadRepoConfig();
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

/**
 * 設定某個 Requirement 的一個 checkbox，回傳該 Requirement 更新後的狀態。
 * force = true：跳階段勾選（renderer 已跟使用者確認），不做 merge 檢查等一般勾選的邏輯，只變更勾選狀態。
 *   此時另外允許：
 *   - `understand`：勾起只設 understand: true；取消則連同 repository / migration / 註解一併清除
 *   - `<stage>.commitsForced`：直接勾起 Confirm Commit；取消則清除該階段的 commit 與 SaaS / Local
 */
async function setFlowCheck({ id, key, value, force = false } = {}) {
  if (!Number.isInteger(id) || typeof key !== 'string' || !/^[\w.]+$/.test(key)) throw new Error('參數錯誤');
  const forcedStage = COMMIT_STAGES.find((s) => key === commitsForcedKey(s));
  if (force && (key === UNDERSTAND_KEY || forcedStage)) {
    return updateRequirementState(id, (checks) => {
      if (key === UNDERSTAND_KEY) {
        if (value) checks[UNDERSTAND_KEY] = true;
        else for (const k of UNDERSTAND_KEYS) delete checks[k];
      } else if (value) {
        checks[key] = true;
      } else {
        for (const k of Object.keys(checks)) if (k.startsWith(`${forcedStage}.`)) delete checks[k];
      }
    });
  }
  if (key.startsWith(UNDERSTAND_KEY) || key.endsWith('.commits') || forcedStage) throw new Error('參數錯誤');
  if (force) {
    return updateRequirementState(id, (checks) => {
      if (value) checks[key] = true;
      else delete checks[key];
    });
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
      if (JSON.stringify(checks[commitsKey(stage)] || {}) !== verifiedCommits) throw new Error('Confirm Commit 已變更，請重新勾選');
    }
    if (value) checks[key] = true;
    else delete checks[key];
  });
}

/**
 * Manager understand：確認此需求要在哪些 repository 開發、各自的 feature branch。
 *   repos = { crmapp: 'feature/x', upagent: 'feature/y' } → understand: true、understandRepos: repos
 *   repos = {} → understand: true、understandRepos: {}（不需修改 repository，Confirm Commit 自動完成）
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
    if (typeof repos !== 'object') return Promise.reject(new Error('參數錯誤'));
    // 可以不選任何 repository（例如只需調整 database 資料），此時 Confirm Commit 自動完成
    const entries = Object.entries(repos);
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
      for (const k of UNDERSTAND_KEYS) delete checks[k];
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
  if (!current[UNDERSTAND_KEY]) throw new Error('請先完成 Manager understand');
  if (!Object.keys(repos).length) throw new Error('Manager understand 未選擇 repository，不需要 Confirm Commit');
  if (typeof commits !== 'object') throw new Error('參數錯誤');

  const normalized = {};
  for (const repo of Object.keys(repos)) {
    const c = typeof commits[repo] === 'string' ? commits[repo].trim().toLowerCase() : '';
    if (!c) throw new Error(`請填入 ${repo} 的 commit`);
    if (!COMMIT_RE.test(c)) throw new Error(`${repo} 的 commit 格式錯誤（${COMMIT_FORMAT_HINT}）`);
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
    delete checks[commitsForcedKey(stage)]; // 已填入實際 commit，不再是跳階段勾起
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
