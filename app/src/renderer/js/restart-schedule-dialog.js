import { api, cleanError } from './api.js';
import { $, el, errorSetter } from './dom.js';
import { loadRepos, repoTag } from './repos.js';
import { createConfirmDialog } from './confirm-dialog.js';
import { createRestartPicker, restartText } from './restart-picker.js';
import { restartSlot } from '../../shared/flow-rules.js';

const timeText = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false }) : '');

/**
 * 排程 description 中的說明部分。Restart-Schedule.ps1 建立的格式為
 * 「AdoMaster：<日期 時間 重啟 App Service> · <說明> · 建立者 <user@host> <時間>」，去掉頭尾的固定部分。
 */
function noteText(description) {
  const parts = String(description || '').split(' · ');
  if (parts[0].startsWith('AdoMaster：')) parts.shift();
  if (parts.length && parts[parts.length - 1].startsWith('建立者 ')) parts.pop();
  return parts.join(' · ').trim();
}

/**
 * 「佈版 → 正式環境排程重啟…」：查看 Azure Automation 中的重啟排程（prodRestart:list），
 * 為選擇的 repository 新增排程（prodRestart:create，同一時間已排程的不會重複建立），或刪除排程（prodRestart:delete）。
 * 設定在 data/config.json 的 prodRestart（main/services/prodRestart.js）；「設定…」開啟設定 dialog，儲存後重新讀取。
 * @param openSettings (onSaved) => void，開啟「正式環境排程重啟設定」dialog
 */
