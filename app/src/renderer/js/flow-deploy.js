import { api } from './api.js';
import { el } from './dom.js';
import { createMergeDialog } from './merge-dialog.js';
import { createDeployDialog } from './deploy-dialog.js';
import { createUpagentReleaseDialog } from './upagent-release-dialog.js';
import { createLocalDeployDialog } from './local-deploy-dialog.js';
import { saasKey } from './flow-stages.js';
import {
  PLAN_REPOS_KEY,
  noRepoChange,
  upagentReleasePlan,
  UPAGENT_RELEASE_KEY,
  RELEASE_ENV,
  RELEASE_TARGETS,
  releaseDbKey,
  releaseTargetOf,
  localDeployKey,
} from '../../shared/flow-rules.js';

/**
 * 佈版階段（Test deploy / Prod deploy）的 SaaS / Local：
 *   勾選前確認 commit 已 merge 進環境 branch（merge-dialog.js）→ SaaS 有設定 Pipeline 時走 deploy-dialog.js；
 *   Local 有設定 localDeploy 時走 local-deploy-dialog.js（docker build + ssh 換 container）
 *   → 規劃含 upagent 時執行 UpAgent 發佈（upagent-release-dialog.js），以及格子裡的狀態列 / 發佈摘要。
 *
 * @param ctx requirement-flow.js 提供的共用環境：
 *   { statusEl, checks(id), setChecks(id, checks), update(req), refresh(id), checkbox(req, stage, key, text, disabledReason) }
 */
