import { api, cleanError } from './api.js';
import { el } from './dom.js';
import { RESTART_SLOTS, restartSlot, restartSlotLabel } from '../../shared/flow-rules.js';

/** Azure Automation 要求 Schedule 至少在 5 分鐘後；多留 1 分鐘 */
const MIN_LEAD_MS = 6 * 60_000;

/** 本機日期 yyyy-MM-dd */
export const localDate = (d = new Date()) => d.toLocaleDateString('sv-SE');

/** 重啟排程的顯示文字：2026-11-12 深夜 23:30 */
export const restartText = (date, time) => `${date} ${restartSlotLabel(time)} ${time}`.replace(/\s+/g, ' ');

/** 時間是否已過（或距離現在不到 Automation 的最短間隔） */
export const restartTooSoon = (date, time) => new Date(`${date}T${time}:00`).getTime() < Date.now() + MIN_LEAD_MS;

/** 預設日期：今天最後一個時段已來不及時改成明天 */
function defaultDate() {
  const today = localDate();
  const last = RESTART_SLOTS[RESTART_SLOTS.length - 1];
  if (!restartTooSoon(today, last.time)) return today;
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return localDate(d);
}

/**
 * 正式環境排程重啟的日期 + 時段選擇（佈版 dialog / 手動佈版 / 排程重啟 dialog 共用）。
 * @param root 放置的容器
 * @param allowNone true = 第一個選項為「不排程重啟」（預設）
 * @param showExisting true = 列出這些 repository 在 Automation 中尚未執行的重啟排程（重複的會標示）
 */
export function createRestartPicker(root, { allowNone = true, showExisting = true } = {}) {
  const slotEl = el('select', 'rp-slot');
  if (allowNone) slotEl.append(new Option('不排程重啟', ''));
  slotEl.append(...RESTART_SLOTS.map((s) => new Option(`${s.label} ${s.time}`, s.key)));
  const dateEl = el('input', 'rp-date');
  dateEl.type = 'date';
  const row = el('div', 'rp-row');
  row.append(dateEl, slotEl);
  const msgEl = el('ul', 'rp-msgs');
  root.replaceChildren(row, msgEl);

  let repos = [];
  let options = null; // prodRestart:options
  let schedules = null; // 尚未執行的排程；null = 查詢中 / 失敗
  let listError = '';
  let token = 0;

  const chosen = () => (slotEl.value ? restartSlot(slotEl.value) : null);

  function render() {
    const slot = chosen();
    dateEl.disabled = !slot;
    const items = [];
    if (options && !options.configured) items.push(['bad', options.error]);
    else if (options && slot) {
      const missing = repos.filter((r) => !options.repos.some((x) => x.key === r));
      if (missing.length) items.push(['bad', `prodRestart.repos 沒有設定：${missing.join('、')}（不會排程）`]);
      const targets = options.repos.filter((x) => repos.includes(x.key));
      if (targets.length) items.push(['muted', `重啟：${targets.map((x) => x.appService || x.key).join('、')}（${options.automationAccount} / ${options.runbook}）`]);
    }
    if (slot && dateEl.value && restartTooSoon(dateEl.value, slot.time)) items.push(['bad', `${restartText(dateEl.value, slot.time)} 已過或太近，請選之後的時間`]);
    if (showExisting && repos.length && options?.configured) {
      if (listError) items.push(['warn', `查詢已排程的重啟失敗：${listError}`]);
      else if (!schedules) items.push(['muted', '查詢 Automation 已排程的重啟…']);
      else {
        const mine = schedules.filter((s) => repos.includes(s.repo));
        if (!mine.length) items.push(['muted', '目前沒有尚未執行的重啟排程']);
        for (const s of mine) {
          const dup = slot && s.date === dateEl.value && s.time === slot.time;
          items.push([dup ? 'warn' : 'muted', `已排程：${s.repo} ${restartText(s.date, s.time)}${dup ? '（相同時間，不會重複建立）' : ''}`]);
        }
      }
    }
    msgEl.replaceChildren(...items.map(([cls, text]) => el('li', `cc-result ${cls}`, text)));
  }

  slotEl.addEventListener('change', render);
  dateEl.addEventListener('input', render);

  /** 設定要重啟的 repository 並重新讀取設定 / 已排程的重啟；選擇回到預設 */
  async function load(repoKeys) {
    const my = ++token;
    repos = [...repoKeys];
    slotEl.value = allowNone ? '' : 'night';
    dateEl.value = defaultDate();
    dateEl.min = localDate();
    options = null;
    schedules = null;
    listError = '';
    render();
    try {
      options = await api.prodRestartOptions();
    } catch (err) {
      options = { configured: false, error: cleanError(err), repos: [] };
    }
    if (my !== token) return;
    render();
    if (!showExisting || !options.configured || !repos.length) return;
    try {
      const r = await api.listRestartSchedules();
      if (my !== token) return;
      schedules = r.items.filter((s) => !s.expired);
    } catch (err) {
      if (my !== token) return;
      listError = cleanError(err);
    }
    render();
  }

  /** 目前的選擇：null = 不排程；選擇不完整 / 已過時丟錯 */
  function value() {
    const slot = chosen();
    if (!slot) return null;
    if (options && !options.configured) throw new Error(`無法排程重啟：${options.error}`);
    if (!dateEl.value) throw new Error('請選擇重啟日期');
    if (restartTooSoon(dateEl.value, slot.time)) throw new Error(`${restartText(dateEl.value, slot.time)} 已過或太近，請選之後的時間`);
    return { date: dateEl.value, slot: slot.key };
  }

  /** 只換要重啟的 repository（保留日期 / 時段的選擇，不重新查詢） */
  function setRepos(repoKeys) {
    repos = [...repoKeys];
    render();
  }

  return { load, setRepos, value, render };
}
