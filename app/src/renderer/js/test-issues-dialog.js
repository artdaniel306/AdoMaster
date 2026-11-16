import { cleanError } from './api.js';
import { $, el, errorSetter } from './dom.js';
import { TEST_ISSUE_TEXT_MAX, TEST_ISSUES_MAX } from '../../shared/flow-rules.js';

/**
 * 問題備忘 dialog（測試與檢核欄的「🐞 問題備忘」）：
 * 測試時發現的問題逐則記下，修好後勾「已修正」；按「儲存」才整份寫入流程狀態檔的 testIssues。
 */
export function createTestIssuesDialog() {
  const dialog = $('test-issues-dialog');
  const form = $('ti-form');
  const reqEl = $('ti-req');
  const listEl = $('ti-list');
  const countEl = $('ti-count');
  const newEl = $('ti-new');
  const addBtn = $('ti-add');
  const errorEl = $('ti-error');
  const okBtn = $('ti-ok');
  const cancelBtn = $('ti-cancel');
  const closeBtn = $('ti-close');

  // 編輯中的清單 [{ text, resolved, createdAt?, resolvedAt?, textEl, checkEl }]
  let rows = [];
  let onSave = null; // (issues) => Promise
  let busy = false;

  const showError = errorSetter(errorEl);
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
  };

  function updateCount() {
    const open = rows.filter((r) => !r.checkEl.checked).length;
    countEl.textContent = rows.length ? `未修正 ${open} / 共 ${rows.length}` : '';
    countEl.classList.toggle('warn', open > 0);
  }

  function render() {
    if (!rows.length) {
      listEl.replaceChildren(el('div', 'muted ti-empty', '尚無問題備忘'));
    } else {
      listEl.replaceChildren(...rows.map(rowEl));
    }
    updateCount();
  }

  function rowEl(r) {
    const row = el('div', `ti-row${r.checkEl.checked ? ' resolved' : ''}`);
    const check = el('label', 'ti-check');
    check.title = '已修正';
    check.append(r.checkEl, el('span', null, '已修正'));
    r.checkEl.onchange = () => {
      row.classList.toggle('resolved', r.checkEl.checked);
      updateCount();
    };
    const meta = el('div', 'ti-meta');
    if (r.createdAt) meta.append(el('span', null, `記錄於 ${fmtDate(r.createdAt)}`));
    if (r.resolved && r.resolvedAt) meta.append(el('span', null, `修正於 ${fmtDate(r.resolvedAt)}`));
    const rm = el('button', 'btn-icon ti-remove', '✕');
    rm.type = 'button';
    rm.title = '刪除這則備忘';
    rm.disabled = busy;
    rm.addEventListener('click', () => {
      rows = rows.filter((x) => x !== r);
      render();
    });
    const body = el('div', 'ti-body');
    body.append(r.textEl, meta);
    row.append(check, body, rm);
    return row;
  }

  function makeRow(issue) {
    const textEl = el('textarea', 'ti-text');
    textEl.rows = 2;
    textEl.maxLength = TEST_ISSUE_TEXT_MAX;
    textEl.value = issue.text || '';
    const checkEl = el('input');
    checkEl.type = 'checkbox';
    checkEl.checked = !!issue.resolved;
    return { ...issue, textEl, checkEl };
  }

  function addIssue() {
    const text = newEl.value.trim();
    if (!text) return newEl.focus();
    if (rows.length >= TEST_ISSUES_MAX) return showError(`問題備忘最多 ${TEST_ISSUES_MAX} 則`);
    showError('');
    rows.push(makeRow({ text, resolved: false }));
    newEl.value = '';
    render();
    newEl.focus();
  }

  function setBusy(v) {
    busy = v;
    okBtn.disabled = cancelBtn.disabled = closeBtn.disabled = addBtn.disabled = newEl.disabled = v;
    for (const r of rows) r.textEl.disabled = r.checkEl.disabled = v;
    for (const b of listEl.querySelectorAll('.ti-remove')) b.disabled = v;
    okBtn.textContent = v ? '儲存中…' : '儲存';
  }

  addBtn.addEventListener('click', addIssue);
  newEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      addIssue();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    // 新增框還有沒按「新增」的文字時一併加入，避免遺漏
    if (newEl.value.trim()) addIssue();
    const issues = rows.map((r) => ({
      text: r.textEl.value.trim(),
      resolved: r.checkEl.checked,
      createdAt: r.createdAt,
      resolvedAt: r.checkEl.checked ? r.resolvedAt : undefined,
    }));
    const blank = issues.findIndex((x) => !x.text);
    if (blank >= 0) {
      showError(`第 ${blank + 1} 則問題備忘是空白（不需要請按 ✕ 刪除）`);
      rows[blank].textEl.focus();
      return;
    }
    setBusy(true);
    showError('');
    try {
      await onSave(issues);
      dialog.close();
    } catch (err) {
      showError(`儲存失敗：${cleanError(err)}`);
    } finally {
      setBusy(false);
    }
  });
  dialog.addEventListener('cancel', (e) => {
    if (busy) e.preventDefault();
  });
  cancelBtn.addEventListener('click', () => dialog.close());
  closeBtn.addEventListener('click', () => dialog.close());

  /**
   * 開啟 dialog。
   * @param req Requirement（顯示標題用）
   * @param issues 既有的問題備忘 [{ text, resolved, createdAt, resolvedAt }]
   * @param saveFn (issues) => Promise；成功後關閉 dialog
   */
  function open({ req, issues, saveFn }) {
    onSave = saveFn;
    rows = (issues || []).map(makeRow);
    setBusy(false);
    showError('');
    reqEl.textContent = `#${req.id} ${req.title}`;
    newEl.value = '';
    render();
    dialog.showModal();
    newEl.focus();
  }

  return { open };
}
