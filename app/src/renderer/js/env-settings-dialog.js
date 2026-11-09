import { api, cleanError } from './api.js';
import { $, el } from './dom.js';

/**
 * 選單「設定 → 連線與機密設定…」：在 App 內編輯 data/.env（ADO 連線、GitHub token、資料庫密碼）。
 * 欄位定義、讀寫都在 main（services/appConfig.js 的 loadEnvSettings / saveEnvSettings）；
 * 只改有列出的 key，.env 中其他行與註解保留；欄位清空 = 從 .env 刪掉該 key。
 * 機密欄位用 password 輸入框，可按 👁 暫時顯示。
 */
export function initEnvSettings() {
  const dialog = $('env-settings-dialog');
  const form = $('es-form');
  const groupsEl = $('es-groups');
  const fileEl = $('es-file');
  const errorEl = $('es-error');
  const okBtn = $('es-ok');

  let inputs = []; // [{ field, input }]
  let busy = false;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function fieldRow(field) {
    const input = el('input', 'es-input');
    input.type = field.secret ? 'password' : 'text';
    input.value = field.value || '';
    input.placeholder = field.placeholder || '';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.addEventListener('input', () => showError(''));

    const box = el('div', 'es-input-box');
    box.append(input);
    if (field.secret) {
      const eye = el('button', 'btn-icon', '👁');
      eye.type = 'button';
      eye.title = '顯示 / 隱藏';
      eye.addEventListener('click', () => {
        input.type = input.type === 'password' ? 'text' : 'password';
      });
      box.append(eye);
    }

    const wrap = el('label', 'rs-field');
    const label = el('span', 'rs-label', field.label);
    if (field.required) label.append(el('span', 'es-required', ' *'));
    label.append(el('span', 'es-key', field.key));
    wrap.append(label, box);
    if (field.envOverride) wrap.append(el('span', 'rs-warn', `⚠ 已設定同名環境變數 ${field.key}，腳本會優先使用環境變數，這裡的值不會生效`));
    inputs.push({ field, input });
    return wrap;
  }

  function render(settings) {
    inputs = [];
    fileEl.textContent = settings.exists ? '' : `${settings.file} 尚未建立，儲存後會自動建立。`;
    fileEl.hidden = settings.exists;
    groupsEl.replaceChildren(
      ...settings.groups.map((g) => {
        const sec = el('section', 'rs-repo');
        sec.append(el('h4', 'es-title', g.title));
        const grid = el('div', 'es-grid');
        grid.append(...g.fields.map(fieldRow));
        sec.append(grid);
        return sec;
      }),
    );
  }

  $('es-cancel').addEventListener('click', () => dialog.close());
  $('es-close').addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const values = Object.fromEntries(inputs.map(({ field, input }) => [field.key, input.value.trim()]));
    const missing = inputs.find(({ field }) => field.required && !values[field.key] && !field.envOverride);
    if (missing) {
      showError(`請填入 ${missing.field.label}（${missing.field.key}）`);
      missing.input.focus();
      return;
    }
    if (values.AZDO_BASE_URL && !/^https?:\/\//i.test(values.AZDO_BASE_URL)) {
      showError('Base URL 必須是 http:// 或 https:// 開頭的網址');
      inputs.find(({ field }) => field.key === 'AZDO_BASE_URL')?.input.focus();
      return;
    }
    busy = true;
    okBtn.disabled = true;
    try {
      await api.saveEnvSettings(values);
      dialog.close();
    } catch (err) {
      showError(`儲存失敗：${cleanError(err)}`);
    } finally {
      busy = false;
      okBtn.disabled = false;
    }
  });

  async function open() {
    if (dialog.open) return;
    inputs = [];
    showError('');
    fileEl.textContent = '';
    groupsEl.replaceChildren(el('span', 'muted', '讀取 data/.env 中…'));
    okBtn.disabled = true;
    dialog.showModal();
    try {
      render(await api.loadEnvSettings());
      okBtn.disabled = false;
      inputs[0]?.input.focus();
    } catch (err) {
      groupsEl.replaceChildren();
      showError(`讀取設定失敗：${cleanError(err)}`);
    }
  }

  api.onEnvSettingsMenu(open);
  return { open };
}
