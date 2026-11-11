import { api } from './api.js';
import { $, el } from './dom.js';
import { repoTag } from './repos.js';
import { createBackgroundJobDialog } from './background-job-dialog.js';
import { LOCAL_STEP_TEXT as STEP_TEXT, ENV_LABEL } from '../../shared/flow-rules.js';

const time = (iso) => new Date(iso).toLocaleString('zh-TW', { hour12: false });

/**
 * Local 佈版（勾測試 / 正式環境佈版的 Local，確認 merge 後執行 shell/Deploy-Local.ps1）：
 *   列出規劃中有設定 localDeploy 的 repository（預設勾選：此階段還沒以目前 Confirm Commit 佈版過的）→ 依序 build 成 image tar（data/local_deploy/）
 *   → docker load + push → ssh 換 container。推送 / ssh 失敗後重試時，同一個 commit 的 tar 已存在就不重新 build。
 *   全部取消勾選 = 略過佈版直接勾起（例如已手動佈版）。
 * 確認 / 執行 / 背景執行 / 通知的流程在 background-job-dialog.js。一次只能有一個 Local 佈版。
 */
export function createLocalDeployDialog() {
  const planEl = $('ld-plan');
  const reposEl = $('ld-repos');
  const rebuildRow = $('ld-rebuild-row');
  const rebuildEl = $('ld-rebuild');
  const okBtn = $('ld-ok');

  /** job 的專屬欄位：{ env, targets, unconfigured, selected: Set, repo } */
  const runnable = (j) => j.targets.filter((t) => !t.error);
  const stepText = (j) => (j.step ? ` · ${STEP_TEXT[j.step] || j.step}` : '');

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
          base.render();
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

  const base = createBackgroundJobDialog({
    dialog: $('local-deploy-dialog'),
    prefix: 'ld',
    label: 'Local 佈版',
    failText: '佈版失敗',
    onLog: api.onLocalDeployLog,
    onStep: api.onLocalDeployStep,
    applyStep(j, { repo, step }) {
      j.repo = repo;
      j.step = step;
    },
    runningText: (j) => (j.repo ? `${j.targets.find((t) => t.repo === j.repo)?.label || j.repo}${stepText(j)}` : ''),
    init(j, status) {
      j.env = status.env;
      j.targets = status.targets;
      j.unconfigured = status.unconfigured || [];
      j.repo = null;
      j.selected = new Set(runnable(j).filter((t) => !t.upToDate).map((t) => t.repo));
      rebuildEl.checked = false;
    },
    confirm(j) {
      const repos = runnable(j).map((t) => t.repo).filter((r) => j.selected.has(r));
      if (!repos.length) return base.finish(true);
      j.repo = repos[0];
      return base.run(j, {
        exec: async () => ({
          checks: await api.runLocalDeploy(j.req.id, j.stage.key, repos, { rebuild: rebuildEl.checked }),
          message: `Local 佈版完成：${repos.join('、')}`,
        }),
        // 回到確認畫面：重新查詢（已成功的 repository 已記錄，預設不再勾選）
        async refresh() {
          j.repo = null;
          const status = await api.localDeployStatus(j.req.id, j.stage.key);
          j.targets = status.targets;
          j.selected = new Set(runnable(j).filter((t) => repos.includes(t.repo) && !t.upToDate).map((t) => t.repo));
        },
      });
    },
    cancel: api.cancelLocalDeploy,
    render(j) {
      planEl.textContent = `勾「${j.stage.label} ${j.checkLabel}」前，將勾選的 repository 佈版到${ENV_LABEL[j.env]}地端主機：\n部署用資料夾切到環境 branch → (套用該環境的 .env) → (前置指令) → build 成 image tar（data/local_deploy/）→ docker load + push → ssh 到主機換掉 container（會有短暫停機）。\n同一個 commit 已 build 過 tar 時直接推送，不重新 build。\n已手動佈版可取消全部勾選，直接勾起。${j.unconfigured.length ? `\n未設定 Local 佈版（不會佈版）：${j.unconfigured.join('、')}` : ''}`;
      renderRepos(j);
      rebuildRow.hidden = j.phase !== 'confirm' || !j.selected.size;
      okBtn.textContent = j.selected.size ? (j.error ? '重試' : `開始佈版（${j.selected.size}）`) : '不佈版，直接勾起';
    },
  });

  const { open, statusOf, show, summary } = base;
  return { open, statusOf, show, summary };
}
