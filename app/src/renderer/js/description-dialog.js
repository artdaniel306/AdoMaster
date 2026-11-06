import { api } from './api.js';
import { $, el } from './dom.js';

/**
 * Work Item Description dialog：
 * 點擊 Work Item id 時在 app 內顯示 Description；Ctrl（macOS 為 ⌘）+ 點擊才用瀏覽器開啟。
 */
let instance = null;

function createDescriptionDialog() {
  const dialog = $('desc-dialog');
  const titleEl = $('ds-title');
  const metaEl = $('ds-meta');
  const bodyEl = $('ds-body');
  let url = '';

  $('ds-close').addEventListener('click', () => dialog.close());
  $('ds-ok').addEventListener('click', () => dialog.close());
  $('ds-open').addEventListener('click', () => {
    if (url) api.openExternal(url);
  });

  /** @param item Work Item row（id / type / title / state / assignedTo / description / webUrl） */
  function open(item) {
    url = item.webUrl || '';
    titleEl.textContent = `${item.type || ''} #${item.id} ${item.title || ''}`.trim();
    metaEl.textContent = `狀態：${item.state || '—'} · 指派：${item.assignedTo || '—'}`;
    bodyEl.textContent = item.description || '（沒有 Description）';
    bodyEl.classList.toggle('muted', !item.description);
    $('ds-open').disabled = !url;
    dialog.showModal();
    bodyEl.scrollTop = 0;
  }

  return { open };
}

/** Work Item id 連結：點擊顯示 Description dialog，Ctrl + 點擊在瀏覽器開啟 */
export function workItemLink(text, item, cls = 'link') {
  const a = el('a', cls, text);
  a.href = '#';
  a.title = '點擊顯示 Description；Ctrl + 點擊在瀏覽器開啟';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      api.openExternal(item.webUrl);
      return;
    }
    instance ||= createDescriptionDialog();
    instance.open(item);
  });
  return a;
}
