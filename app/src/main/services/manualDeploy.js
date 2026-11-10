const { BrowserWindow } = require('electron');
const { loadRepoConfig, fieldHint, DEPLOY_BRANCH_FIELDS } = require('./repoConfig');
const { checkMerged, mergeNoFf, mergeBackToFeatures } = require('./gitCommit');
const { repoPipelineRuns } = require('./pipelines');
const { afterDeployRepo } = require('./afterDeploy');
const prodRestart = require('./prodRestart');
const localDeploy = require('./localDeploy');
const upagentRelease = require('./upagentRelease');
const { CONFIG_LABEL } = require('./appConfig');
const {
  COMMIT_RE,
  COMMIT_FORMAT_HINT,
  UPAGENT_REPO,
  RELEASE_STEPS,
  RELEASE_DB_LABEL,
  releaseDbKey,
  restartSlot,
} = require('../../shared/flow-rules.js');

/**
 * 手動佈版（選單「佈版 → 手動佈版…」）：不經 Requirement 流程，直接把某個 repository 的某個 commit
 * 佈版到 測試 / 正式 環境的 SaaS 或 Local。重用流程的佈版動作，順序與勾 SaaS / Local 時相同：
 *   SaaS：（有 Pipeline）等待進行中的 Run → merge 進環境 branch 並 push（觸發 Pipeline）→ 監看 push 觸發的 Run → 佈版後動作
 *         （測試環境重啟 App Service；正式環境不立即重啟，After-ProdDeploy.ps1 依選擇的日期 / 時段在 Azure Automation 排程重啟）
 *   Local：merge 進環境 branch → （有 localDeploy 設定）shell/Deploy-Local.ps1
 *   upagent：再執行 UpAgent 發佈（shell/Release-UpAgent.ps1，寫入該環境 SaaS / Local 的資料庫）
 *   正式環境 merge 後同樣把 prodBranch 反向 merge 回所有 feature branch。
 * 不寫入流程狀態（只有 UpAgent 寫入資料庫時，把流程中同版本的紀錄標記為已寫入）。
 *
 * 工作在 main process 執行（可在背景跑、renderer 重新載入也不中斷），進度以 'manualDeploy:update'（工作快照）
 * 與 'manualDeploy:log'（{ id, line }）廣播給所有視窗。工作只存在記憶體中（App 關閉即消失）。
 * Local 佈版 / UpAgent 發佈與流程共用「一次一個」的限制。
 */

const ENV_STAGE = { test: 'testDeploy', prod: 'prodDeploy' };
const ENV_LABEL = { test: '測試環境', prod: '正式環境' };
const TARGET_LABEL = { saas: 'SaaS', local: 'Local' };
const BUMPS = ['patch', 'minor'];
/** 「接續」可以選的起點（Bump 需要用「完整發佈」） */
const RESUME_STEPS = RELEASE_STEPS.slice(1);
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const REMARK_MAX = 500;

/** 查詢 Pipeline Run 的間隔 / push 後第一次查詢前的等待 / push 後找不到觸發的 Run 就放棄 */
const POLL_MS = 15_000;
const FIRST_POLL_MS = 5_000;
const FIND_RUN_TIMEOUT_MS = 10 * 60_000;
const LOG_MAX_LINES = 3000;
/** 保留的已結束工作數 */
const KEEP_FINISHED = 20;

const RUN_STATUS_TEXT = { notStarted: '排隊中', inProgress: '進行中', cancelling: '取消中', postponed: '停等中' };
const RUN_RESULT_TEXT = { succeeded: '成功', partiallySucceeded: '部分成功', failed: '失敗', canceled: '已取消' };
const LOCAL_STEP_TEXT = {
  Docker: '確認 Docker',
  Source: '切到環境 branch',
  Env: '套用環境 .env',
  PreBuild: '前置指令',
  Build: 'Build image tar',
  Push: 'docker load + push',
  Deploy: 'ssh 更新 container',
};
const RELEASE_STEP_TEXT = {
  Bump: '更版並 push tag',
  WaitAction: '等待 GitHub Action',
  Download: '下載 staging 檔案',
  Sign: '簽署 Windows 安裝檔',
  UpdateYml: '重算 latest.yml',
  Publish: '上傳 Blob',
  CleanStaging: '清空 staging',
  Database: '寫入資料庫',
};

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const sameCommit = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const runName = (run) => `#${run.buildNumber || run.id}`;
const runText = (run) => (run.active ? RUN_STATUS_TEXT[run.status] || run.status : RUN_RESULT_TEXT[run.result] || run.result || '已結束');
const releaseStepLabel = (step) => `${RELEASE_STEPS.indexOf(step) + 1}/${RELEASE_STEPS.length} ${RELEASE_STEP_TEXT[step] || step}`;

