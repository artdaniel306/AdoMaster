const { CONFIG_FILE, ENV_FILE } = require('../paths');
const { readConfig } = require('./appConfig');
const { runPowerShellJson } = require('../powershell');
const { loadRepoConfig, fieldHint, DEPLOY_BRANCH_FIELDS } = require('./repoConfig');
const { loadFlowState, updateRequirementState, updateFlowState } = require('./flowState');
const { git, mergeNoFf, mergeViaFeature, mergeBackToFeatures } = require('./gitCommit');
const {
  COMMIT_STAGES,
  PLAN_REPOS_KEY,
  commitsKey,
  UPAGENT_REPO,
  UPAGENT_RELEASE_KEY,
  RELEASE_STEPS,
  RELEASE_TARGETS,
  RELEASE_DB_LABEL,
  RELEASE_ENV,
  releaseDbKey,
  needsUpagentRelease,
  upagentReleasePlan,
} = require('../../shared/flow-rules.js');

/**
 * UpAgent 發佈：規劃選了 upagent 的 Requirement，在測試 / 正式環境佈版勾 SaaS / Local 前執行 shell/Release-UpAgent.ps1。
 * SaaS / Local 各有自己的資料庫（測試 / 正式 × SaaS / Local 共 4 組連線，-Environment + -Target 決定寫哪一個）。
 * 進度（版號、最後完成的步驟、各資料庫寫入時間）記在流程狀態的 upagentRelease，
 * 所以中途失敗可以從失敗的步驟接續；已上傳過 Blob 後，其他環境 / 勾選只需寫入資料庫（-StartFrom Database）。
 *
 * 版本是共用的：同一個 feature branch 上的多張 Requirement，只要 Confirm Commit 已包含在某個已發佈（已上傳 Blob）的版本 tag 中，
 * 就沿用該版本（adoptedFrom = 發佈它的 Requirement），不再 Bump；各資料庫的寫入紀錄（db）也同步到同版本的所有 Requirement，
 * 避免同一個版本被重複寫入同一個資料庫。
 *
 * 一次只能執行一個發佈（整個 app 共用）。腳本的 stdout 即時以 'upagentRelease:log' 事件送給 renderer。
 */

const REMARK_MAX = 500;
const MARKER_RE = /^::(version|step|done|error)::(.*)$/;

/** 目前執行中的發佈：{ id, stage, target, controller }（手動佈版的 id 為 null） */
let running = null;

const releaseOf = (checks) => checks[UPAGENT_RELEASE_KEY] || {};
const validParams = (id, stage, target) => Number.isInteger(id) && COMMIT_STAGES.includes(stage) && RELEASE_TARGETS.includes(target);

const VERSION_RE = /^\d+\.\d+\.\d+$/;
/** 已上傳 Blob（completed 至少到 Publish）才算已發佈 */
const isPublished = (rel) => VERSION_RE.test(rel?.version || '') && RELEASE_STEPS.indexOf(rel.completed) >= RELEASE_STEPS.indexOf('Publish');
const compareVersion = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** 整份流程狀態中已發佈的版本：version → { from: 發佈它的 Requirement id, rel, db: 同版本所有紀錄的 db 聯集 } */
function publishedVersions(state) {
  const map = new Map();
  for (const [rid, checks] of Object.entries(state)) {
    const rel = checks?.[UPAGENT_RELEASE_KEY];
    if (!VERSION_RE.test(rel?.version || '')) continue;
    const entry = map.get(rel.version) || { db: {} };
    Object.assign(entry.db, rel.db);
    // 以實際發佈（非沿用）的紀錄為來源
    if (isPublished(rel) && !rel.adoptedFrom && !entry.rel) Object.assign(entry, { from: Number(rid), rel });
    map.set(rel.version, entry);
  }
  for (const [version, entry] of map) if (!entry.rel) map.delete(version);
  return map;
}

