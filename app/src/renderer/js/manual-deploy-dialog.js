import { api, cleanError } from './api.js';
import { $, el } from './dom.js';
import { loadRepos } from './repos.js';
import { createConfirmDialog } from './confirm-dialog.js';
import { RELEASE_STEPS, UPAGENT_REPO } from '../../shared/flow-rules.js';

const STEP_TEXT = {
  WaitAction: '等待 GitHub Action',
  Download: '下載 staging 檔案',
  Sign: '簽署 Windows 安裝檔',
  UpdateYml: '重算 latest.yml',
  Publish: '上傳 Blob',
  CleanStaging: '清空 staging',
  Database: '寫入資料庫',
};
const ENV_LABEL = { test: '測試環境', prod: '正式環境' };
const TARGET_LABEL = { saas: 'SaaS', local: 'Local' };

/**
 * 手動佈版 dialog（選單「佈版 → 手動佈版…」/ 標題列按鈕）：選 SaaS / Local、測試 / 正式、repository 與 commit
 * （upagent 另選完整發佈或接續），按「檢查」由 main 確認 merge 狀態與要做的步驟（manualDeploy:preview），
 * 再按「開始佈版」交給 main 在背景執行（manualDeploy:start），進度在「佈版進度」dialog 查看。
 * @param onStarted (job) => void，工作開始後呼叫（開啟佈版進度）
 */