/** 所有工作（新到舊加入）：id → job */
const jobs = new Map();
let nextId = 1;

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/* ---------- 參數 ---------- */

/**
 * 檢查並整理 renderer 傳來的參數。
 * @returns {{ repo, env, target, commit, rebuild, release? }}
 *   release（只有 upagent）：{ mode: 'new', bump, branch, remark } | { mode: 'resume', version, startFrom, remark, rerunAction }
 */
function normalizeParams(p = {}) {
  const repo = str(p.repo);
  if (!repo || !ENV_STAGE[p.env] || !TARGET_LABEL[p.target]) throw new Error('參數錯誤');
  const commit = str(p.commit).toLowerCase();
  if (commit && !COMMIT_RE.test(commit)) throw new Error(`commit 格式錯誤（${COMMIT_FORMAT_HINT}）`);
  const out = { repo, env: p.env, target: p.target, commit, rebuild: p.target === 'local' && p.rebuild === true };
  // 正式環境 SaaS：Pipeline Run 成功後在 Azure Automation 排程重啟（null = 不排程）
  out.restart = p.env === 'prod' && p.target === 'saas' ? prodRestart.normalizeRestart(p.restart) : null;
  if (repo === UPAGENT_REPO) {
    const u = p.release || {};
    const remark = str(u.remark);
    if (remark.length > REMARK_MAX) throw new Error(`備註最多 ${REMARK_MAX} 字`);
    if (u.mode === 'resume') {
      const version = str(u.version);
      if (!VERSION_RE.test(version)) throw new Error('版號格式錯誤（例：1.2.3）');
      if (!RESUME_STEPS.includes(u.startFrom)) throw new Error('請選擇從哪個步驟開始');
      out.release = { mode: 'resume', version, startFrom: u.startFrom, remark, rerunAction: u.rerunAction === true && u.startFrom === 'WaitAction' };
    } else {
      if (!BUMPS.includes(u.bump)) throw new Error('請選擇版號遞增方式（minor / patch）');
      const branch = str(u.branch);
      if (!branch) throw new Error('請選擇要更版的 upagent feature branch');
      out.release = { mode: 'new', bump: u.bump, branch, remark };
    }
  }
  // 只有 UpAgent「接續 / 只寫入資料庫」可以不填 commit（不 merge）
  if (!commit && out.release?.mode !== 'resume') throw new Error('請填入要佈版的 commit');
  return out;
}

/* ---------- 預覽 ---------- */

/**
 * 開始前的檢查（含 git fetch）：會做哪些步驟、merge 狀態、Pipeline、Local 設定與提醒。
 * @returns {{ params, label, envBranch, merge, pipeline, appService, local, release, steps: [{ key, label }], warnings: string[], errors: string[] }}
 *   errors 不為空時不能開始。
 */