export function createRestartScheduleDialog({ openSettings } = {}) {
  const dialog = $('restart-schedule-dialog');
  const targetEl = $('rsch-target');
  const reposEl = $('rsch-repos');
  const noteEl = $('rsch-note');
  const resultEl = $('rsch-result');
  const expiredEl = $('rsch-expired');
  const listEl = $('rsch-list');
  const statusEl = $('rsch-status');
  const errorEl = $('rsch-error');
  const createBtn = $('rsch-create');
  const refreshBtn = $('rsch-refresh');
  const settingsBtn = $('rsch-settings');
  const picker = createRestartPicker($('rsch-picker'), { allowNone: false, showExisting: false });
  const confirmDialog = createConfirmDialog();

  let options = null;
  let items = [];
  let busy = false;

  const showError = errorSetter(errorEl);

  function setBusy(b, text = '') {
    busy = b;
    statusEl.className = b ? 'status loading' : 'status';
    statusEl.textContent = text;
    createBtn.disabled = b || !options?.configured;
    refreshBtn.disabled = b || !options?.configured;
    settingsBtn.disabled = b;
  }

  const checkedRepos = () => [...reposEl.querySelectorAll('input:checked')].map((x) => x.value);

  function renderRepos() {
    reposEl.replaceChildren(
      ...(options?.repos || []).map((r) => {
        const label = el('label');
        const box = el('input');
        box.type = 'checkbox';
        box.value = r.key;
        box.addEventListener('change', () => picker.setRepos(checkedRepos()));
        label.append(box, repoTag(r.key), el('span', 'muted', r.appService || ''));
        return label;
      })
    );
    if (options && options.configured && !options.repos.length) reposEl.append(el('span', 'cc-result bad', 'prodRestart.repos 沒有設定任何 repository'));
  }

  function renderList() {
    const shown = items.filter((s) => expiredEl.checked || !s.expired);
    if (!shown.length) {
      listEl.replaceChildren(el('div', 'muted', items.length ? '沒有尚未執行的重啟排程' : '沒有重啟排程'));
      return;
    }
    listEl.replaceChildren(
      ...shown.map((s) => {
        const row = el('div', `rs-item${s.expired ? ' expired' : ''}`);
        const when = el('span', 'rs-when', restartText(s.date, s.time));
        const linked = (s.links || []).length > 0;
        const state = s.expired ? ['muted', '已執行'] : linked ? ['ok', '待執行'] : ['bad', '未連結 Runbook'];
        const note = noteText(s.description);
        const desc = el('span', 'muted rs-desc', note);
        if (note) desc.title = note;
        const info = el('span', 'rs-info', '?');
        info.title = [
          s.description,
          `Schedule：${s.name}`,
          ...(s.links || []).map((l) => `Runbook ${l.runbook}：${Object.entries(l.parameters || {}).map(([k, v]) => `${k}=${v}`).join(', ')}`),
          s.createdAt ? `建立時間：${timeText(s.createdAt)}` : '',
        ].filter(Boolean).join('\n');
        const del = el('button', 'btn-ghost btn-danger', '刪除');
        del.type = 'button';
        del.addEventListener('click', () => remove(s));
        row.append(repoTag(s.repo), when, el('span', `cc-result ${state[0]}`, state[1]), desc, info, del);
        return row;
      })
    );
  }

  async function refresh() {
    if (!options?.configured) return;
    setBusy(true, '查詢 Automation 的重啟排程（az）…');
    showError('');
    try {
      const r = await api.listRestartSchedules();
      items = r.items;
      targetEl.textContent = `Automation：${r.automationAccount}　Runbook：${r.runbook}`;
      renderList();
    } catch (err) {
      showError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(s) {
    if (busy) return;
    const ok = await confirmDialog.open({
      title: '刪除重啟排程',
      message: `確定要刪除 ${s.repo} ${restartText(s.date, s.time)} 的重啟排程嗎？\n（${s.name}）`,
      okLabel: '刪除',
    });
    if (!ok) return;
    setBusy(true, `刪除 ${s.name}…`);
    showError('');
    try {
      await api.deleteRestartSchedule(s.name);
    } catch (err) {
      showError(cleanError(err));
    } finally {
      setBusy(false);
    }
    await refresh();
  }

  async function create() {
    if (busy) return;
    showError('');
    resultEl.replaceChildren();
    const repos = checkedRepos();
    let v;
    try {
      if (!repos.length) throw new Error('請選擇要重啟的 repository');
      v = picker.value();
    } catch (err) {
      showError(err.message);
      return;
    }
    const ok = await confirmDialog.open({
      title: '排程重啟正式環境',
      message: `確定要在 ${restartText(v.date, restartSlot(v.slot).time)} 重啟以下 repository 的正式環境 App Service 嗎？\n\n${repos
        .map((r) => `${r}：${options.repos.find((x) => x.key === r)?.appService || ''}`)
        .join('\n')}`,
      okLabel: '建立排程',
    });
    if (!ok) return;
    setBusy(true, '建立排程…');
    try {
      const r = await api.createRestartSchedules(repos, v.date, v.slot, noteEl.value.trim());
      resultEl.replaceChildren(...r.items.map((x) => el('li', `cc-result ${x.ok ? (x.state === 'exists' ? 'warn' : 'ok') : 'bad'}`, `${x.repo}：${x.message}`)));
    } catch (err) {
      showError(cleanError(err));
    } finally {
      setBusy(false);
    }
    await refresh();
  }

  createBtn.addEventListener('click', create);
  refreshBtn.addEventListener('click', refresh);
  settingsBtn.addEventListener('click', () => {
    if (!busy) openSettings?.(load);
  });
  expiredEl.addEventListener('change', renderList);
  const close = () => {
    if (!busy) dialog.close();
  };
  $('rsch-close').addEventListener('click', close);
  $('rsch-cancel').addEventListener('click', close);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });

  /** 讀取設定與排程清單（開啟時、設定儲存後） */
  async function load() {
    showError('');
    resultEl.replaceChildren();
    listEl.replaceChildren();
    targetEl.textContent = '';
    items = [];
    try {
      await loadRepos(); // repository 標籤的顏色
    } catch {
      // 只影響顏色
    }
    try {
      options = await api.prodRestartOptions();
    } catch (err) {
      options = { configured: false, error: cleanError(err), repos: [] };
    }
    renderRepos();
    picker.load([]);
    setBusy(false);
    if (!options.configured) {
      showError(options.error);
      return;
    }
    targetEl.textContent = `Automation：${options.automationAccount}　Runbook：${options.runbook}`;
    await refresh();
  }

  async function open() {
    if (dialog.open) return;
    dialog.showModal();
    await load();
  }

  return { open };
}
