const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const Anser = require('anser');
const { loadRepoConfig, fieldHint } = require('./repoConfig');
const { COMMIT_RE, COMMIT_FORMAT_HINT } = require('../../shared/flow-rules.js');

/**
 * Confirm Commit：到本機 clone 的 repository 確認指定 commit 是否存在。
 * repository 的位置由 data/config.json 的 repos 各 repository 的 `path` 設定（見 repoConfig.js）。
 * 本機找不到（或不在 feature branch 上）時會 `git fetch` 一次再重查。
 */

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
  if (found.onBranch === false) message += `（⚠ 不在 ${branch} 上）`;
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
 * @returns {{ tree: string|null, conflicts: string[] }} 有衝突時 tree 為 null
 */
async function trialMerge(cwd, base, commit) {
  try {
    const out = await git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, commit]);
    return { tree: out.split(/\r?\n/)[0].trim(), conflicts: [] };
  } catch (err) {
    if (err.code === 1) {
      // exit 1 = 有衝突：第一行是 tree，之後是衝突的檔案
      const conflicts = [...new Set(String(err.stdout || '').split(/\r?\n/).slice(1).filter(Boolean))];
      return { tree: null, conflicts };
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

/**
 * 正式環境 merge 完之後：把 origin/<fromBranch>（prodBranch）反向 merge 回該 repository 設定的所有 feature branch
 * （data/config.json repos 的 `branches`；環境 branch 本身除外），讓 feature branch 都以 production 為基礎。
 * 跟 mergeNoFf 一樣一律建立 merge commit（即使可以 fast-forward）、不動本機 working tree、不 --force push。
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
        const { tree, conflicts } = await trialMerge(r.path, base, source);
        if (!tree) {
          Object.assign(item, { state: 'conflict', message: `merge 會有衝突，請手動處理：${conflicts.join(', ')}` });
        } else {
          const message = `Merge ${fromBranch} (${source.slice(0, 10)}) into ${branch}${reqId ? `\n\nRequirement #${reqId}` : ''}`;
          item.mergeCommit = await commitAndPush(r, { tree, base, source, target: branch, message });
          Object.assign(item, { state: 'merged', message: `✓ 已建立 merge commit ${item.mergeCommit.slice(0, 10)} 並 push` });
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

module.exports = { checkCommit, checkMerged, mergeNoFf, mergeBackToFeatures, branchGraph };