async function preview(raw) {
  const p = normalizeParams(raw);
  const stage = ENV_STAGE[p.env];
  const r = (await loadRepoConfig()).repos.find((x) => x.key === p.repo);
  if (!r) throw new Error(`未知的 repository：${p.repo}`);
  if (p.release?.mode === 'new' && !r.branches.includes(p.release.branch)) {
    throw new Error(`${p.release.branch} 不在 upagent 的 branches 設定中（${fieldHint(p.repo, 'branches')}）`);
  }
  const envBranch = r.deployBranches[stage];
  const errors = [];
  const warnings = [];

  let merge = null;
  if (p.commit) {
    if (!envBranch) throw new Error(`尚未設定 ${p.repo} 的環境 branch，請在 ${fieldHint(p.repo, DEPLOY_BRANCH_FIELDS[stage])} 設定`);
    merge = await checkMerged({ repo: p.repo, commit: p.commit, envBranch });
    if (!merge.merged && !merge.canMerge) errors.push(merge.message);
  }

  let pipeline = null;
  if (p.target === 'saas') {
    const runs = await repoPipelineRuns(p.repo, stage);
    if (runs) pipeline = { name: runs.pipeline?.name || runs.name, active: runs.runs.filter((x) => x.active), latest: runs.runs[0] || null };
  }
  const appService = p.env === 'test' ? r.appServices.testDeploy?.name || '' : '';
  const local = p.target === 'local' ? await localDeploy.manualTarget(p.repo, p.env) : null;
  if (local?.error) errors.push(local.error);

  let release = null;
  if (p.release) {
    release = { ...p.release, db: releaseDbKey(p.env, p.target), dbLabel: RELEASE_DB_LABEL[releaseDbKey(p.env, p.target)] };
    if (!(await upagentRelease.releaseConfigExists())) {
      errors.push(`${CONFIG_LABEL} 尚未設定 upagentRelease（參考 templates/config_example.json；密碼與 GitHub token 在「設定 → 連線與機密設定…」）`);
    }
    if (p.release.mode === 'new' && p.commit) {
      const v = await upagentRelease.versionContaining(p.commit);
      if (v) warnings.push(`commit 已包含在版本 tag v${v} 中；若該版本已上傳 Blob，通常只需改用「接續 / 只寫入資料庫」（版號 ${v}，從「寫入資料庫」開始），不用再更版。`);
    }
  }

  if (p.target === 'saas' && !pipeline && !release) {
    warnings.push(`${p.repo} 沒有設定${ENV_LABEL[p.env]}的 Pipeline（${fieldHint(p.repo, p.env === 'test' ? 'testPipeline' : 'prodPipeline')}）：只會 merge 進環境 branch，不會監看自動佈版。`);
  }
  if (pipeline && merge?.merged) {
    warnings.push(`commit 已在 ${envBranch}：不會 push，也不會觸發新的 Pipeline Run${pipeline.active.length ? '（只會等待進行中的 Run 結束）' : ''}。`);
  }
  if (p.target === 'local' && !local && !release) {
    warnings.push(`${p.repo} 沒有設定${ENV_LABEL[p.env]}的 Local 佈版（${CONFIG_LABEL} 的 localDeploy.repos.${p.repo}.${p.env}）：只會 merge 進環境 branch。`);
  }
  if (p.restart) {
    const opts = await prodRestart.restartOptions();
    if (!opts.configured) errors.push(`無法排程重啟：${opts.error}`);
    else if (!opts.repos.some((x) => x.key === p.repo)) errors.push(`無法排程重啟：${CONFIG_LABEL} 的 prodRestart.repos 沒有設定 ${p.repo}`);
    if (!pipeline) warnings.push('沒有設定 Pipeline：不會執行佈版後動作，也不會排程重啟。');
  }
  if (p.env === 'prod') warnings.push('正式環境有客戶在使用，請確認 commit 已在測試環境驗證過。');

  const steps = planSteps({ p, envBranch, merge, pipeline, appService, local, release });
  return { params: p, label: r.label, envBranch, merge, pipeline, appService, local, release, steps, warnings, errors };
}

/** 依設定決定要做的步驟 */
function planSteps({ p, envBranch, pipeline, appService, local, release }) {
  const steps = [];
  if (pipeline) steps.push({ key: 'waitIdle', label: `等待 Pipeline ${pipeline.name} 進行中的 Run 結束` });
  if (p.commit) steps.push({ key: 'merge', label: `merge 進 ${envBranch} 並 push${p.env === 'prod' ? '（再反向 merge 回 feature branch）' : ''}` });
  if (pipeline) {
    steps.push({ key: 'watch', label: '監看 push 觸發的 Pipeline Run' });
    steps.push({
      key: 'afterDeploy',
      label:
        p.env === 'prod'
          ? p.restart
            ? `佈版後動作：排程 ${p.restart.date} ${restartSlot(p.restart.slot).label} ${p.restart.time} 重啟（Azure Automation）`
            : '佈版後動作（After-ProdDeploy.ps1，不排程重啟）'
          : appService
            ? `重啟 App Service ${appService}`
            : '佈版後動作（未設定 App Service，不重啟）',
    });
  }
  if (local) steps.push({ key: 'localDeploy', label: `Local 佈版到 ${local.remoteHost}（container ${local.appName}）` });
  if (release) {
    const from = release.mode === 'new' ? `在 ${release.branch} 更版（${release.bump}）` : `${release.version} 從「${RELEASE_STEP_TEXT[release.startFrom]}」開始`;
    steps.push({ key: 'release', label: `UpAgent 發佈：${from} → 寫入${release.dbLabel} 資料庫` });
  }
  return steps;
}

