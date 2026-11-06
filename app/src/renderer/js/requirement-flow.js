import { api, cleanError } from './api.js';
import { $, el } from './dom.js';
import { createUnderstandDialog } from './understand-dialog.js';
import { createCommitDialog } from './commit-dialog.js';
import { createMergeDialog } from './merge-dialog.js';
import { createDeployDialog } from './deploy-dialog.js';
import { createConfirmDialog } from './confirm-dialog.js';
import { createTaskDialog } from './task-dialog.js';
import { workItemLink } from './description-dialog.js';
import {
  UNDERSTAND_KEY,
  UNDERSTAND_REPOS_KEY,
  UNDERSTAND_MIGRATION_KEY,
  UNDERSTAND_NOTE_KEY,
  isCommitStage,
  commitsKey,
  commitsForcedKey,
  commitsCover,
  commitsConfirmed,
} from '../../shared/flow-rules.js';

/**
 * Requirement 流程（參考 feature/flow.pptx）：
 *   Pending → Implement + Manager understand（並行，同一欄上下兩格）→ Test deploy → Test → Prod deploy → Release recap
 *
 * - Pending / Implement 由 ADO 資料判斷（有沒有展開子項目、子項目是否都已完成）。
 * - 其他人工步驟先以 checkbox 記錄在本機（data/requirement_flow_state.json），之後再串接實際動作。
 * - Manager understand 點擊時開啟 dialog，決定要在哪些 repository 開發、各自的 feature branch。
 * - Test deploy / Prod deploy 勾選 SaaS / Local 前要先 Confirm Commit：依 Manager understand 選的 repository
 *   各自填入測試通過版的 commit，並確認 repository 中真的有這個 commit。
 * - 勾 SaaS 時若有設定自動佈版 Pipeline（app/.env `<REPO>_TEST_PIPELINE` / `<REPO>_PROD_PIPELINE`），
 *   改走 deploy-dialog.js：等進行中的 Run 結束 → merge + push → 監看新 Run → 通知（成功時自動勾起）。
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
/** 佈版階段的 SaaS checkbox key（勾選時走自動佈版流程） */
const saasKey = (stage) => `${stage.key}.saas`;

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
    if (isCommitStage(s.key) && !commitsConfirmed(checks, s.key)) return s.key;
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
  const deployDialog = createDeployDialog();
  const confirmDialog = createConfirmDialog();
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

  function showError(prefix, err) {
    statusEl.className = 'status error';
    statusEl.textContent = `${prefix}：${cleanError(err)}`;
  }

  /**
   * 流程中的 checkbox：只有 checkbox 本身可以點（文字不是 <label>，點了不會觸發）。
   * 點擊時不直接切換，而是交給 toggleCheck 決定（成功後整列重繪）。
   * @param stage 此 checkbox 所屬的階段（決定是否為進行中階段）
   * @param key 跳階段時直接勾選的 key（傳給 setFlowCheck(..., force=true)）
   * @param text 顯示文字
   * @param checked 目前是否勾選
   * @param normal 進行中階段點擊時執行的一般邏輯 (value) => Promise | void
   * @param disabledReason 進行中階段不能點的原因（非進行中階段一律可點）
   * @param title 滑鼠移到 checkbox 上的說明
   */
  function flowCheck(req, { stage, key, text, checked, normal, disabledReason = '', title = '' }) {
    const wrap = el('span', 'flow-check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    const isCurrent = stage.key === req.stage;
    if (isCurrent && disabledReason) {
      input.disabled = true;
      wrap.classList.add('disabled');
      wrap.title = disabledReason;
    } else {
      input.title = isCurrent ? title : `「${stage.label}」不是進行中的階段，點擊後會先確認`;
    }
    input.addEventListener('click', async (e) => {
      e.preventDefault(); // 勾選狀態由儲存結果決定（重繪），不直接切換
      if (input.disabled) return;
      input.disabled = true;
      try {
        await toggleCheck(req, { stage, key, text, value: !checked, normal });
      } catch (err) {
        showError('儲存失敗', err);
      } finally {
        input.disabled = false;
      }
    });
    wrap.append(input, el('span', null, text));
    return wrap;
  }

  /**
   * 進行中（橘黃色）階段：執行一般勾選邏輯。
   * 其他階段：先跳 dialog 確認，確認後只變更勾選狀態（不做 merge 檢查、不開 repository / commit dialog）。
   */
  async function toggleCheck(req, { stage, key, text, value, normal }) {
    if (stage.key === req.stage) return normal(value);
    const current = req.stage === DONE.key ? DONE.label : STAGES[stageIndex(req.stage)].label;
    const ok = await confirmDialog.open({
      title: '跳階段勾選',
      req,
      message:
        `「${stage.label}」不是進行中的階段（目前：${current}）。\n` +
        `確定要直接${value ? '勾起' : '取消勾選'}「${text}」嗎？\n\n` +
        '跳階段只會變更勾選狀態，不會執行一般勾選時的檢查與動作（例如選擇 repository、填 commit、merge 檢查）。',
      okLabel: value ? '確定勾起' : '確定取消',
    });
    if (!ok) return;
    state[req.id] = await api.setFlowCheck(req.id, key, value, true);
    update(req);
  }

  /** 一般 checkbox（SaaS / Local、測試完成、Meeting / Record…） */
  function checkbox(req, stage, key, text, disabledReason = '') {
    return flowCheck(req, {
      stage,
      key,
      text,
      checked: !!state[req.id]?.[key],
      disabledReason,
      normal: async (value) => {
        if (value && isCommitStage(stage.key) && key === saasKey(stage)) return deploySaas(req, stage, key, text);
        // 勾佈版階段的 Local 前，確認 commit 已 merge 進環境 branch
        if (value && isCommitStage(stage.key) && !(await ensureMerged(req, stage))) return;
        state[req.id] = await api.setFlowCheck(req.id, key, value);
        update(req);
      },
    });
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

  /**
   * 勾佈版階段的 SaaS：
   *   - 相關 repository 都沒設定 Pipeline → 同 Local（確認 / merge 後勾選）
   *   - 已全部 merge 且 Pipeline 沒有進行中的 Run → 直接勾選
   *   - 其他 → 開啟佈版 dialog：等待進行中的 Run → merge + push → 監看新 Run → 通知（成功時自動勾起）
   */
  async function deploySaas(req, stage, key, text) {
    statusEl.className = 'status loading';
    statusEl.textContent = `確認 #${req.id} 的 merge 狀態（git fetch）與 Pipeline Run…`;
    const [mergeStatus, pipelineRuns] = await Promise.all([
      api.deployMergeStatus(req.id, stage.key),
      api.deployPipelineRuns(req.id, stage.key),
    ]);
    statusEl.className = 'status';
    statusEl.textContent = '';
    const save = async () => {
      state[req.id] = await api.setFlowCheck(req.id, key, true);
      refresh(req.id);
    };
    if (!pipelineRuns.pipelines.length) {
      if (mergeStatus.allMerged || (await mergeDialog.open({ req, stageLabel: stage.label, status: mergeStatus, mergeFn: () => api.mergeDeploy(req.id, stage.key) }))) {
        await save();
      }
      return;
    }
    const hasActive = pipelineRuns.pipelines.some((p) => p.runs.some((r) => r.active));
    if (mergeStatus.allMerged && !hasActive) return save();
    deployDialog.start({
      req,
      stage,
      checkLabel: text,
      mergeStatus,
      pipelineRuns,
      mergeFn: () => api.mergeDeploy(req.id, stage.key),
      runsFn: () => api.deployPipelineRuns(req.id, stage.key),
      checkFn: save,
      onChange: refresh,
    });
  }

  /** 佈版流程進行中時，在 SaaS 底下顯示狀態，點擊重新開啟佈版 dialog */
  function deployStatusLine(req, stage) {
    const text = deployDialog.statusOf(req.id, stage.key);
    if (!text) return null;
    const btn = el('button', 'btn-link deploy-status', `🚀 ${text}`);
    btn.type = 'button';
    btn.title = '開啟佈版視窗';
    btn.addEventListener('click', () => deployDialog.show());
    return btn;
  }

  /** Manager understand：checkbox 本身不直接切換，點擊時開啟 dialog 選擇 repository / feature branch */
  function understandCheck(req, stage) {
    const s = state[req.id] || {};
    const lab = flowCheck(req, {
      stage,
      key: UNDERSTAND_KEY,
      text: '已理解需求 / 確認開發 repository',
      checked: !!s[UNDERSTAND_KEY],
      title: '點擊選擇要開發的 repository 與 feature branch',
      normal: () => {
        const current = s[UNDERSTAND_KEY]
          ? { repos: s[UNDERSTAND_REPOS_KEY], migration: !!s[UNDERSTAND_MIGRATION_KEY], note: s[UNDERSTAND_NOTE_KEY] }
          : undefined;
        understandDialog.open(req, current, async (repos, migration, note) => {
          state[req.id] = await api.setUnderstand(req.id, repos, migration, note);
          update(req);
        });
      },
    });

    const box = el('div');
    box.append(lab);
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
    const forced = !!s[commitsForcedKey(stage.key)];
    // Manager understand 沒選 repository（不需修改程式）→ 自動完成，不能點
    const auto = !!s[UNDERSTAND_KEY] && !Object.keys(repos).length;

    const box = el('div', 'commit-check');
    if (auto) {
      const wrap = el('span', 'flow-check');
      wrap.title = 'Manager understand 未選擇 repository，不需要 Confirm Commit';
      const input = el('input');
      input.type = 'checkbox';
      input.checked = input.disabled = true;
      wrap.append(input, el('span', null, 'Confirm Commit'));
      box.append(wrap);
      return { box, confirmed };
    }

    box.append(
      flowCheck(req, {
        stage,
        key: commitsForcedKey(stage.key),
        text: 'Confirm Commit',
        checked: confirmed,
        disabledReason: s[UNDERSTAND_KEY] ? '' : '請先完成 Manager understand',
        title: '點擊填入各 repository 測試通過版的 commit',
        normal: () =>
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
          }),
      })
    );
    if (forced && !(s[UNDERSTAND_KEY] && commitsCover(s, stage.key))) {
      box.append(el('div', 'und-summary repo-line repo-branch', '跳階段勾起，未填 commit'));
    } else if (commits) {
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
      mgr.append(mgrHead, understandCheck(req, stage));
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
    } else if (isCommitStage(stage.key)) {
      const { box: commitBox, confirmed } = commitCheck(req, stage);
      const box = el('div', 'checks');
      const reason = confirmed ? '' : '請先完成 Confirm Commit';
      const deploying = deployDialog.statusOf(req.id, stage.key);
      // 已勾選的仍可取消，避免 commit 變更後卡住
      box.append(
        ...stage.checks.map(([k, label]) =>
          checkbox(req, stage, k, label, state[req.id]?.[k] ? '' : k === saasKey(stage) && deploying ? '佈版流程進行中' : reason)
        )
      );
      const line = deployStatusLine(req, stage);
      if (line) box.append(line);
      td.append(commitBox, box);
    } else {
      const box = el('div', 'checks');
      box.append(...stage.checks.map(([k, label]) => checkbox(req, stage, k, label)));
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

  /** 依 id 重繪目前畫面上的 Requirement（佈版流程在背景結束時，畫面可能已換過 Iteration） */
  function refresh(id) {
    const req = requirements.find((r) => r.id === id);
    if (req) update(req);
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