/**
 * 這張 Requirement 還沒有自己的發佈紀錄、但此階段 Confirm Commit 的 upagent commit 已包含在某個已發佈版本的 tag（v<版號>）中時，
 * 回傳最新的那個版本（{ version, from, rel, db }）；否則（或 git 查不到）回傳 null。
 */
async function findCoveringRelease(state, id, stage) {
  const checks = state[id] || {};
  if (!RELEASE_ENV[stage] || !needsUpagentRelease(checks) || releaseOf(checks).version) return null;
  const commit = checks[commitsKey(stage)]?.[UPAGENT_REPO];
  if (!commit) return null;
  const published = publishedVersions(state);
  if (!published.size) return null;
  const repo = (await loadRepoConfig()).repos.find((r) => r.key === UPAGENT_REPO);
  if (!repo?.path) return null;
  let tags;
  try {
    const out = await git(repo.path, ['tag', '--list', 'v*', '--contains', commit]);
    tags = new Set(out.split(/\r?\n/).map((t) => t.trim()));
  } catch {
    return null; // 本機找不到 commit 等：照原本的流程（從 Bump 開始，腳本會再檢查）
  }
  const version = [...published.keys()].filter((v) => tags.has(`v${v}`)).sort(compareVersion).pop();
  return version ? { version, ...published.get(version) } : null;
}

/**
 * Confirm Commit 已包含在已發佈的版本中：把該版本記成這張 Requirement 的發佈紀錄（沿用，不再 Bump），回傳更新後的狀態；
 * 不需沿用時回傳 null。
 */
async function adoptPublishedRelease(id, stage) {
  const found = await findCoveringRelease(await loadFlowState(), id, stage);
  if (!found) return null;
  const { version, from, rel, db } = found;
  return updateRequirementState(id, (checks) => {
    if (releaseOf(checks).version) return; // 期間已有自己的紀錄
    checks[UPAGENT_RELEASE_KEY] = {
      version,
      bump: rel.bump,
      remark: rel.remark,
      completed: rel.completed,
      publishedAt: rel.publishedAt,
      db: { ...db },
      adoptedFrom: from,
    };
  });
}

/**
 * 佈版 merge 用（requirementFlow.deployMergeStatus）：這張 Requirement 在此階段要 merge 進環境 branch 的 UpAgent 版號——
 * 自己的發佈紀錄的版號，或 Confirm Commit 已包含在其中的已發佈版本（只查詢，不寫入沿用紀錄）；都沒有（尚未更版）時回傳 ''。
 */
async function releaseVersionFor(id, stage) {
  const state = await loadFlowState();
  const own = releaseOf(state[id] || {}).version;
  if (own) return own;
  return (await findCoveringRelease(state, id, stage))?.version || '';
}

/** 某個資料庫寫入完成：記到這張 Requirement 及所有同版本的紀錄 */
function markDbWritten(id, db, at) {
  return updateFlowState((state) => {
    const version = state[id]?.[UPAGENT_RELEASE_KEY]?.version;
    for (const [rid, checks] of Object.entries(state)) {
      const rel = checks?.[UPAGENT_RELEASE_KEY];
      if (!rel || (String(rid) !== String(id) && (!version || rel.version !== version))) continue;
      checks[UPAGENT_RELEASE_KEY] = { ...rel, db: { ...rel.db, [db]: at } };
    }
  });
}

/** 更新某個 Requirement 的 upagentRelease（排進流程狀態的寫入佇列） */
function updateRelease(id, mutate) {
  return updateRequirementState(id, (checks) => {
    const rel = { ...releaseOf(checks) };
    mutate(rel);
    checks[UPAGENT_RELEASE_KEY] = rel;
  });
}

/**
 * 勾 SaaS / Local（target = 'saas' | 'local'）前查詢：要不要執行 UpAgent 發佈、從哪一步開始。
 * Confirm Commit 已包含在已發佈的版本中時，會先沿用該版本（寫入流程狀態），此時另回傳 checks（該 Requirement 更新後的狀態）。
 * @returns {{ plan: null | { env, target, db, startFrom, version }, release, configExists, running, checks? }}
 */
