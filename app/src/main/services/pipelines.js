const { runScriptJson } = require('../python');
const { loadRepoConfig } = require('./repoConfig');
const { loadFlowState } = require('./requirementFlow');
const { UNDERSTAND_KEY, UNDERSTAND_REPOS_KEY, COMMIT_STAGES } = require('../../shared/flow-rules.js');

/**
 * 佈版階段的自動佈版 Pipeline：環境 branch push 後由 Azure DevOps Pipeline 自動佈版。
 * Pipeline 名稱由 app/.env 的 `<REPO>_TEST_PIPELINE` / `<REPO>_PROD_PIPELINE` 設定（見 repoConfig.js）。
 */

const RUNS_TOP = 30;

/**
 * Manager understand 所選 repository 中有設定 Pipeline 的，各自最近的 Run（get_pipeline_runs.py）。
 * @returns {{ stage, pipelines: [{ repo, name, pipeline, runs }], unconfigured: string[] }}
 *   runs 新到舊；run.active = 尚未結束（進行中 / 排隊 / 停等）。unconfigured = 沒設定 Pipeline 的 repository。
 */
async function deployPipelineRuns({ id, stage } = {}) {
  if (!Number.isInteger(id) || !COMMIT_STAGES.includes(stage)) throw new Error('參數錯誤');
  const checks = (await loadFlowState())[id] || {};
  const repos = checks[UNDERSTAND_KEY] ? Object.keys(checks[UNDERSTAND_REPOS_KEY] || {}) : [];
  const config = await loadRepoConfig();
  const targets = [];
  const unconfigured = [];
  for (const repo of repos) {
    const name = config.repos.find((r) => r.key === repo)?.pipelines[stage];
    if (name) targets.push({ repo, name });
    else unconfigured.push(repo);
  }
  const pipelines = await Promise.all(
    targets.map(async ({ repo, name }) => {
      try {
        const { pipeline, runs } = await runScriptJson('get_pipeline_runs.py', ['--pipeline', name, '--top', String(RUNS_TOP)]);
        return { repo, name, pipeline, runs };
      } catch (err) {
        throw new Error(`${repo} 的 Pipeline ${name}：${String(err.message || err).trim()}`);
      }
    })
  );
  return { stage, pipelines, unconfigured };
}

module.exports = { deployPipelineRuns };
