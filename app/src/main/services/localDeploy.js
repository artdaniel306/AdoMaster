const path = require('node:path');
const { CONFIG_FILE } = require('../paths');
const { CONFIG_LABEL, readConfig } = require('./appConfig');
const { runPowerShellJson } = require('../powershell');
const { loadRepoConfig } = require('./repoConfig');
const { loadFlowState, updateRequirementState } = require('./flowState');
const {
  COMMIT_STAGES,
  PLAN_KEY,
  PLAN_REPOS_KEY,
  commitsKey,
  localDeployKey,
  DEPLOY_ENV,
  UPAGENT_REPO,
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
 *
 * 成功的 repository 記在流程狀態的 `<stage>.localDeploy`，失敗重試時預設只跑尚未成功的。
 * 一次只能執行一個佈版（整個 app 共用）。腳本的 stdout / stderr 即時以 'localDeploy:log' 事件送給 renderer。
 */

const MARKER_RE = /^::(step|error)::(.*)$/;
const SECTION = 'localDeploy';

/** 目前執行中的佈版：{ id, stage, repo, controller } */
let running = null;

const str = (v) => (v == null ? '' : String(v).trim());
const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** localDeploy.repos.<repo> 的 <env> 有效設定（子物件覆蓋外層）；沒設定該環境時回傳 null */
function effectiveSettings(section, repo, env) {
  const base = section?.repos?.[repo];
  if (!base || typeof base !== 'object' || !base[env] || typeof base[env] !== 'object') return null;
  const { test, prod, ...common } = base;
  return { ...common, ...base[env] };
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
  const planRepos = checks[PLAN_KEY] ? Object.keys(checks[PLAN_REPOS_KEY] || {}) : [];
  const section = (await readConfig())?.[SECTION];
  // unconfigured：規劃中沒有設定此環境 Local 佈版的 repository（upagent 走 UpAgent 發佈，不列入）
  const unconfigured = [];
  if (!planRepos.length) return { env, checks, targets: [], unconfigured };
  const config = await loadRepoConfig();
  const commits = checks[commitsKey(stage)] || {};
  const records = checks[localDeployKey(stage)] || {};
  const targets = [];
  for (const repo of planRepos) {
    const s = effectiveSettings(section, repo, env);
    if (!s) {
      if (repo !== UPAGENT_REPO) unconfigured.push(repo);
      continue;
    }
    const r = config.repos.find((x) => x.key === repo);
    const envBranch = r?.deployBranches[stage] || '';
    const projectDir = str(s.projectDir);
    let error = '';
    if (!envBranch) error = `repos 中 ${repo} 尚未設定環境 branch`;
    else if (!projectDir) error = `${CONFIG_LABEL} 的 localDeploy.repos.${repo} 缺少 projectDir`;
    else if (samePath(projectDir, r?.path)) error = `localDeploy.repos.${repo}.projectDir 不可與開發用 clone（repos 的 path）相同`;
    else if (!str(s.pushRegistry) || !str(s.remoteHost) || !str(s.hostPort) || !str(s.appPort)) {
      error = `${CONFIG_LABEL} 的 localDeploy.repos.${repo}.${env} 缺少 pushRegistry / remoteHost / hostPort / appPort`;
    }
    targets.push({
      repo,
      label: r?.label || repo,
      envBranch,
      commit: commits[repo] || '',
      appName: str(s.appName) || repo,
      remoteHost: str(s.remoteHost),
      hostPort: str(s.hostPort),
      projectDir,
      error,
      last: records[repo] || null,
      upToDate: !!records[repo] && (records[repo].forCommit || '') === (commits[repo] || ''),
    });
  }
  return { env, checks, targets, unconfigured };
}

/** 勾 Local 前查詢要佈版哪些 repository */
async function localDeployStatus({ id, stage } = {}) {
  const { env, targets, unconfigured } = await deployTargets(id, stage);
  return { env, targets, unconfigured, running: running && { id: running.id, stage: running.stage, repo: running.repo } };
}

/**
 * 依序對 repos 執行 Local 佈版（image 先 build 成 data/local_deploy/<repo>/*.tar 再 push；
 * 同一個 commit 的 tar 已存在時略過 build，rebuild = true 強制重新 build），全部成功後回傳該 Requirement 更新後的狀態；任一失敗即停止並丟出錯誤
 * （已成功的 repository 已記錄，重試時可略過）。
 * @param send (channel, payload) => void，送進度給 renderer
 */
async function runLocalDeploy(send, { id, stage, repos, rebuild = false } = {}) {
  if (!Array.isArray(repos) || !repos.length || !repos.every((r) => typeof r === 'string')) throw new Error('參數錯誤');
  if (running) throw new Error(`已有 Local 佈版進行中：#${running.id} ${running.repo}`);
  const { env, targets } = await deployTargets(id, stage);
  const selected = repos.map((repo) => {
    const t = targets.find((x) => x.repo === repo);
    if (!t) throw new Error(`${repo} 沒有設定 ${env} 環境的 Local 佈版`);
    if (t.error) throw new Error(t.error);
    return t;
  });

  const controller = new AbortController();
  running = { id, stage, repo: selected[0].repo, controller };
  const log = (line) => send('localDeploy:log', { id, stage, line });
  try {
    for (const t of selected) {
      running.repo = t.repo;
      send('localDeploy:step', { id, stage, repo: t.repo, step: null });
      let lastError = '';
      const pending = { out: '', err: '' };
      const onText = (which) => (text) => {
        pending[which] += text;
        const lines = pending[which].split(/\r?\n|\r/);
        pending[which] = lines.pop();
        for (const line of lines) {
          const m = MARKER_RE.exec(line.trim());
          if (!m) log(line);
          else if (m[1] === 'step') send('localDeploy:step', { id, stage, repo: t.repo, step: m[2].trim() });
          else lastError = m[2].trim();
        }
      };
      const onStdout = onText('out');
      const onStderr = onText('err');
      const args = ['-Repo', t.repo, '-Environment', env, '-Branch', t.envBranch, '-ConfigPath', CONFIG_FILE];
      if (t.commit) args.push('-ExpectedCommit', t.commit);
      if (rebuild === true) args.push('-Rebuild');
      log(`▶ ${t.label}：Local 佈版到 ${t.remoteHost}（${t.envBranch}）`);
      let result;
      try {
        result = await runPowerShellJson('Deploy-Local.ps1', args, { timeout: 0, onStdout, onStderr, signal: controller.signal });
      } catch (err) {
        if (!controller.signal.aborted && lastError) err.message = lastError;
        err.message = `${t.label}：${err.message}`;
        throw err;
      } finally {
        if (pending.out) onStdout('\n');
        if (pending.err) onStderr('\n');
      }
      await updateRequirementState(id, (checks) => {
        const key = localDeployKey(stage);
        checks[key] = {
          ...(checks[key] || {}),
          [t.repo]: { forCommit: t.commit, commit: str(result?.commit), image: str(result?.image), tar: str(result?.tar), remoteHost: t.remoteHost, deployedAt: new Date().toISOString() },
        };
      });
      log(`✔ ${t.label} 完成`);
    }
  } finally {
    running = null;
  }
  return (await loadFlowState())[id] || {};
}

/** 停止執行中的 Local 佈版 */
function cancelLocalDeploy() {
  running?.controller.abort();
  return !!running;
}

module.exports = { localDeployStatus, runLocalDeploy, cancelLocalDeploy };