async function releaseStatus({ id, stage, target } = {}) {
  if (!validParams(id, stage, target)) throw new Error('參數錯誤');
  const adopted = running ? null : await adoptPublishedRelease(id, stage);
  const checks = adopted || (await loadFlowState())[id] || {};
  return {
    ...(adopted && { checks: adopted }),
    plan: upagentReleasePlan(checks, stage, target),
    release: releaseOf(checks),
    configExists: await releaseConfigExists(), // 機密（.env）由腳本檢查
    running: running && { id: running.id, stage: running.stage, target: running.target, label: ownerLabel(running) },
  };
}

/**
 * 執行 UpAgent 發佈，完成後回傳該 Requirement 更新後的狀態。
 * @param send (channel, payload) => void，送進度給 renderer
 * @param bump 'minor' | 'patch'（從 Bump 開始時必填）
 * @param remark 寫入資料庫的備註（第一次執行時記下，之後的環境沿用；有傳則更新）
 * @param rerunAction true = 先重跑整個 GitHub workflow run（只能在從 WaitAction 接續時使用）
 */
async function runRelease(send, { id, stage, target, bump, remark, rerunAction = false } = {}) {
  if (!validParams(id, stage, target)) throw new Error('參數錯誤');
  if (remark != null && typeof remark !== 'string') throw new Error('參數錯誤');
  if (running) throw new Error(`已有 UpAgent 發佈進行中：${ownerLabel(running)}`);

  const checks = (await adoptPublishedRelease(id, stage)) || (await loadFlowState())[id] || {};
  const plan = upagentReleasePlan(checks, stage, target);
  if (!plan) return checks; // 例如沿用已發佈的版本後，此資料庫已寫入過
  if (running) throw new Error(`已有 UpAgent 發佈進行中：${ownerLabel(running)}`);
  if (plan.startFrom === 'Bump' && !['minor', 'patch'].includes(bump)) throw new Error('請選擇版號遞增方式（minor / patch）');
  remark = (remark ?? releaseOf(checks).remark ?? '').trim();
  if (remark.length > REMARK_MAX) throw new Error(`備註最多 ${REMARK_MAX} 字`);

  const repo = (await loadRepoConfig()).repos.find((r) => r.key === UPAGENT_REPO);
  if (!repo?.path) throw new Error(`尚未設定 upagent 的本機路徑，請在 ${fieldHint(UPAGENT_REPO, 'path')} 設定`);

  const args = ['-Environment', plan.env, '-Target', plan.target, '-UpagentDir', repo.path, '-StartFrom', plan.startFrom, '-ConfigPath', CONFIG_FILE, '-EnvPath', ENV_FILE];
  const featureBranch = checks[PLAN_REPOS_KEY]?.[UPAGENT_REPO];
  const confirmCommit = checks[commitsKey(stage)]?.[UPAGENT_REPO];
  if (plan.startFrom === 'Bump') {
    // 從規劃選的 upagent feature branch 建版；Confirm Commit 會先 merge 進 feature branch（before），腳本再確認它已在其中
    if (!featureBranch) throw new Error('規劃未選擇 upagent 的 feature branch');
    args.push('-Bump', bump, '-Branch', featureBranch);
    if (confirmCommit) args.push('-ExpectedCommit', confirmCommit);
  } else {
    args.push('-Version', plan.version);
  }
  if (remark) args.push('-Remark', remark);
  if (rerunAction) {
    if (plan.startFrom !== 'WaitAction') throw new Error('只有從「等待 GitHub Action」接續時才能重跑 GitHub Action');
    args.push('-RerunAction');
  }

  const log = (line) => send('upagentRelease:log', { id, stage, line });
  let version = plan.version || '';
  // 依腳本輸出的標記即時存進度：app 中途關閉 / 腳本失敗時，下次仍能從正確的步驟接續
  let saving = Promise.resolve();
  const queue = (fn) => {
    saving = saving.then(fn).catch((err) => log(`⚠ 儲存發佈進度失敗：${err.message}`));
  };
  const save = (mutate) => queue(() => updateRelease(id, mutate));
  function onMarker(kind, value) {
    if (kind === 'version' && /^\d+\.\d+\.\d+$/.test(value)) {
      version = value;
      save((rel) => {
        if (rel.version !== value) {
          // 新版本：清掉舊版本的進度
          for (const k of Object.keys(rel)) delete rel[k];
          rel.version = value;
          if (bump) rel.bump = bump;
        }
        rel.remark = remark;
      });
    } else if (kind === 'done' && RELEASE_STEPS.includes(value)) {
      const now = new Date().toISOString();
      if (value === 'Database') queue(() => markDbWritten(id, plan.db, now));
      else
        save((rel) => {
          rel.completed = value;
          if (value === 'Publish') rel.publishedAt = now;
        });
    }
  }

  log(`▶ UpAgent 發佈（${RELEASE_DB_LABEL[plan.db]}）：從 ${plan.startFrom} 開始${plan.version ? `，版號 ${plan.version}` : `，npm version ${bump}`}${rerunAction ? '（先重跑 GitHub Action）' : ''}`);
  await execRelease({
    owner: { id, stage, target },
    args,
    log,
    onStep: (step) => send('upagentRelease:step', { id, stage, step }),
    onMarker,
    settle: () => saving,
    // 開發 branch → feature branch：Bump 要在包含 Confirm Commit 的 feature branch 上更版
    before: plan.startFrom === 'Bump' && confirmCommit ? () => mergeIntoFeature({ commit: confirmCommit, featureBranch, reqId: id, log }) : null,
    // feature branch → 環境 branch：發佈完成後把版本 tag 的 commit merge 進環境 branch（已在其中則略過）
    after: confirmCommit && featureBranch ? () => version && mergeReleaseIntoEnv({ stage, version, commit: confirmCommit, featureBranch, reqId: id, log }) : null,
  });
  return (await loadFlowState())[id] || {};
}

