import { api, cleanError } from './api.js';
import { el } from './dom.js';
import { createPlanDialog } from './plan-dialog.js';
import { createCommitDialog } from './commit-dialog.js';
import { createTaskDialog } from './task-dialog.js';
import { createTestDialog } from './test-dialog.js';
import { workItemLink } from './description-dialog.js';
import { repoTag } from './repos.js';
import { activeKids, isDevDone, stateClass, expectedState, sameState } from './flow-stages.js';
import {
  PLAN_KEY,
  PLAN_REPOS_KEY,
  PLAN_MIGRATION_KEY,
  PLAN_NOTE_KEY,
  TEST_KEY,
  TEST_RECORD_KEY,
  commitsKey,
  commitsForcedKey,
  commitsCover,
  commitsConfirmed,
  noRepoChange,
} from '../../shared/flow-rules.js';

/**
 * 流程表中各格子的內容：狀態 chip、安排預設 Task、開發（Task 清單）、規劃、Confirm Commit、測試 / 檢核。
 * 佈版階段的 SaaS / Local 在 flow-deploy.js。
 *
 * @param ctx requirement-flow.js 提供的共用環境：
 *   { statusEl, checks(id), setChecks(id, checks), update(req), flowCheck(req, options) }
 */
export function createFlowCells(ctx) {
  const { statusEl } = ctx;
  const planDialog = createPlanDialog();
  const commitDialog = createCommitDialog();
  const taskDialog = createTaskDialog();
  const testDialog = createTestDialog();

  /** 儲存後更新本機狀態並重繪該列 */
  const saved = (req) => (checks) => {
    ctx.setChecks(req.id, checks);
    ctx.update(req);
  };

  /** 規劃：checkbox 本身不直接切換，點擊時開啟 dialog 選擇 repository / feature branch */
  function planCheck(req, stage) {
    const s = ctx.checks(req.id);
    const lab = ctx.flowCheck(req, {
      stage,
      key: PLAN_KEY,
      text: '已理解需求 / 確認開發 repository',
      checked: !!s[PLAN_KEY],
      title: '點擊選擇要開發的 repository 與 feature branch',
      normal: () => {
        const current = s[PLAN_KEY]
          ? { repos: s[PLAN_REPOS_KEY], migration: !!s[PLAN_MIGRATION_KEY], note: s[PLAN_NOTE_KEY] }
          : undefined;
        planDialog.open(req, current, async (repos, migration, note) => {
          saved(req)(await api.setPlan(req.id, repos, migration, note));
        });
      },
    });

    const box = el('div');
    box.append(lab);
    if (s[PLAN_KEY]) {
      const list = el('div', 'check-summary');
      const repos = Object.entries(s[PLAN_REPOS_KEY] || {});
      if (!repos.length) list.append(el('div', 'repo-line repo-branch', '不需修改 repository'));
      for (const [repo, branch] of repos) {
        const line = el('div', 'repo-line');
        line.append(repoTag(repo), el('span', 'repo-branch', branch));
        list.append(line);
      }
      if (s[PLAN_MIGRATION_KEY]) list.append(el('div', 'repo-line migration', '⚠ 需要 migration'));
      box.append(list);
    }
    return box;
  }

  /** Confirm Commit：點擊開啟 dialog 填入各 repository 測試通過版的 commit；確認後才能勾 SaaS / Local */
  function commitCheck(req, stage) {
    const s = ctx.checks(req.id);
    const repos = s[PLAN_KEY] ? s[PLAN_REPOS_KEY] || {} : {};
    const commits = s[commitsKey(stage.key)];
    const confirmed = commitsConfirmed(s, stage.key);
    const forced = !!s[commitsForcedKey(stage.key)];

    const box = el('div', 'commit-check');
    // 規劃 沒選 repository（不需修改程式）→ 自動完成，不能點
    if (noRepoChange(s)) {
      const wrap = el('span', 'flow-check');
      wrap.title = '規劃未選擇 repository，不需要 Confirm Commit';
      const input = el('input');
      input.type = 'checkbox';
      input.checked = input.disabled = true;
      wrap.append(input, el('span', null, 'Confirm Commit'));
      box.append(wrap);
      return { box, confirmed };
    }

    box.append(
      ctx.flowCheck(req, {
        stage,
        key: commitsForcedKey(stage.key),
        text: 'Confirm Commit',
        checked: confirmed,
        disabledReason: s[PLAN_KEY] ? '' : '請先完成規劃',
        title: '點擊填入各 repository 測試通過版的 commit',
        normal: () =>
          commitDialog.open({
            req,
            stageLabel: stage.label,
            repos,
            current: commits,
            // Prod deploy 尚未確認時，預設帶入 Test deploy 確認過的 commit
            prefill: stage.key === 'prodDeploy' ? s[commitsKey('testDeploy')] : undefined,
            saveFn: async (c) => saved(req)(await api.setCommits(req.id, stage.key, c)),
          }),
      })
    );
    if (forced && !(s[PLAN_KEY] && commitsCover(s, stage.key))) {
      box.append(el('div', 'check-summary repo-line repo-branch', '跳階段勾起，未填 commit'));
    } else if (commits) {
      const list = el('div', 'check-summary');
      for (const repo of Object.keys(repos)) {
        const line = el('div', 'repo-line');
        line.append(repoTag(repo));
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
        ctx.update(req);
        statusEl.textContent = `已將 #${req.id} 的狀態更新為 ${updated.state}`;
      } catch (err) {
        btn.disabled = false;
        statusEl.className = 'status error';
        statusEl.textContent = `更新狀態失敗：${cleanError(err)}`;
      }
    });
    return btn;
  }

  /**
   * 測試 / 檢核完成：勾起時先開啟測試 / 檢核記錄 dialog，儲存記錄後才勾起；取消勾選時保留記錄（再次勾選會帶入）。
   * 有記錄時在底下顯示連結，點擊可檢視 / 編輯（不變更勾選狀態）。
   */
  function testCheck(req, stage) {
    const s = ctx.checks(req.id);
    const record = s[TEST_RECORD_KEY];
    const openRecord = (confirm) =>
      testDialog.open({
        req,
        record,
        confirm,
        saveFn: async (data) => saved(req)(await api.setTestRecord(req.id, { ...data, check: confirm })),
      });
    const box = el('div', 'checks');
    box.append(
      ctx.flowCheck(req, {
        stage,
        key: TEST_KEY,
        text: '測試 / 檢核完成',
        checked: !!s[TEST_KEY],
        title: '點擊記錄這次的測試場景或驗證方式',
        normal: async (value) => {
          if (value) return openRecord(true);
          saved(req)(await api.setFlowCheck(req.id, TEST_KEY, false));
        },
      })
    );
    if (record) {
      const n = record.images?.length || 0;
      const btn = el('button', 'btn-link test-record-link', `📝 測試 / 檢核記錄${n ? `（${n} 張圖）` : ''}`);
      btn.type = 'button';
      btn.title = `${record.note || '（無文字記錄）'}

點擊檢視 / 編輯`;
      btn.addEventListener('click', () => openRecord(false));
      box.append(btn);
    }
    return box;
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
        ctx.update(req);
        statusEl.textContent = `已建立 Task #${task.id}：${task.title}`;
      });
    });
    return btn;
  }

  /** 開發：子項目（Task / Bug）清單與完成數 */
  function implementCell(req) {
    const kids = activeKids(req);
    const box = el('div', 'impl');
    const doneCount = kids.filter(isDevDone).length;
    const head = el('div', 'sub-head');
    head.append(
      el('span', null, '開發'),
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

  return { planCheck, commitCheck, stateChip, testCheck, defaultTaskButton, implementCell };
}
