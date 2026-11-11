import { api } from './api.js';
import { $ } from './dom.js';
import { createBackgroundJobDialog } from './background-job-dialog.js';
import { RELEASE_STEPS, RELEASE_STEP_TEXT as STEP_TEXT, RELEASE_DB_LABEL, releaseStepLabel as stepLabel } from '../../shared/flow-rules.js';

const willRun = (plan, step) => RELEASE_STEPS.indexOf(step) >= RELEASE_STEPS.indexOf(plan.startFrom);

/**
 * UpAgent 發佈（規劃含 upagent，勾測試 / 正式環境佈版的 SaaS / Local 前執行 shell/Release-UpAgent.ps1）：
 *   - 尚未發佈：選 minor / patch、填資料庫備註 → 更版、等 GitHub Action、簽署、上傳 Blob… → 寫入該環境 SaaS / Local 的資料庫
 *   - 上次中途失敗：從失敗的步驟接續
 *   - 已上傳過 Blob：只寫入該環境 SaaS / Local 的資料庫（SaaS 與 Local 各有自己的資料庫）
 * 確認 / 執行 / 背景執行 / 通知的流程在 background-job-dialog.js。一次只能有一個發佈。
 */
export function createUpagentReleaseDialog() {
  const planEl = $('ur-plan');
  const formEl = $('ur-form');
  const bumpRow = $('ur-bump-row');
  const bumpEl = $('ur-bump');
  const remarkEl = $('ur-remark');
  const hsmEl = $('ur-hsm');
  const errorEl = $('ur-error');
  const okBtn = $('ur-ok');
  const rerunBtn = $('ur-rerun');

  /** job 的專屬欄位：{ plan, planRepos, configExists } */
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

  /** @param rerunAction true = 先重跑整個 GitHub workflow run 再接續等待 */
  function run(j, rerunAction = false) {
    return base.run(j, {
      exec: async () => ({
        checks: await api.runUpagentRelease(j.req.id, j.stage.key, j.plan.target, {
          bump: j.plan.startFrom === 'Bump' ? bumpEl.value : undefined,
          remark: remarkEl.value,
          rerunAction,
        }),
        message: `UpAgent 發佈完成，已寫入 ${RELEASE_DB_LABEL[j.plan.db]} 資料庫`,
      }),
      // 回到確認畫面：重新查詢從哪一步接續（已完成的步驟已記錄在流程狀態）
      async refresh() {
        const status = await api.upagentReleaseStatus(j.req.id, j.stage.key, j.plan.target);
        if (status.plan) j.plan = status.plan;
      },
    });
  }

  const base = createBackgroundJobDialog({
    dialog: $('release-dialog'),
    prefix: 'ur',
    label: 'UpAgent 發佈',
    failText: '發佈失敗',
    onLog: api.onUpagentReleaseLog,
    onStep: api.onUpagentReleaseStep,
    runningText: (j) => (j.step ? stepLabel(j.step) : ''),
    init(j, status, { planRepos }) {
      j.plan = status.plan;
      j.planRepos = planRepos;
      j.configExists = status.configExists;
      bumpEl.value = status.release?.bump || 'patch';
      remarkEl.value = status.release?.remark || '';
    },
    confirm: (j) => run(j),
    cancel: api.cancelUpagentRelease,
    render(j) {
      planEl.textContent = planText(j);
      formEl.hidden = j.phase !== 'confirm';
      bumpRow.hidden = j.plan.startFrom !== 'Bump';
      hsmEl.hidden = !willRun(j.plan, 'Sign');
      okBtn.disabled = !j.configExists;
      // 上次失敗在「等待 GitHub Action」（例如 workflow 失敗）：可直接在 app 裡重跑整個 workflow run
      rerunBtn.hidden = !(j.phase === 'confirm' && j.error && j.plan.startFrom === 'WaitAction');
      rerunBtn.disabled = !j.configExists;
      okBtn.textContent = j.error ? `重試（從 ${STEP_TEXT[j.plan.startFrom]} 接續）` : j.plan.startFrom === 'Database' ? '寫入資料庫' : '開始發佈';
      if (!j.configExists) {
        errorEl.textContent = 'data/config.json 尚未設定 upagentRelease：請先在「設定 → UpAgent 發佈資料庫設定…」填入資料庫連線與密碼（GitHub token 在「設定 → 連線與機密設定…」；其他欄位可參考 templates/config_example.json），再重新勾選。';
        errorEl.hidden = false;
      }
    },
  });

  rerunBtn.addEventListener('click', () => {
    const j = base.current();
    if (j?.phase === 'confirm' && j.plan.startFrom === 'WaitAction') run(j, true);
  });

  const { open, statusOf, show, summary } = base;
  return { open, statusOf, show, summary };
}
