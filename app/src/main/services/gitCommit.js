const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Anser = require('anser');
const { loadRepoConfig, fieldHint } = require('./repoConfig');
const { COMMIT_RE, COMMIT_FORMAT_HINT } = require('../../shared/flow-rules.js');

/**
 * Confirm Commit：到本機 clone 的 repository 確認指定 commit 是否存在。
 * repository 的位置由 data/config.json 的 repos 各 repository 的 `path` 設定（見 repoConfig.js）。
 * 本機找不到（或不在 feature branch 上）時會 `git fetch` 一次再重查。
 */

const FETCH_TIMEOUT = 60_000;

function git(cwd, args, timeout = 15_000, extraEnv = null) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...extraEnv }, // fetch 需要帳密時直接失敗，不要卡住
      },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') err.message = '找不到 git 指令，請確認 git 已安裝並加入 PATH';
          err.stdout = String(stdout || '');
          err.stderr = String(stderr || '');
          reject(err);
        } else resolve(String(stdout));
      }
    );
  });
}

/** 查 commit：找到回傳 { full, subject, author, date, onBranch }，找不到回傳 null */
async function lookup(cwd, commit, branch) {
  let out;
  try {
    out = await git(cwd, ['log', '-1', '--format=%H%x00%s%x00%an%x00%ci', `${commit}^{commit}`, '--']);
  } catch (err) {
    if (/ambiguous/i.test(err.stderr)) throw new Error(`commit ${commit} 不唯一，請多輸入幾碼`);
    return null; // unknown revision 等
  }
  const [full, subject, author, date] = out.trim().split('\0');
  let onBranch = null;
  if (branch) {
    // 本機 branch 或任何 remote 上同名的 branch 包含此 commit 即視為在 feature branch 上
    const refs = (await git(cwd, ['branch', '-a', '--contains', full, '--format=%(refname)']).catch(() => ''))
      .split(/\r?\n/)
      .filter(Boolean);
    onBranch = refs.some((r) => r === `refs/heads/${branch}` || (r.startsWith('refs/remotes/') && r.endsWith(`/${branch}`)));
  }
  return { full, subject, author, date, onBranch };
}

/**
 * 確認 repo 中是否存在 commit。
 * @returns {{ ok, repo, commit, full?, subject?, author?, date?, branch?, onBranch?, fetched, message }}
 *   ok=false 代表找不到；設定錯誤（未設定路徑、路徑不存在、git 錯誤）則直接 throw。
 */
/** 讀取 data/config.json 的 repos 中 repo 的設定，並確認本機 clone 的路徑存在 */
async function resolveRepo(repo) {
  const config = await loadRepoConfig();
  const r = config.repos.find((x) => x.key === repo);
  if (!r) throw new Error(`未知的 repository：${repo}`);
  if (!r.path) throw new Error(`尚未設定 ${repo} 的位置，請在 ${fieldHint(repo, 'path')} 設定本機 clone 的路徑`);
  try {
    if (!(await fs.stat(r.path)).isDirectory()) throw new Error();
  } catch {
    throw new Error(`${fieldHint(repo, 'path')} 指定的路徑不存在：${r.path}`);
  }
  return r;
}

function normalizeCommit(commit) {
  if (typeof commit !== 'string') throw new Error('參數錯誤');
  commit = commit.trim().toLowerCase();
  if (!COMMIT_RE.test(commit)) throw new Error(`commit 格式錯誤（${COMMIT_FORMAT_HINT}）`);
  return commit;
}

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
      await git(r.path, ['fetch', '--all', '--quiet', '--no-tags'], FETCH_TIMEOUT);
      fetched = true;
      found = await lookup(r.path, commit, branch);
    } catch (err) {
      if (!found) throw new Error(`${repo} 本機找不到 commit ${commit}，且 git fetch 失敗：${(err.stderr || err.message).trim()}`);
    }
  }

  const base = { repo, commit, branch: branch || null, fetched };
  if (!found) return { ...base, ok: false, message: `${repo} 找不到 commit ${commit}` };
  let message = `✓ ${found.full.slice(0, 10)} ${found.subject}`;
  if (found.onBranch === false) message += `（⚠ 不在 ${branch} 上，佈版時會先 merge 進 ${branch}）`;
  return { ...base, ok: true, ...found, message };
}

