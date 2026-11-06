import { cleanError } from './api.js';
import { $, el } from './dom.js';

/**
 * 勾 Test deploy / Prod deploy 的 SaaS / Local 時，若 Confirm Commit 的 commit 尚未進到環境 branch，
 * 跳出此 dialog 詢問是否現在 merge；確認後由 main process 建立 merge commit（--no-ff）並 push 到環境 branch。
 */
export function createMergeDialog() {
  const dialog = $('merge-dialog');
  const titleEl = $('mg-title');
  const reqEl = $('mg-req');
  const listEl = $('mg-list');
  const hintEl = $('mg-hint');
  const errorEl = $('mg-error');
  const okBtn = $('mg-ok');

  let onMerge = null; // () => Promise
  let resolveOpen = null; // 關閉時回傳是否已 merge
  let busy = false;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function renderItems(items) {
    listEl.replaceChildren(
      ...items.map((x) => {
        const row = el('div', 'mg-item');
        const name = el('div', 'cc-name');
        name.append(el('span', 'repo-name', x.repo), el('code', 'repo-commit', `${x.commit} → ${x.envBranch}`));
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

  okBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    okBtn.disabled = true;
    const label = okBtn.textContent;
    okBtn.textContent = 'merge 中…';
    showError('');
    try {
      const status = await onMerge();
      renderItems(status.items);
      if (status.allMerged) finish(true);
      else showError('仍有 repository 尚未 merge');
    } catch (err) {
      showError(`merge 失敗：${cleanError(err)}`);
      okBtn.disabled = false;
    } finally {
      busy = false;
      okBtn.textContent = label;
    }
  });
  const cancel = () => {
    if (!busy) finish(false);
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