/** Bump 前：Confirm Commit 不在 feature branch 時，以 merge commit（--no-ff）merge 進去並 push（已在其中則略過） */
async function mergeIntoFeature({ commit, featureBranch, reqId, log }) {
  log(`▶ 確認 Confirm Commit ${commit.slice(0, 10)} 已在 ${featureBranch}…`);
  const r = await mergeNoFf({
    repo: UPAGENT_REPO,
    commit,
    envBranch: featureBranch,
    message: `Merge ${commit.slice(0, 10)} into ${featureBranch}${reqId ? `\n\nRequirement #${reqId}` : ''}`,
  });
  log(r.mergeCommit ? `已建立 merge commit ${r.mergeCommit.slice(0, 10)} 並 push 到 ${featureBranch}` : `✓ ${commit.slice(0, 10)} 已在 ${featureBranch}`);
}

/**
 * 發佈後：把版本 tag（v<version>）merge 進此階段 upagent 的環境 branch；正式環境 merge 後再反向 merge 回所有 feature branch。
 * 失敗時丟錯（發佈進度已存；下次勾選時佈版 merge 會再處理）。
 */
async function mergeReleaseIntoEnv({ stage, version, commit, featureBranch, reqId, log }) {
  const repo = (await loadRepoConfig()).repos.find((r) => r.key === UPAGENT_REPO);
  const envBranch = repo?.deployBranches?.[stage];
  if (!envBranch) throw new Error(`已發佈 ${version}，但尚未設定 upagent 的環境 branch（${fieldHint(UPAGENT_REPO, DEPLOY_BRANCH_FIELDS[stage])}），無法 merge`);
  const tag = `v${version}`;
  let r;
  try {
    r = await mergeViaFeature({ repo: UPAGENT_REPO, commit, featureBranch, envBranch, source: tag, reqId });
  } catch (err) {
    throw new Error(`已發佈 ${version}，但 ${tag} merge 進 ${envBranch} 失敗：${err.message}`);
  }
  if (!r.mergeCommit) return log(`✓ ${tag} 已在 ${envBranch}`);
  log(`已把 ${tag} merge 進 ${envBranch}（merge commit ${r.mergeCommit.slice(0, 10)}）並 push`);
  if (stage !== 'prodDeploy') return;
  try {
    for (const x of (await mergeBackToFeatures({ repo: UPAGENT_REPO, fromBranch: envBranch, reqId })).items) log(`反向 merge 回 ${x.branch}：${x.message}`);
  } catch (err) {
    log(`⚠ 反向 merge 回 feature branch 失敗：${err.message}`);
  }
}

