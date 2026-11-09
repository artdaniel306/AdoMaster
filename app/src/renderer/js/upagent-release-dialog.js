import { api, cleanError } from './api.js';
import { $ } from './dom.js';
import { RELEASE_STEPS, RELEASE_DB_LABEL } from '../../shared/flow-rules.js';

/** 保留在畫面上的輸出行數上限 */
const LOG_MAX_LINES = 3000;

const STEP_TEXT = {
  Bump: '更版並 push tag',
  WaitAction: '等待 GitHub Action',
  Download: '下載 staging 檔案',
  Sign: '簽署 Windows 安裝檔',
  UpdateYml: '重算 latest.yml',
  Publish: '上傳 Blob',
  CleanStaging: '清空 staging',
  Database: '寫入資料庫',
};
const stepLabel = (step) => `${RELEASE_STEPS.indexOf(step) + 1}/${RELEASE_STEPS.length} ${STEP_TEXT[step] || step}`;
const willRun = (plan, step) => RELEASE_STEPS.indexOf(step) >= RELEASE_STEPS.indexOf(plan.startFrom);

/**
 * UpAgent 發佈（規劃含 upagent，勾測試 / 正式環境佈版的 SaaS / Local 前執行 shell/Release-UpAgent.ps1）：
 *   - 尚未發佈：選 minor / patch、填資料庫備註 → 更版、等 GitHub Action、簽署、上傳 Blob… → 寫入該環境 SaaS / Local 的資料庫
 *   - 上次中途失敗：從失敗的步驟接續
 *   - 已上傳過 Blob：只寫入該環境 SaaS / Local 的資料庫（SaaS 與 Local 各有自己的資料庫）
 * 執行中可按「背景執行」關閉視窗，結束時再通知。一次只能有一個發佈。
 */