/* ---------- 工作 ---------- */

/** 送給 renderer 的工作快照（不含 controller；withLog = 含輸出） */
function snapshot(job, withLog = false) {
  const { controller, lines, ...rest } = job;
  return withLog ? { ...rest, lines: [...lines] } : rest;
}

const emit = (job) => broadcast('manualDeploy:update', snapshot(job));

function appendLog(job, line) {
  job.lines.push(line);
  if (job.lines.length > LOG_MAX_LINES) job.lines.splice(0, job.lines.length - LOG_MAX_LINES);
  broadcast('manualDeploy:log', { id: job.id, line });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('已停止'));
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      reject(new Error('已停止'));
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort);
  });
}

/** 執行一個步驟：fn 可把 step.state 設成 'skipped'；失敗時記下錯誤再往外丟 */
async function runStep(job, key, fn) {
  const step = job.steps.find((s) => s.key === key);
  if (!step) return;
  if (job.controller.signal.aborted) throw new Error('已停止');
  step.state = 'running';
  emit(job);
  try {
    await fn(step);
    if (step.state === 'running') step.state = 'done';
  } catch (err) {
    step.state = 'failed';
    const reason = job.controller.signal.aborted ? '已停止' : err.message;
    step.detail = step.detail && step.detail !== reason && !job.controller.signal.aborted ? `${step.detail} → ${reason}` : reason;
    throw err;
  } finally {
    emit(job);
  }
}

/** 查一次 Pipeline 的 Run；失敗時記在 log，回傳 null（之後會再重試） */
async function pollRuns(job) {
  try {
    const r = await repoPipelineRuns(job.params.repo, ENV_STAGE[job.params.env]);
    job.pollError = '';
    return r?.runs || [];
  } catch (err) {
    const msg = `查詢 Pipeline Run 失敗（會繼續重試）：${err.message}`;
    if (job.pollError !== msg) appendLog(job, `⚠ ${msg}`);
    job.pollError = msg;
    return null;
  }
}

/** 等到 Pipeline 沒有進行中 / 停等的 Run（避免 push 觸發的 Run 排在後面） */
async function waitIdle(job, step) {
  const { signal } = job.controller;
  for (;;) {
    const runs = await pollRuns(job);
    if (runs) {
      for (const w of job.waited) w.run = runs.find((x) => x.id === w.run.id) || w.run;
      const active = runs.filter((x) => x.active);
      for (const run of active) if (!job.waited.some((w) => w.run.id === run.id)) job.waited.push({ run });
      if (!active.length) {
        step.detail = job.waited.length ? `等待過 ${job.waited.map((w) => `${runName(w.run)} ${runText(w.run)}`).join('、')}` : '沒有進行中 / 停等的 Run';
        return;
      }
      step.detail = `等待 ${active.map((x) => `${runName(x)} ${runText(x)}`).join('、')}（每 ${POLL_MS / 1000} 秒更新）`;
      emit(job);
    }
    await sleep(POLL_MS, signal);
  }
}

/** merge 進環境 branch 並 push；正式環境再反向 merge 回 feature branch。回傳 push 的 merge commit（已在環境 branch 時為 null） */
async function doMerge(job, envBranch, step) {
  const { repo, commit, env } = job.params;
  const message = `Merge ${commit.slice(0, 10)} into ${envBranch}\n\n手動佈版（AdoMaster）`;
  const status = await mergeNoFf({ repo, commit, envBranch, message });
  if (!status.mergeCommit) {
    step.detail = status.message;
    appendLog(job, status.message);
    return null;
  }
  step.detail = `已建立 merge commit ${status.mergeCommit.slice(0, 10)} 並 push 到 ${envBranch}`;
  appendLog(job, `✔ ${step.detail}`);
  job.mergeCommit = status.mergeCommit;
  if (env === 'prod') {
    // 正式環境已 push：反向 merge 失敗不影響佈版，只提醒手動處理
    try {
      const back = await mergeBackToFeatures({ repo, fromBranch: envBranch });
      job.backMerges = back.items;
      for (const x of back.items) appendLog(job, `反向 merge ${envBranch} → ${x.branch}：${x.message}`);
      if (back.items.some((x) => x.state === 'conflict' || x.state === 'failed')) step.detail += '（有 feature branch 反向 merge 失敗，請手動處理）';
    } catch (err) {
      job.backMerges = [{ branch: '', state: 'failed', message: err.message }];
      appendLog(job, `⚠ 反向 merge 回 feature branch 失敗：${err.message}`);
      step.detail += '（反向 merge 回 feature branch 失敗，請手動處理）';
    }
  }
  return status.mergeCommit;
}

