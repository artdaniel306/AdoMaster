const { runPowerShellJson } = require('../powershell');
const { readConfig, CONFIG_LABEL } = require('./appConfig');
const { RESTART_DATE_RE, restartSlot } = require('../../shared/flow-rules.js');

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
 */

/** 查詢 / 建立 / 刪除要呼叫 Azure API（含 az 取 token），給足時間 */
const SCRIPT_TIMEOUT = 3 * 60_000;
const NOTE_MAX = 200;

/** 讀取 prodRestart 設定摘要（renderer 顯示 / 檢查用，不呼叫 Azure） */
async function restartOptions() {
  const cfg = (await readConfig())?.prodRestart;
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

module.exports = { restartOptions, normalizeRestart, restartArgs, listSchedules, createSchedules, deleteSchedule };
