import { api, cleanError } from './api.js';
import { $, el } from './dom.js';
import { repoTag, repoLabel } from './repos.js';
import { COMMIT_RE, COMMIT_FORMAT_HINT } from '../../shared/flow-rules.js';

/**
 * Confirm Commit dialog（Test deploy / Prod deploy 勾選 SaaS / Local 之前）：
 * manager 依 規劃 選的 repository 各自填入測試通過版的 commit（縮寫即可），
 * 按「檢查」到 app/.env 設定的 repository（<REPO>_REPO_PATH）確認 commit 存在。
 * 按「確認」時 main process 會再全部檢查一次才存檔。
 */
export function createCommitDialog() {
  const dialog = $('commit-dialog');
  const form = $('cc-form');
  const titleEl = $('cc-title');
  const reqEl = $('cc-req');
  const reposEl = $('cc-repos');
  const errorEl = $('cc-error');
  const clearBtn = $('cc-clear');
  const okBtn = $('cc-ok');

  let rows = []; // [{ repo, input }]
  let onSave = null; // (commits | null) => Promise
  let busy = false;
  let openSeq = 0; // dialog 重新開啟後，忽略上一次還沒回來的檢查結果

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function setResult(resultEl, cls, text) {
    resultEl.className = `cc-result ${cls}`;
    resultEl.textContent = text;
    resultEl.title = text;
  }

  function repoRow(repo, branch, commit) {
    const row = el('div', 'cc-repo');
    const name = el('div', 'cc-name');
    name.append(repoTag(repo), el('span', 'repo-branch', branch));

    const input = el('input');
    input.type = 'text';
    input.placeholder = 'commit hash（例：a1b2c3d）';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = commit || '';

    const btn = el('button', 'btn-ghost', '檢查');
    btn.type = 'button';
    const result = el('div', 'cc-result');

    const seq = openSeq;
    btn.addEventListener('click', async () => {
      const c = input.value.trim().toLowerCase();
      if (!COMMIT_RE.test(c)) {
        setResult(result, 'bad', `commit 格式錯誤（${COMMIT_FORMAT_HINT}）`);
        input.focus();
        return;
      }
      btn.disabled = true;
      setResult(result, 'loading', `檢查中…（本機找不到時會 git fetch）`);
      try {
        const r = await api.checkCommit(repo, c, branch);
        if (seq !== openSeq) return;
        if (input.value.trim().toLowerCase() !== c) return; // 檢查期間又改了輸入
        setResult(result, !r.ok ? 'bad' : r.onBranch === false ? 'warn' : 'ok', r.ok ? r.message : `✕ ${r.message}`);
        if (r.ok) result.title = `${r.full}\n${r.subject}\n${r.author} · ${r.date}${r.fetched ? '\n（已 git fetch）' : ''}`;
      } catch (err) {
        if (seq !== openSeq) return;
        setResult(result, 'bad', `✕ ${cleanError(err)}`);
      } finally {
        btn.disabled = false;
      }
    });
    input.addEventListener('input', () => {
      setResult(result, '', '');
      showError('');
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); // Enter 只檢查此列，不送出整個表單
        btn.click();
      }
    });

    row.append(name, input, btn, result);
    rows.push({ repo, input });
    return row;
  }

  async function save(commits) {
    if (busy) return;
    busy = true;
    okBtn.disabled = clearBtn.disabled = true;
    const label = okBtn.textContent;
    if (commits) {
      okBtn.textContent = '確認中…';
      showError('');
    }
    try {
      await onSave(commits);
      dialog.close();
    } catch (err) {
      showError(`儲存失敗：${cleanError(err)}`);
    } finally {
      busy = false;
      okBtn.disabled = clearBtn.disabled = false;
      okBtn.textContent = label;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const commits = {};
    for (const { repo, input } of rows) {
      const c = input.value.trim().toLowerCase();
      if (!c) return showError(`請填入 ${repoLabel(repo)} 的 commit`);
      if (!COMMIT_RE.test(c)) return showError(`${repoLabel(repo)} 的 commit 格式錯誤（${COMMIT_FORMAT_HINT}）`);
      commits[repo] = c;
    }
    save(commits);
  });
  clearBtn.addEventListener('click', () => save(null));
  $('cc-cancel').addEventListener('click', () => dialog.close());
  $('cc-close').addEventListener('click', () => dialog.close());

  /**
   * 開啟 dialog。
   * @param req Requirement（顯示標題用）
   * @param stageLabel 階段名稱（Test deploy / Prod deploy）
   * @param repos 規劃 選的 { repoKey: featureBranch }
   * @param current 目前已確認的 { repoKey: commit }，未確認時為 undefined
   * @param prefill 未確認時預先填入的 commit（例：Prod deploy 帶入 Test deploy 的 commit）
   * @param saveFn (commits | null) => Promise；null 代表取消確認
   */
  function open({ req, stageLabel, repos, current, prefill, saveFn }) {
    openSeq++;
    onSave = saveFn;
    rows = [];
    showError('');
    titleEl.textContent = `Confirm Commit · ${stageLabel}`;
    reqEl.textContent = `#${req.id} ${req.title}`;
    clearBtn.hidden = !current;
    const values = current || prefill || {};
    reposEl.replaceChildren(...Object.entries(repos).map(([repo, branch]) => repoRow(repo, branch, values[repo])));
    dialog.showModal();
    rows.find((r) => !r.input.value)?.input.focus();
  }

  return { open };
}
