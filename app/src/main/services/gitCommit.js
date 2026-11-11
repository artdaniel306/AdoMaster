const { REMOTE, fetchOrigin, resolveRepo, normalizeCommit, lookup, remoteRef } = require('./git');

/**
 * Confirm Commit：到本機 clone 的 repository 確認指定 commit 是否存在（data/config.json repos 的 `path`，見 repoConfig.js）。
 * 本機找不到（或不在 feature branch 上）時會 `git fetch --all` 一次再重查。
 * 佈版 merge 在 deployMerge.js、分支圖在 branchGraph.js、底層 git 操作在 git.js。
 */

/**
 * 確認 repo 中是否存在 commit。
 * @param branch 有指定時一併確認 commit 是否在這個 feature branch 上
 * @returns {{ ok, repo, commit, full?, subject?, author?, date?, branch?, onBranch?, fetched, message }}
 *   ok=false 代表找不到；設定錯誤（未設定路徑、路徑不存在、git 錯誤）則直接 throw。
 */
async function checkCommit({ repo, commit, branch } = {}) {
  if (typeof repo !== 'string') throw new Error('參數錯誤');
  commit = normalizeCommit(commit);
  if (branch != null && typeof branch !== 'string') throw new Error('參數錯誤');

  const r = await resolveRepo(repo);

  let fetched = false;
  let found = await lookup(r.path, commit, branch);
  if (!found || found.onBranch === false) {
    // 本機資料可能太舊：fetch 後再查一次
    try {
      await fetchOrigin(r, { all: true });
      fetched = true;
      found = await lookup(r.path, commit, branch);
    } catch (err) {
      if (!found) throw new Error(`${repo} 本機找不到 commit ${commit}，且 git fetch 失敗：${err.detail || err.message}`);
    }
  }

  const base = { repo, commit, branch: branch || null, fetched };
  if (!found) return { ...base, ok: false, message: `${repo} 找不到 commit ${commit}` };
  let message = `✓ ${found.full.slice(0, 10)} ${found.subject}`;
  if (found.onBranch === false) message += `（⚠ 不在 ${branch} 上，佈版時會先 merge 進 ${branch}）`;
  return { ...base, ok: true, ...found, message };
}

/**
 * 環境 branch 在 remote 的最新 commit（先 git fetch）。手動佈版的客戶環境用來預設帶入正式環境 branch 的 commit。
 * @returns {{ repo, branch, full, subject, author, date }}
 */
async function remoteBranchHead({ repo, branch } = {}) {
  if (typeof repo !== 'string' || typeof branch !== 'string' || !branch.trim()) throw new Error('參數錯誤');
  branch = branch.trim();
  const r = await resolveRepo(repo);
  await fetchOrigin(r);
  const ref = await remoteRef(r.path, repo, branch, '環境 branch');
  const found = await lookup(r.path, ref);
  if (!found) throw new Error(`${repo} 找不到 ${REMOTE}/${branch}`);
  return { repo, branch, ...found };
}

module.exports = { checkCommit, remoteBranchHead };
