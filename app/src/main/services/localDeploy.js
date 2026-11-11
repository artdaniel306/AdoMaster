const fs = require('node:fs');
const path = require('node:path');
const { CONFIG_FILE, LOCAL_DEPLOY_ENV_DIR } = require('../paths');
const { CONFIG_LABEL, readConfig, str, isObj } = require('./appConfig');
const { runPowerShellLines } = require('../powershell');
const { withPathLock } = require('../pathLock');
const { createExclusiveRunner } = require('../exclusiveRunner');
const { loadRepoConfig, findRepo } = require('./repoConfig');
const { loadFlowState, updateRequirementState } = require('./flowState');
const {
  COMMIT_STAGES,
  planRepoKeys,
  commitsKey,
  localDeployKey,
  DEPLOY_ENV,
  UPAGENT_REPO,
  CUSTOMER_KEY_RE,
  stageOfEnv: envStage,
} = require('../../shared/flow-rules.js');

/**
 * Local（地端）佈版：勾測試 / 正式環境佈版的 Local，確認 commit 已 merge 進環境 branch 後，
 * 對規劃中在 data/config.json 的 localDeploy.repos 有設定該環境的 repository 依序執行 shell/Deploy-Local.ps1
 * （docker buildx build + push → ssh 到主機換 container）。沒有任何設定的 repository 不做事（Local 只 merge）。
 *
 * config.json 的 localDeploy（範本 templates/config_example.json；<test|prod> 子物件覆蓋外層同名欄位）：
 *   { "dockerDesktop": "選填，Docker Desktop.exe 路徑",
 *     "repos": { "crmapp": { "projectDir", "appName", "platform", "preBuild", "network", "hostPort", "appPort", "runEnv", "buildArgs",
 *                            "test": { "pushRegistry", "pullRegistry", "remoteHost", ... }, "prod": { ... } } } }
 *   projectDir 是部署專用的 clone（地端設定以本機修改保留在裡面），不可與 repos 的 path（開發用 clone）相同。
 *   envFile（通常放在 test / prod 子物件）：build 前複製到 projectDir\<envTarget>（預設 .env），讓測試 / 正式環境各用自己的 env；
 *   相對路徑以 data/local_deploy_env/ 為準（匯出本地資料會包含這個資料夾）。
 *   envTarget：projectDir 內的相對路徑，例如 crmappui 的 Dockerfile 用 buildArgs ENV_R1 挑 deploy/ 下的檔案 → "deploy/env-art-test"（/ 或 \ 都可以）。
 *
 * 成功的 repository 記在流程狀態的 `<stage>.localDeploy`，失敗重試時預設只跑尚未成功的。
 * 一次只能執行一個佈版（整個 app 共用）。腳本的 stdout / stderr 即時以 'localDeploy:log' 事件送給 renderer。
 */

const SECTION = 'localDeploy';
/** 客戶環境（手動佈版選「客戶環境」）：customerDeploy.<saas|local>.<客戶 key> */
const CUSTOMER_SECTION = 'customerDeploy';
const CUSTOMER_TARGETS = ['saas', 'local'];

/** 顯示用：目前佔用 Local 佈版的是哪個流程 */
const ownerLabel = (r) => `${r.id ? `#${r.id}` : '手動佈版'} ${r.repo}`;
/** 一次只能一個 Local 佈版（流程、手動佈版、客戶環境共用）；current = { id, stage, repo, controller }（手動佈版的 id 為 null） */
const runner = createExclusiveRunner((r) => `已有 Local 佈版進行中：${ownerLabel(r)}`);
/** 手動佈版 / 客戶環境：已有 Local 佈版執行中時排隊（onWait(label) = 顯示正在等哪個工作） */
const queueOptions = (onWait) => ({ wait: true, onWait: (r) => onWait?.(ownerLabel(r)) });