/* ---------- 環境 branch（Test deploy / Prod deploy）---------- */

/** 環境 branch 一律以這個 remote 為準（本機 branch 可能沒更新或根本沒 checkout） */
const REMOTE = 'origin';

/** `git merge-base --is-ancestor a b`：a 是否在 b 的歷史中（exit 0 = 是、1 = 否、其他 = 錯誤） */
async function isAncestor(cwd, a, b) {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch (err) {
    if (err.code === 1) return false;
    throw new Error(`git merge-base 失敗：${(err.stderr || err.message).trim()}`);
  }
}

/**
 * 不 checkout 試算 merge：`git merge-tree --write-tree`（git 2.38+）。
 * @param keepConflictTree 有衝突時仍回傳 tree（含衝突標記；呼叫端要自己把衝突的路徑換掉）
 * @returns {{ tree: string|null, conflicts: string[] }} 有衝突時 tree 為 null（keepConflictTree 除外）
 */
async function trialMerge(cwd, base, commit, { keepConflictTree = false } = {}) {
  try {
    const out = await git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, commit]);
    return { tree: out.split(/\r?\n/)[0].trim(), conflicts: [] };
  } catch (err) {
    if (err.code === 1) {
      // exit 1 = 有衝突：第一行是 tree，之後是衝突的檔案
      const lines = String(err.stdout || '').split(/\r?\n/);
      const conflicts = [...new Set(lines.slice(1).filter(Boolean))];
      return { tree: keepConflictTree ? lines[0].trim() || null : null, conflicts };
    }
    throw new Error(`git merge-tree 失敗（需要 git 2.38 以上）：${(err.stderr || err.message).trim()}`);
  }
}

/**
 * 確認 commit 是否已進到 repo 的環境 branch（origin/<envBranch>）。
 * 「已進到」= commit 是環境 branch 的祖先（不論當初是 merge commit 或 fast-forward）。
 * 尚未 merge 時順便試算 merge 是否有衝突。
 * @param fetch 先 git fetch 取得 remote 最新狀態（預設 true）
 * @returns {{ repo, commit, full, envBranch, merged, canMerge, conflicts, message }}
 */
async function checkMerged({ repo, commit, envBranch, fetch = true } = {}) {
  if (typeof repo !== 'string' || typeof envBranch !== 'string' || !envBranch.trim()) throw new Error('參數錯誤');
  commit = normalizeCommit(commit);
  envBranch = envBranch.trim();
  const r = await resolveRepo(repo);
  try {
    await git(r.path, ['check-ref-format', `refs/heads/${envBranch}`]);
  } catch {
    throw new Error(`${repo} 的環境 branch 名稱不正確：${envBranch}`);
  }

  if (fetch) {
    try {
      await git(r.path, ['fetch', REMOTE, '--quiet', '--no-tags'], FETCH_TIMEOUT);
    } catch (err) {
      throw new Error(`${repo} git fetch ${REMOTE} 失敗：${(err.stderr || err.message).trim()}`);
    }
  }
  const found = await lookup(r.path, commit);
  if (!found) throw new Error(`${repo} 找不到 commit ${commit}`);
  const ref = `refs/remotes/${REMOTE}/${envBranch}`;
  try {
    await git(r.path, ['rev-parse', '--verify', '--quiet', ref]);
  } catch {
    throw new Error(`${repo} 的 remote 沒有環境 branch ${REMOTE}/${envBranch}`);
  }

  const merged = await isAncestor(r.path, found.full, ref);
  const { conflicts } = merged ? { conflicts: [] } : await trialMerge(r.path, ref, found.full);
  const canMerge = !merged && !conflicts.length;
  const short = found.full.slice(0, 10);
  const message = merged
    ? `✓ ${short} 已在 ${envBranch}`
    : canMerge
      ? `${short} 尚未 merge 進 ${envBranch}`
      : `${short} merge 進 ${envBranch} 會有衝突，請手動處理：${conflicts.join(', ')}`;
  return { repo, commit, full: found.full, subject: found.subject, envBranch, merged, canMerge, conflicts, message };
}

