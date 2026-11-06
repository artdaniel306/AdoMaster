const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const { loadRepoConfig } = require('./repoConfig');

/**
 * Confirm Commit：到本機 clone 的 repository 確認指定 commit 是否存在。
 * repository 的位置由 app/.env 的 `<REPO>_REPO_PATH` 設定（見 repoConfig.js）。
 * 本機找不到（或不在 feature branch 上）時會 `git fetch` 一次再重查。
 */

/** commit 縮寫：4～40 個十六進位字元（也避免被 git 當成選項） */
const COMMIT_RE = /^[0-9a-f]{4,40}$/;
const FETCH_TIMEOUT = 60_000;

function git(cwd, args, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, // fetch 需要帳密時直接失敗，不要卡住
      },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') err.message = '找不到 git 指令，請確認 git 已安裝並加入 PATH';
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
async function checkCommit({ repo, commit, branch } = {}) {
  if (typeof repo !== 'string' || typeof commit !== 'string') throw new Error('參數錯誤');
  commit = commit.trim().toLowerCase();
  if (!COMMIT_RE.test(commit)) throw new Error('commit 格式錯誤（需為 4～40 碼的十六進位 hash）');
  if (branch != null && typeof branch !== 'string') throw new Error('參數錯誤');

  const config = await loadRepoConfig();
  const r = config.repos.find((x) => x.key === repo);
  if (!r) throw new Error(`未知的 repository：${repo}`);
  if (!r.path) throw new Error(`尚未設定 ${repo} 的位置，請在 app/.env 設定 ${r.pathEnvKey}（本機 clone 的路徑）`);
  try {
    if (!(await fs.stat(r.path)).isDirectory()) throw new Error();
  } catch {
    throw new Error(`${r.pathEnvKey} 指定的路徑不存在：${r.path}`);
  }

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
  if (found.onBranch === false) message += `（⚠ 不在 ${branch} 上）`;
  return { ...base, ok: true, ...found, message };
}

module.exports = { checkCommit, COMMIT_RE };
