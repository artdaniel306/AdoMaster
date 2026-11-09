const { CONFIG_FILE, ENV_FILE } = require('../paths');
const { readConfig } = require('./appConfig');
const { runPowerShellJson } = require('../powershell');
const { loadRepoConfig, fieldHint } = require('./repoConfig');
const { loadFlowState, updateRequirementState, updateFlowState } = require('./flowState');
const { git } = require('./gitCommit');
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

/** 目前執行中的發佈：{ id, stage, target, controller } */
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
    configExists: !!(await readConfig().catch(() => null))?.upagentRelease, // 機密（.env）由腳本檢查
    running: running && { id: running.id, stage: running.stage, target: running.target },
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
  if (running) throw new Error(`已有 UpAgent 發佈進行中：#${running.id}`);

  const checks = (await adoptPublishedRelease(id, stage)) || (await loadFlowState())[id] || {};
  const plan = upagentReleasePlan(checks, stage, target);
  if (!plan) return checks; // 例如沿用已發佈的版本後，此資料庫已寫入過
  if (running) throw new Error(`已有 UpAgent 發佈進行中：#${running.id}`);
  if (plan.startFrom === 'Bump' && !['minor', 'patch'].includes(bump)) throw new Error('請選擇版號遞增方式（minor / patch）');
  remark = (remark ?? releaseOf(checks).remark ?? '').trim();
  if (remark.length > REMARK_MAX) throw new Error(`備註最多 ${REMARK_MAX} 字`);

  const repo = (await loadRepoConfig()).repos.find((r) => r.key === UPAGENT_REPO);
  if (!repo?.path) throw new Error(`尚未設定 upagent 的本機路徑，請在 ${fieldHint(UPAGENT_REPO, 'path')} 設定`);

  const args = ['-Environment', plan.env, '-Target', plan.target, '-UpagentDir', repo.path, '-StartFrom', plan.startFrom, '-ConfigPath', CONFIG_FILE, '-EnvPath', ENV_FILE];
  if (plan.startFrom === 'Bump') {
    // 從規劃選的 upagent feature branch 建版；有 Confirm Commit 時，腳本會確認它已在 feature branch 中
    const branch = checks[PLAN_REPOS_KEY]?.[UPAGENT_REPO];
    if (!branch) throw new Error('規劃未選擇 upagent 的 feature branch');
    args.push('-Bump', bump, '-Branch', branch);
    const commit = checks[commitsKey(stage)]?.[UPAGENT_REPO];
    if (commit) args.push('-ExpectedCommit', commit);
  } else {
    args.push('-Version', plan.version);
  }
  if (remark) args.push('-Remark', remark);
  if (rerunAction) {
    if (plan.startFrom !== 'WaitAction') throw new Error('只有從「等待 GitHub Action」接續時才能重跑 GitHub Action');
    args.push('-RerunAction');
  }

  const controller = new AbortController();
  running = { id, stage, target, controller };
  const log = (line) => send('upagentRelease:log', { id, stage, line });
  let lastError = '';
  // 依腳本輸出的標記即時存進度：app 中途關閉 / 腳本失敗時，下次仍能從正確的步驟接續
  let saving = Promise.resolve();
  const queue = (fn) => {
    saving = saving.then(fn).catch((err) => log(`⚠ 儲存發佈進度失敗：${err.message}`));
  };
  const save = (mutate) => queue(() => updateRelease(id, mutate));
  function onMarker(kind, value) {
    if (kind === 'version' && /^\d+\.\d+\.\d+$/.test(value)) {
      save((rel) => {
        if (rel.version !== value) {
          // 新版本：清掉舊版本的進度
          for (const k of Object.keys(rel)) delete rel[k];
          rel.version = value;
          if (bump) rel.bump = bump;
        }
        rel.remark = remark;
      });
    } else if (kind === 'step') {
      send('upagentRelease:step', { id, stage, step: value });
    } else if (kind === 'done' && RELEASE_STEPS.includes(value)) {
      const now = new Date().toISOString();
      if (value === 'Database') queue(() => markDbWritten(id, plan.db, now));
      else
        save((rel) => {
          rel.completed = value;
          if (value === 'Publish') rel.publishedAt = now;
        });
    } else if (kind === 'error') {
      lastError = value;
    }
  }

  let pending = '';
  const onStdout = (text) => {
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      const m = MARKER_RE.exec(line.trim());
      if (m) onMarker(m[1], m[2].trim());
      else log(line);
    }
  };

  log(`▶ UpAgent 發佈（${RELEASE_DB_LABEL[plan.db]}）：從 ${plan.startFrom} 開始${plan.version ? `，版號 ${plan.version}` : `，npm version ${bump}`}${rerunAction ? '（先重跑 GitHub Action）' : ''}`);
  try {
    await runPowerShellJson('Release-UpAgent.ps1', args, { timeout: 0, onStdout, signal: controller.signal });
  } catch (err) {
    if (!controller.signal.aborted && lastError) err.message = lastError;
    throw err;
  } finally {
    if (pending) onStdout('\n');
    await saving;
    running = null;
  }
  return (await loadFlowState())[id] || {};
}

/** 停止執行中的發佈（進度停在最後完成的步驟，下次從下一步接續） */
function cancelRelease() {
  running?.controller.abort();
  return !!running;
}

module.exports = { releaseStatus, runRelease, cancelRelease };
