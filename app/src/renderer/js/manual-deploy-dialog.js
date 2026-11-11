import { api, cleanError } from './api.js';
import { $, el } from './dom.js';
import { loadRepos } from './repos.js';
import { createConfirmDialog } from './confirm-dialog.js';
import { createRestartPicker } from './restart-picker.js';
import { RELEASE_STEPS, RELEASE_STEP_TEXT as STEP_TEXT, UPAGENT_REPO, ENV_LABEL, TARGET_LABEL } from '../../shared/flow-rules.js';


/**
 * 手動佈版 dialog（選單「佈版 → 手動佈版…」/ 標題列按鈕）：選 SaaS / Local、測試 / 正式、repository 與 commit
 * （upagent 另選完整發佈或接續），按「檢查」由 main 確認 merge 狀態與要做的步驟（manualDeploy:preview），
 * 再按「開始佈版」交給 main 在背景執行（manualDeploy:start），進度在「佈版進度」dialog 查看。
 * 客戶環境：選 config.json customerDeploy.<saas|local> 中的客戶，commit 預設帶入正式環境 branch 最新的 commit，只 build image tar。
 * @param onStarted (job) => void，工作開始後呼叫（開啟佈版進度）
 */
export function createManualDeployDialog({ onStarted }) {
  const dialog = $('manual-deploy-dialog');
  const form = $('md-form');
  const repoEl = $('md-repo');
  const customerEl = $('md-customer');
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
  const restartEl = $('md-restart');
  const restartPicker = createRestartPicker($('md-restart-picker'));

  let repos = [];
  /** customerDeploy 的客戶：{ saas: [{ key, label, repos }], local: [...] } */
  let customers = { saas: [], local: [] };
  /** 客戶環境自動帶入的 commit 與它所屬的 repository（使用者改過 commit 就不再覆蓋） */
  let autoCommit = '';
  let autoRepo = null;
  let autoToken = 0;
  /** 排程重啟目前載入的 repository（換 repository 時重新查詢已排程的重啟） */
  let restartRepo = null;
  /** 排程重啟的選擇不完整 / 時間已過時的錯誤訊息 */
  let restartError = '';
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

  const prodSaas = () => radio('md-env') === 'prod' && radio('md-target') === 'saas';
  const isCustomer = () => radio('md-env') === 'customer';

  function params() {
    const p = { repo: repoEl.value, env: radio('md-env'), target: radio('md-target'), commit: commitEl.value.trim(), rebuild: rebuildEl.checked };
    if (isCustomer()) return { ...p, customer: customerEl.value, restart: null };
    restartError = '';
    p.restart = null;
    if (prodSaas()) {
      try {
        p.restart = restartPicker.value();
      } catch (err) {
        restartError = err.message;
      }
    }
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
    const customer = isCustomer();
    for (const e of form.querySelectorAll('.md-customer')) e.hidden = !customer;
    if (customer) {
      const list = customers[radio('md-target')] || [];
      const current = customerEl.value;
      customerEl.replaceChildren(...list.map((c) => new Option(c.label === c.key ? c.key : `${c.label}（${c.key}）`, c.key)));
      if (!list.length) customerEl.append(new Option('（未設定客戶）', ''));
      if (list.some((c) => c.key === current)) customerEl.value = current;
    }
    const upagent = isUpagent() && !customer;
    releaseEl.hidden = !upagent;
    const resume = upagent && mode() === 'resume';
    for (const e of releaseEl.querySelectorAll('.md-new')) e.hidden = resume;
    for (const e of releaseEl.querySelectorAll('.md-resume')) e.hidden = !resume;
    const signs = !resume || RELEASE_STEPS.indexOf(startEl.value) <= RELEASE_STEPS.indexOf('Sign');
    hsmEl.hidden = !upagent || !signs;
    rebuildRow.hidden = radio('md-target') !== 'local' && !customer;
    restartEl.hidden = !prodSaas();
    if (prodSaas() && restartRepo !== repoEl.value) {
      restartRepo = repoEl.value;
      restartPicker.load(restartRepo ? [restartRepo] : []);
    }
    commitEl.placeholder = customer ? '要打包的 commit（預設：正式環境 branch 最新）' : resume ? '選填：有填才會先 merge 進環境 branch' : '要佈版的 commit（縮寫即可）';
    if (upagent) {
      const r = repos.find((x) => x.key === UPAGENT_REPO);
      const current = branchEl.value;
      branchEl.replaceChildren(...(r?.branches || []).map((b) => new Option(b, b)));
      if (current && r?.branches.includes(current)) branchEl.value = current;
    }
  }

  /**
   * 客戶環境：commit 預設帶入正式環境 branch 最新的 commit（git fetch）。
   * 只在 commit 空白或仍是上次自動帶入的值時覆蓋；離開客戶環境時清掉自動帶入的值。
   */
  async function fillProdCommit() {
    if (!isCustomer()) {
      if (autoCommit && commitEl.value.trim() === autoCommit) commitEl.value = '';
      autoCommit = '';
      autoRepo = null;
      return;
    }
    const repo = repoEl.value;
    if (!repo || repo === autoRepo || isUpagent()) return;
    const current = commitEl.value.trim();
    if (current && current !== autoCommit) return;
    autoRepo = repo;
    const token = ++autoToken;
    commitResultEl.hidden = false;
    commitResultEl.className = 'cc-result';
    commitResultEl.textContent = '查詢正式環境 branch 最新的 commit…';
    try {
      const head = await api.manualDeployProdHead(repo);
      if (token !== autoToken || !isCustomer() || repoEl.value !== repo) return;
      const latest = commitEl.value.trim();
      if (latest && latest !== autoCommit) return; // 查詢期間使用者自己填了
      autoCommit = head.full.slice(0, 10);
      commitEl.value = autoCommit;
      commitResultEl.className = 'cc-result ok';
      commitResultEl.textContent = `✓ ${head.branch} 最新：${autoCommit} ${head.subject}`;
      commitResultEl.title = `${head.full}
${head.author}　${head.date}`;
      invalidate();
    } catch (err) {
      if (token !== autoToken) return;
      autoRepo = null;
      commitResultEl.className = 'cc-result bad';
      commitResultEl.textContent = cleanError(err);
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
    okBtn.textContent = prod ? '開始佈版到正式環境' : pv.params.env === 'customer' ? '開始打包' : '開始佈版';
    okBtn.classList.toggle('btn-prod', prod);
  }

  async function runPreview() {
    if (busy) return null;
    const p = params();
    if (restartError) {
      showError(restartError);
      return null;
    }
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
      statusEl.textContent = pv.customer
        ? `${ENV_LABEL[p.env]} ${TARGET_LABEL[p.target]} ${pv.customer.label} · ${pv.label}（正式環境 branch：${pv.envBranch}）`
        : `${ENV_LABEL[p.env]} ${TARGET_LABEL[p.target]} · ${pv.label}${pv.envBranch ? `（環境 branch：${pv.envBranch}）` : ''}`;
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
  form.addEventListener('change', (e) => {
    layout();
    invalidate();
    if (e.target === repoEl || e.target.name === 'md-env') fillProdCommit();
  });
  commitCheckBtn.addEventListener('click', checkCommitOnly);
  previewBtn.addEventListener('click', runPreview);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const p = params();
    if (restartError) {
      showError(restartError);
      return;
    }
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
    try {
      customers = await api.manualDeployCustomers();
    } catch (err) {
      customers = { saas: [], local: [] };
      loadError ||= cleanError(err);
    }
    const current = repoEl.value;
    repoEl.replaceChildren(...repos.map((r) => new Option(r.label === r.key ? r.key : `${r.label}（${r.key}）`, r.key)));
    if (repos.some((r) => r.key === current)) repoEl.value = current;
    commitResultEl.hidden = true;
    restartRepo = null; // 每次開啟都重新查詢已排程的重啟
    layout();
    invalidate();
    showError(loadError);
    dialog.showModal();
    commitEl.focus();
    autoRepo = null; // 每次開啟都重新查詢正式環境 branch 最新的 commit
    fillProdCommit();
  }

  return { open };
}
