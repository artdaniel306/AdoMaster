const { requireRepo } = require('./repoConfig');
const { mergeBackToFeatures } = require('./deployMerge');

/**
 * 選單「Git → 同步 prod 至 feature…」：手動把各 repository 的 origin/<prodBranch> 反向 merge 回其所有 feature branch，
 * 與正式環境佈版 merge 後做的事相同（deployMerge.mergeBackToFeatures：一律建立 merge commit、不動 working tree、
 * 不 --force push、有衝突就略過該 branch；backMergeKeepPaths 同樣適用）。
 * 不同 repository 並行處理（同一個 clone 的 git 指令由 pathLock 排隊）；個別 repository 失敗不丟錯，記在結果裡。
 * @param repos 要同步的 repository key 陣列
 * @returns {{ backMerges: { [repo]: [{ branch, state, message, mergeCommit? }] } }}（格式同 requirementFlow.mergeDeploy 的 backMerges）
 */
async function syncProdToFeatures({ repos } = {}) {
  if (!Array.isArray(repos) || !repos.length || !repos.every((k) => typeof k === 'string')) throw new Error('請選擇 repository');
  const entries = await Promise.all(
    [...new Set(repos)].map(async (key) => {
      try {
        const r = await requireRepo(key);
        const prodBranch = r.deployBranches.prodDeploy;
        if (!prodBranch) throw new Error('Repository 設定沒有正式環境 branch（prodBranch）');
        return [key, (await mergeBackToFeatures({ repo: key, fromBranch: prodBranch })).items];
      } catch (err) {
        return [key, [{ branch: '', state: 'failed', message: err.message }]];
      }
    })
  );
  return { backMerges: Object.fromEntries(entries) };
}

module.exports = { syncProdToFeatures };
