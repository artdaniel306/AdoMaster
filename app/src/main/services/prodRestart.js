const { runPowerShellJson } = require('../powershell');
const { readConfig, readSection, updateSection, str, isObj, assertSingleLine, CONFIG_LABEL } = require('./appConfig');
const { RESTART_DATE_RE, restartSlot, runbookParamFields } = require('../../shared/flow-rules.js');

/**
 * 正式環境排程重啟 App Service（正式環境有客戶在用，不立即重啟，只排在 RESTART_SLOTS 的時段）。
 * 實際操作 Azure Automation 的是 shell/Restart-Schedule.ps1（List / Create / Delete），設定在 data/config.json 的 prodRestart：
 *   { subscription?, resourceGroup, automationAccount, runbook, runbookParameters: { 參數: '{appService}' … }, runOn?,
 *     timeZone?, utcOffset?, schedulePrefix?, repos: { <repo>: { appService, resourceGroup, … } } }
 * 已排程的紀錄以 Automation 本身為準（Schedule 名稱 <prefix>-<repo>-<yyyyMMdd>-<HHmm>，說明含 Requirement / commit / 建立者），
 * 同一 repo 同一時間不會重複建立。
 *
 * 呼叫點：佈版後動作（afterDeploy.js → After-ProdDeploy.ps1 -RestartDate -RestartTime）與
 * 選單「佈版 → 正式環境排程重啟…」（restart-schedule-dialog.js）。
 * 設定畫面：選單「設定 → 正式環境排程重啟設定…」（prod-restart-settings-dialog.js → loadSettings / saveSettings）。
 */

/** 查詢 / 建立 / 刪除要呼叫 Azure API（含 az 取 token），給足時間 */
const SCRIPT_TIMEOUT = 3 * 60_000;
const NOTE_MAX = 200;

/** 讀取 prodRestart 設定摘要（renderer 顯示 / 檢查用，不呼叫 Azure） */
async function restartOptions() {
  const cfg = await readSection(SECTION);
  const missing = ['resourceGroup', 'automationAccount', 'runbook', 'runbookParameters'].filter((k) => !cfg?.[k]);
  const repos = Object.entries(cfg?.repos || {})
    .filter(([, r]) => r && typeof r === 'object')
    .map(([key, r]) => ({ key, appService: typeof r.appService === 'string' ? r.appService : '' }));
  const error = !cfg
    ? `${CONFIG_LABEL} 尚未設定 prodRestart（範本：templates/config_example.json）`
    : missing.length
      ? `${CONFIG_LABEL} 的 prodRestart 缺少 ${missing.join('、')}`
      : '';
  return { configured: !error, error, automationAccount: cfg?.automationAccount || '', runbook: cfg?.runbook || '', repos };
}

/**
 * 檢查 renderer 傳來的排程選擇。沒有選（null / undefined）回傳 null。
 * @returns {{ date, slot, time } | null}
 */
function normalizeRestart(raw) {
  if (raw == null) return null;
  const slot = restartSlot(raw.slot);
  if (!slot) throw new Error('請選擇重啟時段');
  const date = typeof raw.date === 'string' ? raw.date.trim() : '';
  if (!RESTART_DATE_RE.test(date) || Number.isNaN(Date.parse(date))) throw new Error('請選擇重啟日期');
  return { date, slot: slot.key, time: slot.time };
}

/** After-ProdDeploy.ps1 / Restart-Schedule.ps1 的排程參數 */
function restartArgs(restart, note) {
  if (!restart) return [];
  const args = ['-RestartDate', restart.date, '-RestartTime', restart.time];
  const n = String(note || '').trim().slice(0, NOTE_MAX);
  if (n) args.push('-Note', n);
  return args;
}

/** 已排程的重啟（含已過期的）：{ automationAccount, runbook, items: [{ name, repo, date, time, startTime, expired, description, links }] } */
async function listSchedules() {
  const r = await runPowerShellJson('Restart-Schedule.ps1', ['-Action', 'List'], { timeout: SCRIPT_TIMEOUT });
  return { ...r, items: Array.isArray(r.items) ? r.items : r.items ? [r.items] : [] };
}

/**
 * 為多個 repository 建立同一時間的重啟排程（逐一建立，某個失敗不影響其他）。
 * @returns {{ items: [{ repo, ok, state?, name?, message }] }}
 */
