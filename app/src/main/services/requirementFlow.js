const fs = require('node:fs/promises');
const { runScriptJson, tempFile, removeTemp } = require('../python');
const { loadFlowState, updateRequirementState } = require('./flowState');
const { loadRepoConfig, fieldHint, DEPLOY_BRANCH_FIELDS } = require('./repoConfig');
const { checkCommit } = require('./gitCommit');
const { checkDeployMerge, mergeViaFeature, mergeBackToFeatures } = require('./deployMerge');
const { releaseVersionFor, dropStaleRelease } = require('./upagentRelease');
const {
  PLAN_KEY,
  PLAN_REPOS_KEY,
  PLAN_MIGRATION_KEY,
  PLAN_NOTE_KEY,
  PLAN_KEYS,
  TEST_RECORD_KEY,
  UPAGENT_RELEASE_KEY,
  UPAGENT_RELEASE_HISTORY_KEY,
  COMMIT_STAGES,
  COMMIT_RE,
  COMMIT_FORMAT_HINT,
  commitsKey,
  commitsForcedKey,
  commitsCover,
  commitsConfirmed,
  upagentReleasePlan,
  releaseTargetOf,
  UPAGENT_REPO,
  DEPLOY_ENV,
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

/**
 * 更新 Requirement 在 ADO 的狀態（update_state.py），回傳更新後的 Work Item（欄位同 requirements，不含 children）。
 * 改成 Closed 時先把底下的子 Task 也都 Closed（--close-child-tasks），結果另含 closedTasks: [這次關閉的子 Task]；
 * 任何子 Task 失敗則 Requirement 不會被更新（已關閉的子 Task 不還原，再點一次會略過）。
 */
async function updateRequirementStateInAdo({ id, state } = {}) {
  if (!Number.isInteger(id) || id <= 0 || !SYNC_STATES.includes(state)) throw new Error('參數錯誤');
  const args = ['--id', String(id), '--state', state];
  if (state === 'Closed') args.push('--close-child-tasks');
  return runScriptJson('update_state.py', args);
}

/**
 * 佈版階段：Confirm Commit 的每個 commit 是否已（經由 feature branch）進到該 repository 的環境 branch
 * （data/config.json 的 repos 的 `testBranch` / `prodBranch`）。見 deployMerge.checkDeployMerge：
 *   一般 repository：開發 branch 的 commit → 規劃的 feature branch → 環境 branch，不直接 merge 進環境 branch。
 *   upagent（需要 UpAgent 發佈）：已有版號（自己的或可沿用的已發佈版本）→ 把版本 tag 的 commit merge 進環境 branch；
 *     還沒有版號 → deferred：由 UpAgent 發佈先 merge 進 feature branch、更版後再 merge 進環境 branch。
 * @returns {{ stage, commits, items: [checkDeployMerge 的結果], allMerged }}
 *   allMerged：都已 merge（deferred 的交給 UpAgent 發佈，不擋這一步；勾選時 setFlowCheck 仍要求真的已 merge）
 */
async function deployMergeStatus({ id, stage, fetch = true } = {}) {
  if (!Number.isInteger(id) || !COMMIT_STAGES.includes(stage)) throw new Error('參數錯誤');
  const checks = (await loadFlowState())[id] || {};
  if (!commitsConfirmed(checks, stage)) throw new Error('請先完成 Confirm Commit');
  const featureBranches = checks[PLAN_REPOS_KEY] || {};
  const repos = Object.keys(featureBranches);
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
    return { repo, commit: commits[repo], featureBranch: featureBranches[repo], envBranch };
  });
  const items = await Promise.all(
    targets.map(async (t) => {
      if (t.repo === UPAGENT_REPO && DEPLOY_ENV[stage]) {
        const version = await releaseVersionFor(id, stage);
        return checkDeployMerge({ ...t, fetch, ...(version ? { source: `v${version}` } : { deferred: true }) });
      }
      return checkDeployMerge({ ...t, fetch });
    })
  );
  return { stage, commits, items, allMerged: items.every((x) => x.merged || x.deferred) };
}

/** 反向 merge 回 feature branch 的階段：正式環境 merge 完後，feature branch 都要以 production 為基礎 */
const MERGE_BACK_STAGE = 'prodDeploy';

/**
 * 正式環境：把這次有 merge 進 prodBranch 的 repository，再把 prodBranch 反向 merge 回其所有 feature branch。
 * 不丟錯（正式環境已 push），失敗記在結果裡。
 * @returns {{ [repo]: [{ branch, state, message, mergeCommit? }] }}
 */
