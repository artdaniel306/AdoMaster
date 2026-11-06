import { api, cleanError } from './api.js';
import { $, el } from './dom.js';

/** 把扁平清單（id / parentId）組成樹狀結構 */
function buildTree(rows) {
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parentId === '' ? null : byId.get(node.parentId);
    (parent ? parent.children : roots).push(node);
    node.parent = parent ?? null;
  }
  return { roots, byId };
}

function matches(node, keyword) {
  return node.name.toLowerCase().includes(keyword) || node.children.some((c) => matches(c, keyword));
}

/**
 * 左側 Iteration 樹。
 * @param {{ onSelect: (node) => void }} options 點選節點時呼叫
 */
export function createIterationTree({ onSelect }) {
  const treeEl = $('tree');
  const statusEl = $('tree-status');
  const filterEl = $('filter');
  const syncBtn = $('sync');

  let roots = [];
  const expanded = new Set(); // 已展開的節點 id
  let selected = null; // 目前選取的 iteration 節點

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

  function render() {
    const keyword = filterEl.value.trim().toLowerCase();
    treeEl.replaceChildren(...roots.map((n) => renderNode(n, keyword)).filter(Boolean));
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
    row.title = node.startDate ? `${node.iterationPath}\n${node.startDate} ~ ${node.finishDate}` : node.iterationPath;

    row.addEventListener('click', () => select(node));
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
    render();
  }

  function select(node) {
    selected = node;
    render();
    onSelect(node);
  }

  function setRows(rows) {
    if (!rows) {
      roots = [];
      treeEl.replaceChildren();
      statusEl.textContent = '找不到 data/iterations.json，請按「↻ 同步」執行 get_iterations.py。';
      return;
    }
    const { roots: r, byId } = buildTree(rows);
    roots = r;
    initExpanded(byId);
    if (selected) selected = byId.get(selected.id) ?? null;
    statusEl.textContent = `共 ${rows.filter((x) => x.level > 0).length} 個 Iteration`;
    render();
  }

  async function load() {
    statusEl.textContent = '讀取中…';
    try {
      setRows(await api.loadIterations());
    } catch (err) {
      statusEl.textContent = `讀取失敗：${cleanError(err)}`;
    }
  }

  async function sync() {
    syncBtn.disabled = true;
    statusEl.textContent = '執行 get_iterations.py 同步中…';
    try {
      setRows(await api.syncIterations());
    } catch (err) {
      statusEl.textContent = `同步失敗：${cleanError(err)}`;
    } finally {
      syncBtn.disabled = false;
    }
  }

  syncBtn.addEventListener('click', sync);
  filterEl.addEventListener('input', render);

  return { load, sync, getSelected: () => selected };
}
