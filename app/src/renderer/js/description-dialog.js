import { api, cleanError } from './api.js';
import { $, el } from './dom.js';

/**
 * Work Item Description dialog：
 * 點擊 Work Item id 時在 app 內顯示 Description 與最新 3 筆留言；Ctrl（macOS 為 ⌘）+ 點擊才用瀏覽器開啟。
 */
let instance = null;

const COMMENT_COUNT = 3;

/** ISO 時間 → 本地時間 yyyy/MM/dd HH:mm */
function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return d.toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function createDescriptionDialog() {
  const dialog = $('desc-dialog');
  const titleEl = $('ds-title');
  const metaEl = $('ds-meta');
  const bodyEl = $('ds-body');
  const commentsEl = $('ds-comments');
  const countEl = $('ds-comments-count');
  let url = '';
  let seq = 0; // 每次開啟遞增；舊請求晚回來時不覆蓋目前的內容

  function setCommentsMessage(text, cls = 'muted') {
    countEl.textContent = '';
    commentsEl.replaceChildren(el('p', cls, text));
  }

  async function loadComments(id) {
    const mine = ++seq;
    setCommentsMessage('載入中…');
    try {
      const { totalCount, comments } = await api.fetchComments(Number(id), COMMENT_COUNT);
      if (mine !== seq) return;
      if (!comments.length) {
        setCommentsMessage('（沒有留言）');
        return;
      }
      countEl.textContent = `（共 ${totalCount} 則）`;
      commentsEl.replaceChildren(...comments.map((c) => {
        const box = el('div', 'ds-comment');
        box.append(
          el('p', 'muted', `${c.createdBy || '—'} · ${formatDate(c.createdDate)}`),
          el('div', 'ds-comment-text', c.text || ''),
        );
        return box;
      }));
    } catch (err) {
      if (mine === seq) setCommentsMessage(`無法取得留言：${cleanError(err)}`, 'status error');
    }
  }

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
    loadComments(item.id);
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