/**
 * 將 commit merge 進環境 branch，一律建立 merge commit（等同 `git merge --no-ff`，即使可以 fast-forward）。
 * 不 checkout、不動本機 working tree：
 *   git merge-tree --write-tree origin/<env> <commit>  → tree
 *   git commit-tree <tree> -p origin/<env> -p <commit> → merge commit
 *   git push origin <merge commit>:refs/heads/<env>    （不加 --force；remote 期間有變動會被拒絕）
 * merge commit 的作者 / committer 用該 repository 的 git user 設定。
 */
async function mergeNoFf({ repo, commit, envBranch, message } = {}) {
  const status = await checkMerged({ repo, commit, envBranch });
  if (status.merged) return status;
  if (!status.canMerge) throw new Error(status.message);
  const r = await resolveRepo(repo);
  const ref = `refs/remotes/${REMOTE}/${status.envBranch}`;
  const base = (await git(r.path, ['rev-parse', '--verify', ref])).trim();
  const { tree, conflicts } = await trialMerge(r.path, base, status.full);
  if (!tree) throw new Error(`${repo} merge 進 ${status.envBranch} 會有衝突：${conflicts.join(', ')}`);

  const msg = typeof message === 'string' && message.trim()
    ? message.trim()
    : `Merge commit '${status.full.slice(0, 10)}' into ${status.envBranch}`;
  const mergeCommit = await commitAndPush(r, { tree, base, source: status.full, target: status.envBranch, message: msg });
  // mergeCommit：push 上去的 merge commit（用來找出 push 觸發的 Pipeline Run）
  return { ...(await checkMerged({ repo, commit, envBranch })), mergeCommit };
}

/* ---------- 佈版：開發 branch → feature branch → 環境 branch ---------- */

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

/** 確認 remote 有此 branch，回傳 refs/remotes/origin/<branch> */
async function remoteRef(cwd, repo, branch, label) {
  try {
    await git(cwd, ['check-ref-format', `refs/heads/${branch}`]);
  } catch {
    throw new Error(`${repo} 的 ${label} 名稱不正確：${branch}`);
  }
  const ref = `refs/remotes/${REMOTE}/${branch}`;
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', ref]);
  } catch {
    throw new Error(`${repo} 的 remote 沒有 ${label} ${REMOTE}/${branch}`);
  }
  return ref;
}

/**
 * 環境 branch 在 remote 的最新 commit（先 git fetch）。手動佈版的客戶環境用來預設帶入正式環境 branch 的 commit。
 * @returns {{ repo, branch, full, subject, author, date }}
 */
