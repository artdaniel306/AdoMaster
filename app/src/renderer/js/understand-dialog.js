import { api, cleanError } from './api.js';
import { $, el } from './dom.js';

/**
 * Manager understand dialog：讓 manager 決定需求要在哪些 repository（crmapp / crmappui / upagent）開發，
 * 以及各自做在哪個 feature branch。可選的 branch 由 app/.env 的 <REPO>_BRANCHES 設定（每次開啟時重新讀取）。
 */
export function createUnderstandDialog() {
  const dialog = $('understand-dialog');
  const form = $('und-form');
  const reqEl = $('und-req');
  const reposEl = $('und-repos');
  const errorEl = $('und-error');
  const clearBtn = $('und-clear');
  const okBtn = $('und-ok');

  let rows = []; // [{ key, check, select }]
  let onSave = null; // (repos | null) => Promise
  let busy = false;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function repoRow(repo, branch) {
    const row = el('div', 'und-repo');
    const lab = el('label', 'flow-check');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = !!branch;
    lab.append(check, el('span', null, repo.label));

    const select = el('select');
    select.append(new Option(repo.branches.length ? '— 選擇 feature branch —' : '— 未設定 branch —', ''));
    // 已存的 branch 若已從 .env 移除，仍保留在選單中，避免開啟後被清掉
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
    if (!repo.branches.length) row.append(el('p', 'muted', `請在 app/.env 設定 ${repo.envKey}（以逗號分隔）`));
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
    if (!Object.keys(repos).length) throw new Error('請至少選擇一個 repository');
    return repos;
  }

  async function save(repos) {
    if (busy) return;
    busy = true;
    okBtn.disabled = clearBtn.disabled = true;
    try {
      await onSave(repos);
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
  $('und-cancel').addEventListener('click', () => dialog.close());
  $('und-close').addEventListener('click', () => dialog.close());

  /**
   * 開啟 dialog。
   * @param req Requirement（顯示標題用）
   * @param current 目前已確認的 { repoKey: branch }，未確認時為 undefined
   * @param save (repos | null) => Promise；null 代表取消確認
   */
  async function open(req, current, saveFn) {
    onSave = saveFn;
    rows = [];
    showError('');
    reqEl.textContent = `#${req.id} ${req.title}`;
    clearBtn.hidden = !current;
    reposEl.replaceChildren(el('span', 'muted', '讀取 app/.env 設定中…'));
    dialog.showModal();
    try {
      const config = await api.loadRepoConfig();
      reposEl.replaceChildren(...config.repos.map((r) => repoRow(r, current?.[r.key])));
      if (!config.envFound) showError('找不到 app/.env（可複製 app/env_example.txt 為 .env 後設定各 repository 的 feature branch）');
    } catch (err) {
      reposEl.replaceChildren();
      showError(`讀取設定失敗：${cleanError(err)}`);
    }
  }

  return { open };
}
