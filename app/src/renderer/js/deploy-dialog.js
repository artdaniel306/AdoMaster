import { api, cleanError } from './api.js';
import { $, el, notify } from './dom.js';
import { repoTag } from './repos.js';
import { backMergeRows, backMergeProblems, hasBackMerges } from './back-merge.js';
import { mergeItemRow, willMerge } from './merge-dialog.js';
import { createRestartPicker, restartText } from './restart-picker.js';
import {
  restartSlot,
  runText,
  sameCommit,
  PIPELINE_POLL_MS as POLL_MS,
  PIPELINE_FIRST_POLL_MS as FIRST_POLL_MS,
  PIPELINE_FIND_RUN_TIMEOUT_MS as FIND_RUN_TIMEOUT_MS,
} from '../../shared/flow-rules.js';

const runClass = (run) => (run.active ? 'warn' : run.result === 'succeeded' ? 'ok' : 'bad');
const timeText = (d) => d.toLocaleTimeString('zh-TW', { hour12: false });

/** 一個 Pipeline Run 一行：#編號（點擊在瀏覽器開啟）、狀態、觸發者 · commit；extra 附加在最後（監視 SaaS 佈版狀態也用） */
export function runLine(run, extra = '') {
  const line = el('div', `dp-run ${runClass(run)}`);
  const link = el('button', 'btn-link', `#${run.buildNumber || run.id}`);
  link.type = 'button';
  link.title = '在瀏覽器開啟此 Run';
  link.addEventListener('click', () => run.webUrl && api.openExternal(run.webUrl));
  const meta = [run.requestedFor, run.sourceVersion?.slice(0, 10), extra].filter(Boolean).join(' · ');
  line.append(link, el('span', null, runText(run)), el('span', 'muted', meta));
  return line;
}

const PHASE_TEXT = {
  confirm: '確認後開始佈版',
  waiting: '等待 Pipeline 進行中 / 停等的 Run 結束',
  merging: 'merge 並 push 到環境 branch',
  watching: '監看 push 觸發的 Run',
  afterDeploy: '執行佈版後動作',
  done: '佈版結束',
};

/**
 * 勾 Test deploy / Prod deploy 的 SaaS 時的自動佈版流程（環境 branch push 後由 Azure DevOps Pipeline 自動佈版）：
 *   1. 確認（有 commit 要 merge 時）：列出要 merge 的 commit 與相關 Pipeline 目前的 Run
 *   2. 等待：Pipeline 還有進行中 / 停等的 Run 時，每 15 秒查一次，直到全部結束
 *   3. merge + push 到環境 branch（觸發自動佈版）
 *   4. 監看 push 觸發的 Run（sourceVersion = 這次的 merge commit）直到結束
 *   5. 佈版後動作（Run 成功的 repository 各一次，main/services/afterDeploy.js）：
 *      測試環境 → 重啟 data/config.json 的 repos 設定的 testAppService；
 *      正式環境 → 不立即重啟，確認畫面選的日期 / 時段交給 After-ProdDeploy.ps1 在 Azure Automation 排程重啟（不選 = 不排程）
 *   6. 通知結果：全部成功 → 自動勾起 SaaS；有失敗 / 找不到 Run / 佈版後動作失敗 → 由使用者決定是否仍然勾起
 * 等待 / 監看期間可以關閉 dialog 讓它在背景繼續，結束時會再跳出來通知。一次只能有一個佈版流程。
 */
