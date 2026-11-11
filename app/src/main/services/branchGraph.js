const Anser = require('anser');
const { REMOTE, git, fetchOrigin, resolveRepo } = require('./git');

/**
 * Confirm Commit 選 commit 用的分支圖：feature branch 與所有 developer branch 的 `git log --graph`。
 * 底層 git 操作在 git.js。
 */

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
      await fetchOrigin(r, { all: true, prune: true });
      fetched = true;
    } catch (err) {
      fetchError = `git fetch 失敗，以本機資料顯示：${err.detail}`;
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

module.exports = { branchGraph };
