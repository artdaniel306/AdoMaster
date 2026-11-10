import { api, cleanError } from './api.js';
import { $, el } from './dom.js';

/**
 * 選單「設定 → 正式環境排程重啟設定…」：在 App 內編輯 config.json 的 prodRestart
 * （Azure Automation 連線、Runbook 參數、各 repository 的正式環境 App Service、排程時區 / 名稱前綴）。
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
  let repoRows = []; // [{ key, appService, resourceGroup }]（input）
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
    row.value.title = '{欄位} = 該 repository 的同名欄位（appService、resourceGroup），{repo} = repository key';
    const del = el('button', 'btn-icon rs-del', '🗑');
    del.type = 'button';
    del.title = '移除';
    const line = el('div', 'prs-param-row');
    line.append(row.name, row.value, del);
    del.addEventListener('click', () => {
      paramRows = paramRows.filter((r) => r !== row);
      line.remove();
      showError('');
    });
    paramRows.push(row);
    paramsEl.append(line);
    return row;
  }

  function repoRow(r) {
    const row = { key: r.key, appService: textInput(r.appService, 'App Service 名稱'), resourceGroup: textInput(r.resourceGroup, 'Resource Group') };
    const name = el('span', 'prs-repo-name', r.label);
    if (r.label !== r.key) name.append(el('span', 'es-key', r.key));
    const line = el('div', 'prs-repo-row');
    line.append(name, row.appService, row.resourceGroup);
    repoRows.push(row);
    return line;
  }

  function render(s) {
    fileEl.textContent = s.exists ? '' : `${s.file} 尚未設定 prodRestart，儲存後會自動建立。`;
    fileEl.hidden = s.exists;
    inputs = {};
    automationEl.replaceChildren(...AUTOMATION_FIELDS.map((f) => field(f, s.settings[f.key]).wrap));

    paramRows = [];
    paramsEl.replaceChildren();
    for (const p of s.parameters) addParam(p);

    repoRows = [];
    reposEl.replaceChildren(
      ...(s.repos.length ? s.repos.map(repoRow) : [el('span', 'muted', '尚未設定 repository')]),
    );

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
    const repos = repoRows.map((r) => ({ key: r.key, appService: r.appService.value.trim(), resourceGroup: r.resourceGroup.value.trim() }));
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