async function mergeBack(id, merged) {
  const entries = await Promise.all(
    merged.map(async (v) => {
      try {
        return [v.repo, (await mergeBackToFeatures({ repo: v.repo, fromBranch: v.envBranch, reqId: id })).items];
      } catch (err) {
        return [v.repo, [{ branch: '', state: 'failed', message: `反向 merge 回 feature branch 失敗：${err.message}` }]];
      }
    })
  );
  return Object.fromEntries(entries);
}

const BACK_MERGE_PROBLEM = new Set(['conflict', 'failed']);

/** 錯誤訊息用：反向 merge 有問題的 branch */
function backMergeProblems(backMerges) {
  return Object.entries(backMerges).flatMap(([repo, items]) =>
    items.filter((x) => BACK_MERGE_PROBLEM.has(x.state)).map((x) => `${repo}${x.branch ? ` ${x.branch}` : ''}：${x.message}`)
  );
}

/**
 * 把尚未 merge 的 commit 經由 feature branch merge 進環境 branch（deployMerge.mergeViaFeature：不在 feature branch 時先 merge 進去，
 * 一律建立 merge commit（--no-ff））；upagent 則是 merge 版本 tag；deferred（UpAgent 尚未更版）的略過，由 UpAgent 發佈處理。
 * 回傳最新的 deployMergeStatus，另加 mergeCommits: { repo: 這次 push 的 merge commit }。
 * Prod deploy：merge 進 prodBranch 之後，再把 prodBranch 反向 merge 回該 repository 的所有 feature branch
 * （一律建立 merge commit），結果放在 backMerges: { repo: [{ branch, state, message, mergeCommit? }] }。
 */
async function mergeDeploy({ id, stage } = {}) {
  const status = await deployMergeStatus({ id, stage });
  const blocked = status.items.filter((x) => !x.merged && !x.canMerge);
  if (blocked.length) throw new Error(blocked.map((x) => `${x.repo}：${x.message}`).join('；'));
  const results = await Promise.allSettled(
    status.items
      .filter((x) => !x.merged && !x.deferred)
      .map((x) =>
        mergeViaFeature({
          repo: x.repo,
          commit: x.commit,
          featureBranch: x.featureBranch,
          envBranch: x.envBranch,
          source: x.sourceRef,
          reqId: id,
          fetch: false, // 上面的 deployMergeStatus 剛 fetch 過
        })
      )
  );
  const merged = results.filter((r) => r.status === 'fulfilled' && r.value.mergeCommit).map((r) => r.value);
  // 已 merge 進 prodBranch 的 repository 先反向 merge 回 feature branch，即使其他 repository 失敗也照做
  const backMerges = stage === MERGE_BACK_STAGE && merged.length ? await mergeBack(id, merged) : {};
  // 等全部做完再回報失敗：已 push 成功的 repository 不會因為另一個失敗而被漏掉
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    const problems = backMergeProblems(backMerges);
    throw new Error(
      failed.map((r) => r.reason?.message || r.reason).join('；') +
        (problems.length ? `（另外反向 merge 回 feature branch 有問題：${problems.join('；')}）` : '')
    );
  }
  const mergeCommits = Object.fromEntries(merged.map((v) => [v.repo, v.mergeCommit]));
  return { ...(await deployMergeStatus({ id, stage, fetch: false })), mergeCommits, backMerges };
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
  if (key.startsWith(PLAN_KEY) || key.endsWith('.commits') || key.endsWith('.localDeploy') || forcedStage || key === TEST_RECORD_KEY || key === UPAGENT_RELEASE_KEY || key === UPAGENT_RELEASE_HISTORY_KEY) throw new Error('參數錯誤');
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
    if (status.items.some((x) => x.deferred)) throw new Error('請先完成 UpAgent 發佈（更版後才會 merge 進環境 branch）');
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
      if (!validKeys.has(k)) throw new Error(`未知的 repository：${k}（不在 data/config.json 的 repos 中）`);
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

  const saved = await updateRequirementState(id, (checks) => {
    if (JSON.stringify(checks[PLAN_REPOS_KEY] || {}) !== JSON.stringify(repos)) {
      throw new Error('規劃的 repository 已變更，請重新開啟後再確認');
    }
    checks[commitsKey(stage)] = normalized;
    delete checks[commitsForcedKey(stage)]; // 已填入實際 commit，不再是跳階段勾起
  });
  // upagent 的 Confirm Commit 不在已發佈的版本中：作廢舊的發佈紀錄，勾 SaaS / Local 時重新更版
  return (await dropStaleRelease(id, stage)) || saved;
}

module.exports = {
  fetchRequirementFlow,
  createDefaultTask,
  updateRequirementStateInAdo,
  setFlowCheck,
  setPlan,
  setCommits,
  deployMergeStatus,
  mergeDeploy,
};
