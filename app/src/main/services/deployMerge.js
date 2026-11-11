const {
  REMOTE,
  git,
  fetchOrigin,
  resolveRepo,
  normalizeCommit,
  lookup,
  isAncestor,
  remoteRef,
  trialMerge,
  commitAndPush,
  restorePaths,
} = require('./git');

/**
 * 佈版的 merge：把 commit merge 進環境 / feature branch、正式環境後反向 merge 回 feature branch。
 * 一律建立 merge commit（等同 `git merge --no-ff`），不 checkout、不動本機 working tree、不 --force push；有衝突就拒絕。
 * 底層 git 操作在 git.js。
 */

/* ---------- 單一 branch：merge commit 進 targetBranch ---------- */

/**
 * 確認 commit 是否已進到 origin/<targetBranch>（環境 branch 或 feature branch）。
 * 「已進到」= commit 是 targetBranch 的祖先（不論當初是 merge commit 或 fast-forward）。
 * 尚未 merge 時順便試算 merge 是否有衝突。
 * @param fetch 先 git fetch 取得 remote 最新狀態（預設 true）
 * @returns {{ repo, commit, full, subject, targetBranch, merged, canMerge, conflicts, message }}
 */
async function checkMerged({ repo, commit, targetBranch, fetch = true } = {}) {
  if (typeof repo !== 'string' || typeof targetBranch !== 'string' || !targetBranch.trim()) throw new Error('參數錯誤');
  commit = normalizeCommit(commit);
  targetBranch = targetBranch.trim();
  const r = await resolveRepo(repo);
  if (fetch) await fetchOrigin(r);
  const found = await lookup(r.path, commit);
  if (!found) throw new Error(`${repo} 找不到 commit ${commit}`);
  const ref = await remoteRef(r.path, repo, targetBranch, 'branch');

  const merged = await isAncestor(r.path, found.full, ref);
  const { conflicts } = merged ? { conflicts: [] } : await trialMerge(r.path, ref, found.full);
  const canMerge = !merged && !conflicts.length;
  const short = found.full.slice(0, 10);
  const message = merged
    ? `✓ ${short} 已在 ${targetBranch}`
    : canMerge
      ? `${short} 尚未 merge 進 ${targetBranch}`
      : `${short} merge 進 ${targetBranch} 會有衝突，請手動處理：${conflicts.join(', ')}`;
  return { repo, commit, full: found.full, subject: found.subject, targetBranch, merged, canMerge, conflicts, message };
}

/**
 * 將 commit merge 進 origin/<targetBranch>，一律建立 merge commit（即使可以 fast-forward）：
 *   git merge-tree --write-tree origin/<target> <commit>  → tree
 *   git commit-tree <tree> -p origin/<target> -p <commit> → merge commit
 *   git push origin <merge commit>:refs/heads/<target>
 * @returns 最新的 checkMerged 結果，另加 mergeCommit（push 上去的 merge commit，用來找出 push 觸發的 Pipeline Run；已在其中時沒有）
 */
async function mergeNoFf({ repo, commit, targetBranch, message } = {}) {
  const status = await checkMerged({ repo, commit, targetBranch });
  if (status.merged) return status;
  if (!status.canMerge) throw new Error(status.message);
  const r = await resolveRepo(repo);
  const ref = `refs/remotes/${REMOTE}/${status.targetBranch}`;
  const base = (await git(r.path, ['rev-parse', '--verify', ref])).trim();
  const { tree, conflicts } = await trialMerge(r.path, base, status.full);
  if (!tree) throw new Error(`${repo} merge 進 ${status.targetBranch} 會有衝突：${conflicts.join(', ')}`);

  const msg = typeof message === 'string' && message.trim()
    ? message.trim()
    : `Merge commit '${status.full.slice(0, 10)}' into ${status.targetBranch}`;
  const mergeCommit = await commitAndPush(r, { tree, base, source: status.full, target: status.targetBranch, message: msg });
  return { ...(await checkMerged({ repo, commit, targetBranch })), mergeCommit };
}

/* ---------- 流程佈版：開發 branch → feature branch → 環境 branch ---------- */

/** 「帶進環境 branch 的額外 commit」最多列出幾筆 */
const EXTRA_LIMIT = 20;

/**
 * Confirm Commit 已在 feature branch 中時，找出它「進到 feature branch」的那個 commit：
 * feature branch first-parent 鏈上最舊、已包含 commit 的 commit（通常是當初 merge 開發 branch 的 merge commit；
 * commit 直接 commit 在 feature branch 上時就是它自己）。merge 進環境 branch 時用它，才不會連帶 feature branch 之後的 commit。
 */
