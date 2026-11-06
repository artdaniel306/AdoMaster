import { api, cleanError } from './api.js';
import { $, el } from './dom.js';

/**
 * Requirement 流程（參考 feature/flow.pptx）：
 *   Pending → Implement + Manager understand（並行，同一欄上下兩格）→ Test deploy → Test → Prod deploy → Release recap
 *
 * - Pending / Implement 由 ADO 資料判斷（有沒有展開子項目、子項目是否都已完成）。
 * - 其他人工步驟先以 checkbox 記錄在本機（data/requirement_flow_state.json），之後再串接實際動作。
 */
const STAGES = [
  { key: 'pending', label: 'Pending' },
  { key: 'implement', label: 'Implement' },
  { key: 'testDeploy', label: 'Test deploy', checks: [['testDeploy.saas', 'SaaS'], ['testDeploy.local', 'Local']] },
  { key: 'test', label: 'Test', checks: [['test', '測試完成']] },
  { key: 'prodDeploy', label: 'Prod deploy', checks: [['prodDeploy.saas', 'SaaS'], ['prodDeploy.local', 'Local']] },
  { key: 'recap', label: 'Release recap', checks: [['recap.meeting', 'Meeting'], ['recap.record', 'Record']] },
];
const DONE = { key: 'done', label: '已完成' };
const UNDERSTAND_KEY = 'understand';

/** 視為「開發完成」的子項目狀態（小寫比對） */
const DEV_DONE_STATES = new Set(['tested by dev', 'resolved', 'closed', 'done', 'completed']);
const isRemoved = (c) => String(c.state).toLowerCase() === 'removed';
const isDevDone = (c) => DEV_DONE_STATES.has(String(c.state).toLowerCase());
const activeKids = (req) => req.children.filter((c) => !isRemoved(c));
const allDevDone = (req) => activeKids(req).length > 0 && activeKids(req).every(isDevDone);
const stateClass = (s) => `state state-${String(s).toLowerCase().replace(/\s+/g, '-')}`;

/** 依子項目與 checkbox 計算 Requirement 目前所在階段 */
function computeStage(req, checks) {
  if (!activeKids(req).length) return 'pending';
  if (!(allDevDone(req) && checks[UNDERSTAND_KEY])) return 'implement';
  for (const s of STAGES.slice(2)) {
    if (!s.checks.every(([k]) => checks[k])) return s.key;
  }
  return DONE.key;
}

const stageIndex = (key) => (key === DONE.key ? STAGES.length : STAGES.findIndex((s) => s.key === key));

function openLink(text, url, cls = 'link') {
  const a = el('a', cls, text);
  a.href = '#';
  a.title = '在瀏覽器開啟';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    api.openExternal(url);
  });
  return a;
}

