import { api, cleanError } from './api.js';
import { $, el } from './dom.js';
import { createUnderstandDialog } from './understand-dialog.js';
import { createCommitDialog } from './commit-dialog.js';
import { createMergeDialog } from './merge-dialog.js';
import { createTaskDialog } from './task-dialog.js';
import { workItemLink } from './description-dialog.js';

/**
 * Requirement 流程（參考 feature/flow.pptx）：
 *   Pending → Implement + Manager understand（並行，同一欄上下兩格）→ Test deploy → Test → Prod deploy → Release recap
 *
 * - Pending / Implement 由 ADO 資料判斷（有沒有展開子項目、子項目是否都已完成）。
 * - 其他人工步驟先以 checkbox 記錄在本機（data/requirement_flow_state.json），之後再串接實際動作。
 * - Manager understand 點擊時開啟 dialog，決定要在哪些 repository 開發、各自的 feature branch。
 * - Test deploy / Prod deploy 勾選 SaaS / Local 前要先 Confirm Commit：依 Manager understand 選的 repository
 *   各自填入測試通過版的 commit，並確認 repository 中真的有這個 commit。
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
const UNDERSTAND_REPOS_KEY = 'understandRepos'; // { repoKey: featureBranch }，由 Manager understand dialog 設定
const UNDERSTAND_MIGRATION_KEY = 'understandMigration'; // 是否需要 migration
const UNDERSTAND_NOTE_KEY = 'understandNote'; // manager 註解，以 tooltip 顯示
/** 佈版前要先 Confirm Commit 的階段；commit 存在 `<stage>.commits`: { repoKey: commit } */
const COMMIT_STAGES = new Set(['testDeploy', 'prodDeploy']);
const commitsKey = (stage) => `${stage}.commits`;

/**
 * 已確認的 commit 是否涵蓋 Manager understand 選的每個 repository。
 * Manager understand 沒選任何 repository（例如只需調整 database 資料）時，視為自動完成。
 */
function commitsConfirmed(checks, stage) {
  const repos = Object.keys(checks[UNDERSTAND_REPOS_KEY] || {});
  const commits = checks[commitsKey(stage)] || {};
  return !!checks[UNDERSTAND_KEY] && repos.every((r) => commits[r]);
}

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
    if (COMMIT_STAGES.has(s.key) && !commitsConfirmed(checks, s.key)) return s.key;
    if (!s.checks.every(([k]) => checks[k])) return s.key;
  }
  return DONE.key;
}

/**
 * Requirement 在 ADO 應有的狀態（點擊狀態 chip 時更新成這個）：
 *   流程全部走完 → Closed；Implement 完成（子項目都 Tested by Dev / Resolved / Closed）→ Resolved；
 *   有子項目已指派給某人 → Active；其他情況沒有建議狀態（null）。
 */
function expectedState(req) {
  if (req.stage === DONE.key) return 'Closed';
  if (allDevDone(req)) return 'Resolved';
  if (activeKids(req).some((c) => c.assignedTo)) return 'Active';
  return null;
}
const sameState = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const stageIndex = (key) => (key === DONE.key ? STAGES.length : STAGES.findIndex((s) => s.key === key));

