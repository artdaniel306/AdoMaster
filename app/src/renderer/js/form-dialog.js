import { cleanError } from './api.js';
import { $, el, errorSetter } from './dom.js';

/**
 * 設定類 dialog 共用的欄位元件與「讀取 → 編輯 → 儲存」流程。
 * dialog 的 HTML 依前綴命名：<prefix>-form / -ok / -cancel / -close / -error。
 */

/** 文字輸入框（設定畫面統一關閉拼字檢查與自動完成） */
export function textInput(value, { placeholder = '', type = 'text', cls = 'es-input' } = {}) {
  const input = el('input', cls);
  input.type = type;
  input.value = value ?? '';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  return input;
}

/** 輸入框 + 右側按鈕（例如「選擇…」）；回傳外框 */
export function inputBox(input, ...buttons) {
  const box = el('div', 'es-input-box');
  box.append(input, ...buttons);
  return box;
}

/** 密碼輸入框 + 👁 顯示 / 隱藏；回傳 { input, box } */
export function secretInput(value, opts = {}) {
  const input = textInput(value, { ...opts, type: 'password' });
  const eye = el('button', 'btn-icon', '👁');
  eye.type = 'button';
  eye.title = '顯示 / 隱藏';
  eye.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  return { input, box: inputBox(input, eye) };
}

/** 環境變數優先於 .env 時的警告文字 */
export const envOverrideWarn = (key) => `⚠ 已設定同名環境變數 ${key}，腳本會優先使用環境變數，這裡的值不會生效`;

/**
 * 一個欄位：標籤（* = 必填、灰字 key）+ 輸入元件 + 警告。
 * @param opts.cls 額外的 class；opts.title 整列的 tooltip
 */
export function fieldRow(labelText, control, { required = false, keyText = '', warn = '', cls = '', title = '' } = {}) {
  const wrap = el('label', cls ? `rs-field ${cls}` : 'rs-field');
  if (title) wrap.title = title;
  const label = el('span', 'rs-label', labelText);
  if (required) label.append(el('span', 'es-required', ' *'));
  if (keyText) label.append(el('span', 'es-key', keyText));
  wrap.append(label, control);
  if (warn) wrap.append(el('span', 'rs-warn', warn));
  return wrap;
}

/**
 * 接好設定 dialog 的開啟 / 儲存 / 關閉流程：
 *   open：清空 → 顯示 → load()（成功後才啟用「儲存」）；讀取失敗顯示錯誤
 *   submit：validate() → save()（儲存中停用按鈕、不能關閉）→ 關閉 → onSaved
 *   任何輸入改變時清掉錯誤訊息
 * @param o.prefix   HTML id 前綴（例 'es'）
 * @param o.reset()  開啟時清空畫面（顯示「讀取中」）
 * @param o.load()   async：讀取並繪製；回傳後可以儲存
 * @param o.loadFailed() 讀取失敗時清畫面；o.loadErrorHint 附加在錯誤訊息後
 * @param o.validate() 回傳 null = 通過，或 { message, focus }（focus = 要聚焦的元件）
 * @param o.save()   async：儲存；回傳值傳給 onSaved
 * @param o.focus()  讀取完成後要聚焦的元件
 * @returns { open(onSaved?), showError, isBusy }
 */
export function bindFormDialog({ dialog, prefix, reset, load, loadFailed, loadErrorHint = '', validate, save, focus }) {
  const form = $(`${prefix}-form`);
  const okBtn = $(`${prefix}-ok`);
  const showError = errorSetter($(`${prefix}-error`));
  let busy = false;
  let ready = false;
  let onSaved = null;

  const close = () => {
    if (!busy) dialog.close();
  };
  $(`${prefix}-cancel`).addEventListener('click', close);
  $(`${prefix}-close`).addEventListener('click', close);
  dialog.addEventListener('cancel', (e) => {
    if (busy) e.preventDefault();
  });
  form.addEventListener('input', () => showError(''));
  form.addEventListener('change', () => showError(''));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !ready) return;
    const bad = validate?.();
    if (bad) {
      showError(bad.message);
      bad.focus?.focus();
      return;
    }
    busy = true;
    okBtn.disabled = true;
    try {
      const result = await save();
      busy = false;
      dialog.close();
      onSaved?.(result);
    } catch (err) {
      showError(`儲存失敗：${cleanError(err)}`);
    } finally {
      busy = false;
      okBtn.disabled = false;
    }
  });

  /** @param savedFn 儲存成功後呼叫（例如讓開啟它的 dialog 重新讀取） */
  async function open(savedFn = null) {
    if (dialog.open) return;
    onSaved = savedFn;
    ready = false;
    showError('');
    reset();
    okBtn.disabled = true;
    dialog.showModal();
    try {
      await load();
      ready = true;
      okBtn.disabled = false;
      focus?.()?.focus();
    } catch (err) {
      loadFailed?.();
      showError(`讀取設定失敗：${cleanError(err)}${loadErrorHint}`);
    }
  }

  return { open, showError, isBusy: () => busy };
}
