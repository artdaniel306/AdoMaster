import { api, cleanError } from './api.js';
import { $, el, errorSetter } from './dom.js';
import { loadRepos, repoTag } from './repos.js';
import { backMergeRows, backMergeProblems } from './back-merge.js';

/**
 * 「Git → 同步 prod 至 feature…」：勾選 repository，把其 prodBranch 反向 merge 回所有 feature branch
 * （main/services/prodSync.js；同正式環境佈版後的反向 merge），結果以 back-merge.js 顯示。
 * 只列出有設定 prodBranch 的 repository；feature branch = branches 中不是環境 branch 的。
 */
export function createProdSyncDialog() {
  const dialog = $('prod-sync-dialog');
  const reposEl = $('ps-repos');
  const resultEl = $('ps-result');
  const statusEl = $('ps-status');
  const errorEl = $('ps-error');
  const runBtn = $('ps-run');
  const cancelBtn = $('ps-cancel');

  const showError = errorSetter(errorEl);
  let busy = false;
  let prodOf = new Map(); // repo key → prodBranch

  function setBusy(b, text = '') {
    busy = b;
    statusEl.className = b ? 'status loading' : 'status';
    statusEl.textContent = text;
    cancelBtn.disabled = b;
    for (const cb of reposEl.querySelectorAll('input')) cb.disabled = b;
    updateRunBtn();
  }

  const selected = () => [...reposEl.querySelectorAll('input:checked')].map((cb) => cb.value);
  const updateRunBtn = () => (runBtn.disabled = busy || !selected().length);

  function renderRepos(repos) {
    prodOf = new Map();
    const rows = repos.flatMap((r) => {
      const prod = r.deployBranches?.prodDeploy;
      if (!prod) return [];
      const envs = new Set(Object.values(r.deployBranches).filter(Boolean));
      const features = r.branches.filter((b) => !envs.has(b));
      prodOf.set(r.key, prod);
      const row = el('label', 'ps-repo');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.value = r.key;
      cb.checked = features.length > 0;
      cb.disabled = !features.length;
      cb.addEventListener('change', updateRunBtn);
      const text = features.length ? `${prod} → ${features.join(', ')}` : `${prod} → （沒有 feature branch）`;
      row.append(cb, repoTag(r.key), el('p', 'ps-branches muted', text));
      return [row];
    });
    reposEl.replaceChildren(...rows);
    if (!rows.length) showError('沒有設定正式環境 branch（prodBranch）的 repository');
    updateRunBtn();
  }

  async function run() {
    const repos = selected();
    if (busy || !repos.length) return;
    showError('');
    resultEl.replaceChildren();
    setBusy(true, `同步 prod 至 feature branch（${repos.length} 個 repository）…`);
    try {
      const { backMerges } = await api.syncProdToFeatures(repos);
      resultEl.replaceChildren(...backMergeRows(backMerges, (repo) => prodOf.get(repo)));
      if (backMergeProblems(backMerges)) showError('有 feature branch 同步失敗或衝突，請手動處理');
    } catch (err) {
      showError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  runBtn.addEventListener('click', run);
  cancelBtn.addEventListener('click', () => !busy && dialog.close());
  $('ps-close').addEventListener('click', () => !busy && dialog.close());
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (!busy) dialog.close();
  });

  async function open() {
    if (busy) return; // 執行中 dialog 無法關閉，一定是開著的
    showError('');
    resultEl.replaceChildren();
    reposEl.replaceChildren();
    statusEl.textContent = '';
    if (!dialog.open) dialog.showModal();
    try {
      renderRepos((await loadRepos()).repos || []);
    } catch (err) {
      showError(cleanError(err));
      updateRunBtn();
    }
  }

  api.onProdSyncMenu(open);
  return { open };
}