export function createUpagentReleaseDialog() {
  const dialog = $('release-dialog');
  const titleEl = $('ur-title');
  const reqEl = $('ur-req');
  const planEl = $('ur-plan');
  const formEl = $('ur-form');
  const bumpRow = $('ur-bump-row');
  const bumpEl = $('ur-bump');
  const remarkEl = $('ur-remark');
  const hsmEl = $('ur-hsm');
  const phaseEl = $('ur-phase');
  const logEl = $('ur-log');
  const errorEl = $('ur-error');
  const stopBtn = $('ur-stop');
  const bgBtn = $('ur-bg');
  const okBtn = $('ur-ok');

  /** { req, stage, checkLabel, plan, phase: 'confirm' | 'running' | 'done', step, lines, error, resolve, onChange } */
  let job = null;

  function planText(j) {
    const env = ` ${RELEASE_DB_LABEL[j.plan.db]} `;
    if (j.plan.startFrom === 'Bump') {
      const branch = j.planRepos?.upagent;
      return `規劃含 upagent，勾「${j.stage.label} ${j.checkLabel}」前要先發佈 UpAgent：\n在 feature branch ${branch || '—'} 更版（npm version，upagent 本機 clone 需無未提交的變更）→ 等 GitHub Action → 下載 → 簽署 → 重算 latest.yml → 上傳 Blob → 清 staging → 寫入${env}資料庫。\n整個流程可能需要一段時間（GitHub Action 建置）。`;
    }
    if (j.plan.startFrom === 'Database') {
      return `UpAgent ${j.plan.version} 已上傳過 Blob，只需在${env}資料庫新增此版本的紀錄。`;
    }
    return `UpAgent ${j.plan.version} 上次發佈未完成，從「${stepLabel(j.plan.startFrom)}」接續，最後寫入${env}資料庫。`;
  }

  function render() {
    const j = job;
    if (!j) return;
    titleEl.textContent = `UpAgent 發佈 · ${j.stage.label} ${j.checkLabel}`;
    reqEl.textContent = `#${j.req.id} ${j.req.title}`;
    planEl.textContent = planText(j);
    formEl.hidden = j.phase !== 'confirm';
    bumpRow.hidden = j.plan.startFrom !== 'Bump';
    hsmEl.hidden = !willRun(j.plan, 'Sign');

    if (j.phase === 'running') {
      phaseEl.className = 'status loading';
      phaseEl.textContent = j.step ? `執行中：${stepLabel(j.step)}` : '執行中…';
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
    okBtn.disabled = !j.configExists;
    okBtn.textContent = j.error ? `重試（從 ${STEP_TEXT[j.plan.startFrom]} 接續）` : j.plan.startFrom === 'Database' ? '寫入資料庫' : '開始發佈';
    if (!j.configExists) {
      errorEl.textContent = '找不到 data/upagent_release.config，請複製 app/upagent_release_example.config 後填入連線資訊，再重新勾選。';
      errorEl.hidden = false;
    }
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

  api.onUpagentReleaseLog(({ id, stage, line }) => {
    if (job && job.req.id === id && job.stage.key === stage) appendLog(line);
  });
  api.onUpagentReleaseStep(({ id, stage, step }) => {
    if (!job || job.req.id !== id || job.stage.key !== stage) return;
    job.step = step;
    render();
    job.onChange?.(id);
  });

  async function run(j) {
    j.phase = 'running';
    j.error = '';
    j.step = null;
    render();
    j.onChange?.(j.req.id);
    try {
      const checks = await api.runUpagentRelease(j.req.id, j.stage.key, j.plan.target, {
        bump: j.plan.startFrom === 'Bump' ? bumpEl.value : undefined,
        remark: remarkEl.value,
      });
      j.doneMessage = `UpAgent 發佈完成，已寫入 ${RELEASE_DB_LABEL[j.plan.db]} 資料庫`;
      j.phase = 'done';
      render();
      finish(true, checks);
      if (!document.hasFocus() && 'Notification' in window) {
        new Notification(`#${j.req.id} ${j.stage.label} ${j.checkLabel}`, { body: j.doneMessage });
      }
    } catch (err) {
      if (job !== j) return;
      // 回到確認畫面：重新查詢從哪一步接續（已完成的步驟已記錄在流程狀態）
      j.error = `發佈失敗：${cleanError(err)}`;
      try {
        const status = await api.upagentReleaseStatus(j.req.id, j.stage.key, j.plan.target);
        if (status.plan) j.plan = status.plan;
      } catch {
        // 查不到就沿用原本的 plan
      }
      j.phase = 'confirm';
      render();
      j.onChange?.(j.req.id);
      if (!dialog.open) dialog.showModal();
      if (!document.hasFocus() && 'Notification' in window) {
        new Notification(`#${j.req.id} UpAgent 發佈失敗`, { body: cleanError(err) });
      }
    }
  }

  /** 結束這次發佈：ok = 已完成（呼叫端接著勾起 checkbox）；完成時保留視窗顯示結果，其他情況關閉 */
  function finish(ok, checks) {
    const j = job;
    if (!j) return;
    // 完成且視窗開著：保留 job 顯示結果，按「關閉」時才清除；在背景完成則直接清除
    if (!ok || !dialog.open) {
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
      await api.cancelUpagentRelease(); // run() 會收到「已停止」的錯誤並回到確認畫面
    } finally {
      stopBtn.disabled = false;
    }
  });
  bgBtn.addEventListener('click', dismiss);
  $('ur-close').addEventListener('click', dismiss);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    dismiss();
  });

  /**
   * 開啟發佈視窗，回傳 Promise<{ ok, checks }>：ok = true 代表發佈完成（checks 為該 Requirement 更新後的狀態）。
   * @param status api.upagentReleaseStatus 的結果（status.plan 不可為 null）
   * @param planRepos 規劃選的 { repo: feature branch }（顯示 upagent 的 feature branch 用）
   * @param onChange (reqId) => void，狀態改變時呼叫（重繪該列的狀態文字）
   */
  function open({ req, stage, checkLabel, status, planRepos, onChange }) {
    if (job) throw new Error(`已有 UpAgent 發佈進行中：#${job.req.id} ${job.stage.label}`);
    if (status.running) throw new Error(`已有 UpAgent 發佈進行中：#${status.running.id}`);
    return new Promise((resolve) => {
      job = {
        req,
        stage,
        checkLabel,
        plan: status.plan,
        planRepos,
        configExists: status.configExists,
        phase: 'confirm',
        step: null,
        lines: [],
        error: '',
        resolve,
        onChange,
      };
      bumpEl.value = status.release?.bump || 'patch';
      remarkEl.value = status.release?.remark || '';
      logEl.textContent = '';
      render();
      dialog.showModal();
    });
  }

  /** 該 Requirement / 階段是否有發佈進行中；有的話回傳顯示用的狀態文字 */
  function statusOf(reqId, stageKey) {
    if (!job || job.req.id !== reqId || job.stage.key !== stageKey) return null;
    if (job.phase === 'running') return `UpAgent 發佈中${job.step ? `：${stepLabel(job.step)}` : '…'}`;
    if (job.phase === 'confirm' && job.error) return 'UpAgent 發佈失敗（點擊查看）';
    return null;
  }

  /** 重新開啟視窗（從背景執行中叫回來） */
  function show() {
    if (job && !dialog.open) {
      render();
      dialog.showModal();
    }
  }

  return { open, statusOf, show };
}