async function createSchedules({ repos, date, slot, note } = {}) {
  const restart = normalizeRestart({ date, slot });
  const opts = await restartOptions();
  if (!opts.configured) throw new Error(opts.error);
  if (!Array.isArray(repos) || !repos.length) throw new Error('請選擇要重啟的 repository');
  const unknown = repos.filter((r) => !opts.repos.some((x) => x.key === r));
  if (unknown.length) throw new Error(`${CONFIG_LABEL} 的 prodRestart.repos 沒有設定：${unknown.join('、')}`);
  const items = [];
  for (const repo of repos) {
    const args = ['-Action', 'Create', '-Repo', repo, '-Date', restart.date, '-Time', restart.time];
    const n = String(note || '').trim().slice(0, NOTE_MAX);
    if (n) args.push('-Note', n);
    try {
      const r = await runPowerShellJson('Restart-Schedule.ps1', args, { timeout: SCRIPT_TIMEOUT });
      items.push({ repo, ok: true, state: r.state, name: r.name, message: r.message });
    } catch (err) {
      items.push({ repo, ok: false, message: String(err.message || err).trim() });
    }
  }
  return { items };
}

/** 刪除一個重啟排程（連同連結的 Job Schedule） */
async function deleteSchedule({ name } = {}) {
  if (typeof name !== 'string' || !/^[\w-]+$/.test(name)) throw new Error('參數錯誤');
  return runPowerShellJson('Restart-Schedule.ps1', ['-Action', 'Delete', '-Name', name], { timeout: SCRIPT_TIMEOUT });
}

// ---- 設定畫面（選單「設定 → 正式環境排程重啟設定…」）----

const SECTION = 'prodRestart';
/** Restart-Schedule.ps1 的預設值（欄位空白 = 刪掉 key，讓腳本用預設值） */
const DEFAULTS = { timeZone: 'Asia/Taipei', utcOffset: '+08:00', schedulePrefix: 'adomaster-restart' };
/** 設定畫面可編輯的單值欄位；required = 必填 */
const FIELDS = [
  { key: 'subscription' },
  { key: 'resourceGroup', required: true },
  { key: 'automationAccount', required: true },
  { key: 'runbook', required: true },
  { key: 'runOn' },
  { key: 'timeZone' },
  { key: 'utcOffset', re: /^[+-]\d{2}:\d{2}$/, hint: '格式 +08:00' },
  { key: 'schedulePrefix', re: /^[A-Za-z0-9][\w-]*$/, hint: '只能用英數字、- 與 _' },
];
const FIELD_LABEL = {
  subscription: '訂閱', resourceGroup: 'Resource Group', automationAccount: 'Automation Account', runbook: 'Runbook',
  runOn: 'Hybrid Worker Group', timeZone: '時區', utcOffset: 'UTC 位移', schedulePrefix: '排程名稱前綴',
};
/** 尚未設定時預先帶入的 Runbook 參數（同 templates/config_example.json） */
const DEFAULT_PARAMETERS = [
  { name: 'ResourceGroupName', value: '{resourceGroup}' },
  { name: 'AppServiceName', value: '{appService}' },
];

/**
 * 讀取設定畫面的內容。repository 清單 = config.json repos（依順序）+ prodRestart.repos 中其他的 key。
 * enabled = 已在 prodRestart.repos（可排程重啟）；values = 該 repo 在 prodRestart.repos 的所有單值欄位（release、server、appService…）。
 * @returns {{ file, exists, defaults, settings, parameters: [{ name, value }], repos: [{ key, label, enabled, values: { 欄位: 值 } }] }}
 */
