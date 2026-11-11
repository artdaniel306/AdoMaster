import { api, cleanError } from './api.js';
import { $, el, errorSetter } from './dom.js';
import { loadRepos, repoTag } from './repos.js';
import { createLogView } from './log-view.js';

/** Sync-Repos.ps1 的 branch status → [樣式, 文字] */
const BRANCH_STATUS = {
  updated: ['ok', '已快轉'],
  wouldUpdate: ['warn', '可快轉'],
  diverged: ['warn', '分岔，未處理'],
  upstreamGone: ['muted', 'upstream 已刪除'],
  failed: ['bad', '失敗'],
};

/**
 * 「工具 → 同步所有 Repository…」：執行 shell/Sync-Repos.ps1（main/services/repoSync.js），
 * 對 config.json 的 repos（開發用 clone）與 localDeploy（部署用 clone）git fetch 並快轉落後的 local branch。
 */
export function createRepoSyncDialog() {
  const dialog = $('repo-sync-dialog');
  const fetchOnlyEl = $('sy-fetch-only');
  const resultEl = $('sy-result');
  const statusEl = $('sy-status');
  const errorEl = $('sy-error');
  const logEl = $('sy-log');
  const runBtn = $('sy-run');
  const cancelBtn = $('sy-cancel');

  const log = createLogView(logEl, { maxLines: 2000 });
  let busy = false;

  const showError = errorSetter(errorEl);

  function setBusy(b, text = '') {
    busy = b;
    statusEl.className = b ? 'status loading' : 'status';
    statusEl.textContent = text;
    runBtn.disabled = b;
    fetchOnlyEl.disabled = b;
    cancelBtn.textContent = b ? '停止' : '關閉';
  }

  api.onRepoSyncLog(({ line }) => {
    if (busy) log.append(line);
  });

  function repoState(r) {
    if (r.status === 'skipped') return ['muted', `略過：${r.message}`];
    if (r.status === 'fetchFailed') return ['bad', `fetch 失敗：${r.message}`];
    const counts = {};
    for (const b of r.branches) counts[b.status] = (counts[b.status] || 0) + 1;
    if (counts.failed) return ['bad', `${counts.failed} 個 branch 失敗`];
    if (counts.updated) return ['ok', `已快轉 ${counts.updated} 個 branch`];
    if (counts.wouldUpdate) return ['warn', `${counts.wouldUpdate} 個 branch 可快轉`];
    return ['ok', '已是最新'];
  }

  function renderResult(repos) {
    resultEl.replaceChildren(
      ...repos.map((r) => {
        const box = el('div', 'sy-repo');
        const head = el('div', 'sy-head');
        const [cls, text] = repoState(r);
        const path = el('p', 'muted sy-path', `${r.kind === 'deploy' ? '部署用' : '開發用'}　${r.path}`);
        path.title = r.path;
        head.append(repoTag(r.key), path, el('span', `cc-result ${cls}`, text));
        box.append(head);
        if (r.branches.length) {
          const ul = el('ul', 'sy-branches');
          for (const b of r.branches) {
            const [bc, bt] = BRANCH_STATUS[b.status] || ['bad', b.status];
            ul.append(el('li', `cc-result ${bc}`, `${b.branch} → ${b.upstream}：${bt}${b.detail ? `（${b.detail}）` : ''}`));
          }
          box.append(ul);
        }
        return box;
      })
    );
  }

  async function run() {
    if (busy) return;
    showError('');
    resultEl.replaceChildren();
    log.reset();
    logEl.hidden = true;
    const fetchOnly = fetchOnlyEl.checked;
    setBusy(true, fetchOnly ? 'git fetch 所有 repository…' : '同步所有 repository…');
    try {
      const r = await api.runRepoSync(fetchOnly);
      renderResult(r.repos || []);
    } catch (err) {
      showError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  runBtn.addEventListener('click', run);
  cancelBtn.addEventListener('click', () => (busy ? api.cancelRepoSync() : dialog.close()));
  $('sy-close').addEventListener('click', () => {
    if (!busy) dialog.close();
  });
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (!busy) dialog.close();
  });

  async function open() {
    if (!dialog.open) dialog.showModal();
    try {
      await loadRepos(); // repository 標籤的顏色
    } catch {
      // 只影響顏色
    }
  }

  api.onRepoSyncMenu(open);
  return { open };
}
