import { api, cleanError } from './api.js';

/**
 * 使用手冊視窗：內容是 main 用 marked 把 docs/user-guide.md 轉好的 HTML（標題已帶 id），
 * 這裡只負責放進頁面、依 h2 / h3 產生左側目錄，並標示目前捲到的章節。
 */
const docEl = document.getElementById('doc');
const tocEl = document.getElementById('toc');

function buildToc() {
  const heads = [...docEl.querySelectorAll('h2[id], h3[id]')];
  const links = heads.map((h) => {
    const a = document.createElement('a');
    a.href = `#${h.id}`;
    a.textContent = h.textContent;
    a.className = h.tagName === 'H3' ? 'lv3' : 'lv2';
    return a;
  });
  tocEl.replaceChildren(...links);

  // 捲動時把最後一個已捲過頂端的標題標成 active
  const update = () => {
    const top = docEl.getBoundingClientRect().top + 8;
    let current = 0;
    heads.forEach((h, i) => {
      if (h.getBoundingClientRect().top <= top) current = i;
    });
    links.forEach((a, i) => a.classList.toggle('active', i === current));
  };
  docEl.addEventListener('scroll', update, { passive: true });
  update();
}

async function load() {
  try {
    const { html } = await api.loadUserGuide();
    docEl.innerHTML = html; // 來源是隨 app 發佈的 docs/user-guide.md，不是外部輸入
    buildToc();
    const h1 = docEl.querySelector('h1');
    if (h1) document.title = h1.textContent;
  } catch (err) {
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = `讀取使用手冊失敗：${cleanError(err)}`;
    docEl.replaceChildren(p);
  }
}

// 外部連結交給系統瀏覽器（main 的 setWindowOpenHandler / will-navigate 也會擋下站內導覽）
docEl.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (href.startsWith('#')) return;
  e.preventDefault();
  if (/^https:\/\//i.test(href)) api.openExternal(href);
});

load();
