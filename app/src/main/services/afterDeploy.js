const { runPowerShellJson } = require('../powershell');
const { loadRepoConfig } = require('./repoConfig');
const { loadFlowState } = require('./flowState');
const { normalizeRestart, restartArgs } = require('./prodRestart');
const { planRepoKeys, COMMIT_STAGES } = require('../../shared/flow-rules.js');

/**
 * 佈版後動作：勾 SaaS 的自動佈版流程中，push 觸發的 Pipeline Run 成功後，對該 repository 各執行一次。
 *   - 測試環境（testDeploy）：data/config.json 的 repos 有設定 testAppService 時，以 shell/Restart-AppService.ps1 重啟該 App Service
 *     （testResourceGroup 選填，空白時由 App Service 名稱自動查詢；需先 az login）；沒設定則不做任何事。
 *   - 正式環境（prodDeploy）：正式環境有客戶在用，不可直接重啟。呼叫 shell/After-ProdDeploy.ps1：佈版時有選重啟日期 / 時段
 *     （restart = { date, slot }）就在 Azure Automation 排程重啟（data/config.json 的 prodRestart，見 prodRestart.js），沒選則不做事。
 */

/** 重啟 + 等網站回應（腳本預設最多等 300 秒）的上限 */
const RESTART_TIMEOUT = 10 * 60_000;

/**
 * @returns {{ action: 'none' | 'restart' | 'prod', message: string, result?: object }}
 */
async function runAfterDeploy({ id, stage, repo, commit, restart } = {}) {
  if (!Number.isInteger(id) || !COMMIT_STAGES.includes(stage) || typeof repo !== 'string') throw new Error('參數錯誤');
  const checks = (await loadFlowState())[id] || {};
  const planRepos = planRepoKeys(checks);
  if (!planRepos.includes(repo)) throw new Error(`#${id} 的規劃沒有選 ${repo}`);
  return afterDeployRepo({ stage, repo, commit, restart, note: `Requirement #${id}` });
}

/**
 * 對某 repository 執行佈版後動作（流程與手動佈版共用，不檢查 Requirement 的規劃）。
 * restart（只有正式環境）：{ date, slot } = 排程重啟，null = 不排程；note 寫進 Automation Schedule 的說明。
 */
async function afterDeployRepo({ stage, repo, commit, restart, note } = {}) {
  if (!COMMIT_STAGES.includes(stage) || typeof repo !== 'string') throw new Error('參數錯誤');
  if (stage === 'prodDeploy') {
    const args = ['-Repo', repo];
    if (typeof commit === 'string' && commit) args.push('-Commit', commit);
    args.push(...restartArgs(normalizeRestart(restart), note));
    const result = await runPowerShellJson('After-ProdDeploy.ps1', args, { timeout: RESTART_TIMEOUT });
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

/**
 * 監視 SaaS 佈版狀態的「重啟 App Service」：手動重啟某 repository 的測試環境 App Service（同 Test deploy 的佈版後動作）。
 * 正式環境刻意不提供（改用排程重啟，見 prodRestart.js）。
 */
async function restartTestAppService({ repo } = {}) {
  if (typeof repo !== 'string') throw new Error('參數錯誤');
  const r = await afterDeployRepo({ stage: 'testDeploy', repo });
  if (r.action !== 'restart') throw new Error(`${repo} 沒有設定測試環境 App Service（testAppService）`);
  return r;
}

module.exports = { runAfterDeploy, afterDeployRepo, restartTestAppService };
