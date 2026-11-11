import { api, cleanError } from './api.js';
import { $, el } from './dom.js';
import { flowDeployJobs } from './deploy-jobs.js';
import { RELEASE_STEPS, RUN_RESULT_TEXT } from '../../shared/flow-rules.js';

const LOG_MAX_LINES = 3000;
const STATUS_TEXT = { running: '⏳ 佈版中', succeeded: '✔ 完成', failed: '✖ 失敗', canceled: '■ 已停止' };
const STEP_ICON = { pending: '○', running: '▶', done: '✔', skipped: '–', failed: '✖' };
const time = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false }) : '');

/**
 * 佈版進度 dialog（選單「佈版 → 佈版進度…」/ 標題列按鈕）：
 *   - 手動佈版：main process 的工作（manualDeploy.js），即時顯示步驟、Pipeline Run、輸出，可停止 / 重試 / 移除
 *   - Requirement 流程：在背景執行中的 SaaS 自動佈版 / Local 佈版 / UpAgent 發佈（deploy-jobs.js），按「開啟」回到原本的視窗
 * 手動佈版結束時跳出通知（視窗不在前景時用系統通知；沒有其他 dialog 開著時開啟此 dialog）。
 * @param openManual () => void，開啟手動佈版 dialog
 * @param badgeEl 標題列按鈕上的數字（進行中的工作數）
 */
