import { cleanError } from './api.js';
import { $, notify } from './dom.js';
import { createLogView } from './log-view.js';

/**
 * Requirement 流程中「確認 → 執行 → 完成」的背景工作 dialog 共用骨架（Local 佈版、UpAgent 發佈）：
 *   confirm：顯示要做什麼，按「確定」開始；失敗後回到這裡顯示錯誤，可重試
 *   running：顯示步驟與輸出，可「停止」或「背景執行」（關閉視窗，結束時通知）
 *   done：顯示結果，按「關閉」才清除；在背景完成則直接清除
 * 一次只能有一個工作。HTML 依前綴命名：<prefix>-title / -req / -phase / -log / -error / -stop / -bg / -ok / -close。
 *
 * @param o.label        工作名稱（例 'Local 佈版'），用於標題、狀態與通知
 * @param o.failText     失敗訊息的前綴（例 '佈版失敗'）
 * @param o.onLog / o.onStep  api 的事件訂閱（payload 含 id、stage）
 * @param o.applyStep(j, payload) 收到 step 事件時更新 job（預設只記 step）
 * @param o.runningText(j) 執行中顯示的步驟文字（可為空）
 * @param o.init(j, status, extra) 開啟時補上 job 的專屬欄位、重設表單
 * @param o.confirm(j)   確認畫面按「確定」
 * @param o.cancel()     停止執行中的工作（run 會收到「已停止」的錯誤並回到確認畫面）
 * @param o.render(j)    畫專屬部分；在共用部分之後呼叫，可覆寫按鈕文字 / 錯誤
 */
