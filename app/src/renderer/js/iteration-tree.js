import { api, cleanError } from './api.js';
import { $, el } from './dom.js';

const PIN_KEY = 'pinnedIterations'; // localStorage：固定的 Iteration identifier（GUID，改名也不會失效）

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
  return (
    node.name.toLowerCase().includes(keyword) ||
    node.iterationPath.toLowerCase().includes(keyword) ||
    node.children.some((c) => matches(c, keyword))
  );
}

function loadPins() {
  try {
    const v = JSON.parse(localStorage.getItem(PIN_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function savePins(pins) {
  try { localStorage.setItem(PIN_KEY, JSON.stringify(pins)); } catch { /* 忽略 */ }
}

/** 上層路徑（不含根節點與自己），用來區分不同專案下同名的 Sprint */
function parentLabel(node) {
  const names = [];
  for (let p = node.parent; p && p.level > 0; p = p.parent) names.unshift(p.name);
  return names.join(' › ');
}

function tooltip(node) {
  return node.startDate ? `${node.iterationPath}\n${node.startDate} ~ ${node.finishDate}` : node.iterationPath;
}

/**
 * Iteration 選擇器：
 * - 左側只列出使用者「固定」的 Iteration（以及目前選取但未固定的那一個）
 * - 「選擇 Iteration…」按鈕開啟 dialog，從完整樹狀結構挑選，並可按 ☆ 固定 / 取消固定
 * @param {{ onSelect: (node) => void }} options 選取 Iteration 時呼叫
 */
export function createIterationTree({ onSelect }) {
  const pinnedEl = $('pinned');
  const statusEl = $('tree-status');
  const syncBtn = $('sync');
  const browseBtn = $('browse');
  const dialog = $('iter-dialog');
  const treeEl = $('tree');
  const filterEl = $('filter');

  let roots = [];
  let byIdentifier = new Map(); // identifier → node
  let order = new Map(); // identifier → 樹狀深度優先順序（側欄依此排序）
  const expanded = new Set(); // dialog 中已展開的節點 id
  let selected = null; // 目前選取的 iteration 節點
  let pins = loadPins();

  const isPinned = (node) => pins.includes(node.identifier);

  function togglePin(node) {
    pins = isPinned(node) ? pins.filter((x) => x !== node.identifier) : [...pins, node.identifier];
    savePins(pins);
    renderPinned();
    if (dialog.open) renderTree();
  }

  function unpinIdentifier(identifier) {
    pins = pins.filter((x) => x !== identifier);
    savePins(pins);
    renderPinned();
  }

  function pinButton(node) {
    const pinned = isPinned(node);
    const btn = el('button', `pin-btn${pinned ? ' pinned' : ''}`, pinned ? '★' : '☆');
    btn.title = pinned ? '取消固定' : '固定到側欄';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(node);
    });
    return btn;
  }

  // ---------- 側欄：固定清單 ----------

  function pinnedItem(node) {
    const item = el('div', 'pin-item');
    if (selected && selected.id === node.id) item.classList.add('selected');
    if (node.timeFrame) item.classList.add(`tf-${node.timeFrame}`);
    item.title = tooltip(node);

    const text = el('div', 'pin-text');
    const top = el('div', 'pin-top');
    top.append(el('span', 'name', node.name));
    if (node.timeFrame === 'current') top.append(el('span', 'badge', '進行中'));
    text.append(top);
    const sub = [parentLabel(node), node.startDate && `${node.startDate} ~ ${node.finishDate}`].filter(Boolean).join('　');
    if (sub) text.append(el('div', 'pin-sub', sub));

    item.append(text, pinButton(node));
    item.addEventListener('click', () => select(node));
    return item;
  }

  function renderPinned() {
    const children = [];

    // 目前選取但沒固定的 Iteration，放在最上面方便一鍵固定
    if (selected && !isPinned(selected)) {
      children.push(el('div', 'pin-section', '目前選取'), pinnedItem(selected));
    }

    const nodes = pins.map((p) => byIdentifier.get(p)).filter(Boolean);
    nodes.sort((a, b) => order.get(a.identifier) - order.get(b.identifier));
    children.push(el('div', 'pin-section', `已固定（${nodes.length}）`));
    if (nodes.length) {
      children.push(...nodes.map(pinnedItem));
    } else if (roots.length) {
      children.push(el('p', 'muted pin-empty', '尚未固定任何 Iteration'));
    }

    // 同步後已不存在的 Iteration：提示並可移除
    const missing = roots.length ? pins.filter((p) => !byIdentifier.has(p)) : [];
    if (missing.length) {
      const row = el('div', 'pin-missing');
      row.append(el('span', null, `${missing.length} 個已固定的 Iteration 已不存在`));
      const btn = el('button', 'btn-link', '移除');
      btn.addEventListener('click', () => missing.forEach(unpinIdentifier));
      row.append(btn);
      children.push(row);
    }

    pinnedEl.replaceChildren(...children);
  }

  // ---------- Dialog：完整樹狀結構 ----------

  /** 預設展開根節點，以及進行中 (current) Iteration 的所有上層 */
  function initExpanded() {
    expanded.clear();
    for (const node of byIdentifier.values()) {
      if (node.level === 0) expanded.add(node.id);
      if (node.timeFrame === 'current') {
        for (let p = node.parent; p; p = p.parent) expanded.add(p.id);
      }
    }
  }

  function renderTree() {
    const keyword = filterEl.value.trim().toLowerCase();
    const nodes = roots.map((n) => renderNode(n, keyword)).filter(Boolean);
    treeEl.replaceChildren(...(nodes.length ? nodes : [el('p', 'muted tree-empty', roots.length ? '沒有符合的 Iteration' : '尚無 Iteration 資料，請先「↻ 同步」')]));
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
    if (node.startDate) row.append(el('span', 'node-date', `${node.startDate} ~ ${node.finishDate}`));
    if (node.level > 0) row.append(pinButton(node));
    row.title = tooltip(node);

    row.addEventListener('click', () => {
      select(node);
      dialog.close();
    });
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

  function openDialog() {
    // 展開目前選取節點的上層，讓它在樹中看得到
    if (selected) for (let p = selected.parent; p; p = p.parent) expanded.add(p.id);
    filterEl.value = '';
    renderTree();
    dialog.showModal();
    filterEl.focus();
    treeEl.querySelector('.node-row.selected')?.scrollIntoView({ block: 'center' });
  }

  // ---------- 共用 ----------

  function select(node) {
    selected = node;
    renderPinned();
    onSelect(node);
  }

  function setRows(rows) {
    if (!rows) {
      roots = [];
      byIdentifier = new Map();
      order = new Map();
      renderPinned();
      statusEl.textContent = '找不到 data/iterations.json，請按「↻ 同步」執行 get_iterations.py。';
      return;
    }
    const { roots: r, byId } = buildTree(rows);
    roots = r;
    byIdentifier = new Map([...byId.values()].map((n) => [n.identifier, n]));
    order = new Map(rows.map((row, i) => [row.identifier, i]));
    initExpanded();
    if (selected) selected = byIdentifier.get(selected.identifier) ?? null;
    statusEl.textContent = `共 ${rows.filter((x) => x.level > 0).length} 個 Iteration`;
    renderPinned();
    if (dialog.open) renderTree();
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
  browseBtn.addEventListener('click', openDialog);
  filterEl.addEventListener('input', renderTree);
  $('dlg-close').addEventListener('click', () => dialog.close());
  // 點 dialog 外的背景關閉
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  return { load, sync, getSelected: () => selected };
}
