import { api, cleanError } from './api.js';
import { $, el, errorSetter } from './dom.js';
import { loadRepos, repoTag } from './repos.js';
import { runLine } from './deploy-dialog.js';
import { createConfirmDialog } from './confirm-dialog.js';
import { PIPELINE_POLL_MS as POLL_MS } from '../../shared/flow-rules.js';

const timeText = (d) => d.toLocaleTimeString('zh-TW', { hour12: false });
/** Run 的時間：結束 → 結束時間，進行中 → 開始 / 排隊時間 */
function runTime(run) {
  const t = run.finishTime || run.startTime || run.queueTime;
  if (!t) return '';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '' : `${run.finishTime ? '結束' : '開始'} ${d.toLocaleString('zh-TW', { hour12: false })}`;
}

/**
 * 「佈版 → 監視 SaaS 佈版狀態…」：列出所有 repository 測試 / 正式環境 Pipeline 最新的 Run（main/services/pipelines.monitorPipelineRuns），
 * 只讀，不 merge、不自動重啟。有進行中的 Run 時每 15 秒（PIPELINE_POLL_MS）自動更新，dialog 關閉即停止。
 *   - 測試環境：有設定 testAppService 的 repository 可手動「重啟 App Service」（afterDeploy.restartTestAppService）
 *   - 正式環境：不提供立即重啟，按鈕導向「正式環境排程重啟」dialog
 */
export function createSaasMonitorDialog({ openRestartSchedule } = {}) {
  const dialog = $('saas-monitor-dialog');
  const statusEl = $('sm-status');
  const testEl = $('sm-test');
  const prodEl = $('sm-prod');
  const refreshBtn = $('sm-refresh');
  const showError = errorSetter($('sm-error'));
  const confirm = createConfirmDialog();

  let pipelines = null;
  let loading = false;
  let lastPoll = null;
  let timer = null;
  /** repo → { state: 'running' | 'ok' | 'bad', message }（手動重啟測試環境 App Service 的結果，重新整理後保留） */
  const restarts = new Map();

  const hasActive = () => (pipelines || []).some((p) => p.runs[0]?.active);

  function renderStatus() {
    if (loading) {
      statusEl.className = 'status loading';
      statusEl.textContent = '查詢 Pipeline Run…';
      return;
    }
    statusEl.className = 'status';
    if (!lastPoll) statusEl.textContent = '';
    else statusEl.textContent = `最後更新 ${timeText(lastPoll)}${hasActive() ? `（有進行中的 Run，每 ${POLL_MS / 1000} 秒自動更新）` : ''}`;
  }

  async function restart(p) {
    const ok = await confirm.open({
      title: '重啟測試環境 App Service',
      message: `確定要重啟 ${p.repo} 的測試環境 App Service「${p.appService}」？`,
      okLabel: '重啟',
    });
    if (!ok || restarts.get(p.repo)?.state === 'running') return;
    restarts.set(p.repo, { state: 'running', message: `重啟 App Service ${p.appService} 中…` });
    render();
    try {
      const r = await api.restartTestAppService(p.repo);
      restarts.set(p.repo, { state: 'ok', message: r?.message || `已重啟 App Service ${p.appService}` });
    } catch (err) {
      restarts.set(p.repo, { state: 'bad', message: cleanError(err) });
    }
    render();
  }

  function pipelineRow(p) {
    const row = el('div', 'dp-pipe');
    const name = el('div', 'cc-name');
    name.append(repoTag(p.repo), el('span', 'repo-branch', p.pipeline?.name || p.name));
    const runs = el('div', 'dp-runs');
    if (p.error) runs.append(el('div', 'dp-run bad', p.error));
    else if (!p.runs.length) runs.append(el('div', 'dp-run muted', '沒有 Run'));
    else runs.append(runLine(p.runs[0], runTime(p.runs[0])));
    if (p.stage === 'testDeploy' && p.appService) {
      const r = restarts.get(p.repo);
      if (r) runs.append(el('div', `dp-run ${r.state === 'running' ? 'warn' : r.state}`, r.message));
      const btn = el('button', 'btn-ghost sm-restart', '重啟 App Service');
      btn.type = 'button';
      btn.title = p.appService;
      btn.disabled = r?.state === 'running';
      btn.addEventListener('click', () => restart(p));
      runs.append(btn);
    }
    row.append(name, runs);
    return row;
  }

  function renderSection(target, stage) {
    const list = (pipelines || []).filter((p) => p.stage === stage);
    target.replaceChildren(...(pipelines && !list.length ? [el('div', 'muted', '沒有設定 Pipeline 的 repository')] : list.map(pipelineRow)));
  }

  function render() {
    renderStatus();
    renderSection(testEl, 'testDeploy');
    renderSection(prodEl, 'prodDeploy');
    refreshBtn.disabled = loading;
  }

  function schedule() {
    clearTimeout(timer);
    timer = dialog.open && hasActive() ? setTimeout(refresh, POLL_MS) : null;
  }

  async function refresh() {
    if (loading) return;
    clearTimeout(timer);
    loading = true;
    render();
    try {
      pipelines = (await api.monitorPipelineRuns()).pipelines;
      lastPoll = new Date();
      showError('');
    } catch (err) {
      showError(`查詢 Pipeline Run 失敗：${cleanError(err)}`);
    } finally {
      loading = false;
      render();
      schedule();
    }
  }

  const close = () => dialog.close();
  dialog.addEventListener('close', () => clearTimeout(timer));
  $('sm-close').addEventListener('click', close);
  $('sm-ok').addEventListener('click', close);
  refreshBtn.addEventListener('click', refresh);
  $('sm-prod-restart').addEventListener('click', () => openRestartSchedule?.());

  async function open() {
    if (!dialog.open) dialog.showModal();
    try {
      await loadRepos(); // repository 標籤的顏色
    } catch {
      // 只影響顏色
    }
    refresh();
  }

  return { open };
}