/** 監看 push（mergeCommit）觸發的 Run 直到結束；未成功則丟錯 */
async function watchRun(job, mergeCommit, step) {
  const { signal } = job.controller;
  const pushedAt = Date.now();
  let first = true;
  for (;;) {
    await sleep(first ? FIRST_POLL_MS : POLL_MS, signal);
    first = false;
    const runs = await pollRuns(job);
    if (runs) {
      const run = runs.find((x) => (job.run ? x.id === job.run.id : sameCommit(x.sourceVersion, mergeCommit)));
      if (run) job.run = run;
    }
    if (job.run && !job.run.active) break;
    if (!job.run && Date.now() - pushedAt > FIND_RUN_TIMEOUT_MS) {
      throw new Error(`push 後 ${FIND_RUN_TIMEOUT_MS / 60_000} 分鐘內找不到 ${mergeCommit.slice(0, 10)} 觸發的 Pipeline Run`);
    }
    step.detail = job.run ? `Run ${runName(job.run)} ${runText(job.run)}` : `等待 ${mergeCommit.slice(0, 10)} 觸發的 Run 建立…`;
    emit(job);
  }
  step.detail = `Run ${runName(job.run)} ${runText(job.run)}`;
  if (job.run.result !== 'succeeded') throw new Error(`Pipeline Run ${runName(job.run)} ${runText(job.run)}`);
}

async function execute(job) {
  const p = job.params;
  const stage = ENV_STAGE[p.env];
  const { signal } = job.controller;
  const log = (line) => appendLog(job, line);
  let mergeCommit = null;
  try {
    await runStep(job, 'waitIdle', (step) => waitIdle(job, step));
    await runStep(job, 'merge', async (step) => {
      mergeCommit = await doMerge(job, job.envBranch, step);
    });
    await runStep(job, 'watch', async (step) => {
      if (mergeCommit) return watchRun(job, mergeCommit, step);
      step.state = 'skipped';
      step.detail = '沒有 push，不會觸發新的 Run';
    });
    await runStep(job, 'afterDeploy', async (step) => {
      if (!mergeCommit) {
        step.state = 'skipped';
        step.detail = '沒有新的 Run，不執行';
        return;
      }
      step.detail = '執行中…';
      emit(job);
      const r = await afterDeployRepo({ stage, repo: p.repo, commit: mergeCommit, restart: p.restart, note: '手動佈版' });
      step.detail = r.message || '沒有設定 App Service，不需重啟';
      log(`✔ 佈版後動作：${step.detail}`);
    });
    await runStep(job, 'localDeploy', async (step) => {
      const result = await localDeploy.runManualLocalDeploy({
        repo: p.repo,
        env: p.env,
        commit: p.commit,
        rebuild: p.rebuild,
        log,
        onStep: (s) => {
          step.detail = LOCAL_STEP_TEXT[s] || s || '';
          emit(job);
        },
        signal,
      });
      step.detail = `${result.image || '完成'} → ${result.remoteHost}`;
    });
    await runStep(job, 'release', async (step) => {
      await upagentRelease.runManualRelease({
        env: p.env,
        target: p.target,
        release: p.release,
        commit: p.commit,
        log,
        onStep: (s) => {
          step.detail = releaseStepLabel(s);
          emit(job);
        },
        onVersion: (v) => {
          job.release.version = v;
          emit(job);
        },
        onDone: (s) => {
          job.release.completed = s;
        },
        signal,
      });
      step.detail = `UpAgent ${job.release.version} 已寫入${RELEASE_DB_LABEL[releaseDbKey(p.env, p.target)]} 資料庫`;
    });
    finish(job, 'succeeded');
  } catch (err) {
    finish(job, signal.aborted ? 'canceled' : 'failed', err);
  }
}