/** 顯示用：目前佔用 UpAgent 發佈的是哪個流程 */
const ownerLabel = (r) => (r.id ? `#${r.id}` : '手動佈版');

/**
 * 執行 shell/Release-UpAgent.ps1（流程與手動佈版共用；一次只能一個）。
 * stdout 的標記：::step:: → onStep、::error:: → 失敗時的錯誤訊息、::version:: / ::done:: → onMarker(kind, value)，其餘行 → log。
 * @param owner { id, stage, target }（手動佈版 id 為 null）
 * @param signal 外部的 AbortSignal（手動佈版的停止）；cancelRelease 也會停止
 * @param settle 結束前等待（例如進度寫入），等完才釋放「執行中」
 * @param before 執行腳本前（已佔用「執行中」）先做的事，例如把 Confirm Commit merge 進 feature branch
 * @param after  腳本成功後（仍佔用「執行中」）再做的事，例如把版本 tag merge 進環境 branch
 */
async function execRelease({ owner, args, log, onStep, onMarker, signal, settle, before, after }) {
  if (running) throw new Error(`已有 UpAgent 發佈進行中：${ownerLabel(running)}`);
  if (signal?.aborted) throw new Error('已停止');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  running = { ...owner, controller };
  let lastError = '';
  let pending = '';
  const onStdout = (text) => {
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      const m = MARKER_RE.exec(line.trim());
      if (!m) log(line);
      else if (m[1] === 'step') onStep?.(m[2].trim());
      else if (m[1] === 'error') lastError = m[2].trim();
      else onMarker?.(m[1], m[2].trim());
    }
  };
  try {
    if (before) {
      onStep?.('Bump');
      await before();
      if (controller.signal.aborted) throw new Error('已停止');
    }
    await runPowerShellJson('Release-UpAgent.ps1', args, { timeout: 0, onStdout, signal: controller.signal });
    if (pending) onStdout('\n');
    await after?.();
  } catch (err) {
    if (!controller.signal.aborted && lastError) err.message = lastError;
    throw err;
  } finally {
    if (pending) onStdout('\n');
    signal?.removeEventListener('abort', abort);
    try {
      await settle?.();
    } finally {
      running = null;
    }
  }
}

/** 手動佈版的 Database 步驟完成：流程狀態中同版本的發佈紀錄也記下已寫入，避免之後流程又寫入同一個資料庫 */
function markVersionDbWritten(version, db, at) {
  return updateFlowState((state) => {
    for (const checks of Object.values(state)) {
      const rel = checks?.[UPAGENT_RELEASE_KEY];
      if (rel?.version === version) checks[UPAGENT_RELEASE_KEY] = { ...rel, db: { ...rel.db, [db]: at } };
    }
  });
}

/** data/config.json 是否有 upagentRelease 區段（機密由腳本檢查） */
async function releaseConfigExists() {
  return !!(await readConfig().catch(() => null))?.upagentRelease;
}

