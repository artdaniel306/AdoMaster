const treeEl = document.getElementById('tree');
const treeStatus = document.getElementById('tree-status');
const filterEl = document.getElementById('filter');
const syncBtn = document.getElementById('sync');
const exactEl = document.getElementById('exact');
const wiTitle = document.getElementById('wi-title');
const wiSub = document.getElementById('wi-sub');
const wiStatus = document.getElementById('wi-status');
const wiSummary = document.getElementById('wi-summary');
const wiTable = document.getElementById('wi-table');
const wiBody = wiTable.querySelector('tbody');

let roots = [];
const expanded = new Set(); // 已展開的節點 id
let selected = null; // 目前選取的 iteration 節點
let requestSeq = 0; // 避免較慢的舊請求覆蓋新結果

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ------------------------------------------------------------ Iteration 樹

/** 把扁平清單（id / parentId）組成樹狀結構 */
function buildTree(rows) {
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  const result = [];
  for (const node of byId.values()) {
    const parent = node.parentId === '' ? null : byId.get(node.parentId);
    (parent ? parent.children : result).push(node);
    node.parent = parent ?? null;
  }
  return { roots: result, byId };
}

/** 預設展開根節點，以及進行中 (current) Iteration 的所有上層 */
function initExpanded(byId) {
  expanded.clear();
  for (const node of byId.values()) {
    if (node.level === 0) expanded.add(node.id);
    if (node.timeFrame === 'current') {
      for (let p = node.parent; p; p = p.parent) expanded.add(p.id);
    }
  }
}

function renderTree() {
  const keyword = filterEl.value.trim().toLowerCase();
  treeEl.replaceChildren(...roots.map((n) => renderNode(n, keyword)).filter(Boolean));
}

function matches(node, keyword) {
  return node.name.toLowerCase().includes(keyword) || node.children.some((c) => matches(c, keyword));
}

function renderNode(node, keyword) {
  if (keyword && !matches(node, keyword)) return null;
  const hasChildren = node.children.length > 0;
  const isOpen = keyword ? true : expanded.has(node.id); // 篩選時自動全部展開

  const wrap = el('div', 'node');
  const row = el('div', 'node-row');
  row.setAttribute('role', 'treeitem');
  row.style.paddingLeft = `${node.level * 16 + 4}px`;
  if (selected && selected.id === node.id) row.classList.add('selected');
  if (node.timeFrame) row.classList.add(`tf-${node.timeFrame}`);

  const twisty = el('span', 'twisty', hasChildren ? (isOpen ? '▾' : '▸') : '');
  twisty.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle(node);
  });
  row.append(twisty, el('span', 'name', node.name));
  if (node.timeFrame === 'current') row.append(el('span', 'badge', '進行中'));
  if (node.startDate) row.title = `${node.iterationPath}\n${node.startDate} ~ ${node.finishDate}`;
  else row.title = node.iterationPath;

  row.addEventListener('click', () => selectIteration(node));
  row.addEventListener('dblclick', () => hasChildren && toggle(node));
  wrap.append(row);

  if (hasChildren && isOpen) {
    const kids = el('div', 'children');
    kids.append(...node.children.map((c) => renderNode(c, keyword)).filter(Boolean));
    wrap.append(kids);
  }
  return wrap;
}

function toggle(node) {
  if (expanded.has(node.id)) expanded.delete(node.id);
  else expanded.add(node.id);
  renderTree();
}

function setIterations(rows) {
  if (!rows) {
    roots = [];
    treeEl.replaceChildren();
    treeStatus.textContent = '找不到 data/iterations.json，請按「↻ 同步」執行 get_iterations.py。';
    return;
  }
  const { roots: r, byId } = buildTree(rows);
  roots = r;
  initExpanded(byId);
  if (selected) selected = byId.get(selected.id) ?? null;
  treeStatus.textContent = `共 ${rows.filter((x) => x.level > 0).length} 個 Iteration`;
  renderTree();
}