/** Local 佈版會組進遠端 ssh 指令的欄位與允許的字元（與 Deploy-Local.ps1 相同規則） */
const REMOTE_SAFE_FIELDS = ['appName', 'pullRegistry', 'network', 'hostPort', 'appPort'];
const REMOTE_SAFE_RE = /^[A-Za-z0-9_.:/-]*$/;
/** envTarget 只能是 projectDir 內的相對路徑（與 Deploy-Local.ps1 相同規則） */
const validEnvTarget = (t) => /^[A-Za-z0-9_.\\/-]+$/.test(t) && !path.isAbsolute(t) && !t.split(/[\\/]/).includes('..');
/** test / prod → 佈版階段 */
const stageOfEnv = (env) => {
  const stage = envStage(env);
  if (!stage) throw new Error('參數錯誤');
  return stage;
};
const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** localDeploy.repos.<repo> 的 <env> 有效設定（子物件覆蓋外層）；沒設定該環境時回傳 null */
function effectiveSettings(section, repo, env) {
  const base = section?.repos?.[repo];
  if (!base || typeof base !== 'object' || !base[env] || typeof base[env] !== 'object') return null;
  const { test, prod, ...common } = base;
  return { ...common, ...base[env] };
}

/**
 * 某 repository 某環境的 Local 佈版目標（不含流程紀錄）；config.json 沒有設定該環境時回傳 null。
 * 設定有問題時 error 為錯誤訊息（不丟錯，讓畫面列出來）。
 */
function buildTarget(section, config, repo, stage, env) {
  const s = effectiveSettings(section, repo, env);
  if (!s) return null;
  const r = config.repos.find((x) => x.key === repo);
  const envBranch = r?.deployBranches[stage] || '';
  const projectDir = str(s.projectDir);
  let error = '';
  if (!envBranch) error = `repos 中 ${repo} 尚未設定環境 branch`;
  else if (!projectDir) error = `${CONFIG_LABEL} 的 localDeploy.repos.${repo} 缺少 projectDir`;
  else if (samePath(projectDir, r?.path)) error = `localDeploy.repos.${repo}.projectDir 不可與開發用 clone（repos 的 path）相同`;
  else if (!str(s.pushRegistry) || !str(s.remoteHost) || !str(s.hostPort) || !str(s.appPort)) {
    error = `${CONFIG_LABEL} 的 localDeploy.repos.${repo}.${env} 缺少 pushRegistry / remoteHost / hostPort / appPort`;
  } else if (str(s.envFile) && !fs.existsSync(path.resolve(LOCAL_DEPLOY_ENV_DIR, str(s.envFile)))) {
    error = `找不到 localDeploy.repos.${repo}.${env} 的 envFile：${path.resolve(LOCAL_DEPLOY_ENV_DIR, str(s.envFile))}`;
  } else if (str(s.envFile) && str(s.envTarget) && !validEnvTarget(str(s.envTarget))) {
    error = `localDeploy.repos.${repo}.${env} 的 envTarget 必須是部署用資料夾內的相對路徑：${str(s.envTarget)}`;
  } else {
    // 會組進遠端 shell 指令的值，只允許安全字元（與 Deploy-Local.ps1 相同規則）
    const unsafe = REMOTE_SAFE_FIELDS.find((f) => !REMOTE_SAFE_RE.test(str(s[f])));
    if (unsafe) error = `localDeploy.repos.${repo} 的 ${unsafe} 含有不允許的字元：${str(s[unsafe])}`;
  }
  return {
    repo,
    label: r?.label || repo,
    envBranch,
    appName: str(s.appName) || repo,
    remoteHost: str(s.remoteHost),
    hostPort: str(s.hostPort),
    projectDir,
    error,
  };
}

/**
 * 某 Requirement 某佈版階段要做 Local 佈版的 repository。
 *   last = 此階段上次 Local 佈版成功的紀錄；upToDate = 該紀錄是以目前的 Confirm Commit 佈版的
 *   （Confirm Commit 改過之後，舊紀錄不算數，預設要重新佈版）。
 * @returns {Promise<{ env, targets: [{ repo, label, envBranch, commit, appName, remoteHost, hostPort, projectDir, error, last, upToDate }] }>}
 */
