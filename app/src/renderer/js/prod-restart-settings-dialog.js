import { api, cleanError } from './api.js';
import { $, el } from './dom.js';
import { runbookParamFields } from '../../shared/flow-rules.js';

/**
 * 選單「設定 → 正式環境排程重啟設定…」：在 App 內編輯 config.json 的 prodRestart
 * （Azure Automation 連線、Runbook 參數、各 repository 是否可排程與 Runbook 參數用到的 {欄位} 值、排程時區 / 名稱前綴）。
 * repository 的欄位依 Runbook 參數值中的 {欄位} 動態產生（例：{release}、{server} → release、server 兩欄）。
 * 讀寫都在 main（services/prodRestart.js 的 loadSettings / saveSettings，驗證也在那裡）；
 * 「正式環境排程重啟」dialog 的「設定…」也會開啟這裡，儲存後重新讀取。
 */
let instance = null;

/** Azure Automation 區塊的欄位；required = 必填 */
const AUTOMATION_FIELDS = [
  { key: 'automationAccount', label: 'Automation Account', required: true },
  { key: 'resourceGroup', label: 'Resource Group', required: true, title: 'Automation Account 所在的 Resource Group' },
  { key: 'runbook', label: 'Runbook', required: true },
  { key: 'subscription', label: '訂閱', placeholder: 'az 目前的訂閱' },
  { key: 'runOn', label: 'Hybrid Worker Group', placeholder: 'Azure（雲端執行）' },
];
/** 排程區塊的欄位；placeholder 用 main 回傳的預設值 */
const SCHEDULE_FIELDS = [
  { key: 'timeZone', label: '時區' },
  { key: 'utcOffset', label: 'UTC 位移' },
  { key: 'schedulePrefix', label: '排程名稱前綴', title: '只會列出 / 刪除這個前綴開頭的排程' },
];

