import { cleanError } from './api.js';
import { $, el } from './dom.js';
import { repoTag } from './repos.js';
import { backMergeRows, backMergeProblems, hasBackMerges } from './back-merge.js';

/**
 * 勾 Test deploy / Prod deploy 的 SaaS / Local 時，若 Confirm Commit 的 commit 尚未進到環境 branch，
 * 跳出此 dialog 詢問是否現在 merge；確認後由 main process 建立 merge commit（--no-ff）並 push 到環境 branch。
 * Prod deploy 另會把 prodBranch 反向 merge 回 feature branch，完成後停在畫面上顯示結果。
 */
export function createMergeDialog() {
  const dialog = $('merge-dialog');
  const titleEl = $('mg-title');
  const reqEl = $('mg-req');
  const listEl = $('mg-list');
  const hintEl = $('mg-hint');
  const errorEl = $('mg-error');
  const okBtn = $('mg-ok');

  const okLabel = okBtn.textContent;
  let onMerge = null; // () => Promise
  let resolveOpen = null; // 關閉時回傳是否已 merge
  let busy = false;
  let done = false; // 已全部 merge，停在畫面上顯示反向 merge 回 feature branch 的結果

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function renderItems(items) {
    listEl.replaceChildren(
      ...items.map((x) => {
        const row = el('div', 'mg-item');
        const name = el('div', 'cc-name');
        name.append(repoTag(x.repo), el('code', 'repo-commit', `${x.commit} → ${x.envBranch}`));
        const cls = x.merged ? 'ok' : x.canMerge ? 'warn' : 'bad';
        const result = el('div', `cc-result ${cls}`, x.message);
        result.title = x.subject ? `${x.full}\n${x.subject}` : x.message;
        row.append(name, result);
        return row;
      })
    );
    const blocked = items.some((x) => !x.merged && !x.canMerge);
    okBtn.disabled = blocked;
    hintEl.textContent = blocked
      ? '有 repository merge 會發生衝突，請先手動處理後再勾選。'
      : '確定後會在環境 branch 建立 merge commit（即使可以 fast-forward 也一樣）並 push，不會動到本機 working tree。';
  }

  function finish(merged) {
    const r = resolveOpen;
    resolveOpen = null;
    if (dialog.open) dialog.close();
    r?.(merged);
  }

  /** Prod deploy：merge 完成後顯示 prodBranch 反向 merge 回 feature branch 的結果，按「完成」才關閉 */
  function showBackMerges(status) {
    const fromOf = (repo) => status.items.find((x) => x.repo === repo)?.envBranch;
    listEl.append(el('div', 'muted', '反向 merge 回 feature branch：'), ...backMergeRows(status.backMerges, fromOf));
    hintEl.textContent = backMergeProblems(status.backMerges)
      ? '已 merge 進正式環境 branch；有 feature branch 反向 merge 失敗或有衝突，請手動處理。'
      : '已 merge 進正式環境 branch，並已把它反向 merge 回 feature branch（一律建立 merge commit）。';
    done = true;
    okBtn.disabled = false;
    okBtn.textContent = '完成';
  }

  okBtn.addEventListener('click', async () => {
    if (done) return finish(true);
    if (busy) return;
    busy = true;
    okBtn.disabled = true;
    okBtn.textContent = 'merge 中…';
    showError('');
    try {
      const status = await onMerge();
      renderItems(status.items);
      okBtn.textContent = okLabel;
      if (!status.allMerged) showError('仍有 repository 尚未 merge');
      else if (hasBackMerges(status.backMerges)) showBackMerges(status);
      else finish(true);
    } catch (err) {
      showError(`merge 失敗：${cleanError(err)}`);
      okBtn.disabled = false;
      okBtn.textContent = okLabel;
    } finally {
      busy = false;
    }
  });
  const cancel = () => {
    if (!busy) finish(done);
  };
  $('mg-cancel').addEventListener('click', cancel);
  $('mg-close').addEventListener('click', cancel);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault(); // Esc：merge 進行中不關閉
    cancel();
  });

  /**
   * 開啟 dialog，回傳 Promise<boolean>：true = 已全部 merge、false = 取消。
   * @param req Requirement（顯示標題用）
   * @param stageLabel 階段名稱（Test deploy / Prod deploy）
   * @param status deployMergeStatus 的結果
   * @param mergeFn () => Promise<status>，執行 merge 並回傳最新狀態
   */
  function open({ req, stageLabel, status, mergeFn }) {
    onMerge = mergeFn;
    done = false;
    okBtn.textContent = okLabel;
    showError('');
    titleEl.textContent = `尚未 merge · ${stageLabel}`;
    reqEl.textContent = `#${req.id} ${req.title}`;
    renderItems(status.items);
    dialog.showModal();
    return new Promise((resolve) => {
      resolveOpen = resolve;
    });
  }

  return { open };
}
