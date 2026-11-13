const { runScriptJson } = require('../python');
const { loadRepoConfig, findRepo } = require('./repoConfig');
const { loadFlowState } = require('./flowState');
const { planRepoKeys, COMMIT_STAGES } = require('../../shared/flow-rules.js');

/**
 * 佈版階段的自動佈版 Pipeline：環境 branch push 後由 Azure DevOps Pipeline 自動佈版。
 * Pipeline 名稱由 data/config.json 的 repos 各 repository 的 `testPipeline` / `prodPipeline` 設定（見 repoConfig.js）。
 */

const RUNS_TOP = 30;

/**
 * 規劃 所選 repository 中有設定 Pipeline 的，各自最近的 Run（get_pipeline_runs.py）。
 * @returns {{ stage, pipelines: [{ repo, name, pipeline, runs }], unconfigured: string[] }}
 *   runs 新到舊；run.active = 尚未結束（進行中 / 排隊 / 停等）。unconfigured = 沒設定 Pipeline 的 repository。
 */
async function deployPipelineRuns({ id, stage } = {}) {
  if (!Number.isInteger(id) || !COMMIT_STAGES.includes(stage)) throw new Error('參數錯誤');
  const checks = (await loadFlowState())[id] || {};
  const repos = planRepoKeys(checks);
  const config = await loadRepoConfig();
  const targets = [];
  const unconfigured = [];
  for (const repo of repos) {
    const name = config.repos.find((r) => r.key === repo)?.pipelines[stage];
    if (name) targets.push({ repo, name });
    else unconfigured.push(repo);
  }
  const pipelines = await Promise.all(targets.map(({ repo, name }) => fetchRuns(repo, name)));
  return { stage, pipelines, unconfigured };
}

/** 某 repository 的 Pipeline 最近的 Run（get_pipeline_runs.py） */
async function fetchRuns(repo, name) {
  try {
    const { pipeline, runs } = await runScriptJson('get_pipeline_runs.py', ['--pipeline', name, '--top', String(RUNS_TOP)]);
    return { repo, name, pipeline, runs };
  } catch (err) {
    throw new Error(`${repo} 的 Pipeline ${name}：${String(err.message || err).trim()}`);
  }
}

/**
 * 手動佈版（manualDeploy.js）：某 repository 某佈版階段的 Pipeline 最近的 Run；沒有設定 Pipeline 時回傳 null。
 * @returns {Promise<null | { repo, name, pipeline, runs }>}
 */
async function repoPipelineRuns(repo, stage) {
  if (typeof repo !== 'string' || !COMMIT_STAGES.includes(stage)) throw new Error('參數錯誤');
  const name = (await findRepo(repo))?.pipelines[stage];
  return name ? fetchRuns(repo, name) : null;
}

/** 監視 SaaS 佈版狀態：每個 Pipeline 只取最近幾個 Run */
const MONITOR_TOP = 5;

/**
 * 選單「佈版 → 監視 SaaS 佈版狀態…」：所有 repository 有設定的測試 / 正式環境 Pipeline 最近的 Run（只讀，不 merge、不重啟）。
 * 個別 Pipeline 查詢失敗不影響其他的，錯誤放在該筆的 error。
 * @returns {{ pipelines: [{ repo, stage, name, pipeline?, runs, error?, appService }] }}
 *   appService：測試環境有設定 testAppService 時為其名稱（可手動重啟），否則為 ''
 */
async function monitorPipelineRuns() {
  const config = await loadRepoConfig();
  const targets = COMMIT_STAGES.flatMap((stage) =>
    config.repos.filter((r) => r.pipelines[stage]).map((r) => ({ repo: r.key, stage, name: r.pipelines[stage], appService: r.appServices[stage]?.name || '' }))
  );
  const pipelines = await Promise.all(
    targets.map(async (t) => {
      try {
        const { pipeline, runs } = await runScriptJson('get_pipeline_runs.py', ['--pipeline', t.name, '--top', String(MONITOR_TOP)]);
        return { ...t, pipeline, runs };
      } catch (err) {
        return { ...t, runs: [], error: String(err.message || err).trim() };
      }
    })
  );
  return { pipelines };
}

module.exports = { deployPipelineRuns, repoPipelineRuns, monitorPipelineRuns };
