import { cleanError } from './api.js';
import { $, el, errorSetter } from './dom.js';
import { loadRepos, repoTag } from './repos.js';

/**
 * 規劃 dialog：讓 manager 決定需求要在哪些 repository（清單與代表色由 data/config.json 的 repos 設定）開發，
 * 以及各自做在哪個 feature branch。可選的 branch 由 data/config.json 的 repos 的 branches 設定（每次開啟時重新讀取）。
 */
export function createPlanDialog() {
  const dialog = $('plan-dialog');
  const form = $('plan-form');
  const reqEl = $('plan-req');
  const reposEl = $('plan-repos');
  const errorEl = $('plan-error');
  const clearBtn = $('plan-clear');
  const okBtn = $('plan-ok');
  const migrationEl = $('plan-migration');
  const noteEl = $('plan-note');

  let rows = []; // [{ key, check, select }]
  let onSave = null; // (repos | null, migration, note) => Promise
  let busy = false;

  const showError = errorSetter(errorEl);

  function repoRow(repo, branch) {
    const row = el('div', 'plan-repo');
    const lab = el('label', 'flow-check');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = !!branch;
    lab.append(check, repoTag(repo.key));

    const select = el('select');
    select.append(new Option(repo.branches.length ? '— 選擇 feature branch —' : '— 未設定 branch —', ''));
    // 已存的 branch 若已從設定移除，仍保留在選單中，避免開啟後被清掉
    const branches = branch && !repo.branches.includes(branch) ? [branch, ...repo.branches] : repo.branches;
    for (const b of branches) select.append(new Option(b, b));
    select.value = branch || '';
    select.disabled = !check.checked;

    check.addEventListener('change', () => {
      select.disabled = !check.checked;
      if (check.checked && !select.value && branches.length === 1) select.value = branches[0];
      if (check.checked) select.focus();
      showError('');
    });
    select.addEventListener('change', () => showError(''));

    row.append(lab, select);
    if (!repo.branches.length) row.append(el('p', 'muted', `請在 data/config.json 的 repos 設定 ${repo.key} 的 "branches"`));
    rows.push({ key: repo.key, label: repo.label, check, select });
    return row;
  }

  function collect() {
    const repos = {};
    for (const r of rows) {
      if (!r.check.checked) continue;
      if (!r.select.value) throw new Error(`請選擇 ${r.label} 的 feature branch`);
      repos[r.key] = r.select.value;
    }
    return repos; // 可以是空的：不需修改 repository（例如只需調整 database 資料）
  }

  async function save(repos) {
    if (busy) return;
    busy = true;
    okBtn.disabled = clearBtn.disabled = true;
    try {
      await onSave(repos, migrationEl.checked, noteEl.value);
      dialog.close();
    } catch (err) {
      showError(`儲存失敗：${cleanError(err)}`);
    } finally {
      busy = false;
      okBtn.disabled = clearBtn.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    let repos;
    try {
      repos = collect();
    } catch (err) {
      showError(err.message);
      return;
    }
    save(repos);
  });
  clearBtn.addEventListener('click', () => save(null));
  $('plan-cancel').addEventListener('click', () => dialog.close());
  $('plan-close').addEventListener('click', () => dialog.close());

  /**
   * 開啟 dialog。
   * @param req Requirement（顯示標題用）
   * @param current 目前已確認的 { repos: { repoKey: branch }, migration, note }，未確認時為 undefined
   * @param save (repos | null, migration, note) => Promise；repos 為 null 代表取消確認
   */
  async function open(req, current, saveFn) {
    onSave = saveFn;
    rows = [];
    showError('');
    reqEl.textContent = `#${req.id} ${req.title}`;
    clearBtn.hidden = !current;
    migrationEl.checked = !!current?.migration;
    noteEl.value = current?.note || '';
    reposEl.replaceChildren(el('span', 'muted', '讀取 repository 設定中…'));
    dialog.showModal();
    try {
      const config = await loadRepos();
      reposEl.replaceChildren(...config.repos.map((r) => repoRow(r, current?.repos?.[r.key])));
    } catch (err) {
      reposEl.replaceChildren();
      showError(`讀取設定失敗：${cleanError(err)}`);
    }
  }

  return { open };
}