/** 右側 Requirement 流程看板：每列一個 Requirement，目前階段 highlight。 */
export function createRequirementFlowView() {
  const statusEl = $('flow-status');
  const summaryEl = $('flow-summary');
  const table = $('flow-table');
  const tbody = table.querySelector('tbody');

  let requestSeq = 0; // 避免較慢的舊請求覆蓋新結果
  let requirements = [];
  let state = {}; // { [id]: { [checkKey]: true, understandRepos?: { repoKey: branch }, understandMigration?: true } }
  const understandDialog = createUnderstandDialog();
  const commitDialog = createCommitDialog();
  const mergeDialog = createMergeDialog();
  const taskDialog = createTaskDialog();

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

  function checkbox(req, key, label, disabledReason = '') {
    const lab = el('label', 'flow-check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = !!state[req.id]?.[key];
    if (disabledReason) {
      input.disabled = true;
      lab.classList.add('disabled');
      lab.title = disabledReason;
    }
    input.addEventListener('change', async () => {
      input.disabled = true;
      try {
        const stage = STAGES.find((s) => COMMIT_STAGES.has(s.key) && key.startsWith(`${s.key}.`));
        if (input.checked && stage && !(await ensureMerged(req, stage))) {
          input.checked = false;
          return;
        }
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

  /**
   * 勾佈版階段的 SaaS / Local 前：確認 Confirm Commit 的 commit 都已進到環境 branch。
   * 尚未 merge 時跳出 dialog 詢問是否現在 merge（建立 merge commit）。回傳 true 代表可以勾選。
   */
  async function ensureMerged(req, stage) {
    statusEl.className = 'status loading';
    statusEl.textContent = `確認 #${req.id} 的 commit 是否已 merge 進 ${stage.label} 環境 branch（git fetch）…`;
    const status = await api.deployMergeStatus(req.id, stage.key);
    statusEl.className = 'status';
    statusEl.textContent = '';
    if (status.allMerged) return true;
    return mergeDialog.open({
      req,
      stageLabel: stage.label,
      status,
      mergeFn: () => api.mergeDeploy(req.id, stage.key),
    });
  }

  /** Manager understand：checkbox 本身不直接切換，點擊時開啟 dialog 選擇 repository / feature branch */
  function understandCheck(req) {
    const lab = el('label', 'flow-check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = !!state[req.id]?.[UNDERSTAND_KEY];
    lab.title = '點擊選擇要開發的 repository 與 feature branch';
    lab.addEventListener('click', (e) => {
      e.preventDefault();
      const s = state[req.id] || {};
      const current = s[UNDERSTAND_KEY]
        ? { repos: s[UNDERSTAND_REPOS_KEY], migration: !!s[UNDERSTAND_MIGRATION_KEY], note: s[UNDERSTAND_NOTE_KEY] }
        : undefined;
      understandDialog.open(req, current, async (repos, migration, note) => {
        state[req.id] = await api.setUnderstand(req.id, repos, migration, note);
        update(req);
      });
    });
    lab.append(input, el('span', null, '已理解需求 / 確認開發 repository'));

    const box = el('div');
    box.append(lab);
    const s = state[req.id] || {};
    if (s[UNDERSTAND_KEY]) {
      const list = el('div', 'und-summary');
      const repos = Object.entries(s[UNDERSTAND_REPOS_KEY] || {});
      if (!repos.length) list.append(el('div', 'repo-line repo-branch', '不需修改 repository'));
      for (const [repo, branch] of repos) {
        const line = el('div', 'repo-line');
        line.append(el('span', 'repo-name', repo), el('span', 'repo-branch', branch));
        list.append(line);
      }
      if (s[UNDERSTAND_MIGRATION_KEY]) list.append(el('div', 'repo-line migration', '⚠ 需要 migration'));
      box.append(list);
    }
    return box;
  }

  /** Confirm Commit：點擊開啟 dialog 填入各 repository 測試通過版的 commit；確認後才能勾 SaaS / Local */
  function commitCheck(req, stage) {
    const s = state[req.id] || {};
    const repos = s[UNDERSTAND_KEY] ? s[UNDERSTAND_REPOS_KEY] || {} : {};
    const commits = s[commitsKey(stage.key)];
    const confirmed = commitsConfirmed(s, stage.key);

    const lab = el('label', 'flow-check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = confirmed;
    lab.append(input, el('span', null, 'Confirm Commit'));
    if (!s[UNDERSTAND_KEY]) {
      input.disabled = true;
      lab.classList.add('disabled');
      lab.title = '請先完成 Manager understand';
    } else if (!Object.keys(repos).length) {
      // Manager understand 沒選 repository（不需修改程式）→ 自動完成
      input.disabled = true;
      lab.title = 'Manager understand 未選擇 repository，不需要 Confirm Commit';
    } else {
      lab.title = '點擊填入各 repository 測試通過版的 commit';
      lab.addEventListener('click', (e) => {
        e.preventDefault();
        commitDialog.open({
          req,
          stageLabel: stage.label,
          repos,
          current: commits,
          // Prod deploy 尚未確認時，預設帶入 Test deploy 確認過的 commit
          prefill: stage.key === 'prodDeploy' ? s[commitsKey('testDeploy')] : undefined,
          saveFn: async (c) => {
            state[req.id] = await api.setCommits(req.id, stage.key, c);
            update(req);
          },
        });
      });
    }

    const box = el('div', 'commit-check');
    box.append(lab);
    if (commits) {
      const list = el('div', 'und-summary');
      for (const repo of Object.keys(repos)) {
        const line = el('div', 'repo-line');
        line.append(el('span', 'repo-name', repo));
        if (commits[repo]) line.append(el('code', 'repo-commit', commits[repo]));
        else line.append(el('span', 'repo-missing', '⚠ 尚未填入（repository 已變更）'));
        list.append(line);
      }
      box.append(list);
    }
    return { box, confirmed };
  }

  /**
   * Requirement 的狀態 chip：目前狀態與應有狀態（expectedState）不同時 highlight，
   * 點擊後呼叫 ADO API 更新成應有狀態。
   */
  function stateChip(req) {
    const target = expectedState(req);
    if (!target || sameState(req.state, target)) return el('span', stateClass(req.state), req.state);

    const btn = el('button', `${stateClass(req.state)} state-mismatch`, `${req.state} → ${target}`);
    btn.type = 'button';
    btn.title = `點擊將 ADO 狀態從 ${req.state} 更新為 ${target}`;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      statusEl.className = 'status loading';
      statusEl.textContent = `更新 #${req.id} 的狀態為 ${target}…`;
      try {
        const updated = await api.updateRequirementState(req.id, target);
        Object.assign(req, { state: updated.state, reason: updated.reason, changedDate: updated.changedDate });
        update(req);
        statusEl.textContent = `已將 #${req.id} 的狀態更新為 ${updated.state}`;
      } catch (err) {
        btn.disabled = false;
        statusEl.className = 'status error';
        statusEl.textContent = `更新狀態失敗：${cleanError(err)}`;
      }
    });
    return btn;
  }

  /** Pending 且尚未展開 Task：開啟 dialog 輸入 Description，在 ADO 建立與 Requirement 同名的 Task */
  function defaultTaskButton(req) {
    const btn = el('button', 'btn-ghost btn-default-task', '安排預設 Task');
    btn.type = 'button';
    btn.title = '在此 Requirement 底下建立同名的 Task';
    btn.addEventListener('click', () => {
      taskDialog.open(req, async (description) => {
        const task = await api.createDefaultTask(req.id, description);
        req.children = [...req.children, task];
        update(req);
        statusEl.textContent = `已建立 Task #${task.id}：${task.title}`;
      });
    });
    return btn;
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
      t.append(workItemLink(`${c.type === 'Task' ? '' : `${c.type} `}#${c.id}`, c), el('span', stateClass(c.state), c.state));
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
      const mgrHead = el('div', 'sub-head');
      mgrHead.append(el('span', null, 'Manager understand'));
      const note = state[req.id]?.[UNDERSTAND_NOTE_KEY];
      if (note) {
        const icon = el('span', 'note-icon', '💬');
        icon.title = note; // 滑鼠移上去以 tooltip 顯示 manager 的註解
        mgrHead.append(icon);
      }
      mgr.append(mgrHead, understandCheck(req));
      const box = el('div', 'split-box');
      box.append(impl, mgr);
      const td = el('td', 'stage-split');
      td.append(box);
      return [td];
    }
    const td = cell(idx, curIdx);
    if (stage.key === 'pending') {
      td.append(el('span', 'stage-mark', idx < curIdx ? '✓ 已展開' : '待指派 / 展開 Task'));
      if (!activeKids(req).length) td.append(defaultTaskButton(req));
    } else if (COMMIT_STAGES.has(stage.key)) {
      const { box: commitBox, confirmed } = commitCheck(req, stage);
      const box = el('div', 'checks');
      const reason = confirmed ? '' : '請先完成 Confirm Commit';
      // 已勾選的仍可取消，避免 commit 變更後卡住
      box.append(
        ...stage.checks.map(([k, label]) => checkbox(req, k, label, state[req.id]?.[k] ? '' : reason))
      );
      td.append(commitBox, box);
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
    top.append(workItemLink(`#${req.id}`, req), stateChip(req));
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
