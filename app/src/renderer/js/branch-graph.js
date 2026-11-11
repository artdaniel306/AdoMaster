import { api, cleanError } from './api.js';
import { el } from './dom.js';

/**
 * Confirm Commit 的分支圖：以 `git log --graph`（main process 產生，見 branchGraph.js）
 * 顯示 feature branch 與 developer branch（`<feature>_<developer>`）之間的 commit 關係，點一下 commit 即可選取。
 * 開啟時先用本機資料畫出來，再 git fetch 後重畫。
 *
 * @param repo repository key
 * @param branch 規劃 選的 feature branch
 * @param onPick (commit: { full, short, ... }) => void
 * @returns {{ el: HTMLElement, load: (opts?) => Promise, highlight: (value: string) => void }}
 */
export function createBranchGraph({ repo, branch, onPick }) {
  const root = el('div', 'bg-panel');

  const bar = el('div', 'bg-bar');
  const legend = el('span', 'bg-legend');
  const allBox = el('input');
  allBox.type = 'checkbox';
  const allLabel = el('label', 'bg-all');
  const allText = el('span', null, '包含已進正式環境的 commit');
  allLabel.append(allBox, allText);
  const refreshBtn = el('button', 'btn-ghost bg-refresh', '⟳ git fetch');
  refreshBtn.type = 'button';
  refreshBtn.title = '從 remote 取得最新的 branch 後重畫';
  bar.append(legend, el('span', 'spacer'), allLabel, refreshBtn);

  const status = el('div', 'bg-status');
  const list = el('div', 'bg-list');
  list.tabIndex = -1;
  root.append(bar, status, list);

  let seq = 0;
  let selected = '';
  let fetchedOnce = false;
  const items = []; // [{ full, row }]

  function setStatus(text, cls = '') {
    status.className = `bg-status ${cls}`;
    status.textContent = text;
  }

  function graphCell(segments) {
    const pre = el('span', 'bg-graph');
    for (const s of segments) pre.append(s.c ? el('span', s.c, s.t) : document.createTextNode(s.t));
    return pre;
  }

  function branchChip(name, data) {
    const ref = data.refs.find((x) => x.name === name);
    const chip = el('span', `bg-chip ${ref?.kind || ''}`, ref?.kind === 'dev' ? ref.developer : name);
    chip.title = `${ref?.local ? '本機 branch' : 'remote branch'}：${name}`;
    return chip;
  }

  function render(data) {
    items.length = 0;
    const devs = data.refs.filter((x) => x.kind === 'dev');
    const feature = data.refs.find((x) => x.kind === 'feature');
    legend.replaceChildren(
      el('span', 'bg-chip feature', branch),
      document.createTextNode(feature ? '' : '（找不到此 branch）'),
      ...(devs.length ? devs.map((x) => branchChip(x.name, data)) : [el('span', 'muted-inline', '沒有 developer branch')])
    );
    allText.textContent = data.base ? `包含已進 ${data.base.name} 的 commit` : '包含已進正式環境的 commit';

    const notes = [];
    if (data.fetchError) notes.push(data.fetchError);
    if (!data.refs.length) notes.push(`找不到 ${branch} 或 ${branch}_<developer> 的 branch`);
    else if (!data.lines.some((l) => l.commit && !l.commit.boundary))
      notes.push(data.base ? `所有 commit 都已進 ${data.base.name}，勾選「包含已進…」可顯示歷史` : '沒有 commit');
    if (data.truncated) notes.push('只顯示最近的 commit');
    setStatus(notes.join('\n'), data.fetchError ? 'warn' : '');

    list.replaceChildren(
      ...data.lines.map((line) => {
        const row = el('div', 'bg-line');
        row.append(graphCell(line.graph));
        const c = line.commit;
        if (!c) return row;

        row.classList.add('commit');
        if (c.boundary) row.classList.add('boundary');
        const hash = el('span', 'bg-hash', c.short);
        const info = el('span', 'bg-info');
        info.append(...c.refs.map((name) => branchChip(name, data)));
        if (!c.onFeature && !c.boundary) info.append(el('span', 'bg-off', `未進 ${branch}`));
        info.append(el('span', 'bg-subject', c.subject));
        row.append(hash, info, el('span', 'bg-meta', `${c.author} · ${c.relDate}`));
        row.title = [
          c.full,
          c.subject,
          `${c.author} · ${c.date}`,
          c.boundary ? `（已進 ${data.base?.name || '正式環境'}）` : c.onFeature ? `（在 ${branch} 上）` : `（⚠ 不在 ${branch} 上）`,
        ].join('\n');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        const pick = () => {
          selected = c.full;
          markSelected();
          onPick(c);
        };
        row.addEventListener('click', pick);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
          }
        });
        items.push({ full: c.full, row });
        return row;
      })
    );
    markSelected(true);
  }

  function markSelected(scroll = false) {
    let hit = null;
    for (const it of items) {
      const on = !!selected && it.full.startsWith(selected);
      it.row.classList.toggle('selected', on);
      if (on && !hit) hit = it.row;
    }
    if (scroll && hit) hit.scrollIntoView({ block: 'nearest' });
  }

  /** 載入分支圖；fetch = 先 git fetch。第一次載入時先畫本機資料，再自動 fetch 一次。 */
  async function load({ fetch = false } = {}) {
    const my = ++seq;
    refreshBtn.disabled = true;
    setStatus(fetch ? 'git fetch 中…' : '載入中…', 'loading');
    try {
      const data = await api.branchGraph(repo, branch, { fetch, all: allBox.checked });
      if (my !== seq) return;
      render(data);
      if (fetch) fetchedOnce = true;
    } catch (err) {
      if (my !== seq) return;
      setStatus(`✕ ${cleanError(err)}`, 'bad');
    } finally {
      if (my === seq) refreshBtn.disabled = false;
    }
    if (my === seq && !fetch && !fetchedOnce) await load({ fetch: true });
  }

  refreshBtn.addEventListener('click', () => load({ fetch: true }));
  allBox.addEventListener('change', () => load());

  /** 輸入框內容變更時呼叫：標示對應的 commit（前綴比對） */
  function highlight(value) {
    selected = /^[0-9a-f]{4,40}$/.test(value) ? value : '';
    markSelected(true);
  }

  return { el: root, load, highlight };
}