export function initProdRestartSettings() {
  if (instance) return instance;

  const dialog = $('prod-restart-settings-dialog');
  const form = $('prs-form');
  const fileEl = $('prs-file');
  const automationEl = $('prs-automation');
  const paramsEl = $('prs-params');
  const reposEl = $('prs-repos');
  const scheduleEl = $('prs-schedule');
  const errorEl = $('prs-error');
  const okBtn = $('prs-ok');

  let inputs = {}; // key → input（Automation + 排程）
  let paramRows = []; // [{ name, value }]（input）
  let repoRows = []; // [{ key, enabled: checkbox, values: { 欄位: 值 }, cells }]
  let columns = null; // 目前 Runbook 參數用到的 {欄位}
  let busy = false;
  let onSaved = null;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function textInput(value = '', placeholder = '') {
    const input = el('input', 'es-input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.addEventListener('input', () => showError(''));
    return input;
  }

  function field(f, value, placeholder = f.placeholder || '') {
    const input = textInput(value, placeholder);
    inputs[f.key] = input;
    const wrap = el('label', 'rs-field');
    if (f.title) wrap.title = f.title;
    const label = el('span', 'rs-label', f.label);
    if (f.required) label.append(el('span', 'es-required', ' *'));
    label.append(el('span', 'es-key', f.key));
    wrap.append(label, input);
    return { wrap, input };
  }

  function addParam(p = { name: '', value: '' }) {
    const row = { name: textInput(p.name, '參數名稱'), value: textInput(p.value, '{appService}') };
    row.value.title = '{欄位} = 該 repository 的同名欄位，{repo} = repository key';
    row.value.addEventListener('input', syncColumns);
    const del = el('button', 'btn-icon rs-del', '🗑');
    del.type = 'button';
    del.title = '移除';
    const line = el('div', 'prs-param-row');
    line.append(row.name, row.value, del);
    del.addEventListener('click', () => {
      paramRows = paramRows.filter((r) => r !== row);
      line.remove();
      showError('');
      syncColumns();
    });
    paramRows.push(row);
    paramsEl.append(line);
    syncColumns();
    return row;
  }

  /** repository 列的欄位輸入框（依目前的 columns）；沒勾選時停用 */
  function renderCells(row) {
    row.cells.replaceChildren(
      ...columns.map((f) => {
        const input = textInput(row.values[f] || '', f);
        input.title = f;
        input.disabled = !row.enabled.checked;
        input.addEventListener('input', () => {
          row.values[f] = input.value;
        });
        return input;
      }),
    );
  }

  /** Runbook 參數的 {欄位} 改變時，重畫 repository 的欄位（已輸入的值保留在 row.values） */
  function syncColumns() {
    const next = runbookParamFields(paramRows.map((r) => r.value.value));
    if (columns && next.join('\n') === columns.join('\n')) return;
    columns = next;
    const head = reposEl.querySelector('.prs-repo-head .prs-repo-fields');
    head?.replaceChildren(...columns.map((f) => el('span', 'es-key', f)));
    for (const row of repoRows) renderCells(row);
  }

  function repoRow(r) {
    const enabled = el('input');
    enabled.type = 'checkbox';
    enabled.checked = r.enabled;
    const row = { key: r.key, enabled, values: { ...r.values }, cells: el('div', 'prs-repo-fields') };
    const name = el('label', 'prs-repo-name');
    name.title = '可排程重啟';
    name.append(enabled, el('span', '', r.label));
    if (r.label !== r.key) name.append(el('span', 'es-key', r.key));
    enabled.addEventListener('change', () => {
      showError('');
      renderCells(row);
    });
    const line = el('div', 'prs-repo-row');
    line.append(name, row.cells);
    repoRows.push(row);
    renderCells(row);
    return line;
  }

  function repoHead() {
    const line = el('div', 'prs-repo-row prs-repo-head');
    line.append(el('span'), el('div', 'prs-repo-fields'));
    return line;
  }

  function render(s) {
    fileEl.textContent = s.exists ? '' : `${s.file} 尚未設定 prodRestart，儲存後會自動建立。`;
    fileEl.hidden = s.exists;
    inputs = {};
    automationEl.replaceChildren(...AUTOMATION_FIELDS.map((f) => field(f, s.settings[f.key]).wrap));

    paramRows = [];
    repoRows = [];
    columns = null;
    paramsEl.replaceChildren();
    reposEl.replaceChildren();
    for (const p of s.parameters) addParam(p);
    syncColumns();

    reposEl.replaceChildren(
      ...(s.repos.length ? [repoHead(), ...s.repos.map(repoRow)] : [el('span', 'muted', '尚未設定 repository')]),
    );
    columns = null;
    syncColumns(); // 填表頭

    const original = s.settings.schedulePrefix || s.defaults.schedulePrefix;
    scheduleEl.replaceChildren(
      ...SCHEDULE_FIELDS.map((f) => {
        const { wrap, input } = field(f, s.settings[f.key], s.defaults[f.key]);
        if (f.key === 'schedulePrefix' && s.exists) {
          const warn = el('span', 'rs-warn', `變更後，「${original}」開頭的既有排程不會再列出，也無法從 App 刪除`);
          const sync = () => {
            warn.hidden = (input.value.trim() || s.defaults.schedulePrefix) === original;
          };
          input.addEventListener('input', sync);
          sync();
          wrap.append(warn);
        }
        return wrap;
      }),
    );
  }

  $('prs-add-param').addEventListener('click', () => addParam().name.focus());
  $('prs-cancel').addEventListener('click', () => dialog.close());
  $('prs-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (e) => {
    if (busy) e.preventDefault();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !inputs.runbook) return;
    const settings = Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value.trim()]));
    const parameters = paramRows.map((r) => ({ name: r.name.value.trim(), value: r.value.value.trim() }));
    // 只送目前欄位的值；其他既有欄位由 main 保留
    const repos = repoRows.map((r) => ({
      key: r.key,
      enabled: r.enabled.checked,
      values: Object.fromEntries(columns.map((f) => [f, String(r.values[f] ?? '').trim()])),
    }));
    busy = true;
    okBtn.disabled = true;
    try {
      await api.saveProdRestartSettings(settings, parameters, repos);
      dialog.close();
      onSaved?.();
    } catch (err) {
      showError(`儲存失敗：${cleanError(err)}`);
    } finally {
      busy = false;
      okBtn.disabled = false;
    }
  });

  /** @param savedFn 儲存成功後呼叫（例如讓「正式環境排程重啟」dialog 重新讀取） */
  async function open(savedFn = null) {
    if (dialog.open) return;
    onSaved = savedFn;
    inputs = {};
    paramRows = [];
    repoRows = [];
    columns = null;
    showError('');
    fileEl.textContent = '';
    fileEl.hidden = true;
    automationEl.replaceChildren(el('span', 'muted', '讀取設定中…'));
    paramsEl.replaceChildren();
    reposEl.replaceChildren();
    scheduleEl.replaceChildren();
    okBtn.disabled = true;
    dialog.showModal();
    try {
      render(await api.loadProdRestartSettings());
      okBtn.disabled = false;
      inputs.automationAccount?.focus();
    } catch (err) {
      automationEl.replaceChildren();
      showError(`讀取設定失敗：${cleanError(err)}`);
    }
  }

  api.onProdRestartSettingsMenu(() => open());
  instance = { open };
  return instance;
}
