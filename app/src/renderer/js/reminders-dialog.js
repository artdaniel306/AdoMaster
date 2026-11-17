import { api, cleanError } from './api.js';
import { $, el, errorSetter } from './dom.js';
import { REMINDER_TYPES, reminderTypeLabel } from '../../shared/flow-rules.js';

/**
 * 選單「開發指標 → 流程提醒…」：列出被提醒過的開發人員（依人員 × 提醒類型彙整）、次數與被提醒的 Task。
 * 資料來自 main/services/reminders.js（data/reminders.json）；提醒類型見 shared/flow-rules.js 的 REMINDER_TYPES。
 */
export function createRemindersDialog() {
  const dialog = $('reminders-dialog');
  const typeEl = $('rm-type');
  const bodyEl = $('rm-rows');
  const emptyEl = $('rm-empty');
  const showError = errorSetter($('rm-error'));
  let rows = [];

  typeEl.replaceChildren(
    new Option('全部類型', ''),
    ...Object.entries(REMINDER_TYPES).map(([key, label]) => new Option(label, key)),
  );

  /** ISO 時間 → 本地時間 yyyy/MM/dd HH:mm */
  const formatDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso || '' : d.toLocaleString('zh-TW', {
      hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  };

  function workItemLinks(items) {
    const box = el('div', 'rm-items');
    for (const w of items) {
      const text = w.count > 1 ? `#${w.id} ×${w.count}` : `#${w.id}`;
      if (w.url) {
        const a = el('a', 'link', text);
        a.href = '#';
        a.title = '在瀏覽器開啟';
        a.addEventListener('click', (e) => {
          e.preventDefault();
          api.openExternal(w.url);
        });
        box.append(a);
      } else {
        box.append(el('span', null, text));
      }
    }
    return box;
  }

  function render() {
    const type = typeEl.value;
    const shown = rows.filter((r) => !type || r.type === type);
    bodyEl.replaceChildren(...shown.map((r) => {
      const tr = el('tr');
      const who = el('td');
      who.append(el('div', null, r.name || r.email), el('div', 'muted', r.email));
      const items = el('td');
      items.append(workItemLinks(r.workItems));
      tr.append(
        who,
        el('td', 'nowrap', reminderTypeLabel(r.type)),
        el('td', 'num', String(r.count)),
        items,
        el('td', 'nowrap', formatDate(r.lastAt)),
      );
      return tr;
    }));
    emptyEl.hidden = shown.length > 0;
  }

  async function open() {
    showError('');
    rows = [];
    render();
    emptyEl.textContent = '載入中…';
    if (!dialog.open) dialog.showModal();
    try {
      rows = await api.reminderSummary();
    } catch (err) {
      showError(cleanError(err));
    }
    emptyEl.textContent = '（沒有提醒紀錄）';
    render();
  }

  typeEl.addEventListener('change', render);
  $('rm-close').addEventListener('click', () => dialog.close());
  $('rm-ok').addEventListener('click', () => dialog.close());
  $('rm-reload').addEventListener('click', open);
  api.onMetricsMenu((action) => {
    if (action === 'reminders') open();
  });
  return { open };
}
