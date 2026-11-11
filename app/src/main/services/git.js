const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { requireRepo, fieldHint } = require('./repoConfig');
const { withPathLock } = require('../pathLock');
const { COMMIT_RE, COMMIT_FORMAT_HINT } = require('../../shared/flow-rules.js');

/**
 * git 指令的共用底層：在 repository 的本機 clone 執行 git、查 commit / ref、試算 merge、建立 merge commit 並 push。
 * 一律不 checkout、不動本機 working tree / index，push 不加 --force。
 * 同一個 clone 的 git 指令依序執行（pathLock.js；也會等 Sync-Repos.ps1 / Deploy-Local.ps1 對同一個資料夾的操作結束）。
 * 上層：gitCommit.js（Confirm Commit）、deployMerge.js（佈版 merge）、branchGraph.js（分支圖）。
 */

/** 環境 / feature branch 一律以這個 remote 為準（本機 branch 可能沒更新或根本沒 checkout） */
const REMOTE = 'origin';
const FETCH_TIMEOUT = 60_000;

/** timeout 從輪到這個指令執行時才開始算 */
function git(cwd, args, timeout = 15_000, extraEnv = null) {
  return withPathLock([cwd], () => runGit(cwd, args, timeout, extraEnv));
}

function runGit(cwd, args, timeout, extraEnv) {
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

/** git 錯誤的說明（stderr 優先） */
const gitError = (err) => (err.stderr || err.message).trim();

/**
 * git fetch；失敗時丟出「<repo> git fetch <remote> 失敗：…」（err.detail = git 的錯誤訊息，給要自訂訊息的呼叫端）。
 * @param r      repository 設定（key、path）
 * @param all    true = 所有 remote（--all），否則只 fetch origin
 * @param tags   true = 連 tag 一起 fetch
 * @param prune  true = 刪掉 remote 已不存在的 branch
 */
async function fetchOrigin(r, { all = false, tags = false, prune = false } = {}) {
  const args = ['fetch', ...(all ? ['--all'] : [REMOTE]), '--quiet', tags ? '--tags' : '--no-tags', ...(prune ? ['--prune'] : [])];
  try {
    await git(r.path, args, FETCH_TIMEOUT);
  } catch (err) {
    const e = new Error(`${r.key} git fetch ${all ? '--all' : REMOTE} 失敗：${gitError(err)}`);
    e.detail = gitError(err);
    throw e;
  }
}

/** 讀取 data/config.json 的 repos 中 repo 的設定，並確認本機 clone 的路徑存在 */
async function resolveRepo(repo) {
  const r = await requireRepo(repo);
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

/** `git merge-base --is-ancestor a b`：a 是否在 b 的歷史中（exit 0 = 是、1 = 否、其他 = 錯誤） */
async function isAncestor(cwd, a, b) {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch (err) {
    if (err.code === 1) return false;
    throw new Error(`git merge-base 失敗：${gitError(err)}`);
  }
}

/** 確認 branch 名稱正確且 remote 有此 branch，回傳 refs/remotes/origin/<branch>；label 用於錯誤訊息（例 '環境 branch'） */
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
    throw new Error(`git merge-tree 失敗（需要 git 2.38 以上）：${gitError(err)}`);
  }
}

/**
 * 以 trialMerge 算出的 tree 建立 merge commit（第一個 parent = base、第二個 = source）並 push 到 origin/<target>。
 * base 必須是 origin/<target> 目前的 commit；push 不加 --force，remote 期間有變動會被拒絕。
 * push 成功後本機的 refs/remotes/origin/<target> 也指向 merge commit，之後的檢查不用再 fetch。
 * merge commit 的作者 / committer 用該 repository 的 git user 設定。
 * @returns 建立的 merge commit
 */
async function commitAndPush(r, { tree, base, source, target, message }) {
  let mergeCommit;
  try {
    mergeCommit = (await git(r.path, ['commit-tree', tree, '-p', base, '-p', source, '-m', message])).trim();
  } catch (err) {
    throw new Error(`${r.key} 建立 merge commit 失敗：${gitError(err)}`);
  }
  try {
    await git(r.path, ['push', '--quiet', REMOTE, `${mergeCommit}:refs/heads/${target}`], FETCH_TIMEOUT);
  } catch (err) {
    throw new Error(`${r.key} push 到 ${REMOTE}/${target} 失敗：${gitError(err)}`);
  }
  // git push 通常已更新 remote-tracking ref；明確再設一次（失敗不影響，下次 fetch 也會更新）
  await git(r.path, ['update-ref', `refs/remotes/${REMOTE}/${target}`, mergeCommit]).catch(() => {});
  return mergeCommit;
}

/**
 * 把 tree 中 keep 的路徑換回 base 的內容，回傳新的 tree：
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
    throw new Error(`還原 ${keep.join(', ')} 失敗：${gitError(err)}`);
  } finally {
    await Promise.all([fs.rm(indexFile, { force: true }), fs.rm(`${indexFile}.lock`, { force: true })]);
  }
}

module.exports = {
  REMOTE,
  git,
  gitError,
  fetchOrigin,
  resolveRepo,
  normalizeCommit,
  lookup,
  isAncestor,
  remoteRef,
  trialMerge,
  commitAndPush,
  restorePaths,
};