async function featureEntry(cwd, full, featureRef) {
  const chain = (await git(cwd, ['rev-list', '--first-parent', `${full}..${featureRef}`])).split(/\r?\n/).filter(Boolean);
  if (!chain.length) return full; // commit 就是 feature branch 的最新 commit
  // chain 由新到舊；「包含 commit」在 first-parent 鏈上是單調的：二分搜尋最舊的那一個
  let lo = 0;
  let hi = chain.length - 1; // chain[0]（最新）一定包含
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (await isAncestor(cwd, full, chain[mid])) lo = mid;
    else hi = mid - 1;
  }
  const entry = chain[lo];
  const firstParent = (await git(cwd, ['rev-parse', `${entry}^1`]).catch(() => '')).trim();
  return firstParent === full ? full : entry;
}

/** source 會帶進環境 branch、但不在 Confirm Commit 中的 commit（feature branch 上其他人的變更） */
async function extraCommits(cwd, source, full, envRef) {
  if (source === full) return [];
  const out = await git(cwd, ['log', '--oneline', '--no-decorate', '--no-merges', `--max-count=${EXTRA_LIMIT + 1}`, source, '--not', envRef, full, '--']);
  return out.split(/\r?\n/).filter(Boolean);
}

/**
 * 佈版的 merge 狀態：Confirm Commit 一律「開發 branch → feature branch → 環境 branch」，不直接 merge 進環境 branch。
 *   1. commit 不在 origin/<featureBranch> → 先以 merge commit（--no-ff）merge 進 feature branch（已在其中則略過）
 *   2. 再把 feature branch 上包含它的 commit（featureEntry；第 1 步建立的 merge commit）merge 進 origin/<envBranch>
 * source（例：UpAgent 的版本 tag `v1.2.3`）：直接把它 merge 進環境 branch（它已在 feature branch 上），不做第 1 步；
 *   「已 merge」= source 已在環境 branch 中。source 不包含 Confirm Commit 時不能 merge。
 * deferred = true（UpAgent 尚未更版）：環境 branch 由 UpAgent 發佈在更版後 merge，這裡只檢查第 1 步會不會衝突。
 * 只試算、不 push（第 1 步的 merge commit 只在本機建立物件來試算第 2 步）。
 * @returns {{ repo, commit, full, subject, featureBranch, envBranch, sourceRef, source, sourceLabel, inFeature, merged, deferred,
 *             canMerge, conflicts, extra: string[], extraMore, message }}
 */