async function loadSettings() {
  const cfg = (await readConfig()) || {};
  const section = isObj(cfg[SECTION]) ? cfg[SECTION] : null;
  const s = section || {};
  const settings = Object.fromEntries(FIELDS.map(({ key }) => [key, str(s[key])]));
  const parameters = isObj(s.runbookParameters)
    ? Object.entries(s.runbookParameters).map(([name, value]) => ({ name, value: str(value) }))
    : section ? [] : DEFAULT_PARAMETERS.map((p) => ({ ...p }));
  const restartRepos = isObj(s.repos) ? s.repos : {};
  const known = (Array.isArray(cfg.repos) ? cfg.repos : []).filter((r) => r && typeof r.key === 'string' && r.key);
  const keys = [...new Set([...known.map((r) => r.key), ...Object.keys(restartRepos)])];
  const repos = keys.map((key) => {
    const enabled = isObj(restartRepos[key]);
    const values = Object.fromEntries(
      Object.entries(enabled ? restartRepos[key] : {})
        .filter(([, v]) => v == null || typeof v !== 'object')
        .map(([f, v]) => [f, str(v)]),
    );
    const k = known.find((x) => x.key === key);
    return { key, label: k?.label || key, enabled, values };
  });
  return { file: CONFIG_LABEL, exists: !!section, defaults: DEFAULTS, settings, parameters, repos };
}

/**
 * 儲存設定畫面的內容到 config.json 的 prodRestart（其他 section、本 section 未列出的欄位、各 repo 的其他欄位都保留）。
 * 選填欄位空白 = 刪掉 key；repository 沒勾選（enabled = false）= 不能排程重啟（從 repos 移除）。
 * 畫面送來的 repo 欄位（values）空白 = 刪掉該欄位；沒送來的欄位保留。
 * Runbook 參數值中的 {欄位} 必須在每個勾選的 repository 都有值（與 Restart-Schedule.ps1 的取代規則相同）。
 */
async function saveSettings({ settings, parameters, repos } = {}) {
  const values = {};
  for (const f of FIELDS) {
    const v = str(settings?.[f.key]);
    assertSingleLine(v, FIELD_LABEL[f.key]);
    if (!v && f.required) throw new Error(`請填入 ${FIELD_LABEL[f.key]}`);
    if (v && f.re && !f.re.test(v)) throw new Error(`${FIELD_LABEL[f.key]} 格式錯誤（${f.hint}）`);
    values[f.key] = v;
  }

  const params = {};
  for (const p of Array.isArray(parameters) ? parameters : []) {
    const name = str(p?.name);
    const value = str(p?.value);
    if (!name && !value) continue;
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`Runbook 參數名稱「${name}」格式錯誤（英數字與 _，不能以數字開頭）`);
    if (Object.keys(params).some((k) => k.toLowerCase() === name.toLowerCase())) throw new Error(`Runbook 參數「${name}」重複`);
    if (!value) throw new Error(`請填入 Runbook 參數「${name}」的值`);
    assertSingleLine(value, `Runbook 參數「${name}」`);
    params[name] = value;
  }
  if (!Object.keys(params).length) throw new Error('請至少設定一個 Runbook 參數');
  const fields = runbookParamFields(Object.values(params));

  const input = new Map();
  for (const r of Array.isArray(repos) ? repos : []) {
    const key = str(r?.key);
    if (!key) continue;
    const values = {};
    for (const [f, v] of Object.entries(isObj(r.values) ? r.values : {})) {
      if (!/^\w+$/.test(f)) continue;
      const s = str(v);
      assertSingleLine(s, `${key} 的 ${f}`);
      values[f] = s;
    }
    input.set(key, { enabled: !!r.enabled, values });
  }

  await updateSection(SECTION, (prev) => {
    const prevRepos = isObj(prev.repos) ? prev.repos : {};
    const next = { ...prev };
    for (const f of FIELDS) {
      if (values[f.key]) next[f.key] = values[f.key];
      else delete next[f.key];
    }
    next.runbookParameters = params;
    const nextRepos = {};
    // 畫面沒有列出的 repo（理論上不會有）原樣保留
    for (const [key, r] of Object.entries(prevRepos)) if (!input.has(key)) nextRepos[key] = r;
    for (const [key, { enabled, values }] of input) {
      if (!enabled) continue;
      const r = { ...(isObj(prevRepos[key]) ? prevRepos[key] : {}) };
      for (const [f, v] of Object.entries(values)) {
        if (v) r[f] = v;
        else delete r[f];
      }
      for (const field of fields) {
        if (!str(r[field])) throw new Error(`${key} 缺少 ${field}（Runbook 參數用到 {${field}}）`);
      }
      nextRepos[key] = r;
    }
    next.repos = nextRepos;
    return next;
  });
  return loadSettings();
}

module.exports = { loadSettings, saveSettings, restartOptions, normalizeRestart, restartArgs, listSchedules, createSchedules, deleteSchedule };