export function createFlowDeploy(ctx) {
  const { statusEl } = ctx;
  const mergeDialog = createMergeDialog();
  const deployDialog = createDeployDialog();
  const releaseDialog = createUpagentReleaseDialog();
  const localDialog = createLocalDeployDialog();

  /**
   * 勾佈版階段的 SaaS / Local 前：確認 Confirm Commit 的 commit 都已進到環境 branch。
   * 尚未 merge 時跳出 dialog 詢問是否現在 merge（建立 merge commit）。回傳 true 代表可以勾選。
   */
  async function ensureMerged(req, stage) {
    statusEl.className = 'status loading';
    statusEl.textContent = `確認 #${req.id} 的 commit 是否已 merge 進 ${stage.label} 環境 branch（git fetch）…`;
    const status = await api.deployMergeStatus(req.id, stage.key);
    statusEl.className = 'status';
    statusEl.textContent = '';
    if (status.allMerged) return true;
    return mergeDialog.open({
      req,
      stageLabel: stage.label,
      status,
      mergeFn: () => api.mergeDeploy(req.id, stage.key),
    });
  }

  /**
   * 規劃含 upagent：勾佈版階段的 SaaS / Local 前執行 UpAgent 發佈
   * （第一次完整發佈；已上傳過 Blob 則只寫入該環境 SaaS / Local 各自的資料庫）。
   * 回傳 true 代表可以勾選（不需發佈或已完成）。
   */
  async function ensureReleased(req, stage, key, text) {
    const target = releaseTargetOf(key);
    if (!upagentReleasePlan(ctx.checks(req.id), stage.key, target)) return true;
    const status = await api.upagentReleaseStatus(req.id, stage.key, target);
    if (!status.plan) return true;
    const { ok, checks } = await releaseDialog.open({
      req,
      stage,
      checkLabel: text,
      status,
      planRepos: ctx.checks(req.id)[PLAN_REPOS_KEY],
      onChange: ctx.refresh,
    });
    if (checks) ctx.setChecks(req.id, checks);
    return ok;
  }

  /**
   * 勾佈版階段的 Local 前（已確認 merge）：規劃中有設定 localDeploy 的 repository 執行 Local 佈版
   * （shell/Deploy-Local.ps1）。回傳 true 代表可以勾選（沒有設定、已完成，或使用者選擇略過）。
   */
  async function ensureLocalDeployed(req, stage, text) {
    const status = await api.localDeployStatus(req.id, stage.key);
    if (!status.targets.length) return true;
    const { ok, checks } = await localDialog.open({ req, stage, checkLabel: text, status, onChange: ctx.refresh });
    if (checks) ctx.setChecks(req.id, checks);
    return ok;
  }

  /**
   * 勾佈版階段的 SaaS：
   *   - 相關 repository 都沒設定 Pipeline → 同 Local（確認 / merge 後勾選）
   *   - 已全部 merge 且 Pipeline 沒有進行中的 Run → 直接勾選
   *   - 其他 → 開啟佈版 dialog：等待進行中的 Run → merge + push → 監看新 Run → 通知（成功時自動勾起）
   */
  async function deploySaas(req, stage, key, text) {
    statusEl.className = 'status loading';
    statusEl.textContent = `確認 #${req.id} 的 merge 狀態（git fetch）與 Pipeline Run…`;
    const [mergeStatus, pipelineRuns] = await Promise.all([
      api.deployMergeStatus(req.id, stage.key),
      api.deployPipelineRuns(req.id, stage.key),
    ]);
    statusEl.className = 'status';
    statusEl.textContent = '';
    const check = async () => {
      ctx.setChecks(req.id, await api.setFlowCheck(req.id, key, true));
      ctx.refresh(req.id);
    };
    // merge 完成後：規劃含 upagent 時先執行 UpAgent 發佈，再勾選
    const save = async () => {
      if (await ensureReleased(req, stage, key, text)) await check();
    };
    if (!pipelineRuns.pipelines.length) {
      if (mergeStatus.allMerged || (await mergeDialog.open({ req, stageLabel: stage.label, status: mergeStatus, mergeFn: () => api.mergeDeploy(req.id, stage.key) }))) {
        await save();
      }
      return;
    }
    const hasActive = pipelineRuns.pipelines.some((p) => p.runs.some((r) => r.active));
    if (mergeStatus.allMerged && !hasActive) return save();
    deployDialog.start({
      req,
      stage,
      checkLabel: text,
      mergeStatus,
      pipelineRuns,
      mergeFn: () => api.mergeDeploy(req.id, stage.key),
      runsFn: () => api.deployPipelineRuns(req.id, stage.key),
      // Run 成功後：測試環境重啟 App Service；正式環境只呼叫預留的 shell（不重啟）
      afterDeployFn: (repo, commit) => api.afterDeploy(req.id, stage.key, repo, commit),
      // 佈版 dialog 以 checkFn 是否成功判斷「已勾起」：UpAgent 發佈沒完成要丟錯，dialog 會提供「仍然勾起」重試
      checkFn: async () => {
        if (!(await ensureReleased(req, stage, key, text))) throw new Error('UpAgent 發佈未完成，尚未勾起');
        await check();
      },
      onChange: ctx.refresh,
    });
  }

  /** 進行中階段勾起佈版階段的 SaaS / Local（一般邏輯）：SaaS 走 deploySaas；Local 確認 merge、Local 佈版、UpAgent 發佈後勾選 */
  async function checkDeploy(req, stage, key, text) {
    if (key === saasKey(stage)) return deploySaas(req, stage, key, text);
    if (!(await ensureMerged(req, stage))) return;
    if (!(await ensureLocalDeployed(req, stage, text))) return;
    if (!(await ensureReleased(req, stage, key, text))) return;
    ctx.setChecks(req.id, await api.setFlowCheck(req.id, key, true));
    ctx.update(req);
  }

  /** 佈版流程進行中時，在 SaaS 底下顯示狀態，點擊重新開啟佈版 dialog */
  function deployStatusLine(req, stage) {
    const text = deployDialog.statusOf(req.id, stage.key);
    if (!text) return null;
    const btn = el('button', 'btn-link deploy-status', `🚀 ${text}`);
    btn.type = 'button';
    btn.title = '開啟佈版視窗';
    btn.addEventListener('click', () => deployDialog.show());
    return btn;
  }

  /** UpAgent 發佈進行中 / 失敗時，在 SaaS / Local 底下顯示狀態，點擊重新開啟發佈視窗 */
  function releaseStatusLine(req, stage) {
    const text = releaseDialog.statusOf(req.id, stage.key);
    if (!text) return null;
    const btn = el('button', 'btn-link release-status', `📦 ${text}`);
    btn.type = 'button';
    btn.title = '開啟 UpAgent 發佈視窗';
    btn.addEventListener('click', () => releaseDialog.show());
    return btn;
  }

  /** Local 佈版進行中 / 失敗時，在 Local 底下顯示狀態，點擊重新開啟視窗 */
  function localStatusLine(req, stage) {
    const text = localDialog.statusOf(req.id, stage.key);
    if (!text) return null;
    const btn = el('button', 'btn-link local-deploy-status', `🐳 ${text}`);
    btn.type = 'button';
    btn.title = '開啟 Local 佈版視窗';
    btn.addEventListener('click', () => localDialog.show());
    return btn;
  }

  /** 此階段已 Local 佈版的 repository（滑過顯示 image / 主機 / 時間） */
  function localDeploySummary(records) {
    const entries = Object.entries(records || {});
    if (!entries.length) return null;
    const line = el('div', 'check-summary repo-line repo-branch', `Local 佈版：${entries.map(([repo, r]) => `${repo} ${String(r.commit || '').slice(0, 7)}`).join(' / ')}`);
    line.title = entries
      .map(([repo, r]) => `${repo}：${r.image || '—'} → ${r.remoteHost || '—'}（${new Date(r.deployedAt).toLocaleString('zh-TW', { hour12: false })}）`)
      .join('\n');
    return line;
  }

  /** 已發佈的 UpAgent 版本與此環境 SaaS / Local 資料庫是否已寫入 */
  function releaseSummary(release, stage) {
    const env = RELEASE_ENV[stage.key];
    const time = (iso) => new Date(iso).toLocaleString('zh-TW', { hour12: false });
    const published = !!release.publishedAt;
    const label = { saas: 'SaaS', local: 'Local' };
    const writtenAt = Object.fromEntries(RELEASE_TARGETS.map((t) => [t, release.db?.[releaseDbKey(env, t)]]));
    const allWritten = RELEASE_TARGETS.every((t) => writtenAt[t]);
    const dbText = RELEASE_TARGETS.map((t) => `${label[t]} ${writtenAt[t] ? '✓' : '—'}`).join(' / ');
    const text = `UpAgent ${release.version}${published ? '' : '（Blob 未上傳完成）'} · DB：${dbText}`;
    const line = el('div', `check-summary repo-line ${allWritten ? 'repo-branch' : 'repo-missing'}`, text);
    line.title = [
      release.remark ? `備註：${release.remark}` : '',
      release.publishedAt ? `上傳 Blob：${time(release.publishedAt)}` : `最後完成步驟：${release.completed || '—'}`,
      ...RELEASE_TARGETS.map((t) => (writtenAt[t] ? `寫入 ${label[t]} DB：${time(writtenAt[t])}` : `${label[t]} DB 尚未寫入`)),
    ].filter(Boolean).join('\n');
    return line;
  }

  /** 佈版階段格子中 Confirm Commit 底下的 SaaS / Local checkbox、狀態列與 UpAgent 發佈摘要 */
  function deployChecks(req, stage, confirmed) {
    const s = ctx.checks(req.id);
    const box = el('div', 'checks');
    if (noRepoChange(s)) {
      // 不需修改 repository：沒有東西要佈版，SaaS / Local 省略
      box.append(el('span', 'muted', '不需佈版（未修改 repository）'));
      return box;
    }
    const reason = confirmed ? '' : '請先完成 Confirm Commit';
    const deploying = deployDialog.statusOf(req.id, stage.key);
    const releasing = releaseDialog.statusOf(req.id, stage.key);
    const localDeploying = localDialog.statusOf(req.id, stage.key);
    // 已勾選的仍可取消，避免 commit 變更後卡住
    box.append(
      ...stage.checks.map(([k, label]) =>
        ctx.checkbox(
          req,
          stage,
          k,
          label,
          s[k] ? '' : releasing ? 'UpAgent 發佈進行中' : k === saasKey(stage) && deploying ? '佈版流程進行中' : k !== saasKey(stage) && localDeploying ? 'Local 佈版進行中' : reason
        )
      )
    );
    const line = deployStatusLine(req, stage);
    if (line) box.append(line);
    const localLine = localStatusLine(req, stage);
    if (localLine) box.append(localLine);
    const localSummary = localDeploySummary(s[localDeployKey(stage)]);
    if (localSummary) box.append(localSummary);
    const releaseLine = releaseStatusLine(req, stage);
    if (releaseLine) box.append(releaseLine);
    const release = s[UPAGENT_RELEASE_KEY];
    if (release?.version) box.append(releaseSummary(release, stage));
    return box;
  }

  return { checkDeploy, deployChecks };
}
