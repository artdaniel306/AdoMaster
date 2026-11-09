import { api, cleanError } from './api.js';
import { $, el } from './dom.js';
import { repoTag } from './repos.js';

/** 保留在畫面上的輸出行數上限 */
const LOG_MAX_LINES = 3000;

const STEP_TEXT = {
  Docker: '確認 Docker',
  Source: '切到環境 branch',
  Env: '套用環境 .env',
  PreBuild: '前置指令',
  Build: 'Build image tar',
  Push: 'docker load + push',
  Deploy: 'ssh 更新 container',
};
const ENV_LABEL = { test: '測試環境', prod: '正式環境' };
const time = (iso) => new Date(iso).toLocaleString('zh-TW', { hour12: false });

/**
 * Local 佈版（勾測試 / 正式環境佈版的 Local，確認 merge 後執行 shell/Deploy-Local.ps1）：
 *   列出規劃中有設定 localDeploy 的 repository（預設勾選：此階段還沒以目前 Confirm Commit 佈版過的）→ 依序 build 成 image tar（data/local_deploy/）
 *   → docker load + push → ssh 換 container。推送 / ssh 失敗後重試時，同一個 commit 的 tar 已存在就不重新 build。
 *   全部取消勾選 = 略過佈版直接勾起（例如已手動佈版）。
 * 執行中可按「背景執行」關閉視窗，結束時再通知。一次只能有一個 Local 佈版。
 */