async function deployTargets(id, stage) {
  if (!Number.isInteger(id) || !COMMIT_STAGES.includes(stage)) throw new Error('參數錯誤');
  const env = DEPLOY_ENV[stage];
  const checks = (await loadFlowState())[id] || {};
  const planRepos = planRepoKeys(checks);
  const section = (await readConfig())?.[SECTION];
  // unconfigured：規劃中沒有設定此環境 Local 佈版的 repository（upagent 走 UpAgent 發佈，不列入）
  const unconfigured = [];
  if (!planRepos.length) return { env, checks, targets: [], unconfigured };
  const config = await loadRepoConfig();
  const commits = checks[commitsKey(stage)] || {};
  const records = checks[localDeployKey(stage)] || {};
  const targets = [];
  for (const repo of planRepos) {
    const t = buildTarget(section, config, repo, stage, env);
    if (!t) {
      if (repo !== UPAGENT_REPO) unconfigured.push(repo);
      continue;
    }
    targets.push({
      ...t,
      commit: commits[repo] || '',
      last: records[repo] || null,
      upToDate: !!records[repo] && (records[repo].forCommit || '') === (commits[repo] || ''),
    });
  }
  return { env, checks, targets, unconfigured };
}

/** 手動佈版（manualDeploy.js）：某 repository 某環境（test / prod）的 Local 佈版目標；沒有設定時回傳 null */
async function manualTarget(repo, env) {
  return buildTarget((await readConfig())?.[SECTION], await loadRepoConfig(), repo, stageOfEnv(env), env);
}

/** 勾 Local 前查詢要佈版哪些 repository */
async function localDeployStatus({ id, stage } = {}) {
  const { env, targets, unconfigured } = await deployTargets(id, stage);
  const r = runner.current;
  return { env, targets, unconfigured, running: r && { id: r.id, stage: r.stage, repo: r.repo, label: ownerLabel(r) } };
}

/**
 * 對一個目標執行 shell/Deploy-Local.ps1，回傳腳本的結果（{ commit, image, tar }）。
 * 執行期間佔用部署用 clone（pathLock）：「同步所有 Repository」會等 build 完才快轉這個資料夾的 branch。
 * @param t buildTarget 的結果 + commit（要確認已在環境 branch 中的 commit，可省略）
 * @param log (line) => void；onStep (step) => void
 */
async function runScript(t, { env, rebuild, signal, log, onStep }) {
  const args = ['-Repo', t.repo, '-Environment', env, '-Branch', t.envBranch, '-ConfigPath', CONFIG_FILE, ...(t.extraArgs || [])];
  if (t.commit) args.push('-ExpectedCommit', t.commit);
  if (rebuild === true) args.push('-Rebuild');
  log(t.startLine || `▶ ${t.label}：Local 佈版到 ${t.remoteHost}（${t.envBranch}）`);
  try {
    return await withPathLock(
      [t.projectDir],
      () =>
        runPowerShellLines('Deploy-Local.ps1', args, {
          stderr: true, // docker / git 的進度輸出在 stderr
          onLine: log,
          onMarker: (kind, value) => kind === 'step' && onStep(value),
          signal,
        }),
      { signal, onWait: () => log(`⏳ 等待 ${t.projectDir} 的其他 git 操作（例如同步 Repository）結束…`) },
    );
  } catch (err) {
    err.message = `${t.label}：${err.message}`;
    throw err;
  }
}

/**
 * 依序對 repos 執行 Local 佈版（image 先 build 成 data/local_deploy/<repo>/*.tar 再 push；
 * 同一個 commit 的 tar 已存在時略過 build，rebuild = true 強制重新 build），全部成功後回傳該 Requirement 更新後的狀態；任一失敗即停止並丟出錯誤
 * （已成功的 repository 已記錄，重試時可略過）。
 * @param send (channel, payload) => void，送進度給 renderer
 */