async function checkDeployMerge({ repo, commit, featureBranch, envBranch, source = null, deferred = false, fetch = true } = {}) {
  if (typeof repo !== 'string' || typeof envBranch !== 'string' || !envBranch.trim()) throw new Error('參數錯誤');
  if (typeof featureBranch !== 'string' || !featureBranch.trim()) throw new Error(`${repo} 沒有 feature branch（請確認規劃）`);
  commit = normalizeCommit(commit);
  envBranch = envBranch.trim();
  featureBranch = featureBranch.trim();
  const r = await resolveRepo(repo);
  if (fetch) await fetchOrigin(r, { tags: !!source }); // 有指定 source（版本 tag）時連 tag 一起 fetch
  const found = await lookup(r.path, commit);
  if (!found) throw new Error(`${repo} 找不到 commit ${commit}`);
  const envRef = await remoteRef(r.path, repo, envBranch, '環境 branch');
  const featureRef = await remoteRef(r.path, repo, featureBranch, 'feature branch');
  const short = found.full.slice(0, 10);
  const base = { repo, commit, full: found.full, subject: found.subject, featureBranch, envBranch, sourceRef: source, deferred, extra: [], extraMore: false, conflicts: [] };
  const inFeature = await isAncestor(r.path, found.full, featureRef);

  if (deferred) {
    const { conflicts } = inFeature ? { conflicts: [] } : await trialMerge(r.path, featureRef, found.full);
    const message = conflicts.length
      ? `${short} merge 進 ${featureBranch} 會有衝突，請手動處理：${conflicts.join(', ')}`
      : `UpAgent 發佈時${inFeature ? '' : `先 merge 進 ${featureBranch}、`}更版後再 merge 進 ${envBranch}`;
    return { ...base, source: null, sourceLabel: '', inFeature, merged: false, canMerge: !conflicts.length, conflicts, message };
  }

  let sourceFull;
  let sourceLabel;
  if (source) {
    sourceFull = await git(r.path, ['rev-parse', '--verify', '--quiet', `${source}^{commit}`]).then((s) => s.trim(), () => '');
    if (!sourceFull) throw new Error(`${repo} 找不到 ${source}`);
    sourceLabel = source;
  }
  const target = sourceFull || found.full;
  if (await isAncestor(r.path, target, envRef)) {
    return { ...base, source: sourceFull || null, sourceLabel: sourceLabel || '', inFeature, merged: true, canMerge: false, message: `✓ ${sourceLabel || short} 已在 ${envBranch}` };
  }
  const fail = (message, conflicts = []) => ({ ...base, source: sourceFull || null, sourceLabel: sourceLabel || '', inFeature, merged: false, canMerge: false, conflicts, message });

  if (sourceFull) {
    if (!(await isAncestor(r.path, found.full, sourceFull))) return fail(`${sourceLabel} 不包含 Confirm Commit ${short}，無法 merge 進 ${envBranch}`);
  } else if (inFeature) {
    sourceFull = await featureEntry(r.path, found.full, featureRef);
    sourceLabel = sourceFull === found.full ? short : `${featureBranch} ${sourceFull.slice(0, 10)}`;
  } else {
    // 第 1 步：試算 merge 進 feature branch；沒有衝突時在本機建立 merge commit 物件（不 push）來試算第 2 步
    const { tree, conflicts } = await trialMerge(r.path, featureRef, found.full);
    if (!tree) return fail(`${short} merge 進 ${featureBranch} 會有衝突，請手動處理：${conflicts.join(', ')}`, conflicts);
    const featureTip = (await git(r.path, ['rev-parse', '--verify', featureRef])).trim();
    sourceFull = (await git(r.path, ['commit-tree', tree, '-p', featureTip, '-p', found.full, '-m', 'AdoMaster trial merge'])).trim();
    sourceLabel = featureBranch;
  }

  const { conflicts } = await trialMerge(r.path, envRef, sourceFull);
  if (conflicts.length) return fail(`${sourceLabel} merge 進 ${envBranch} 會有衝突，請手動處理：${conflicts.join(', ')}`, conflicts);
  const extra = await extraCommits(r.path, sourceFull, found.full, envRef);
  const route = source ? `${sourceLabel} 尚未 merge 進 ${envBranch}` : inFeature ? `${short} 已在 ${featureBranch}，尚未 merge 進 ${envBranch}` : `${short} 會先 merge 進 ${featureBranch}，再 merge 進 ${envBranch}`;
  return {
    ...base,
    source: inFeature || source ? sourceFull : null, // 試算用的 merge commit 物件不回傳
    sourceLabel,
    inFeature,
    merged: false,
    canMerge: true,
    extra: extra.slice(0, EXTRA_LIMIT),
    extraMore: extra.length > EXTRA_LIMIT,
    message: extra.length ? `${route}（⚠ 會一起帶進 ${extra.length > EXTRA_LIMIT ? `${EXTRA_LIMIT}+` : extra.length} 個不在 Confirm Commit 中的 commit）` : route,
  };
}

/**
 * 佈版 merge（見 checkDeployMerge）：需要時先把 Confirm Commit merge 進 feature branch 並 push，
 * 再把 feature branch 上的對應 commit（或指定的 source）merge 進環境 branch 並 push。
 * @param reqId 寫進 merge commit 訊息
 * @returns 最新的 checkDeployMerge 結果，另加 mergeCommit（push 到環境 branch 的 merge commit）、featureMergeCommit（第 1 步，有做才有）
 */
async function mergeViaFeature({ repo, commit, featureBranch, envBranch, source = null, reqId } = {}) {
  const status = await checkDeployMerge({ repo, commit, featureBranch, envBranch, source });
  if (status.merged) return status;
  if (!status.canMerge) throw new Error(status.message);
  const tail = reqId ? `\n\nRequirement #${reqId}` : '';
  let from = status.source;
  let featureMergeCommit;
  if (!from) {
    const fm = await mergeNoFf({ repo, commit: status.full, targetBranch: featureBranch, message: `Merge ${status.full.slice(0, 10)} into ${featureBranch}${tail}` });
    featureMergeCommit = fm.mergeCommit;
    from = featureMergeCommit || (await featureEntry((await resolveRepo(repo)).path, status.full, `refs/remotes/${REMOTE}/${featureBranch}`));
  }
  const label = source || featureBranch;
  const em = await mergeNoFf({ repo, commit: from, targetBranch: envBranch, message: `Merge ${label} (${from.slice(0, 10)}) into ${envBranch}${tail}` });
  return { ...(await checkDeployMerge({ repo, commit, featureBranch, envBranch, source, fetch: false })), mergeCommit: em.mergeCommit, featureMergeCommit };
}

