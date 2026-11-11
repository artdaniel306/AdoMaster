const { requireRepo, fieldHint, DEPLOY_BRANCH_FIELDS } = require('./repoConfig');
const { checkMerged } = require('./deployMerge');
const { remoteBranchHead } = require('./gitCommit');
const localDeploy = require('./localDeploy');
const { CONFIG_LABEL } = require('./appConfig');

/**
 * 手動佈版的「客戶環境」：不 merge、不佈版，只在部署用資料夾以正式環境 branch 中的 commit build image tar 交給客戶
 * （config.json 的 customerDeploy.<saas|local>.<客戶>，build 在 localDeploy.runCustomerBuild）。
 * 工作的執行與其他手動佈版相同（manualDeploy.js）。
 */

/**
 * 開始前的檢查：commit 必須已在正式環境 branch（git fetch 後確認），只有一個 build 步驟。
 * @param p manualDeploy.normalizeParams 整理過的參數（env = 'customer'）
 * @returns 與 manualDeploy.preview 相同的結構，另加 customer
 */
async function previewCustomer(p) {
  const r = await requireRepo(p.repo);
  const t = await localDeploy.customerTarget(p.repo, p.target, p.customer);
  if (!t) throw new Error(`${CONFIG_LABEL} 尚未設定 customerDeploy.${p.target}.${p.customer}`);
  const errors = [];
  const warnings = [];
  let merge = null;
  if (t.error) errors.push(t.error);
  else {
    const m = await checkMerged({ repo: p.repo, commit: p.commit, targetBranch: t.envBranch });
    const short = m.full.slice(0, 10);
    merge = { ...m, merged: m.merged, canMerge: false, message: m.merged ? `✓ ${short} 已在正式環境 branch ${t.envBranch}` : `${short} 不在正式環境 branch ${t.envBranch}` };
    if (!m.merged) errors.push(`客戶環境只能打包已在正式環境 branch（${t.envBranch}）的 commit`);
  }
  if (!t.error) {
    warnings.push(
      t.envRemoved
        ? `build 時移除部署用資料夾的 ${t.envTarget}（套用客戶環境設定的變數），完成後還原。`
        : `build 時使用 env 檔 ${t.envFile} → ${t.envTarget}，完成後還原部署用資料夾原本的檔案。`,
    );
  }
  const steps = [{ key: 'customerBuild', label: `Build ${t.appName} image tar（${t.customerLabel}，${t.platform}）` }];
  const customer = { key: t.customer, label: t.customerLabel, appName: t.appName, envFile: t.envFile, envTarget: t.envTarget, envRemoved: t.envRemoved };
  return { params: p, label: r.label, envBranch: t.envBranch, merge, pipeline: null, appService: '', local: null, release: null, customer, steps, warnings, errors };
}

/** 預設 commit：正式環境 branch 在 remote 的最新 commit */
async function prodHead({ repo } = {}) {
  const r = await requireRepo(repo);
  const branch = r.deployBranches.prodDeploy;
  if (!branch) throw new Error(`尚未設定 ${repo} 的正式環境 branch，請在 ${fieldHint(repo, DEPLOY_BRANCH_FIELDS.prodDeploy)} 設定`);
  return remoteBranchHead({ repo, branch });
}

module.exports = { previewCustomer, prodHead, customers: localDeploy.listCustomers };