async function runLocalDeploy(send, { id, stage, repos, rebuild = false } = {}) {
  if (!Array.isArray(repos) || !repos.length || !repos.every((r) => typeof r === 'string')) throw new Error('參數錯誤');
  runner.assertIdle();
  const { env, targets } = await deployTargets(id, stage);
  const selected = repos.map((repo) => {
    const t = targets.find((x) => x.repo === repo);
    if (!t) throw new Error(`${repo} 沒有設定 ${env} 環境的 Local 佈版`);
    if (t.error) throw new Error(t.error);
    return t;
  });

  const log = (line) => send('localDeploy:log', { id, stage, line });
  await runner.run({ id, stage, repo: selected[0].repo }, null, async (signal, current) => {
    for (const t of selected) {
      current.repo = t.repo;
      send('localDeploy:step', { id, stage, repo: t.repo, step: null });
      const onStep = (step) => send('localDeploy:step', { id, stage, repo: t.repo, step });
      const result = await runScript(t, { env, rebuild, signal, log, onStep });
      await updateRequirementState(id, (checks) => {
        const key = localDeployKey(stage);
        checks[key] = {
          ...(checks[key] || {}),
          [t.repo]: { forCommit: t.commit, commit: str(result?.commit), image: str(result?.image), tar: str(result?.tar), remoteHost: t.remoteHost, deployedAt: new Date().toISOString() },
        };
      });
      log(`✔ ${t.label} 完成`);
    }
  });
  return (await loadFlowState())[id] || {};
}

/**
 * 手動佈版（manualDeploy.js）：不經 Requirement，直接把某 repository 的環境 branch 佈版到 Local（不寫流程紀錄）。
 * 與流程共用同一個「一次一個 Local 佈版」的限制（已有執行中時排隊）；signal abort = 停止（排隊中 = 離開隊伍）。
 * @returns {{ commit, image, tar, remoteHost }}
 */
async function runManualLocalDeploy({ repo, env, commit, rebuild = false, log, onStep, onWait, signal }) {
  const t = await manualTarget(repo, env);
  if (!t) throw new Error(`${repo} 沒有設定 ${env} 環境的 Local 佈版（${CONFIG_LABEL} 的 localDeploy.repos.${repo}.${env}）`);
  if (t.error) throw new Error(t.error);
  return runner.run(
    { id: null, stage: stageOfEnv(env), repo },
    signal,
    async (runSignal) => {
      const result = await runScript({ ...t, commit: commit || '' }, { env, rebuild, signal: runSignal, log, onStep });
      log(`✔ ${t.label} 完成`);
      return { commit: str(result?.commit), image: str(result?.image), tar: str(result?.tar), remoteHost: t.remoteHost };
    },
    queueOptions(onWait),
  );
}

/* ---------- 客戶環境（只 build image tar 交給客戶） ---------- */

/**
 * config.json 的 customerDeploy：{ saas: { <客戶 key>: { label, repos: { <repo>: { …localDeploy 欄位, envFile, envTarget } } } }, local: { … } }
 * @returns {{ saas: [{ key, label, repos: string[] }], local: [...] }}（給 dialog 列客戶）
 */
async function listCustomers() {
  const section = (await readConfig())?.[CUSTOMER_SECTION];
  const out = {};
  for (const target of CUSTOMER_TARGETS) {
    const t = isObj(section?.[target]) ? section[target] : {};
    out[target] = Object.entries(t)
      .filter(([key, c]) => CUSTOMER_KEY_RE.test(key) && isObj(c))
      .map(([key, c]) => ({ key, label: str(c.label) || key, repos: isObj(c.repos) ? Object.keys(c.repos) : [] }));
  }
  return out;
}

/**
 * 某客戶某 repository 的打包目標；客戶不存在時回傳 null。設定有問題時 error 為錯誤訊息。
 * 設定 = localDeploy.repos.<repo> 外層（不含 test / prod）被客戶的 repos.<repo> 覆蓋；envFile / envTarget 只看客戶的設定。
 * env：有 envFile → 複製到 envTarget；SaaS 沒有 envFile → build 時移除 envTarget（預設 .env）；Local 必須有 envFile。
 */
