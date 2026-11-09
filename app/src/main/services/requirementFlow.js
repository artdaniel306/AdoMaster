const fs = require('node:fs/promises');
const path = require('node:path');
const { FLOW_STATE_FILE } = require('../paths');
const { runScriptJson, tempFile, removeTemp } = require('../python');
const { loadRepoConfig, fieldHint, DEPLOY_BRANCH_FIELDS } = require('./repoConfig');
const { checkCommit, checkMerged, mergeNoFf } = require('./gitCommit');
const {
  PLAN_KEY,
  PLAN_REPOS_KEY,
  PLAN_MIGRATION_KEY,
  PLAN_NOTE_KEY,
  PLAN_KEYS,
  TEST_RECORD_KEY,
  UPAGENT_RELEASE_KEY,
  COMMIT_STAGES,
  COMMIT_RE,
  COMMIT_FORMAT_HINT,
  commitsKey,
  commitsForcedKey,
  commitsCover,
  commitsConfirmed,
  upagentReleasePlan,
  releaseTargetOf,
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

/** 舊版（「Manager understand」時期）存的 key → 現在的 key */
const LEGACY_KEYS = {
  understand: PLAN_KEY,
  understandRepos: PLAN_REPOS_KEY,
  understandMigration: PLAN_MIGRATION_KEY,
  understandNote: PLAN_NOTE_KEY,
};

/** 讀檔時把舊 key 轉成新 key（下次寫入時就會以新 key 存回；匯入舊版匯出的檔案也適用） */
function migrateLegacyKeys(state) {
  for (const checks of Object.values(state || {})) {
    if (!checks || typeof checks !== 'object') continue;
    for (const [oldKey, newKey] of Object.entries(LEGACY_KEYS)) {
      if (!(oldKey in checks)) continue;
      if (!(newKey in checks)) checks[newKey] = checks[oldKey];
      delete checks[oldKey];
    }
  }
  return state;
}

/**
 * 流程中尚未串接 ADO 的人工步驟（規劃、佈版、測試、發表會…）先以 checkbox 記錄在本機：
 * data/requirement_flow_state.json → { "<requirementId>": { "<checkKey>": true, ... } }
 */
async function loadFlowState() {
  try {
    return migrateLegacyKeys(JSON.parse(await fs.readFile(FLOW_STATE_FILE, 'utf-8')));
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

/** 整份覆蓋流程狀態檔（匯入本地資料用）；同樣排進 writeQueue，不會和勾選的寫入互相覆蓋。 */
function replaceFlowState(text) {
  JSON.parse(text); // 不是合法 JSON 就直接丟錯，不寫入
  const task = writeQueue.then(() => writeFileAtomic(FLOW_STATE_FILE, text));
  writeQueue = task.catch(() => {});
  return task;
}

/**
 * 佈版階段：Confirm Commit 的每個 commit 是否已進到該 repository 的環境 branch
 * （data/repos.json 的 `testBranch` / `prodBranch`）。
 * @returns {{ stage, commits, items: [{ repo, commit, envBranch, merged, canMerge, conflicts, message }], allMerged }}
 */
async function deployMergeStatus({ id, stage, fetch = true } = {}) {
  if (!Number.isInteger(id) || !COMMIT_STAGES.includes(stage)) throw new Error('參數錯誤');
  const checks = (await loadFlowState())[id] || {};
  if (!commitsConfirmed(checks, stage)) throw new Error('請先完成 Confirm Commit');
  const repos = Object.keys(checks[PLAN_REPOS_KEY] || {});
  const commits = checks[commitsKey(stage)] || {};
  // 不需修改 repository（Confirm Commit 自動完成），或跳階段勾起 Confirm Commit 而沒有 commit 可檢查
  if (!repos.length || !checks[PLAN_KEY] || !commitsCover(checks, stage)) {
    return { stage, commits, items: [], allMerged: true };
  }
  const config = await loadRepoConfig();
  const targets = repos.map((repo) => {
    const r = config.repos.find((x) => x.key === repo);
    if (!r) throw new Error(`未知的 repository：${repo}`);
    const envBranch = r.deployBranches[stage];
    if (!envBranch) throw new Error(`尚未設定 ${repo} 的環境 branch，請在 ${fieldHint(repo, DEPLOY_BRANCH_FIELDS[stage])} 設定`);
    return { repo, commit: commits[repo], envBranch };
  });
  const items = await Promise.all(targets.map((t) => checkMerged({ ...t, fetch })));
  return { stage, commits, items, allMerged: items.every((x) => x.merged) };
}

/**
 * 把尚未 merge 的 commit 以 merge commit（--no-ff）merge 進環境 branch，
 * 回傳最新的 deployMergeStatus，另加 mergeCommits: { repo: 這次 push 的 merge commit }。
 */
async function mergeDeploy({ id, stage } = {}) {
  const status = await deployMergeStatus({ id, stage });
  const blocked = status.items.filter((x) => !x.merged && !x.canMerge);
  if (blocked.length) throw new Error(blocked.map((x) => `${x.repo}：${x.message}`).join('；'));
  const featureBranches = (await loadFlowState())[id]?.[PLAN_REPOS_KEY] || {};
  const results = await Promise.allSettled(
    status.items
      .filter((x) => !x.merged)
      .map((x) => {
        const from = featureBranches[x.repo] ? `${featureBranches[x.repo]} (${x.full.slice(0, 10)})` : x.full.slice(0, 10);
        return mergeNoFf({ ...x, message: `Merge ${from} into ${x.envBranch}\n\nRequirement #${id}` });
      })
  );
  // 等全部做完再回報失敗：已 push 成功的 repository 不會因為另一個失敗而被漏掉
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) throw new Error(failed.map((r) => r.reason?.message || r.reason).join('；'));
  const mergeCommits = Object.fromEntries(
    results.map((r) => r.value).filter((v) => v.mergeCommit).map((v) => [v.repo, v.mergeCommit])
  );
  return { ...(await deployMergeStatus({ id, stage, fetch: false })), mergeCommits };
}

/**
 * 設定某個 Requirement 的一個 checkbox，回傳該 Requirement 更新後的狀態。
 * force = true：跳階段勾選（renderer 已跟使用者確認），不做 merge 檢查等一般勾選的邏輯，只變更勾選狀態。
 *   此時另外允許：
 *   - `plan`：勾起只設 plan: true；取消則連同 repository / migration / 註解一併清除
 *   - `<stage>.commitsForced`：直接勾起 Confirm Commit；取消則清除該階段的 commit 與 SaaS / Local
 */
async function setFlowCheck({ id, key, value, force = false } = {}) {
  if (!Number.isInteger(id) || typeof key !== 'string' || !/^[\w.]+$/.test(key)) throw new Error('參數錯誤');
  const forcedStage = COMMIT_STAGES.find((s) => key === commitsForcedKey(s));
  if (force && (key === PLAN_KEY || forcedStage)) {
    return updateRequirementState(id, (checks) => {
      if (key === PLAN_KEY) {
        if (value) checks[PLAN_KEY] = true;
        else for (const k of PLAN_KEYS) delete checks[k];
      } else if (value) {
        checks[key] = true;
      } else {
        for (const k of Object.keys(checks)) if (k.startsWith(`${forcedStage}.`)) delete checks[k];
      }
    });
  }
  if (key.startsWith(PLAN_KEY) || key.endsWith('.commits') || forcedStage || key === TEST_RECORD_KEY || key === UPAGENT_RELEASE_KEY) throw new Error('參數錯誤');
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
      // 規劃含 upagent：要先完成 UpAgent 發佈（含寫入此環境 SaaS / Local 的資料庫）
      if (upagentReleasePlan(checks, stage, releaseTargetOf(key))) throw new Error('請先完成 UpAgent 發佈');
    }
    if (value) checks[key] = true;
    else delete checks[key];
  });
}

