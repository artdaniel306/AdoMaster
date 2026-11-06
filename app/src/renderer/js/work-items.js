import { api, cleanError } from './api.js';
import { $, el } from './dom.js';

function fmtDate(v) {
  return v ? String(v).slice(0, 16).replace('T', ' ') : '';
}

/** 右側 Work Item 清單（摘要 + 表格）。 */
export function createWorkItemsView() {
  const statusEl = $('wi-status');
  const summaryEl = $('wi-summary');
  const table = $('wi-table');
  const tbody = table.querySelector('tbody');

  let requestSeq = 0; // 避免較慢的舊請求覆蓋新結果

  function renderSummary(items) {
    const count = (key) =>
      Object.entries(items.reduce((m, i) => ((m[i[key] || '—'] = (m[i[key] || '—'] || 0) + 1), m), {}))
        .sort((a, b) => b[1] - a[1]);
    const group = (label, entries) => {
      const g = el('div', 'chip-group');
      g.append(el('span', 'chip-label', label), ...entries.map(([k, v]) => el('span', 'chip', `${k} ${v}`)));
      return g;
    };
    summaryEl.replaceChildren(group('類型', count('type')), group('狀態', count('state')));
  }

  function renderRow(i) {
    const tr = el('tr');
    const idCell = el('td');
    const link = el('a', 'link', String(i.id));
    link.href = '#';
    link.title = '在瀏覽器開啟';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      api.openExternal(i.webUrl);
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
  }

  function renderItems(items) {
    if (!items.length) {
      statusEl.textContent += '（此 Iteration 沒有 Work Item）';
      return;
    }
    renderSummary(items);
    tbody.replaceChildren(...items.map(renderRow));
    table.hidden = false;
  }

  /** 顯示指定 Iteration 的 Work Item；exact=true 時不含子 Iteration。 */
  async function show(node, exact) {
    const seq = ++requestSeq;
    statusEl.className = 'status loading';
    statusEl.textContent = '執行 get_iteration_work_items.py 取得 Work Item 中…';
    summaryEl.replaceChildren();
    table.hidden = true;

    try {
      const result = await api.fetchWorkItems(node.iterationPath, exact);
      if (seq !== requestSeq) return;
      statusEl.className = 'status';
      statusEl.textContent = `共 ${result.count} 筆 · 取得時間 ${result.fetchedAt.replace('T', ' ')}`;
      renderItems(result.items);
    } catch (err) {
      if (seq !== requestSeq) return;
      statusEl.className = 'status error';
      statusEl.textContent = cleanError(err);
    }
  }

  return { show };
}
