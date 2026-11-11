import { api } from './api.js';
import { $, el } from './dom.js';
import { bindFormDialog, envOverrideWarn, fieldRow, inputBox, secretInput, textInput } from './form-dialog.js';

/**
 * 選單「設定 → 連線與機密設定…」：在 App 內編輯 data/.env（ADO 連線、GitHub token、資料庫密碼）。
 * 欄位定義、讀寫都在 main（services/appConfig.js 的 loadEnvSettings / saveEnvSettings）；
 * 只改有列出的 key，.env 中其他行與註解保留；欄位清空 = 從 .env 刪掉該 key。
 * 機密欄位用 password 輸入框，可按 👁 暫時顯示。
 */
export function initEnvSettings() {
  const dialog = $('env-settings-dialog');
  const groupsEl = $('es-groups');
  const fileEl = $('es-file');

  let inputs = []; // [{ field, input }]

  function fieldEl(field) {
    const opts = { placeholder: field.placeholder || '' };
    let input;
    let control;
    if (field.secret) ({ input, box: control } = secretInput(field.value, opts));
    else control = inputBox((input = textInput(field.value, opts)));
    inputs.push({ field, input });
    return fieldRow(field.label, control, {
      required: field.required,
      keyText: field.key,
      warn: field.envOverride ? envOverrideWarn(field.key) : '',
    });
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
        grid.append(...g.fields.map(fieldEl));
        sec.append(grid);
        return sec;
      }),
    );
  }

  const values = () => Object.fromEntries(inputs.map(({ field, input }) => [field.key, input.value.trim()]));

  const { open } = bindFormDialog({
    dialog,
    prefix: 'es',
    reset() {
      inputs = [];
      fileEl.textContent = '';
      groupsEl.replaceChildren(el('span', 'muted', '讀取 data/.env 中…'));
    },
    load: async () => render(await api.loadEnvSettings()),
    loadFailed: () => groupsEl.replaceChildren(),
    focus: () => inputs[0]?.input,
    validate() {
      const v = values();
      const missing = inputs.find(({ field }) => field.required && !v[field.key] && !field.envOverride);
      if (missing) return { message: `請填入 ${missing.field.label}（${missing.field.key}）`, focus: missing.input };
      if (v.AZDO_BASE_URL && !/^https?:\/\//i.test(v.AZDO_BASE_URL)) {
        return {
          message: 'Base URL 必須是 http:// 或 https:// 開頭的網址',
          focus: inputs.find(({ field }) => field.key === 'AZDO_BASE_URL')?.input,
        };
      }
      return null;
    },
    save: () => api.saveEnvSettings(values()),
  });

  api.onEnvSettingsMenu(() => open());
  return { open: () => open() };
}