function finish(job, status, err) {
  job.status = status;
  job.error = err ? String(err.message || err) : '';
  job.finishedAt = new Date().toISOString();
  job.message = status === 'succeeded' ? '佈版完成' : status === 'canceled' ? '已停止' : '佈版失敗';
  appendLog(job, `${status === 'succeeded' ? '✔' : '✖'} ${job.message}${job.error && status !== 'canceled' ? `：${job.error}` : ''}`);
  emit(job);
  // 只保留最近的已結束工作
  const finished = [...jobs.values()].filter((j) => j.status !== 'running');
  for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
    jobs.delete(j.id);
    broadcast('manualDeploy:update', { id: j.id, removed: true });
  }
}

/** 檢查後開始一個手動佈版工作，回傳工作快照（工作在背景繼續執行） */
async function start(raw) {
  const pv = await preview(raw);
  if (pv.errors.length) throw new Error(pv.errors.join('；'));
  const p = pv.params;
  const job = {
    id: nextId++,
    params: p,
    title: `${ENV_LABEL[p.env]} ${TARGET_LABEL[p.target]} · ${pv.label}${p.commit ? ` ${p.commit.slice(0, 10)}` : ''}`,
    envBranch: pv.envBranch,
    steps: pv.steps.map((s) => ({ ...s, state: 'pending', detail: '' })),
    status: 'running',
    message: '佈版中',
    error: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    waited: [],
    run: null,
    mergeCommit: null,
    backMerges: null,
    pollError: '',
    // UpAgent：版號與最後完成的步驟（重試時從下一步接續）
    release: p.release ? { version: p.release.version || '', completed: '' } : null,
    lines: [],
    controller: new AbortController(),
  };
  jobs.set(job.id, job);
  emit(job); // 先讓 renderer 知道這個工作，之後的輸出才接得上
  appendLog(job, `▶ ${job.title}`);
  for (const w of pv.warnings) appendLog(job, `⚠ ${w}`);
  execute(job);
  return snapshot(job);
}

/** 停止執行中的工作（merge / 佈版後動作進行中時，等該步驟做完才停） */
function cancel({ id } = {}) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.controller.abort();
  appendLog(job, '■ 停止中…');
  return true;
}

/**
 * 以相同設定重新執行已結束的工作（取代原本的工作）。
 * UpAgent 已有版號時，從最後完成步驟的下一步接續；rerunAction = 從「等待 GitHub Action」接續時先重跑整個 workflow run。
 */
async function retry({ id, rerunAction = false } = {}) {
  const job = jobs.get(id);
  if (!job) throw new Error('找不到這個佈版工作');
  if (job.status === 'running') throw new Error('佈版工作仍在執行中');
  const params = { ...job.params };
  if (params.release) {
    const { version, completed } = job.release;
    if (version && completed) {
      const next = RELEASE_STEPS[RELEASE_STEPS.indexOf(completed) + 1];
      if (!next) throw new Error('UpAgent 發佈已完成，不需重試');
      params.release = { mode: 'resume', version, startFrom: next, remark: params.release.remark };
    } else {
      // 還沒有完成任何步驟：用原本的設定（完整發佈仍從 Bump 開始，腳本會檢查）
      params.release = { ...params.release };
    }
    if (params.release.mode === 'resume') params.release.rerunAction = rerunAction === true && params.release.startFrom === 'WaitAction';
  }
  const started = await start(params);
  jobs.delete(id);
  broadcast('manualDeploy:update', { id, removed: true });
  return started;
}

/** 從清單移除已結束的工作 */
function dismiss({ id } = {}) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'running') throw new Error('佈版工作仍在執行中，請先停止');
  jobs.delete(id);
  broadcast('manualDeploy:update', { id, removed: true });
  return true;
}

/** 所有工作（含輸出），renderer 載入時同步用 */
function list() {
  return [...jobs.values()].map((j) => snapshot(j, true));
}

module.exports = { preview, start, cancel, retry, dismiss, list, RESUME_STEPS };