export function createManualDeployDialog({ onStarted }) {
  const dialog = $('manual-deploy-dialog');
  const form = $('md-form');
  const repoEl = $('md-repo');
  const commitEl = $('md-commit');
  const commitCheckBtn = $('md-commit-check');
  const commitResultEl = $('md-commit-result');
  const releaseEl = $('md-release');
  const branchEl = $('md-branch');
  const bumpEl = $('md-bump');
  const versionEl = $('md-version');
  const startEl = $('md-start');
  const remarkEl = $('md-remark');
  const hsmEl = $('md-hsm');
  const rebuildRow = $('md-rebuild-row');
  const rebuildEl = $('md-rebuild');
  const previewEl = $('md-preview');
  const stepsEl = $('md-steps');
  const warningsEl = $('md-warnings');
  const statusEl = $('md-status');
  const errorEl = $('md-error');
  const previewBtn = $('md-preview-btn');
  const okBtn = $('md-ok');
  const confirmDialog = createConfirmDialog();

  let repos = [];
  /** 上次「檢查」的參數（JSON）與結果；表單變更後失效 */
  let checked = null;
  let busy = false;

  startEl.replaceChildren(...RELEASE_STEPS.slice(1).map((s) => new Option(`${RELEASE_STEPS.indexOf(s) + 1}. ${STEP_TEXT[s]}`, s)));
  startEl.value = 'Database';

  const radio = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;
  const isUpagent = () => repoEl.value === UPAGENT_REPO;
  const mode = () => radio('md-mode') || 'new';

  function showError(msg) {
    errorEl.textContent = msg || '';
    errorEl.hidden = !msg;
  }

  function params() {
    const p = { repo: repoEl.value, env: radio('md-env'), target: radio('md-target'), commit: commitEl.value.trim(), rebuild: rebuildEl.checked };
    if (isUpagent()) {
      p.release =
        mode() === 'resume'
          ? { mode: 'resume', version: versionEl.value.trim(), startFrom: startEl.value, remark: remarkEl.value }
          : { mode: 'new', bump: bumpEl.value, branch: branchEl.value, remark: remarkEl.value };
    }
    return p;
  }

  /** 依目前的選擇顯示 / 隱藏欄位 */
  function layout() {
    const upagent = isUpagent();
    releaseEl.hidden = !upagent;
    const resume = upagent && mode() === 'resume';
    for (const e of releaseEl.querySelectorAll('.md-new')) e.hidden = resume;
    for (const e of releaseEl.querySelectorAll('.md-resume')) e.hidden = !resume;
    const signs = !resume || RELEASE_STEPS.indexOf(startEl.value) <= RELEASE_STEPS.indexOf('Sign');
    hsmEl.hidden = !upagent || !signs;
    rebuildRow.hidden = radio('md-target') !== 'local';
    commitEl.placeholder = resume ? '選填：有填才會先 merge 進環境 branch' : '要佈版的 commit（縮寫即可）';
    if (upagent) {
      const r = repos.find((x) => x.key === UPAGENT_REPO);
      const current = branchEl.value;
      branchEl.replaceChildren(...(r?.branches || []).map((b) => new Option(b, b)));
      if (current && r?.branches.includes(current)) branchEl.value = current;
    }
  }

  /** 表單改變：之前的檢查結果失效 */
  function invalidate() {
    checked = null;
    previewEl.hidden = true;
    okBtn.disabled = true;
    okBtn.textContent = '開始佈版';
    statusEl.className = 'status';
    statusEl.textContent = '';
    showError('');
  }

  function renderPreview(pv) {
    stepsEl.replaceChildren(...pv.steps.map((s) => el('li', null, s.label)));
    if (!pv.steps.length) stepsEl.append(el('li', 'muted', '沒有需要執行的步驟'));
    const items = [
      ...(pv.merge ? [[pv.merge.merged ? 'ok' : pv.merge.canMerge ? 'warn' : 'bad', pv.merge.message]] : []),
      ...(pv.pipeline?.latest ? [['muted', `Pipeline ${pv.pipeline.name} 最近的 Run：#${pv.pipeline.latest.buildNumber || pv.pipeline.latest.id}（${pv.pipeline.latest.sourceVersion?.slice(0, 10) || '—'}）${pv.pipeline.active.length ? `，進行中 ${pv.pipeline.active.length} 個` : ''}`]] : []),
      ...pv.warnings.map((w) => ['warn', `⚠ ${w}`]),
      ...pv.errors.map((e) => ['bad', `✖ ${e}`]),
    ];
    warningsEl.replaceChildren(...items.map(([cls, text]) => el('li', `cc-result ${cls}`, text)));
    previewEl.hidden = false;
    const prod = pv.params.env === 'prod';
    okBtn.disabled = !!pv.errors.length;
    okBtn.textContent = prod ? '開始佈版到正式環境' : '開始佈版';
    okBtn.classList.toggle('btn-prod', prod);
  }

  async function runPreview() {
    if (busy) return null;
    const p = params();
    busy = true;
    previewBtn.disabled = true;
    okBtn.disabled = true;
    showError('');
    statusEl.className = 'status loading';
    statusEl.textContent = '檢查中（git fetch、查詢 Pipeline / Local 設定）…';
    try {
      const pv = await api.manualDeployPreview(p);
      checked = { key: JSON.stringify(p), pv };
      statusEl.className = 'status';
      statusEl.textContent = `${ENV_LABEL[p.env]} ${TARGET_LABEL[p.target]} · ${pv.label}${pv.envBranch ? `（環境 branch：${pv.envBranch}）` : ''}`;
      renderPreview(pv);
      return pv;
    } catch (err) {
      statusEl.className = 'status';
      statusEl.textContent = '';
      showError(cleanError(err));
      return null;
    } finally {
      busy = false;
      previewBtn.disabled = false;
    }
  }

  async function checkCommitOnly() {
    const commit = commitEl.value.trim();
    if (!commit) return;
    commitCheckBtn.disabled = true;
    commitResultEl.hidden = false;
    commitResultEl.className = 'cc-result';
    commitResultEl.textContent = '檢查中…';
    try {
      const branch = isUpagent() && mode() === 'new' ? branchEl.value || undefined : undefined;
      const r = await api.checkCommit(repoEl.value, commit, branch);
      commitResultEl.className = `cc-result ${r.ok ? (r.onBranch === false ? 'warn' : 'ok') : 'bad'}`;
      commitResultEl.textContent = r.message;
      commitResultEl.title = r.ok ? `${r.full}\n${r.author}　${r.date}` : '';
    } catch (err) {
      commitResultEl.className = 'cc-result bad';
      commitResultEl.textContent = cleanError(err);
    } finally {
      commitCheckBtn.disabled = false;
    }
  }

  form.addEventListener('input', (e) => {
    if (e.target === commitEl) commitResultEl.hidden = true;
    layout();
    invalidate();
  });
  form.addEventListener('change', () => {
    layout();
    invalidate();
  });
  commitCheckBtn.addEventListener('click', checkCommitOnly);
  previewBtn.addEventListener('click', runPreview);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const p = params();
    // 檢查後又改了表單：重新檢查，讓使用者看過步驟再按一次
    if (!checked || checked.key !== JSON.stringify(p)) {
      await runPreview();
      return;
    }
    if (checked.pv.errors.length) return;
    if (p.env === 'prod') {
      const ok = await confirmDialog.open({
        title: '佈版到正式環境',
        message: `確定要把 ${checked.pv.label} ${p.commit ? p.commit : ''} 佈版到正式環境 ${TARGET_LABEL[p.target]} 嗎？\n\n${checked.pv.steps.map((s, i) => `${i + 1}. ${s.label}`).join('\n')}`,
        okLabel: '開始佈版',
      });
      if (!ok) return;
    }
    busy = true;
    okBtn.disabled = true;
    showError('');
    statusEl.className = 'status loading';
    statusEl.textContent = '開始佈版…';
    try {
      const job = await api.manualDeployStart(p);
      dialog.close();
      onStarted?.(job);
    } catch (err) {
      statusEl.className = 'status';
      statusEl.textContent = '';
      showError(cleanError(err));
      okBtn.disabled = false;
    } finally {
      busy = false;
    }
  });
  const close = () => {
    if (!busy) dialog.close();
  };
  $('md-cancel').addEventListener('click', close);
  $('md-close').addEventListener('click', close);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });

  /** 開啟 dialog（保留上次的選擇；repository 清單每次重新讀取） */
  async function open() {
    let loadError = '';
    try {
      repos = (await loadRepos()).repos;
    } catch (err) {
      repos = [];
      loadError = cleanError(err);
    }
    const current = repoEl.value;
    repoEl.replaceChildren(...repos.map((r) => new Option(r.label === r.key ? r.key : `${r.label}（${r.key}）`, r.key)));
    if (repos.some((r) => r.key === current)) repoEl.value = current;
    commitResultEl.hidden = true;
    layout();
    invalidate();
    showError(loadError);
    dialog.showModal();
    commitEl.focus();
  }

  return { open };
}
