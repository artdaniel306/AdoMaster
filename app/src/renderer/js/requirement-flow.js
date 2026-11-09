import { api, cleanError } from './api.js';
import { $, el } from './dom.js';
import { createConfirmDialog } from './confirm-dialog.js';
import { workItemLink } from './description-dialog.js';
import { loadRepos, repoTag } from './repos.js';
import { STAGES, DONE, allDevDone, activeKids, computeStage, stageIndex } from './flow-stages.js';
import { createFlowCells } from './flow-cells.js';
import { createFlowDeploy } from './flow-deploy.js';
import { PLAN_KEY, PLAN_REPOS_KEY, PLAN_NOTE_KEY, isCommitStage } from '../../shared/flow-rules.js';

/**
 * Requirement 流程看板（參考 docs/flow.pptx，規格見 docs/requirement-flow.md）：
 *   Pending → Implement + 規劃（並行，同一欄上下兩格）→ Test deploy → Test → Prod deploy → Release recap
 *
 * 本檔負責整張表：取資料、每列的組裝、checkbox 的共用行為（flowCheck / 跳階段確認）。
 *   - flow-stages.js  階段定義與純計算（computeStage / expectedState…）
 *   - flow-cells.js   各格子內容（規劃、Confirm Commit、測試 / 檢核、狀態 chip、預設 Task、開發清單）
 *   - flow-deploy.js  佈版階段 SaaS / Local（merge 檢查、Pipeline 自動佈版、UpAgent 發佈）
 * 兩個子模組透過 ctx 共用狀態與重繪函式。
 */
export function createRequirementFlowView() {
  const statusEl = $('flow-status');
  const summaryEl = $('flow-summary');
  const table = $('flow-table');
  const tbody = table.querySelector('tbody');

  let requestSeq = 0; // 避免較慢的舊請求覆蓋新結果
  let requirements = [];
  let state = {}; // { [id]: { [checkKey]: true, planRepos?: { repoKey: branch }, planMigration?: true } }
  const confirmDialog = createConfirmDialog();

  const ctx = {
    statusEl,
    checks: (id) => state[id] || {},
    setChecks: (id, checks) => {
      state[id] = checks;
    },
    update,
    refresh,
    flowCheck,
    checkbox,
  };
  const cells = createFlowCells(ctx);
  const deploy = createFlowDeploy(ctx);

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

  /** 一般 checkbox（SaaS / Local、Meeting / Record…）；佈版階段勾起時交給 flow-deploy.js */
  function checkbox(req, stage, key, text, disabledReason = '') {
    return flowCheck(req, {
      stage,
      key,
      text,
      checked: !!state[req.id]?.[key],
      disabledReason,
      normal: async (value) => {
        if (value && isCommitStage(stage.key)) return deploy.checkDeploy(req, stage, key, text);
        state[req.id] = await api.setFlowCheck(req.id, key, value);
        update(req);
      },
    });
  }

  /** done=true 的格子在進行中階段也顯示為綠色（例：Implement 的 Task 都已 Tested by Dev） */
  function progressClass(idx, curIdx, done = false) {
    return idx < curIdx || (idx === curIdx && done) ? 'past' : idx === curIdx ? 'current' : 'future';
  }

  /** Implement 與 規劃 同屬一個階段：同一欄，分成上下兩格 */
  function implementPlanCell(req, stage, idx, curIdx) {
    const impl = el('div', `stage ${progressClass(idx, curIdx, allDevDone(req))}`);
    impl.append(cells.implementCell(req));
    const mgr = el('div', `stage ${progressClass(idx, curIdx, !!state[req.id]?.[PLAN_KEY])}`);
    const mgrHead = el('div', 'sub-head');
    mgrHead.append(el('span', null, '規劃'));
    const note = state[req.id]?.[PLAN_NOTE_KEY];
    if (note) {
      const icon = el('span', 'note-icon', '💬');
      icon.title = note; // 滑鼠移上去以 tooltip 顯示 manager 的註解
      mgrHead.append(icon);
    }
    mgr.append(mgrHead, cells.planCheck(req, stage));
    const box = el('div', 'split-box');
    box.append(impl, mgr);
    const td = el('td', 'stage-split');
    td.append(box);
    return td;
  }

  function stageCell(req, stage, idx, curIdx) {
    if (stage.key === 'implement') return implementPlanCell(req, stage, idx, curIdx);
    const td = el('td', 'stage');
    td.classList.add(progressClass(idx, curIdx));
    if (stage.key === 'pending') {
      td.append(el('span', 'stage-mark', idx < curIdx ? '✓ 已展開' : '待指派 / 展開 Task'));
      if (!activeKids(req).length) td.append(cells.defaultTaskButton(req));
    } else if (isCommitStage(stage.key)) {
      const { box: commitBox, confirmed } = cells.commitCheck(req, stage);
      td.append(commitBox, deploy.deployChecks(req, stage, confirmed));
    } else if (stage.key === 'test') {
      td.append(cells.testCheck(req, stage));
    } else {
      const box = el('div', 'checks');
      box.append(...stage.checks.map(([k, label]) => checkbox(req, stage, k, label)));
      td.append(box);
    }
    return td;
  }

  function renderRow(req) {
    req.stage = computeStage(req, state[req.id] || {});
    const curIdx = stageIndex(req.stage);
    const tr = el('tr');
    tr.dataset.id = req.id;
    if (req.stage === DONE.key) tr.classList.add('all-done');

    const head = el('td', 'req-col');
    const top = el('div', 'req-top');
    top.append(workItemLink(`#${req.id}`, req), cells.stateChip(req));
    const stageName = req.stage === DONE.key ? DONE.label : STAGES[curIdx].label;
    head.append(top, el('div', 'req-title', req.title));
    // 規劃 選的 repository：以代表色標示，一眼看出此需求動到哪些 repository
    const s = state[req.id] || {};
    const repoKeys = s[PLAN_KEY] ? Object.keys(s[PLAN_REPOS_KEY] || {}) : [];
    if (repoKeys.length) {
      const tags = el('div', 'req-repos');
      tags.append(...repoKeys.map((k) => repoTag(k, 'repo-chip')));
      head.append(tags);
    }
    head.append(el('div', 'req-meta muted', `${req.assignedTo || '未指派'} · ${stageName}`));
    head.title = req.description ? req.description.slice(0, 300) : '';

    tr.append(head, ...STAGES.map((s, i) => stageCell(req, s, i, curIdx)));
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
      let repoError = '';
      const [result, st] = await Promise.all([
        api.fetchRequirementFlow(node.iterationPath, exact),
        api.loadFlowState(),
        // repository 設定讀不到時只影響顏色 / 名稱顯示，不擋流程表
        loadRepos().catch((err) => {
          repoError = cleanError(err);
        }),
      ]);
      if (seq !== requestSeq) return;
      requirements = result.requirements;
      state = st || {};
      statusEl.className = 'status';
      statusEl.textContent = `共 ${result.count} 筆 ${result.type} · 取得時間 ${result.fetchedAt.replace('T', ' ')}`;
      if (repoError) statusEl.textContent += ` · ⚠ 讀取 repository 設定失敗：${repoError}`;
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

  /** 只用目前資料重繪整張表（不重新查詢 ADO），例如 repository 設定（名稱 / 代表色）改變後 */
  function repaint() {
    if (table.hidden || !requirements.length) return;
    tbody.replaceChildren(...requirements.map(renderRow));
    renderSummary();
  }

  return { show, repaint };
}