async function customerTarget(repo, target, customer) {
  if (!CUSTOMER_TARGETS.includes(target) || !CUSTOMER_KEY_RE.test(customer || '')) throw new Error('參數錯誤');
  const config = await readConfig();
  const c = config?.[CUSTOMER_SECTION]?.[target]?.[customer];
  if (!isObj(c)) return null;
  const where = `${CONFIG_LABEL} 的 ${CUSTOMER_SECTION}.${target}.${customer}.repos.${repo}`;
  const own = isObj(c.repos?.[repo]) ? c.repos[repo] : null;
  const base = config?.[SECTION]?.repos?.[repo];
  const { test, prod, ...common } = isObj(base) ? base : {};
  const s = { ...common, ...(own || {}) };
  const r = await findRepo(repo);
  const prodBranch = r?.deployBranches.prodDeploy || '';
  const projectDir = str(s.projectDir);
  const envFile = str(own?.envFile);
  const envTarget = str(own?.envTarget) || '.env';
  const appName = str(s.appName) || repo;
  let error = '';
  if (!own) error = `客戶 ${str(c.label) || customer} 沒有設定 ${repo}（${where}）`;
  else if (!prodBranch) error = `repos 中 ${repo} 尚未設定正式環境 branch`;
  else if (!projectDir) error = `${where} 缺少 projectDir（或設定在 localDeploy.repos.${repo}）`;
  else if (samePath(projectDir, r?.path)) error = `${repo} 的 projectDir 不可與開發用 clone（repos 的 path）相同`;
  else if (!/^[A-Za-z0-9_.-]+$/.test(appName)) error = `${where} 的 appName 含有不允許的字元：${appName}`;
  else if (!envFile && target === 'local') error = `${where} 缺少 envFile（Local 客戶環境需要 env 檔，放在 data/local_deploy_env/）`;
  else if (envFile && !fs.existsSync(path.resolve(LOCAL_DEPLOY_ENV_DIR, envFile))) error = `找不到 ${where} 的 envFile：${path.resolve(LOCAL_DEPLOY_ENV_DIR, envFile)}`;
  else if (!validEnvTarget(envTarget)) error = `${where} 的 envTarget 必須是部署用資料夾內的相對路徑：${envTarget}`;
  return {
    repo,
    label: r?.label || repo,
    customer,
    customerLabel: str(c.label) || customer,
    target,
    envBranch: prodBranch,
    appName,
    platform: str(s.platform) || 'linux/arm64',
    projectDir,
    envFile,
    envTarget,
    envRemoved: !envFile,
    error,
  };
}

/**
 * 手動佈版的客戶環境：在部署用資料夾切到 commit（必須已在正式環境 branch）build image tar（data/customer_build/…），不 push、不 ssh。
 * 與 Local 佈版共用「一次一個」的限制（已有執行中時排隊）。
 * @returns {{ commit, image, tar }}
 */
async function runCustomerBuild({ repo, target, customer, commit, rebuild = false, log, onStep, onWait, signal }) {
  const t = await customerTarget(repo, target, customer);
  if (!t) throw new Error(`${CONFIG_LABEL} 尚未設定 ${CUSTOMER_SECTION}.${target}.${customer}`);
  if (t.error) throw new Error(t.error);
  return runner.run({ id: null, stage: 'customer', repo }, signal, async (runSignal) => {
    const result = await runScript(
      {
        ...t,
        commit,
        extraArgs: ['-Customer', customer, '-CustomerTarget', target],
        startLine: `▶ ${t.label}：打包客戶環境 ${t.customerLabel}（${commit.slice(0, 10)}）`,
      },
      { env: 'customer', rebuild, signal: runSignal, log, onStep },
    );
    log(`✔ ${t.label} 完成`);
    return { commit: str(result?.commit), image: str(result?.image), tar: str(result?.tar) };
  }, queueOptions(onWait));
}

/** 停止執行中的 Local 佈版 */
function cancelLocalDeploy() {
  return runner.cancel();
}

module.exports = {
  localDeployStatus,
  runLocalDeploy,
  cancelLocalDeploy,
  manualTarget,
  runManualLocalDeploy,
  listCustomers,
  customerTarget,
  runCustomerBuild,
};