/* ---------- 正式環境之後：反向 merge 回 feature branch ---------- */

/** path 是否等於 keep 中的某個路徑或在它底下 */
const underAny = (p, keep) => keep.some((k) => p === k || p.startsWith(`${k}/`));

/**
 * 正式環境 merge 完之後：把 origin/<fromBranch>（prodBranch）反向 merge 回該 repository 設定的所有 feature branch
 * （data/config.json repos 的 `branches`；環境 branch 本身除外），讓 feature branch 都以 production 為基礎。
 * repos 的 `backMergeKeepPaths`（{ "<feature branch>": ["<路徑>", ...] }，例：peach_101 的 tenant_db/migrations）：
 *   merge 後把這些路徑還原成該 feature branch 原本的內容（production 對它們的改動不帶進來）；
 *   只在這些路徑內的衝突也一併以 feature branch 的版本解決。
 * 個別 branch 失敗不影響其他 branch，也不丟錯（正式環境已經 push 了），結果逐一回報：
 *   state：'merged' 已建立 merge commit 並 push | 'upToDate' 已包含 | 'missing' remote 沒有此 branch
 *          | 'conflict' 有衝突（請手動處理）| 'failed' 其他錯誤
 * @param reqId Requirement id（寫進 merge commit 訊息，方便追蹤）
 * @returns {{ repo, from, items: [{ branch, state, message, mergeCommit? }] }}
 */
async function mergeBackToFeatures({ repo, fromBranch, reqId } = {}) {
  if (typeof repo !== 'string' || typeof fromBranch !== 'string' || !fromBranch.trim()) throw new Error('參數錯誤');
  fromBranch = fromBranch.trim();
  const r = await resolveRepo(repo);
  await fetchOrigin(r);
  let source;
  try {
    source = (await git(r.path, ['rev-parse', '--verify', `refs/remotes/${REMOTE}/${fromBranch}^{commit}`])).trim();
  } catch {
    throw new Error(`${repo} 的 remote 沒有 ${REMOTE}/${fromBranch}`);
  }

  const envBranches = new Set(Object.values(r.deployBranches).filter(Boolean));
  const branches = r.branches.filter((b) => !envBranches.has(b));
  const items = [];
  // 同一個 repository 依序處理（同一個 clone 的 git 指令不並行）
  for (const branch of branches) {
    const item = { branch };
    try {
      await git(r.path, ['check-ref-format', `refs/heads/${branch}`]).catch(() => {
        throw new Error(`branch 名稱不正確：${branch}`);
      });
      const ref = `refs/remotes/${REMOTE}/${branch}`;
      const base = await git(r.path, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then((s) => s.trim(), () => null);
      if (!base) {
        Object.assign(item, { state: 'missing', message: `remote 沒有 ${REMOTE}/${branch}，略過` });
      } else if (await isAncestor(r.path, source, base)) {
        Object.assign(item, { state: 'upToDate', message: `✓ ${branch} 已包含 ${fromBranch}` });
      } else {
        const keep = r.backMergeKeepPaths[branch] || [];
        let { tree, conflicts } = await trialMerge(r.path, base, source, { keepConflictTree: keep.length > 0 });
        const realConflicts = conflicts.filter((p) => !underAny(p, keep));
        if (realConflicts.length) {
          Object.assign(item, { state: 'conflict', message: `merge 會有衝突，請手動處理：${realConflicts.join(', ')}` });
        } else {
          if (keep.length) tree = await restorePaths(r.path, tree, base, keep);
          const kept = keep.length ? `\n\nKeep ${branch} version of: ${keep.join(', ')}` : '';
          const message = `Merge ${fromBranch} (${source.slice(0, 10)}) into ${branch}${kept}${reqId ? `\n\nRequirement #${reqId}` : ''}`;
          item.mergeCommit = await commitAndPush(r, { tree, base, source, target: branch, message });
          const note = keep.length ? `（${keep.join(', ')} 保留 ${branch} 原本的內容）` : '';
          Object.assign(item, { state: 'merged', message: `✓ 已建立 merge commit ${item.mergeCommit.slice(0, 10)} 並 push${note}` });
        }
      }
    } catch (err) {
      Object.assign(item, { state: 'failed', message: err.message });
    }
    items.push(item);
  }
  return { repo, from: fromBranch, items };
}

module.exports = { checkMerged, mergeNoFf, checkDeployMerge, mergeViaFeature, mergeBackToFeatures };