export function createBackgroundJobDialog({ dialog, prefix, label, failText, onLog, onStep, applyStep, runningText, init, confirm, cancel, render: renderBody }) {
  const titleEl = $(`${prefix}-title`);
  const reqEl = $(`${prefix}-req`);
  const phaseEl = $(`${prefix}-phase`);
  const logEl = $(`${prefix}-log`);
  const errorEl = $(`${prefix}-error`);
  const stopBtn = $(`${prefix}-stop`);
  const bgBtn = $(`${prefix}-bg`);
  const okBtn = $(`${prefix}-ok`);
  const log = createLogView(logEl);

  /** { req, stage, checkLabel, phase: 'confirm' | 'running' | 'done', step, error, doneMessage, resolve, onChange, ...專屬欄位 } */
  let job = null;

  const owns = (id, stage) => job && job.req.id === id && job.stage.key === stage;
  const changed = (j) => j.onChange?.(j.req.id);
  const stepSuffix = (j) => {
    const t = runningText(j);
    return t ? `：${t}` : '…';
  };

  function render() {
    const j = job;
    if (!j) return;
    titleEl.textContent = `${label} · ${j.stage.label} ${j.checkLabel}`;
    reqEl.textContent = `#${j.req.id} ${j.req.title}`;
    if (j.phase === 'running') {
      phaseEl.className = 'status loading';
      phaseEl.textContent = `執行中${stepSuffix(j)}`;
    } else if (j.phase === 'done') {
      phaseEl.className = 'status ok';
      phaseEl.textContent = j.doneMessage;
    } else {
      phaseEl.className = 'status';
      phaseEl.textContent = '';
    }
    logEl.hidden = !log.length;
    errorEl.textContent = j.error || '';
    errorEl.hidden = !j.error;

    stopBtn.hidden = j.phase === 'done';
    stopBtn.textContent = j.phase === 'running' ? '停止' : '取消';
    bgBtn.hidden = j.phase === 'confirm';
    bgBtn.textContent = j.phase === 'running' ? '背景執行' : '關閉';
    okBtn.hidden = j.phase !== 'confirm';
    renderBody(j);
  }

  onLog(({ id, stage, line }) => {
    if (owns(id, stage)) log.append(line);
  });
  onStep((payload) => {
    if (!owns(payload.id, payload.stage)) return;
    if (applyStep) applyStep(job, payload);
    else job.step = payload.step;
    render();
    changed(job);
  });

  /**
   * 執行工作。
   * @param exec    async () => { checks, message }：完成後的流程狀態與結果文字
   * @param refresh async (j) => void：失敗後重新查詢狀態（例如從哪一步接續）；查不到就沿用原本的資料
   */
  async function run(j, { exec, refresh }) {
    j.phase = 'running';
    j.error = '';
    j.step = null;
    render();
    changed(j);
    try {
      const { checks, message } = await exec();
      j.doneMessage = message;
      j.phase = 'done';
      render();
      finish(true, checks);
      notify(`#${j.req.id} ${j.stage.label} ${j.checkLabel}`, message);
    } catch (err) {
      if (job !== j) return;
      j.error = `${failText}：${cleanError(err)}`;
      try {
        await refresh?.(j);
      } catch {
        // 查不到就沿用原本的資料
      }
      j.phase = 'confirm';
      render();
      changed(j);
      if (!dialog.open) dialog.showModal();
      notify(`#${j.req.id} ${label}失敗`, cleanError(err));
    }
  }

  /** 結束：ok = 可以勾起 checkbox；完成且視窗開著時保留結果，其他情況清除並關閉 */
  function finish(ok, checks) {
    const j = job;
    if (!j) return;
    if (!ok || !dialog.open || j.phase !== 'done') {
      job = null;
      if (dialog.open) dialog.close();
    }
    j.resolve({ ok, checks });
    changed(j);
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
    if (job?.phase === 'confirm') confirm(job);
  });
  stopBtn.addEventListener('click', async () => {
    if (!job) return;
    if (job.phase !== 'running') return finish(false);
    stopBtn.disabled = true;
    try {
      await cancel();
    } finally {
      stopBtn.disabled = false;
    }
  });
  bgBtn.addEventListener('click', dismiss);
  $(`${prefix}-close`).addEventListener('click', dismiss);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    dismiss();
  });

  /**
   * 開啟視窗，回傳 Promise<{ ok, checks }>：ok = true 代表可以勾起 checkbox（checks 為更新後的狀態，略過時為 undefined）。
   * @param status 該工作的 status API 結果（status.running = 其他地方正在執行）
   * @param onChange (reqId) => void，狀態改變時呼叫（重繪該列的狀態文字）
   * @param extra 傳給 init 的其他參數
   */
  function open({ req, stage, checkLabel, status, onChange, ...extra }) {
    if (job) throw new Error(`已有 ${label}進行中：#${job.req.id} ${job.stage.label}`);
    if (status.running) throw new Error(`已有 ${label}進行中：${status.running.label}`);
    return new Promise((resolve) => {
      job = { req, stage, checkLabel, phase: 'confirm', step: null, error: '', resolve, onChange };
      init(job, status, extra);
      log.reset();
      render();
      dialog.showModal();
    });
  }

  /** 該 Requirement / 階段是否有工作進行中；有的話回傳顯示用的狀態文字 */
  function statusOf(reqId, stageKey) {
    if (!owns(reqId, stageKey)) return null;
    if (job.phase === 'running') return `${label}中${stepSuffix(job)}`;
    if (job.phase === 'confirm' && job.error) return `${label}失敗（點擊查看）`;
    return null;
  }

  /** 重新開啟視窗（從背景執行中叫回來） */
  function show() {
    if (job && !dialog.open) {
      render();
      dialog.showModal();
    }
  }

  /** 「佈版進度」dialog 用：目前的工作（沒有時回傳 null） */
  function summary() {
    if (!job) return null;
    const text = job.phase === 'running' ? `執行中${stepSuffix(job)}` : job.phase === 'done' ? job.doneMessage : job.error || '等待確認';
    return {
      title: `#${job.req.id} ${job.req.title}`,
      kind: `${job.stage.label} ${job.checkLabel} · ${label}`,
      text,
      active: job.phase === 'running',
      failed: job.phase === 'confirm' && !!job.error,
    };
  }

  return { open, statusOf, show, summary, run, finish, render, current: () => job };
}