/** 包含 commit 的最新版本 tag（v<x.y.z>）的版號；沒有或查不到時回傳 ''（手動佈版提醒「已有版本」用） */
async function versionContaining(commit) {
  const repo = (await loadRepoConfig()).repos.find((r) => r.key === UPAGENT_REPO);
  if (!repo?.path) return '';
  try {
    const out = await git(repo.path, ['tag', '--list', 'v*', '--contains', commit]);
    const versions = out.split(/\r?\n/).map((t) => t.trim().slice(1)).filter((v) => VERSION_RE.test(v));
    return versions.sort(compareVersion).pop() || '';
  } catch {
    return '';
  }
}

/**
 * 手動佈版（manualDeploy.js）：不經 Requirement 執行 UpAgent 發佈，不寫流程紀錄
 * （只在 Database 完成時，把流程中同版本的紀錄標記為已寫入該資料庫）。
 * @param release { mode: 'new', bump, branch, remark } = 在 branch 更版並完整發佈；
 *                { mode: 'resume', version, startFrom, remark, rerunAction } = 已有版號，從 startFrom 接續（Database = 只寫入資料庫）
 * @param commit 'new' 時要求已在 branch 中的 commit（可省略）
 * @param onVersion (version) => void；onDone (step) => void（某步驟完成）
 */
async function runManualRelease({ env, target, release, commit, log, onStep, onVersion, onDone, signal }) {
  if (!RELEASE_TARGETS.includes(target) || !Object.values(RELEASE_ENV).includes(env)) throw new Error('參數錯誤');
  const repo = (await loadRepoConfig()).repos.find((r) => r.key === UPAGENT_REPO);
  if (!repo?.path) throw new Error(`尚未設定 upagent 的本機路徑，請在 ${fieldHint(UPAGENT_REPO, 'path')} 設定`);
  const db = releaseDbKey(env, target);
  const args = ['-Environment', env, '-Target', target, '-UpagentDir', repo.path, '-ConfigPath', CONFIG_FILE, '-EnvPath', ENV_FILE];
  if (release.mode === 'new') {
    args.push('-StartFrom', 'Bump', '-Bump', release.bump, '-Branch', release.branch);
    if (commit) args.push('-ExpectedCommit', commit);
  } else {
    args.push('-StartFrom', release.startFrom, '-Version', release.version);
    if (release.rerunAction) args.push('-RerunAction');
  }
  if (release.remark) args.push('-Remark', release.remark);

  let version = release.mode === 'new' ? '' : release.version;
  let saving = Promise.resolve();
  const onMarker = (kind, value) => {
    if (kind === 'version' && VERSION_RE.test(value)) {
      version = value;
      onVersion?.(value);
    } else if (kind === 'done' && RELEASE_STEPS.includes(value)) {
      onDone?.(value);
      if (value === 'Database' && version) {
        const at = new Date().toISOString();
        saving = saving.then(() => markVersionDbWritten(version, db, at)).catch((err) => log(`⚠ 更新流程中同版本的資料庫紀錄失敗：${err.message}`));
      }
    }
  };
  const from = release.mode === 'new' ? `在 ${release.branch} npm version ${release.bump}` : `版號 ${release.version}，從 ${release.startFrom} 開始`;
  log(`▶ UpAgent 發佈（手動，${RELEASE_DB_LABEL[db]}）：${from}${release.rerunAction ? '（先重跑 GitHub Action）' : ''}`);
  await execRelease({ owner: { id: null, stage: null, target }, args, log, onStep, onMarker, signal, settle: () => saving });
  return { version };
}

/** 停止執行中的發佈（進度停在最後完成的步驟，下次從下一步接續） */
function cancelRelease() {
  running?.controller.abort();
  return !!running;
}

module.exports = { releaseStatus, runRelease, cancelRelease, runManualRelease, releaseConfigExists, versionContaining, releaseVersionFor };