export function createLocalDeployDialog() {
  const dialog = $('local-deploy-dialog');
  const titleEl = $('ld-title');
  const reqEl = $('ld-req');
  const planEl = $('ld-plan');
  const reposEl = $('ld-repos');
  const rebuildRow = $('ld-rebuild-row');
  const rebuildEl = $('ld-rebuild');
  const phaseEl = $('ld-phase');
  const logEl = $('ld-log');
  const errorEl = $('ld-error');
  const stopBtn = $('ld-stop');
  const bgBtn = $('ld-bg');
  const okBtn = $('ld-ok');

  /** { req, stage, checkLabel, env, targets, selected: Set, phase: 'confirm' | 'running' | 'done', repo, step, lines, error, resolve, onChange } */
  let job = null;

  const runnable = (j) => j.targets.filter((t) => !t.error);

  function renderRepos(j) {
    reposEl.replaceChildren(
      ...j.targets.map((t) => {
        const row = el('label', `ld-repo${t.upToDate ? ' done' : ''}`);
        const box = el('input');
        box.type = 'checkbox';
        box.checked = j.selected.has(t.repo);
        box.disabled = j.phase !== 'confirm' || !!t.error;
        box.addEventListener('change', () => {
          if (box.checked) j.selected.add(t.repo);
          else j.selected.delete(t.repo);
          render();
        });
        const info = el('span');
        info.append(repoTag(t.repo), ` → ${t.remoteHost}（port ${t.hostPort}，container ${t.appName}）`);
        info.append(el('span', 'muted', `從 ${t.projectDir} 切到 origin/${t.envBranch} 後 build`));
        if (t.upToDate) info.append(el('span', 'muted', `✓ 已佈版 ${t.last.commit.slice(0, 10)}（${time(t.last.deployedAt)}）`));
        else if (t.last) info.append(el('span', 'muted', `上次佈版 ${t.last.commit.slice(0, 10)}（${time(t.last.deployedAt)}）之後 Confirm Commit 已變更，需重新佈版`));
        if (t.error) info.append(el('span', 'error', t.error));
        if (j.phase === 'running' && j.repo === t.repo) info.append(el('span', 'muted', `▶ 執行中${j.step ? `：${STEP_TEXT[j.step] || j.step}` : '…'}`));
        row.append(box, info);
        return row;
      })
    );
  }

  function render() {
    const j = job;
    if (!j) return;
    titleEl.textContent = `Local 佈版 · ${j.stage.label} ${j.checkLabel}`;
    reqEl.textContent = `#${j.req.id} ${j.req.title}`;
    planEl.textContent = `勾「${j.stage.label} ${j.checkLabel}」前，將勾選的 repository 佈版到${ENV_LABEL[j.env]}地端主機：\n部署用資料夾切到環境 branch → (套用該環境的 .env) → (前置指令) → build 成 image tar（data/local_deploy/）→ docker load + push → ssh 到主機換掉 container（會有短暫停機）。\n同一個 commit 已 build 過 tar 時直接推送，不重新 build。\n已手動佈版可取消全部勾選，直接勾起。${j.unconfigured.length ? `\n未設定 Local 佈版（不會佈版）：${j.unconfigured.join('、')}` : ''}`;
    renderRepos(j);
    rebuildRow.hidden = j.phase !== 'confirm' || !j.selected.size;

    if (j.phase === 'running') {
      phaseEl.className = 'status loading';
      const t = j.targets.find((x) => x.repo === j.repo);
      phaseEl.textContent = `執行中：${t?.label || j.repo}${j.step ? ` · ${STEP_TEXT[j.step] || j.step}` : ''}`;
    } else if (j.phase === 'done') {
      phaseEl.className = 'status ok';
      phaseEl.textContent = j.doneMessage;
    } else {
      phaseEl.className = 'status';
      phaseEl.textContent = '';
    }
    logEl.hidden = !j.lines.length;
    errorEl.textContent = j.error || '';
    errorEl.hidden = !j.error;

    stopBtn.hidden = j.phase === 'done';
    stopBtn.textContent = j.phase === 'running' ? '停止' : '取消';
    bgBtn.hidden = j.phase === 'confirm';
    bgBtn.textContent = j.phase === 'running' ? '背景執行' : '關閉';
    okBtn.hidden = j.phase !== 'confirm';
    okBtn.textContent = j.selected.size ? (j.error ? '重試' : `開始佈版（${j.selected.size}）`) : '不佈版，直接勾起';
  }

  function appendLog(line) {
    const j = job;
    j.lines.push(line);
    if (j.lines.length > LOG_MAX_LINES) j.lines.splice(0, j.lines.length - LOG_MAX_LINES);
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
    logEl.textContent = j.lines.join('\n');
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
    logEl.hidden = false;
  }

  api.onLocalDeployLog(({ id, stage, line }) => {
    if (job && job.req.id === id && job.stage.key === stage) appendLog(line);
  });
  api.onLocalDeployStep(({ id, stage, repo, step }) => {
    if (!job || job.req.id !== id || job.stage.key !== stage) return;
    job.repo = repo;
    job.step = step;
    render();
    job.onChange?.(id);
  });

  const notify = (title, body) => {
    if (!document.hasFocus() && 'Notification' in window) new Notification(title, { body });
  };

  async function run(j) {
    const repos = runnable(j).map((t) => t.repo).filter((r) => j.selected.has(r));
    if (!repos.length) return finish(true);
    j.phase = 'running';
    j.error = '';
    j.repo = repos[0];
    j.step = null;
    render();
    j.onChange?.(j.req.id);
    try {
      const checks = await api.runLocalDeploy(j.req.id, j.stage.key, repos, { rebuild: rebuildEl.checked });
      j.doneMessage = `Local 佈版完成：${repos.join('、')}`;
      j.phase = 'done';
      render();
      finish(true, checks);
      notify(`#${j.req.id} ${j.stage.label} ${j.checkLabel}`, j.doneMessage);
    } catch (err) {
      if (job !== j) return;
      // 回到確認畫面：重新查詢（已成功的 repository 已記錄，預設不再勾選）
      j.error = `佈版失敗：${cleanError(err)}`;
      try {
        const status = await api.localDeployStatus(j.req.id, j.stage.key);
        j.targets = status.targets;
        j.selected = new Set(runnable(j).filter((t) => repos.includes(t.repo) && !t.upToDate).map((t) => t.repo));
      } catch {
        // 查不到就沿用原本的清單
      }
      j.phase = 'confirm';
      j.repo = null;
      render();
      j.onChange?.(j.req.id);
      if (!dialog.open) dialog.showModal();
      notify(`#${j.req.id} Local 佈版失敗`, cleanError(err));
    }
  }

  /** 結束：ok = 可以勾起 Local；完成時保留視窗顯示結果，其他情況關閉 */
  function finish(ok, checks) {
    const j = job;
    if (!j) return;
    if (!ok || !dialog.open || j.phase !== 'done') {
      job = null;
      if (dialog.open) dialog.close();
    }
    j.resolve({ ok, checks });
    j.onChange?.(j.req.id);
  }

  function dismiss() {
    if (!job) return dialog.open && dialog.close();
    if (job.phase === 'running') dialog.close(); // 在背景繼續
    else if (job.phase === 'done') {
      job = null;
      dialog.close();
    } else finish(false);
  }

  okBtn.addEventListener('click', () => {
    if (job?.phase === 'confirm') run(job);
  });
  stopBtn.addEventListener('click', async () => {
    if (!job) return;
    if (job.phase !== 'running') return finish(false);
    stopBtn.disabled = true;
    try {
      await api.cancelLocalDeploy(); // run() 會收到「已停止」的錯誤並回到確認畫面
    } finally {
      stopBtn.disabled = false;
    }
  });
  bgBtn.addEventListener('click', dismiss);
  $('ld-close').addEventListener('click', dismiss);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    dismiss();
  });

  /**
   * 開啟 Local 佈版視窗，回傳 Promise<{ ok, checks }>：ok = true 代表可以勾起 Local（checks 為佈版後的狀態，略過時為 undefined）。
   * @param status api.localDeployStatus 的結果（targets 不可為空）
   * @param onChange (reqId) => void，狀態改變時呼叫（重繪該列的狀態文字）
   */
  function open({ req, stage, checkLabel, status, onChange }) {
    if (job) throw new Error(`已有 Local 佈版進行中：#${job.req.id} ${job.stage.label}`);
    if (status.running) throw new Error(`已有 Local 佈版進行中：${status.running.label || `#${status.running.id} ${status.running.repo}`}`);
    return new Promise((resolve) => {
      job = {
        req,
        stage,
        checkLabel,
        env: status.env,
        targets: status.targets,
        unconfigured: status.unconfigured || [],
        selected: new Set(),
        phase: 'confirm',
        repo: null,
        step: null,
        lines: [],
        error: '',
        resolve,
        onChange,
      };
      job.selected = new Set(runnable(job).filter((t) => !t.upToDate).map((t) => t.repo));
      logEl.textContent = '';
      rebuildEl.checked = false;
      render();
      dialog.showModal();
    });
  }

  /** 該 Requirement / 階段是否有 Local 佈版進行中；有的話回傳顯示用的狀態文字 */
  function statusOf(reqId, stageKey) {
    if (!job || job.req.id !== reqId || job.stage.key !== stageKey) return null;
    if (job.phase === 'running') return `Local 佈版中：${job.repo}${job.step ? ` · ${STEP_TEXT[job.step] || job.step}` : '…'}`;
    if (job.phase === 'confirm' && job.error) return 'Local 佈版失敗（點擊查看）';
    return null;
  }

  /** 重新開啟視窗（從背景執行中叫回來） */
  function show() {
    if (job && !dialog.open) {
      render();
      dialog.showModal();
    }
  }

  /** 「佈版進度」dialog 用：目前的 Local 佈版（沒有時回傳 null） */
  function summary() {
    if (!job) return null;
    const text =
      job.phase === 'running'
        ? `執行中：${job.repo}${job.step ? ` · ${STEP_TEXT[job.step] || job.step}` : '…'}`
        : job.phase === 'done'
          ? job.doneMessage
          : job.error || '等待確認';
    return {
      title: `#${job.req.id} ${job.req.title}`,
      kind: `${job.stage.label} ${job.checkLabel} · Local 佈版`,
      text,
      active: job.phase === 'running',
      failed: job.phase === 'confirm' && !!job.error,
    };
  }

  return { open, statusOf, show, summary };
}