async function remoteBranchHead({ repo, branch } = {}) {
  if (typeof repo !== 'string' || typeof branch !== 'string' || !branch.trim()) throw new Error('參數錯誤');
  branch = branch.trim();
  const r = await resolveRepo(repo);
  try {
    await git(r.path, ['fetch', REMOTE, '--quiet', '--no-tags'], FETCH_TIMEOUT);
  } catch (err) {
    throw new Error(`${repo} git fetch ${REMOTE} 失敗：${(err.stderr || err.message).trim()}`);
  }
  const ref = await remoteRef(r.path, repo, branch, '環境 branch');
  const found = await lookup(r.path, ref);
  if (!found) throw new Error(`${repo} 找不到 ${REMOTE}/${branch}`);
  return { repo, branch, ...found };
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
  if (fetch) {
    try {
      // 有指定 source（版本 tag）時連 tag 一起 fetch
      await git(r.path, ['fetch', REMOTE, '--quiet', source ? '--tags' : '--no-tags'], FETCH_TIMEOUT);
    } catch (err) {
      throw new Error(`${repo} git fetch ${REMOTE} 失敗：${(err.stderr || err.message).trim()}`);
    }
  }
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
 * 再把 feature branch 上的對應 commit（或指定的 source）merge 進環境 branch 並 push。都一律建立 merge commit、不動 working tree、不 --force。
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
    const fm = await mergeNoFf({ repo, commit: status.full, envBranch: featureBranch, message: `Merge ${status.full.slice(0, 10)} into ${featureBranch}${tail}` });
    featureMergeCommit = fm.mergeCommit;
    from = featureMergeCommit || (await featureEntry((await resolveRepo(repo)).path, status.full, `refs/remotes/${REMOTE}/${featureBranch}`));
  }
  const label = source || featureBranch;
  const em = await mergeNoFf({ repo, commit: from, envBranch, message: `Merge ${label} (${from.slice(0, 10)}) into ${envBranch}${tail}` });
  return { ...(await checkDeployMerge({ repo, commit, featureBranch, envBranch, source, fetch: false })), mergeCommit: em.mergeCommit, featureMergeCommit };
}

/**
 * 以 trialMerge 算出的 tree 建立 merge commit（第一個 parent = base、第二個 = source）並 push 到 origin/<target>。
 * base 必須是 origin/<target> 目前的 commit；push 不加 --force，remote 期間有變動會被拒絕。
 * @returns 建立的 merge commit
 */
async function commitAndPush(r, { tree, base, source, target, message }) {
  let mergeCommit;
  try {
    mergeCommit = (await git(r.path, ['commit-tree', tree, '-p', base, '-p', source, '-m', message])).trim();
  } catch (err) {
    throw new Error(`${r.key} 建立 merge commit 失敗：${(err.stderr || err.message).trim()}`);
  }
  try {
    await git(r.path, ['push', '--quiet', REMOTE, `${mergeCommit}:refs/heads/${target}`], FETCH_TIMEOUT);
  } catch (err) {
    throw new Error(`${r.key} push 到 ${REMOTE}/${target} 失敗：${(err.stderr || err.message).trim()}`);
  }
  return mergeCommit;
}

/** path 是否等於 keep 中的某個路徑或在它底下 */
const underAny = (p, keep) => keep.some((k) => p === k || p.startsWith(`${k}/`));

/**
 * 把 tree 中 keep 的路徑換回 base（feature branch merge 前）的內容，回傳新的 tree：
 * 等同 merge 後 `git checkout <base> -- <path>`（base 沒有的路徑則刪掉）。
 * 用暫存的 index 檔（GIT_INDEX_FILE）操作，不動本機 clone 的 index / working tree。
 */