export function createDeployProgressDialog({ openManual, badgeEl }) {
  const dialog = $('deploy-progress-dialog');
  const flowHead = $('pg-flow-head');
  const flowEl = $('pg-flow');
  const jobsHead = $('pg-jobs-head');
  const jobsEl = $('pg-jobs');
  const emptyEl = $('pg-empty');
  const clearBtn = $('pg-clear');

  /** 手動佈版工作：id → { job, lines, card: { root, body, details, pre, summary } } */
  const jobs = new Map();

  const nextReleaseStep = (job) => {
    const rel = job.release;
    const p = job.params.release;
    if (!rel || !p) return null;
    if (rel.version && rel.completed) return RELEASE_STEPS[RELEASE_STEPS.indexOf(rel.completed) + 1] || null;
    return p.mode === 'resume' ? p.startFrom : 'Bump';
  };

  function button(text, cls, onClick) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await onClick();
      } catch (err) {
        alertError(err);
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  function alertError(err) {
    const msg = el('p', 'status error', cleanError(err));
    jobsEl.prepend(msg);
    setTimeout(() => msg.remove(), 8000);
  }

  function renderBody(entry) {
    const { job } = entry;
    const head = el('div', 'pg-head');
    head.append(
      el('span', `pg-status ${job.status}`, STATUS_TEXT[job.status] || job.status),
      el('b', 'pg-title', job.title),
      el('span', 'muted', job.finishedAt ? `${time(job.startedAt)} ～ ${time(job.finishedAt)}` : `開始於 ${time(job.startedAt)}`)
    );
    const steps = el('ol', 'pg-steps');
    for (const s of job.steps) {
      const li = el('li', `pg-step ${s.state}`);
      li.append(el('span', 'pg-icon', STEP_ICON[s.state] || '○'), el('span', null, s.label));
      if (s.detail) li.append(el('span', 'pg-detail', s.detail));
      steps.append(li);
    }
    const parts = [head, steps];
    if (job.run) {
      const line = el('div', 'pg-run');
      const link = el('button', 'btn-link', `Pipeline Run #${job.run.buildNumber || job.run.id}`);
      link.type = 'button';
      link.title = '在瀏覽器開啟此 Run';
      link.addEventListener('click', () => job.run.webUrl && api.openExternal(job.run.webUrl));
      line.append(link, el('span', 'muted', job.run.active ? '進行中' : RUN_RESULT_TEXT[job.run.result] || job.run.result || ''));
      parts.push(line);
    }
    if (job.release?.version) parts.push(el('div', 'muted', `UpAgent 版號 ${job.release.version}${job.release.completed ? `，最後完成：${job.release.completed}` : ''}`));
    if (job.error && job.status !== 'canceled') parts.push(el('p', 'status error', job.error));

    const actions = el('div', 'pg-actions');
    if (job.status === 'running') {
      actions.append(button('停止', 'btn-ghost btn-danger', () => api.manualDeployCancel(job.id)));
    } else {
      actions.append(button('移除', 'btn-ghost', () => api.manualDeployDismiss(job.id)));
      // 客戶環境：在檔案總管中顯示 build 出的 image tar
      if (job.output) actions.append(button('開啟資料夾', 'btn-ghost', () => api.manualDeployShowOutput(job.id)));
      if (job.status !== 'succeeded') {
        const next = nextReleaseStep(job);
        if (next === 'WaitAction') {
          actions.append(button('重跑 GitHub Action 後重試', 'btn-ghost', () => api.manualDeployRetry(job.id, { rerunAction: true })));
        }
        actions.append(button(next && next !== 'Bump' && job.release?.completed ? `重試（UpAgent 從 ${next} 接續）` : '重試', 'btn-primary', () => api.manualDeployRetry(job.id)));
      }
    }
    parts.push(actions);
    entry.card.body.replaceChildren(...parts);
    entry.card.root.className = `pg-job ${job.status}`;
    entry.card.summary.textContent = `輸出（${entry.lines.length} 行）`;
  }

  function renderLog(entry) {
    const { pre, details } = entry.card;
    if (!details.open) return;
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    pre.textContent = entry.lines.join('\n');
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  function createCard(entry) {
    const root = el('div', 'pg-job');
    const body = el('div');
    const details = el('details', 'pg-log');
    const summary = el('summary', null, '輸出');
    const pre = el('pre', 'ur-log');
    details.append(summary, pre);
    details.addEventListener('toggle', () => {
      if (details.open) {
        renderLog(entry);
        pre.scrollTop = pre.scrollHeight;
      }
    });
    root.append(body, details);
    entry.card = { root, body, details, pre, summary };
  }

  function renderJobs() {
    const list = [...jobs.values()].sort((a, b) => b.job.id - a.job.id);
    jobsEl.replaceChildren(...list.map((e) => e.card.root));
    jobsHead.hidden = !list.length;
    clearBtn.hidden = !list.some((e) => e.job.status !== 'running');
  }

  function renderFlow() {
    const list = flowDeployJobs();
    flowHead.hidden = !list.length;
    flowEl.replaceChildren(
      ...list.map((j) => {
        const row = el('div', `pg-flow-job${j.active ? ' running' : j.failed ? ' failed' : ''}`);
        const info = el('div', 'pg-flow-info');
        info.append(el('b', null, j.title), el('span', 'muted', j.kind), el('span', 'pg-detail', j.text || ''));
        const open = el('button', 'btn-ghost', '開啟');
        open.type = 'button';
        open.addEventListener('click', () => {
          dialog.close();
          j.show();
        });
        row.append(info, open);
        return row;
      })
    );
    emptyEl.hidden = !!(list.length || jobs.size);
    return list;
  }

  /** 標題列按鈕上的數字：進行中的手動佈版 + 流程的工作 */
  function updateBadge() {
    const count = [...jobs.values()].filter((e) => e.job.status === 'running').length + flowDeployJobs().filter((j) => j.active).length;
    if (!badgeEl) return;
    badgeEl.textContent = String(count);
    badgeEl.hidden = !count;
  }

  function upsert(job, lines) {
    let entry = jobs.get(job.id);
    if (!entry) {
      entry = { job, lines: lines || [] };
      createCard(entry);
      jobs.set(job.id, entry);
    }
    entry.job = job;
    if (lines) entry.lines = lines;
    renderBody(entry);
    renderLog(entry);
    return entry;
  }

  function notifyFinished(job) {
    const body = job.status === 'succeeded' ? '佈版完成' : job.status === 'canceled' ? '已停止' : `佈版失敗：${job.error}`;
    if (!document.hasFocus() && 'Notification' in window) new Notification(`手動佈版 · ${job.title}`, { body });
    // 沒有其他視窗擋著時直接打開進度
    if (!dialog.open && !document.querySelector('dialog[open]')) open(job.id);
  }

  api.onManualDeployUpdate((job) => {
    if (job.removed) {
      jobs.delete(job.id);
    } else {
      const prev = jobs.get(job.id)?.job.status;
      upsert(job);
      if (prev === 'running' && job.status !== 'running') notifyFinished(job);
    }
    renderJobs();
    renderFlow();
    updateBadge();
  });
  api.onManualDeployLog(({ id, line }) => {
    const entry = jobs.get(id);
    if (!entry) return;
    entry.lines.push(line);
    if (entry.lines.length > LOG_MAX_LINES) entry.lines.splice(0, entry.lines.length - LOG_MAX_LINES);
    entry.card.summary.textContent = `輸出（${entry.lines.length} 行）`;
    renderLog(entry);
  });

  // renderer 重新載入時，main 仍在執行的工作要同步回來
  api
    .manualDeployList()
    .then((list) => {
      for (const job of list) upsert(job, job.lines);
      renderJobs();
      updateBadge();
    })
    .catch(() => {});

  // 流程的工作沒有事件：開著時每秒重繪，標題列數字每 2 秒更新
  setInterval(() => {
    if (dialog.open) renderFlow();
  }, 1000);
  setInterval(updateBadge, 2000);

  clearBtn.addEventListener('click', async () => {
    for (const e of [...jobs.values()]) if (e.job.status !== 'running') await api.manualDeployDismiss(e.job.id).catch(() => {});
  });
  $('pg-new').addEventListener('click', () => {
    dialog.close();
    openManual();
  });
  $('pg-ok').addEventListener('click', () => dialog.close());
  $('pg-close').addEventListener('click', () => dialog.close());

  /** 開啟 dialog；focusId = 要展開輸出並捲到的手動佈版工作 */
  function open(focusId) {
    renderJobs();
    renderFlow();
    if (!dialog.open) dialog.showModal();
    const entry = focusId != null && jobs.get(focusId);
    if (entry) {
      entry.card.details.open = true;
      entry.card.root.scrollIntoView({ block: 'nearest' });
    }
  }

  /** 手動佈版開始後：加入清單並開啟 */
  function started(job) {
    if (!jobs.has(job.id)) upsert(job); // 通常 manualDeploy:update 已先送到（較新）
    renderJobs();
    updateBadge();
    open(job.id);
  }

  return { open, started };
}
