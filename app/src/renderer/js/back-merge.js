import { el } from './dom.js';
import { repoTag } from './repos.js';

/**
 * Prod deploy merge 後「prodBranch 反向 merge 回 feature branch」的結果（mergeDeploy 回傳的 backMerges）。
 * merge-dialog.js / deploy-dialog.js 共用。
 */

const STATE_CLASS = { merged: 'ok', upToDate: 'ok', missing: 'warn', conflict: 'bad', failed: 'bad' };

/** backMerges 是否有任何結果 */
export const hasBackMerges = (backMerges) => Object.values(backMerges || {}).some((items) => items.length);

/** 是否有 branch 衝突 / 失敗（需要手動處理） */
export const backMergeProblems = (backMerges) =>
  Object.values(backMerges || {}).some((items) => items.some((x) => x.state === 'conflict' || x.state === 'failed'));

/**
 * 每個 feature branch 一列：repository 標籤、`<prodBranch> → <feature>`、結果。
 * @param backMerges { repo: [{ branch, state, message, mergeCommit? }] }
 * @param fromOf (repo) => prodBranch 名稱
 */
export function backMergeRows(backMerges, fromOf) {
  return Object.entries(backMerges || {}).flatMap(([repo, items]) =>
    items.map((x) => {
      const row = el('div', 'mg-item');
      const name = el('div', 'cc-name');
      const from = fromOf(repo);
      name.append(repoTag(repo), el('code', 'repo-commit', x.branch ? `${from || ''} → ${x.branch}` : `${from || ''} → feature branch`));
      const result = el('div', `cc-result ${STATE_CLASS[x.state] || 'bad'}`, x.message);
      if (x.mergeCommit) result.title = x.mergeCommit;
      row.append(name, result);
      return row;
    })
  );
}