async function restorePaths(cwd, tree, base, keep) {
  const indexFile = path.join(os.tmpdir(), `adomaster-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: indexFile };
  const run = (args) => git(cwd, args, 15_000, env);
  try {
    await run(['read-tree', tree]);
    for (const p of keep) {
      await run(['rm', '-r', '-f', '-q', '--cached', '--ignore-unmatch', '--', `:(literal)${p}`]);
      const type = await git(cwd, ['cat-file', '-t', `${base}:${p}`]).then((s) => s.trim(), () => '');
      if (type === 'tree') {
        await run(['read-tree', `--prefix=${p}/`, `${base}:${p}`]);
      } else if (type === 'blob') {
        const [meta] = (await git(cwd, ['ls-tree', base, '--', `:(literal)${p}`])).split('\t');
        const [mode, , sha] = meta.trim().split(/\s+/);
        await run(['update-index', '--add', '--cacheinfo', `${mode},${sha},${p}`]);
      }
    }
    return (await run(['write-tree'])).trim();
  } catch (err) {
    throw new Error(`還原 ${keep.join(', ')} 失敗：${(err.stderr || err.message).trim()}`);
  } finally {
    await Promise.all([fs.rm(indexFile, { force: true }), fs.rm(`${indexFile}.lock`, { force: true })]);
  }
}

/**
 * 正式環境 merge 完之後：把 origin/<fromBranch>（prodBranch）反向 merge 回該 repository 設定的所有 feature branch
 * （data/config.json repos 的 `branches`；環境 branch 本身除外），讓 feature branch 都以 production 為基礎。
 * 跟 mergeNoFf 一樣一律建立 merge commit（即使可以 fast-forward）、不動本機 working tree、不 --force push。
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
  try {
    await git(r.path, ['fetch', REMOTE, '--quiet', '--no-tags'], FETCH_TIMEOUT);
  } catch (err) {
    throw new Error(`${repo} git fetch ${REMOTE} 失敗：${(err.stderr || err.message).trim()}`);
  }
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

/* ---------- 分支圖（Confirm Commit 選 commit 用）---------- */

/** 分支圖最多顯示的 commit 數 */
const GRAPH_LIMIT = 300;

/**
 * 找出 feature branch 與其 developer branch（命名為 `<feature>_<developer>`，例：peach_hotfix_max）。
 * 以 remote branch 為主；本機 branch 只在 remote 沒有同名 branch 時才列入。
 * 若 `<feature>_xxx` 其實是 data/config.json 的 repos 中另一個更長的 feature branch（或其 developer branch），則不算。
 * @returns {[{ ref, name, kind: 'feature'|'dev', developer, local }]}
 */
async function branchRefs(cwd, feature, configured) {
  const longer = configured.filter((b) => b !== feature && b.startsWith(`${feature}_`));
  const belongs = (name) =>
    (name === feature || name.startsWith(`${feature}_`)) &&
    !longer.some((b) => name === b || name.startsWith(`${b}_`));

  const out = await git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  const remote = new Map(); // branch 名稱 → ref
  const local = new Map();
  for (const ref of out.split(/\r?\n/).filter(Boolean)) {
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length);
      if (belongs(name)) local.set(name, ref);
    } else {
      const m = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref);
      if (!m || m[2] === 'HEAD' || !belongs(m[2])) continue;
      // 有多個 remote 時以 origin 為準
      if (!remote.has(m[2]) || m[1] === REMOTE) remote.set(m[2], ref);
    }
  }
  const entry = (name, ref, isLocal) => ({
    ref,
    name,
    kind: name === feature ? 'feature' : 'dev',
    developer: name === feature ? null : name.slice(feature.length + 1),
    local: isLocal,
  });
  const refs = [...remote].map(([name, ref]) => entry(name, ref, false));
  for (const [name, ref] of local) if (!remote.has(name)) refs.push(entry(name, ref, true));
  // feature branch 排第一，其餘依 developer 名稱
  return refs.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'feature' ? -1 : 1));
}

/** `git log --graph --color=always` 的圖形部分（含 ANSI 色碼）→ [{ t: 文字, c: 顏色 class }] */
function parseGraph(text) {
  return Anser.ansiToJson(text, { use_classes: true, remove_empty: true }).map((s) => ({
    t: s.content,
    c: s.fg ? `${s.fg}${(s.decorations || []).includes('bold') ? ' bold' : ''}` : '',
  }));
}

/**
 * Confirm Commit 的分支圖：feature branch 與所有 developer branch 的 commit 關係（`git log --graph`）。
 * 預設排除已進 prodBranch（正式環境）的 commit，只看還在進行中的部分；邊界 commit（--boundary）會標示出來。
 * @param fetch 先 `git fetch --all`（失敗不中斷，改回傳 fetchError，以本機資料繪製）
 * @param all   true = 不排除已進 prodBranch 的 commit（最多 GRAPH_LIMIT 筆）
 * @returns {{ repo, branch, refs, base, all, fetched, fetchError, truncated, lines: [{ graph, commit? }] }}
 *   commit = { full, short, subject, author, date, relDate, refs: [branch 名稱], boundary, onFeature }
 */
async function branchGraph({ repo, branch, fetch = false, all = false } = {}) {
  if (typeof repo !== 'string' || typeof branch !== 'string' || !branch.trim()) throw new Error('參數錯誤');
  branch = branch.trim();
  const r = await resolveRepo(repo);

  let fetched = false;
  let fetchError = null;
  if (fetch) {
    try {
      await git(r.path, ['fetch', '--all', '--quiet', '--no-tags', '--prune'], FETCH_TIMEOUT);
      fetched = true;
    } catch (err) {
      fetchError = `git fetch 失敗，以本機資料顯示：${(err.stderr || err.message).trim()}`;
    }
  }

  const refs = await branchRefs(r.path, branch, r.branches);
  const result = { repo, branch, refs, base: null, all: !!all, fetched, fetchError, truncated: false, lines: [] };
  if (!refs.length) return result;

  // 排除已進正式環境 branch 的 commit
  const prodBranch = r.deployBranches.prodDeploy;
  if (!all && prodBranch) {
    const prodRef = `refs/remotes/${REMOTE}/${prodBranch}`;
    const exists = await git(r.path, ['rev-parse', '--verify', '--quiet', prodRef]).then(() => true, () => false);
    if (exists) result.base = { name: `${REMOTE}/${prodBranch}`, ref: prodRef };
  }
  const not = result.base ? ['--not', result.base.ref] : [];
  const tips = refs.map((x) => x.ref);

  // 在 feature branch 上的 commit（不在其上的 commit 選了之後「檢查」會警告）
  const featureTips = refs.filter((x) => x.kind === 'feature').map((x) => x.ref);
  const onFeature = new Set(
    featureTips.length
      ? (await git(r.path, ['rev-list', ...(result.base ? [] : ['--max-count=5000']), ...featureTips, ...not, '--']))
          .split(/\r?\n/)
          .filter(Boolean)
      : []
  );

  const out = await git(
    r.path,
    [
      '-c', 'log.showSignature=false',
      'log', '--graph', '--color=always', '--date-order', '--boundary',
      `--max-count=${GRAPH_LIMIT}`,
      ...tips.map((ref) => `--decorate-refs=${ref}`),
      '--format=%x01%m%x02%H%x02%h%x02%s%x02%an%x02%ci%x02%cr%x02%D',
      ...tips, ...not, '--',
    ],
    30_000
  );

  const nameByShort = new Map(refs.map((x) => [x.local ? x.name : `${x.ref.split('/')[2]}/${x.name}`, x.name]));
  let count = 0;
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const i = line.indexOf('\x01');
    const graph = parseGraph((i < 0 ? line : line.slice(0, i)).replace(/\s+$/, ''));
    if (i < 0) {
      result.lines.push({ graph });
      continue;
    }
    const [mark, full, short, subject, author, date, relDate, deco] = line.slice(i + 1).split('\x02');
    const boundary = mark === '-';
    if (!boundary) count++;
    result.lines.push({
      graph,
      commit: {
        full, short, subject, author, date, relDate, boundary,
        onFeature: onFeature.has(full),
        refs: (deco || '').split(', ').map((d) => nameByShort.get(d.replace(/^HEAD -> /, ''))).filter(Boolean),
      },
    });
  }
  result.truncated = count >= GRAPH_LIMIT;
  return result;
}

module.exports = { git, checkCommit, checkMerged, remoteBranchHead, mergeNoFf, checkDeployMerge, mergeViaFeature, mergeBackToFeatures, branchGraph };
