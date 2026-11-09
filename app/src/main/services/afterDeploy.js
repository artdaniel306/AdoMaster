const { runPowerShellJson } = require('../powershell');
const { loadRepoConfig } = require('./repoConfig');
const { loadFlowState } = require('./requirementFlow');
const { PLAN_KEY, PLAN_REPOS_KEY, COMMIT_STAGES } = require('../../shared/flow-rules.js');

/**
 * 佈版後動作：勾 SaaS 的自動佈版流程中，push 觸發的 Pipeline Run 成功後，對該 repository 各執行一次。
 *   - 測試環境（testDeploy）：data/config.json 的 repos 有設定 testAppService 時，以 shell/Restart-AppService.ps1 重啟該 App Service
 *     （testResourceGroup 選填，空白時由 App Service 名稱自動查詢；需先 az login）；沒設定則不做任何事。
 *   - 正式環境（prodDeploy）：正式環境有客戶在用，不可直接重啟。只呼叫預留的 shell/After-ProdDeploy.ps1（目前沒有任何邏輯）。
 */

/** 重啟 + 等網站回應（腳本預設最多等 300 秒）的上限 */
const RESTART_TIMEOUT = 10 * 60_000;

/**
 * @returns {{ action: 'none' | 'restart' | 'prod', message: string, result?: object }}
 */
async function runAfterDeploy({ id, stage, repo, commit } = {}) {
  if (!Number.isInteger(id) || !COMMIT_STAGES.includes(stage) || typeof repo !== 'string') throw new Error('參數錯誤');
  const checks = (await loadFlowState())[id] || {};
  const planRepos = checks[PLAN_KEY] ? Object.keys(checks[PLAN_REPOS_KEY] || {}) : [];
  if (!planRepos.includes(repo)) throw new Error(`#${id} 的規劃沒有選 ${repo}`);

  if (stage === 'prodDeploy') {
    const args = ['-Repo', repo];
    if (typeof commit === 'string' && commit) args.push('-Commit', commit);
    const result = await runPowerShellJson('After-ProdDeploy.ps1', args);
    return { action: 'prod', message: String(result?.message || '正式環境佈版後動作已執行'), result };
  }

  const config = await loadRepoConfig();
  const app = config.repos.find((r) => r.key === repo)?.appServices[stage];
  if (!app?.name) return { action: 'none', message: '' };
  const args = ['-Name', app.name];
  if (app.resourceGroup) args.push('-ResourceGroup', app.resourceGroup);
  let result;
  try {
    result = await runPowerShellJson('Restart-AppService.ps1', args, { timeout: RESTART_TIMEOUT });
  } catch (err) {
    throw new Error(`重啟 App Service ${app.name} 失敗：${String(err.message || err).trim()}`);
  }
  const http = result?.status != null ? `HTTP ${result.status}，` : '';
  const secs = result?.elapsedSec != null ? `${result.elapsedSec} 秒` : '';
  return { action: 'restart', message: `已重啟 App Service ${app.name}${http || secs ? `（${http}${secs}）` : ''}`, result };
}

module.exports = { runAfterDeploy };