/**
 * 規劃：確認此需求要在哪些 repository 開發、各自的 feature branch。
 *   repos = { crmapp: 'feature/x', upagent: 'feature/y' } → plan: true、planRepos: repos
 *   repos = {} → plan: true、planRepos: {}（不需修改 repository，Confirm Commit 自動完成）
 *   migration = true → planMigration: true（需要 migration）
 *   note = '...'     → planNote: '...'（manager 的註解，空白則不存）
 *   repos = null → 取消確認（全部清除）
 */
async function setPlan({ id, repos, migration, note } = {}) {
  if (!Number.isInteger(id)) throw new Error('參數錯誤');
  if (note != null && typeof note !== 'string') throw new Error('參數錯誤');
  note = (note || '').trim();
  if (note.length > NOTE_MAX) throw new Error(`註解最多 ${NOTE_MAX} 字`);
  if (repos != null) {
    if (typeof repos !== 'object') throw new Error('參數錯誤');
    const validKeys = new Set((await loadRepoConfig()).repos.map((r) => r.key));
    // 可以不選任何 repository（例如只需調整 database 資料），此時 Confirm Commit 自動完成
    const entries = Object.entries(repos);
    for (const [k, branch] of entries) {
      if (!validKeys.has(k)) throw new Error(`未知的 repository：${k}（不在 data/repos.json 中）`);
      if (typeof branch !== 'string' || !branch.trim()) throw new Error(`${k} 尚未選擇 feature branch`);
    }
    repos = Object.fromEntries(entries.map(([k, b]) => [k, b.trim()]));
  }
  return updateRequirementState(id, (checks) => {
    if (repos) {
      checks[PLAN_KEY] = true;
      checks[PLAN_REPOS_KEY] = repos;
      if (migration === true) checks[PLAN_MIGRATION_KEY] = true;
      else delete checks[PLAN_MIGRATION_KEY];
      if (note) checks[PLAN_NOTE_KEY] = note;
      else delete checks[PLAN_NOTE_KEY];
    } else {
      for (const k of PLAN_KEYS) delete checks[k];
    }
  });
}

/**
 * Confirm Commit（Test deploy / Prod deploy 佈版前）：manager 填入 規劃 所選每個 repository
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
  const repos = current[PLAN_KEY] ? current[PLAN_REPOS_KEY] || {} : {};
  if (!current[PLAN_KEY]) throw new Error('請先完成規劃');
  if (!Object.keys(repos).length) throw new Error('規劃未選擇 repository，不需要 Confirm Commit');
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
    if (JSON.stringify(checks[PLAN_REPOS_KEY] || {}) !== JSON.stringify(repos)) {
      throw new Error('規劃的 repository 已變更，請重新開啟後再確認');
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
  replaceFlowState,
  writeFileAtomic,
  updateRequirementState,
  setFlowCheck,
  setPlan,
  setCommits,
  deployMergeStatus,
  mergeDeploy,
};