/** 右側 Requirement 流程看板：每列一個 Requirement，目前階段 highlight。 */
export function createRequirementFlowView() {
  const statusEl = $('flow-status');
  const summaryEl = $('flow-summary');
  const table = $('flow-table');
  const tbody = table.querySelector('tbody');

  let requestSeq = 0; // 避免較慢的舊請求覆蓋新結果
  let requirements = [];
  let state = {}; // { [id]: { [checkKey]: true } }

  function renderSummary() {
    const counts = new Map([...STAGES, DONE].map((s) => [s.key, 0]));
    for (const r of requirements) counts.set(r.stage, counts.get(r.stage) + 1);
    const g = el('div', 'chip-group');
    g.append(el('span', 'chip-label', '階段'));
    for (const s of [...STAGES, DONE]) {
      const n = counts.get(s.key);
      g.append(el('span', `chip stage-chip${n ? ' has' : ''}`, `${s.label} ${n}`));
    }
    summaryEl.replaceChildren(g);
  }

  function checkbox(req, key, label) {
    const lab = el('label', 'flow-check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = !!state[req.id]?.[key];
    input.addEventListener('change', async () => {
      input.disabled = true;
      try {
        state[req.id] = await api.setFlowCheck(req.id, key, input.checked);
        update(req);
      } catch (err) {
        input.checked = !input.checked;
        statusEl.className = 'status error';
        statusEl.textContent = `儲存失敗：${cleanError(err)}`;
      } finally {
        input.disabled = false;
      }
    });
    lab.append(input, el('span', null, label));
    return lab;
  }

  function implementCell(req) {
    const kids = activeKids(req);
    const box = el('div', 'impl');
    const doneCount = kids.filter(isDevDone).length;
    const head = el('div', 'sub-head');
    head.append(
      el('span', null, 'Implement'),
      el('span', `count${kids.length && doneCount === kids.length ? ' ok' : ''}`, `${doneCount}/${kids.length}`)
    );
    const list = el('div', 'task-list');
    if (!kids.length) list.append(el('span', 'muted', '尚未展開 Task'));
    for (const c of kids) {
      const t = el('div', `task${isDevDone(c) ? ' dev-done' : ''}`);
      t.title = `${c.type} ${c.id}：${c.title}\n狀態：${c.state}\n指派：${c.assignedTo || '—'}`;
      t.append(openLink(`${c.type === 'Task' ? '' : `${c.type} `}#${c.id}`, c.webUrl), el('span', stateClass(c.state), c.state));
      list.append(t);
    }
    box.append(head, list);
    return box;
  }

  /** done=true 的格子在進行中階段也顯示為綠色（例：Implement 的 Task 都已 Tested by Dev） */
  function progressClass(idx, curIdx, done = false) {
    return idx < curIdx || (idx === curIdx && done) ? 'past' : idx === curIdx ? 'current' : 'future';
  }

  function cell(idx, curIdx, done = false) {
    const td = el('td', 'stage');
    td.classList.add(progressClass(idx, curIdx, done));
    return td;
  }

  /** Implement 與 Manager understand 同屬一個階段：同一欄，分成上下兩格 */
  function stageCells(req, stage, idx, curIdx) {
    if (stage.key === 'implement') {
      const impl = el('div', `stage ${progressClass(idx, curIdx, allDevDone(req))}`);
      impl.append(implementCell(req));
      const mgr = el('div', `stage ${progressClass(idx, curIdx, !!state[req.id]?.[UNDERSTAND_KEY])}`);
      mgr.append(el('div', 'sub-head', 'Manager understand'), checkbox(req, UNDERSTAND_KEY, '已理解需求 / 確認驗收方式'));
      const box = el('div', 'split-box');
      box.append(impl, mgr);
      const td = el('td', 'stage-split');
      td.append(box);
      return [td];
    }
    const td = cell(idx, curIdx);
    if (stage.key === 'pending') {
      td.append(el('span', 'stage-mark', idx < curIdx ? '✓ 已展開' : '待指派 / 展開 Task'));
    } else {
      const box = el('div', 'checks');
      box.append(...stage.checks.map(([k, label]) => checkbox(req, k, label)));
      td.append(box);
    }
    return [td];
  }

  function renderRow(req) {
    req.stage = computeStage(req, state[req.id] || {});
    const curIdx = stageIndex(req.stage);
    const tr = el('tr');
    tr.dataset.id = req.id;
    if (req.stage === DONE.key) tr.classList.add('all-done');

    const head = el('td', 'req-col');
    const top = el('div', 'req-top');
    top.append(openLink(`#${req.id}`, req.webUrl), el('span', stateClass(req.state), req.state));
    const stageName = req.stage === DONE.key ? DONE.label : STAGES[curIdx].label;
    head.append(top, el('div', 'req-title', req.title), el('div', 'req-meta muted', `${req.assignedTo || '未指派'} · ${stageName}`));
    head.title = req.description ? req.description.slice(0, 300) : '';

    tr.append(head, ...STAGES.flatMap((s, i) => stageCells(req, s, i, curIdx)));
    return tr;
  }

  /** 勾選後只重繪該列與摘要 */
  function update(req) {
    const old = tbody.querySelector(`tr[data-id="${req.id}"]`);
    if (old) old.replaceWith(renderRow(req));
    renderSummary();
    statusEl.className = 'status';
  }

  /** 顯示指定 Iteration 的 Requirement 流程；exact=true 時不含子 Iteration。 */
  async function show(node, exact) {
    const seq = ++requestSeq;
    statusEl.className = 'status loading';
    statusEl.textContent = '執行 get_requirement_flow.py 取得 Requirement 中…';
    summaryEl.replaceChildren();
    table.hidden = true;

    try {
      const [result, st] = await Promise.all([api.fetchRequirementFlow(node.iterationPath, exact), api.loadFlowState()]);
      if (seq !== requestSeq) return;
      requirements = result.requirements;
      state = st || {};
      statusEl.className = 'status';
      statusEl.textContent = `共 ${result.count} 筆 ${result.type} · 取得時間 ${result.fetchedAt.replace('T', ' ')}`;
      if (!requirements.length) {
        statusEl.textContent += `（此 Iteration 沒有 ${result.type}）`;
        return;
      }
      tbody.replaceChildren(...requirements.map(renderRow));
      renderSummary();
      table.hidden = false;
    } catch (err) {
      if (seq !== requestSeq) return;
      statusEl.className = 'status error';
      statusEl.textContent = cleanError(err);
    }
  }

  return { show };
}