async function loadIterations() {
  treeStatus.textContent = '讀取中…';
  try {
    setIterations(await window.api.loadIterations());
  } catch (err) {
    treeStatus.textContent = `讀取失敗：${err.message}`;
  }
}

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  treeStatus.textContent = '執行 get_iterations.py 同步中…';
  try {
    setIterations(await window.api.syncIterations());
  } catch (err) {
    treeStatus.textContent = `同步失敗：${cleanError(err)}`;
  } finally {
    syncBtn.disabled = false;
  }
});

filterEl.addEventListener('input', renderTree);

// ------------------------------------------------------------ Work Items

function cleanError(err) {
  // ipcRenderer.invoke 的錯誤訊息前面會帶 "Error invoking remote method '...': Error: "
  return String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function selectIteration(node) {
  selected = node;
  renderTree();
  fetchWorkItems();
}

exactEl.addEventListener('change', () => selected && fetchWorkItems());

async function fetchWorkItems() {
  const node = selected;
  const seq = ++requestSeq;
  wiTitle.textContent = node.name;
  wiSub.textContent = node.iterationPath + (node.startDate ? `　(${node.startDate} ~ ${node.finishDate})` : '');
  wiStatus.className = 'status loading';
  wiStatus.textContent = '執行 get_iteration_work_items.py 取得 Work Item 中…';
  wiSummary.replaceChildren();
  wiTable.hidden = true;

  try {
    const result = await window.api.fetchWorkItems(node.iterationPath, exactEl.checked);
    if (seq !== requestSeq) return;
    wiStatus.className = 'status';
    wiStatus.textContent = `共 ${result.count} 筆 · 取得時間 ${result.fetchedAt.replace('T', ' ')}`;
    renderWorkItems(result.items);
  } catch (err) {
    if (seq !== requestSeq) return;
    wiStatus.className = 'status error';
    wiStatus.textContent = cleanError(err);
  }
}

function renderSummary(items) {
  const count = (key) =>
    Object.entries(items.reduce((m, i) => ((m[i[key] || '—'] = (m[i[key] || '—'] || 0) + 1), m), {}))
      .sort((a, b) => b[1] - a[1]);
  const group = (label, entries) => {
    const g = el('div', 'chip-group');
    g.append(el('span', 'chip-label', label), ...entries.map(([k, v]) => el('span', 'chip', `${k} ${v}`)));
    return g;
  };
  wiSummary.replaceChildren(group('類型', count('type')), group('狀態', count('state')));
}

function fmtDate(v) {
  return v ? String(v).slice(0, 16).replace('T', ' ') : '';
}

function renderWorkItems(items) {
  if (!items.length) {
    wiStatus.textContent += '（此 Iteration 沒有 Work Item）';
    return;
  }
  renderSummary(items);
  wiBody.replaceChildren(
    ...items.map((i) => {
      const tr = el('tr');
      const idCell = el('td');
      const link = el('a', 'link', String(i.id));
      link.href = '#';
      link.title = '在瀏覽器開啟';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        window.api.openExternal(i.webUrl);
      });
      idCell.append(link);
      const typeCell = el('td', null, i.type);
      typeCell.dataset.type = i.type;
      const stateCell = el('td');
      stateCell.append(el('span', `state state-${String(i.state).toLowerCase().replace(/\s+/g, '-')}`, i.state));
      tr.append(
        idCell,
        typeCell,
        el('td', 'title', i.title),
        stateCell,
        el('td', null, i.assignedTo),
        el('td', 'path', i.iterationPath),
        el('td', 'num', i.remainingWork),
        el('td', 'num', i.completedWork),
        el('td', 'nowrap', fmtDate(i.changedDate))
      );
      tr.title = i.description ? i.description.slice(0, 300) : '';
      return tr;
    })
  );
  wiTable.hidden = false;
}

loadIterations();