export function createDeployDialog() {
  const dialog = $('deploy-dialog');
  const titleEl = $('dp-title');
  const reqEl = $('dp-req');
  const phaseEl = $('dp-phase');
  const mergeEl = $('dp-merge');
  const pipesEl = $('dp-pipelines');
  const hintEl = $('dp-hint');
  const errorEl = $('dp-error');
  const stopBtn = $('dp-stop');
  const bgBtn = $('dp-bg');
  const okBtn = $('dp-ok');
  const mergeHead = mergeEl.previousElementSibling;
  const restartHead = $('dp-restart-head');
  const restartEl = $('dp-restart');
  const restartChosenEl = $('dp-restart-chosen');
  const restartPicker = createRestartPicker(restartEl);

  /**
   * 目前的佈版流程：
   * { req, stage, checkLabel, phase, mergeStatus, pipelines, unconfigured, waited: Map<runId, { repo, run }>,
   *   targets: [{ repo, mergeCommit, run, after: { state: 'running' | 'ok' | 'bad', message } }], pushedAt, lastPoll, pollError, outcome, stopped, fns… }
   */
  let job = null;

  const pipelineOf = (j, repo) => j.pipelines.find((p) => p.repo === repo);
  const activeRuns = (j) => j.pipelines.flatMap((p) => p.runs.filter((r) => r.active).map((run) => ({ repo: p.repo, run })));
  const needsMerge = (j) => j.mergeStatus.items.some(willMerge);
  const blocked = (j) => j.mergeStatus.items.some((x) => !x.merged && !x.canMerge);
  /** 正式環境：這次會 merge 且有 Pipeline 的 repository（Run 成功後才會執行佈版後動作 / 排程重啟） */
  const restartRepos = (j) =>
    j.stage.key === 'prodDeploy' ? j.mergeStatus.items.filter((x) => willMerge(x) && pipelineOf(j, x.repo)).map((x) => x.repo) : [];

  function renderRestart(j) {
    const show = j.restartRepos.length > 0;
    restartHead.hidden = !show;
    restartEl.hidden = !show || j.phase !== 'confirm';
    restartChosenEl.hidden = !show || j.phase === 'confirm';
    if (show && j.phase !== 'confirm') {
      restartChosenEl.textContent = j.restart
        ? `${restartText(j.restart.date, restartSlot(j.restart.slot).time)} 重啟 ${j.restartRepos.join('、')}（Run 成功後建立排程）`
        : '不排程重啟';
    }
  }

  function setPhase(j, phase) {
    j.phase = phase;
    render();
    j.onChange?.(j.req.id);
  }

  function renderMerge(j) {
    mergeHead.hidden = !j.mergeStatus.items.length;
    mergeEl.replaceChildren(...j.mergeStatus.items.map(mergeItemRow));
    // Prod deploy：prodBranch 反向 merge 回 feature branch 的結果
    const { backMerges } = j.mergeStatus;
    if (hasBackMerges(backMerges)) {
      const fromOf = (repo) => j.mergeStatus.items.find((x) => x.repo === repo)?.envBranch;
      mergeEl.append(el('div', 'muted', '反向 merge 回 feature branch：'), ...backMergeRows(backMerges, fromOf));
    }
  }

  /** 每個 Pipeline 顯示：等待中的 Run（waiting）或 push 觸發的 Run（watching / done） */
  function renderPipelines(j) {
    const rows = j.pipelines.map((p) => {
      const row = el('div', 'dp-pipe');
      const name = el('div', 'cc-name');
      name.append(repoTag(p.repo), el('span', 'repo-branch', p.pipeline?.name || p.name));
      const runs = el('div', 'dp-runs');
      const target = j.targets.find((t) => t.repo === p.repo);
      // 等待過的 Run + 目前尚未結束的 Run（確認畫面時還沒開始等待）
      const shown = new Map([...j.waited.values()].filter((w) => w.repo === p.repo).map((w) => [w.run.id, w.run]));
      if (!target) for (const r of p.runs) if (r.active && !shown.has(r.id)) shown.set(r.id, r);
      const waited = [...shown.values()];
      if (target) {
        if (target.run) runs.append(runLine(target.run));
        else if (target.missing) runs.append(el('div', 'dp-run bad', '找不到 push 後觸發的 Run'));
        else runs.append(el('div', 'dp-run warn', `等待 ${target.mergeCommit.slice(0, 10)} 觸發的 Run 建立…`));
        const after = target.after;
        if (after && (after.state !== 'ok' || after.message)) {
          const cls = after.state === 'running' ? 'warn' : after.state;
          runs.append(el('div', `dp-run ${cls}`, after.state === 'running' ? after.message || '執行佈版後動作中…' : after.message));
        }
      }
      if (waited.length) {
        if (target) runs.append(el('div', 'muted', '先前等待的 Run：'));
        runs.append(...waited.map((r) => runLine(r)));
      }
      if (!target && !waited.length) runs.append(el('div', 'dp-run ok', '沒有進行中 / 停等的 Run'));
      row.append(name, runs);
      return row;
    });
    if (j.unconfigured.length) {
      rows.push(el('div', 'muted', `未設定 Pipeline（只 merge、不監看）：${j.unconfigured.join('、')}`));
    }
    pipesEl.replaceChildren(...rows);
  }

  function renderButtons(j) {
    const { phase } = j;
    stopBtn.hidden = phase === 'done';
    stopBtn.disabled = phase === 'merging' || phase === 'afterDeploy';
    stopBtn.textContent = phase === 'confirm' ? '取消' : phase === 'watching' ? '停止監看' : '停止';
    bgBtn.hidden = phase === 'confirm';
    bgBtn.disabled = phase === 'merging';
    okBtn.hidden = !(phase === 'confirm' || (phase === 'done' && !j.outcome.success && j.outcome.canCheck));
    okBtn.disabled = phase === 'confirm' && blocked(j);
    if (phase === 'confirm') okBtn.textContent = needsMerge(j) ? '開始佈版' : '開始';
    else okBtn.textContent = `仍然勾起 ${j.checkLabel}`;
    if (phase === 'done') bgBtn.textContent = j.outcome.success || !j.outcome.canCheck ? '關閉' : '不勾選';
    else bgBtn.textContent = '背景執行';
  }

  function render() {
    const j = job;
    if (!j) return;
    titleEl.textContent = `佈版 · ${j.stage.label} ${j.checkLabel}`;
    reqEl.textContent = `#${j.req.id} ${j.req.title}`;
    let text = PHASE_TEXT[j.phase];
    if (j.phase === 'done') text = j.outcome.message;
    else if (j.phase !== 'confirm' && j.phase !== 'merging' && j.phase !== 'afterDeploy' && j.lastPoll) text += `（每 ${POLL_MS / 1000} 秒更新，最後更新 ${timeText(j.lastPoll)}）`;
    phaseEl.textContent = text;
    phaseEl.className = `status${j.phase === 'done' ? (j.outcome.success ? ' ok' : ' error') : j.phase === 'confirm' ? '' : ' loading'}`;
    renderMerge(j);
    renderPipelines(j);
    renderRestart(j);
    hintEl.textContent = j.phase === 'confirm' && blocked(j) ? '有 repository merge 會發生衝突，請先手動處理後再勾選。' : '';
    const err = j.phase === 'done' ? j.outcome.error : j.phase === 'confirm' ? j.confirmError : j.pollError;
    errorEl.textContent = err || '';
    errorEl.hidden = !err;
    renderButtons(j);
  }

  function sleep(j, ms) {
    return new Promise((resolve) => {
      j.wake = resolve;
      j.timer = setTimeout(resolve, ms);
    });
  }

  /** 重新查一次各 Pipeline 的 Run，更新等待中 / push 觸發的 Run */
  async function poll(j) {
    try {
      const r = await j.runsFn();
      if (j.stopped) return;
      j.pipelines = r.pipelines;
      j.pollError = '';
      for (const [id, w] of j.waited) {
        const run = pipelineOf(j, w.repo)?.runs.find((x) => x.id === id);
        if (run) w.run = run;
      }
      for (const t of j.targets) {
        const runs = pipelineOf(j, t.repo)?.runs || [];
        t.run = runs.find((x) => (t.run ? x.id === t.run.id : sameCommit(x.sourceVersion, t.mergeCommit))) || t.run;
      }
    } catch (err) {
      j.pollError = `查詢 Pipeline Run 失敗（會繼續重試）：${cleanError(err)}`;
    }
    j.lastPoll = new Date();
    render();
  }

  async function waitIdle(j) {
    for (;;) {
      const active = activeRuns(j);
      for (const a of active) j.waited.set(a.run.id, a);
      render();
      if (!active.length || j.stopped) return;
      await sleep(j, POLL_MS);
      if (j.stopped) return;
      await poll(j);
    }
  }

  async function watchNewRuns(j) {
    let first = true;
    for (;;) {
      if (Date.now() - j.pushedAt > FIND_RUN_TIMEOUT_MS) {
        for (const t of j.targets) if (!t.run) t.missing = true; // 其他已找到的 Run 仍要等到結束
      }
      if (j.stopped || !j.targets.some((t) => !t.missing && (!t.run || t.run.active))) return;
      await sleep(j, first ? FIRST_POLL_MS : POLL_MS);
      first = false;
      if (j.stopped) return;
      await poll(j);
    }
  }

  /** 依結果決定是否自動勾選，並跳出 dialog 通知 */
  async function finish(j, error) {
    // 有 merge 並 push 的 repository → 看 push 觸發的 Run；沒有 → 看等待過的 Run
    const results = j.targets.length ? j.targets.map((t) => t.run) : [...j.waited.values()].map((w) => w.run);
    const runsOk = results.every((r) => r && r.result === 'succeeded');
    const afterFailed = j.targets.filter((t) => t.after?.state === 'bad');
    const success = !error && runsOk && !afterFailed.length;
    let message;
    if (error) message = '佈版失敗';
    else if (success) message = results.length ? '佈版完成：所有 Run 都已成功' : '佈版完成：已 merge，沒有需要監看的 Run';
    else if (results.some((r) => !r)) message = '佈版結束：有 repository 找不到 push 後觸發的 Run';
    else if (!runsOk) message = `佈版結束：有 Run 未成功（${results.filter((r) => r.result !== 'succeeded').map(runText).join('、')}）`;
    else message = `佈版結束：Run 都已成功，但佈版後動作失敗（${afterFailed.map((t) => t.repo).join('、')}）`;
    // 反向 merge 回 feature branch 失敗不影響佈版結果（正式環境已 push），只提醒手動處理
    if (backMergeProblems(j.mergeStatus.backMerges)) message += '（有 feature branch 反向 merge 失敗，請手動處理）';
    j.outcome = { success, message, error: error ? cleanError(error) : '', canCheck: !error };
    if (success) {
      try {
        await j.checkFn();
        j.outcome.message += `，已勾起 ${j.checkLabel}`;
      } catch (err) {
        j.outcome = { ...j.outcome, success: false, canCheck: true, error: `勾選 ${j.checkLabel} 失敗：${cleanError(err)}` };
      }
    }
    setPhase(j, 'done');
    if (!dialog.open) dialog.showModal();
    notify(`#${j.req.id} ${j.stage.label} ${j.checkLabel}`, j.outcome.message);
  }

  /** push 觸發的 Run 成功的 repository，各執行一次佈版後動作（測試環境重啟 App Service；正式環境依選擇的時段在 Azure Automation 排程重啟，不立即重啟） */
  async function runAfterDeploy(j) {
    const done = j.targets.filter((t) => t.run?.result === 'succeeded');
    if (!done.length) return;
    setPhase(j, 'afterDeploy');
    await Promise.all(
      done.map(async (t) => {
        t.after = { state: 'running', message: '' };
        render();
        try {
          const r = await j.afterDeployFn(t.repo, t.mergeCommit, j.restart);
          t.after = { state: 'ok', message: r?.message || '' };
        } catch (err) {
          t.after = { state: 'bad', message: cleanError(err) };
        }
        render();
      })
    );
  }

  async function run(j) {
    try {
      setPhase(j, 'waiting');
      await waitIdle(j);
      if (j.stopped) return;
      if (needsMerge(j)) {
        setPhase(j, 'merging');
        const status = await j.mergeFn();
        if (j.stopped) return; // merge 中不能停止，保險起見
        j.mergeStatus = status;
        j.pushedAt = Date.now();
        j.targets = Object.entries(status.mergeCommits || {})
          .filter(([repo]) => pipelineOf(j, repo))
          .map(([repo, mergeCommit]) => ({ repo, mergeCommit, run: null, missing: false, after: null }));
        if (j.targets.length) {
          setPhase(j, 'watching');
          await watchNewRuns(j);
          if (j.stopped) return;
          await runAfterDeploy(j);
          if (j.stopped) return;
        }
      }
      await finish(j);
    } catch (err) {
      if (!j.stopped) await finish(j, err);
    }
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  /** 結束並清除目前的流程 */
  function end() {
    const j = job;
    if (!j) return;
    j.stopped = true;
    clearTimeout(j.timer);
    j.wake?.();
    job = null;
    close();
    j.onChange?.(j.req.id);
  }

  okBtn.addEventListener('click', async () => {
    const j = job;
    if (!j) return;
    if (j.phase === 'confirm') {
      try {
        j.restart = j.restartRepos.length ? restartPicker.value() : null;
      } catch (err) {
        j.confirmError = err.message;
        render();
        return;
      }
      j.confirmError = '';
      run(j);
      return;
    }
    // done 且未成功：使用者決定仍然勾起
    okBtn.disabled = true;
    try {
      await j.checkFn();
      end();
    } catch (err) {
      j.outcome.error = `勾選 ${j.checkLabel} 失敗：${cleanError(err)}`;
      render();
    } finally {
      okBtn.disabled = false;
    }
  });
  stopBtn.addEventListener('click', () => {
    if (job && job.phase !== 'merging' && job.phase !== 'afterDeploy') end();
  });
  bgBtn.addEventListener('click', () => {
    if (!job) return;
    if (job.phase === 'done') end();
    else if (job.phase !== 'merging') close();
  });
  const dismiss = () => {
    if (!job) return close();
    if (job.phase === 'confirm' || job.phase === 'done') end();
    else if (job.phase !== 'merging') close(); // 等待 / 監看中：在背景繼續
  };
  $('dp-close').addEventListener('click', dismiss);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    dismiss();
  });

  /**
   * 開始佈版流程並開啟 dialog。有 commit 要 merge 時先停在確認畫面；否則直接開始等待進行中的 Run。
   * @param req Requirement
   * @param stage { key, label }
   * @param checkLabel 要勾的 checkbox 名稱（SaaS）
   * @param mergeStatus deployMergeStatus 的結果
   * @param pipelineRuns deployPipelineRuns 的結果
   * @param mergeFn () => Promise<mergeDeploy 的結果>
   * @param runsFn () => Promise<deployPipelineRuns 的結果>
   * @param afterDeployFn (repo, mergeCommit, restart) => Promise<{ message }>，Run 成功後的佈版後動作
   *   （restart：正式環境確認畫面選的 { date, slot }，null = 不排程重啟）
   * @param checkFn () => Promise，勾起 checkbox
   * @param onChange (reqId) => void，流程狀態改變時呼叫（重繪該列）
   */
  function start({ req, stage, checkLabel, mergeStatus, pipelineRuns, mergeFn, runsFn, afterDeployFn, checkFn, onChange }) {
    if (job) throw new Error(`已有佈版流程進行中：#${job.req.id} ${job.stage.label} ${job.checkLabel}`);
    job = {
      req,
      stage,
      checkLabel,
      phase: 'confirm',
      mergeStatus,
      pipelines: pipelineRuns.pipelines,
      unconfigured: pipelineRuns.unconfigured,
      waited: new Map(),
      targets: [],
      lastPoll: new Date(),
      pollError: '',
      stopped: false,
      mergeFn,
      runsFn,
      afterDeployFn,
      checkFn,
      onChange,
      restart: null,
      restartRepos: [],
      confirmError: '',
    };
    job.restartRepos = restartRepos(job);
    if (job.restartRepos.length) restartPicker.load(job.restartRepos);
    render();
    dialog.showModal();
    if (needsMerge(job)) job.onChange?.(req.id);
    else run(job);
  }

  /** 該 Requirement / 階段是否有佈版流程進行中；有的話回傳顯示用的狀態文字 */
  function statusOf(reqId, stageKey) {
    if (!job || job.req.id !== reqId || job.stage.key !== stageKey) return null;
    return job.phase === 'done' ? job.outcome.message : `佈版中：${PHASE_TEXT[job.phase]}`;
  }

  /** 重新開啟 dialog（從背景執行中叫回來） */
  function show() {
    if (job && !dialog.open) {
      render();
      dialog.showModal();
    }
  }

  /** 「佈版進度」dialog 用：目前的流程（沒有時回傳 null） */
  function summary() {
    if (!job) return null;
    const done = job.phase === 'done';
    return {
      title: `#${job.req.id} ${job.req.title}`,
      kind: `${job.stage.label} ${job.checkLabel} · SaaS 自動佈版`,
      text: done ? job.outcome.message : PHASE_TEXT[job.phase],
      active: !done && job.phase !== 'confirm',
      failed: done && !job.outcome.success,
    };
  }

  return { start, statusOf, show, summary };
}
