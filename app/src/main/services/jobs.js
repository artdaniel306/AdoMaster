const { BrowserWindow } = require('electron');

/**
 * main process 的背景工作清單（例：手動佈版）：工作在 main 執行，renderer 重新載入也不中斷。
 * 進度以 '<channel>:update'（工作快照；移除時為 { id, removed: true }）與 '<channel>:log'（{ id, line }）廣播給所有視窗。
 * 工作只存在記憶體中（App 關閉即消失）。
 *
 * job 的共用欄位：{ id, status: 'running' | 'succeeded' | 'failed' | 'canceled', message, error, startedAt, finishedAt,
 *                  steps: [{ key, label, state, detail }], lines（輸出）, controller（AbortController，不送給 renderer）}
 */

const LOG_MAX_LINES = 3000;

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/** 等 ms 毫秒；signal 中止時丟出「已停止」 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('已停止'));
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      reject(new Error('已停止'));
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort);
  });
}

/**
 * @param channel      IPC 頻道前綴（例 'manualDeploy'）
 * @param noun         錯誤訊息用的名稱（例 '佈版工作'）
 * @param doneText     各結束狀態的訊息（{ running, succeeded, failed, canceled }）
 * @param keepFinished 保留的已結束工作數
 */
function createJobStore({ channel, noun, doneText, keepFinished = 20 }) {
  /** 所有工作（舊到新加入）：id → job */
  const jobs = new Map();
  let nextId = 1;

  /** 送給 renderer 的工作快照（不含 controller；withLog = 含輸出） */
  function snapshot(job, withLog = false) {
    const { controller, lines, ...rest } = job;
    return withLog ? { ...rest, lines: [...lines] } : rest;
  }

  const emit = (job) => broadcast(`${channel}:update`, snapshot(job));

  function remove(id) {
    jobs.delete(id);
    broadcast(`${channel}:update`, { id, removed: true });
  }

  function appendLog(job, line) {
    job.lines.push(line);
    if (job.lines.length > LOG_MAX_LINES) job.lines.splice(0, job.lines.length - LOG_MAX_LINES);
    broadcast(`${channel}:log`, { id: job.id, line });
  }

  /** 建立並登記一個執行中的工作（fields = 專屬欄位；steps 只需 { key, label }） */
  function add({ steps = [], ...fields }) {
    const job = {
      id: nextId++,
      status: 'running',
      message: doneText.running,
      error: '',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ...fields,
      steps: steps.map((s) => ({ ...s, state: 'pending', detail: '' })),
      lines: [],
      controller: new AbortController(),
    };
    jobs.set(job.id, job);
    emit(job); // 先讓 renderer 知道這個工作，之後的輸出才接得上
    return job;
  }

  /** 執行一個步驟（沒有這個步驟時略過）：fn 可把 step.state 設成 'skipped'；失敗時記下錯誤再往外丟 */
  async function runStep(job, key, fn) {
    const step = job.steps.find((s) => s.key === key);
    if (!step) return;
    const { signal } = job.controller;
    if (signal.aborted) throw new Error('已停止');
    step.state = 'running';
    emit(job);
    try {
      await fn(step);
      if (step.state === 'running') step.state = 'done';
    } catch (err) {
      step.state = 'failed';
      const reason = signal.aborted ? '已停止' : err.message;
      step.detail = step.detail && step.detail !== reason && !signal.aborted ? `${step.detail} → ${reason}` : reason;
      throw err;
    } finally {
      emit(job);
    }
  }

  /** 結束工作並只保留最近 keepFinished 個已結束的工作 */
  function finish(job, status, err) {
    job.status = status;
    job.error = err ? String(err.message || err) : '';
    job.finishedAt = new Date().toISOString();
    job.message = doneText[status];
    appendLog(job, `${status === 'succeeded' ? '✔' : '✖'} ${job.message}${job.error && status !== 'canceled' ? `：${job.error}` : ''}`);
    emit(job);
    const finished = [...jobs.values()].filter((j) => j.status !== 'running');
    for (const j of finished.slice(0, Math.max(0, finished.length - keepFinished))) remove(j.id);
  }

  /** 找已結束的工作（重試 / 移除用）；不存在或仍在執行時丟錯 */
  function getFinished(id) {
    const job = jobs.get(id);
    if (!job) throw new Error(`找不到這個${noun}`);
    if (job.status === 'running') throw new Error(`${noun}仍在執行中`);
    return job;
  }

  /** 停止執行中的工作（正在跑的步驟若不能中斷，等它做完才停） */
  function cancel({ id } = {}) {
    const job = jobs.get(id);
    if (!job || job.status !== 'running') return false;
    job.controller.abort();
    appendLog(job, '■ 停止中…');
    return true;
  }

  /** 從清單移除已結束的工作 */
  function dismiss({ id } = {}) {
    const job = jobs.get(id);
    if (!job) return false;
    if (job.status === 'running') throw new Error(`${noun}仍在執行中，請先停止`);
    remove(id);
    return true;
  }

  /** 所有工作（含輸出），renderer 載入時同步用 */
  const list = () => [...jobs.values()].map((j) => snapshot(j, true));

  return { add, get: (id) => jobs.get(id), getFinished, remove, snapshot, emit, appendLog, runStep, finish, cancel, dismiss, list };
}

module.exports = { createJobStore, broadcast, sleep };
