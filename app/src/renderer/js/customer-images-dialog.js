import { api, cleanError } from './api.js';
import { $, el, errorSetter } from './dom.js';
import { loadRepos, repoTag } from './repos.js';
import { TARGET_LABEL } from '../../shared/flow-rules.js';

/** ISO 時間 → 本地時間 yyyy/MM/dd HH:mm */
const formatDate = (iso) => {
  const d = new Date(iso);
  return !iso || Number.isNaN(d.getTime())
    ? iso || ''
    : d.toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const formatSize = (bytes) => `${(bytes / 1024 / 1024).toLocaleString('zh-TW', { maximumFractionDigits: 0 })} MB`;

/**
 * 選單「版本控制 → 查看客戶發佈版本…」：選客戶，列出客戶環境 build 過的 image tar（main/services/customerImages.js）：
 * build 時間（tar 檔的修改時間）、由檔名推測的 commit 與該 commit 的 commit 時間 / 作者 / 標題；可在檔案總管中顯示 tar。
 * 客戶選單的值為 "<saas|local>/<客戶 key>"，最後選的客戶記在 localStorage（customerImages.customer）。
 */
export function createCustomerImagesDialog() {
  const dialog = $('customer-images-dialog');
  const customerEl = $('ci-customer');
  const bodyEl = $('ci-rows');
  const emptyEl = $('ci-empty');
  const showError = errorSetter($('ci-error'));
  const STORAGE_KEY = 'customerImages.customer';
  let seq = 0;

  const selected = () => {
    const [target, customer] = customerEl.value.split('/');
    return customer ? { target, customer } : null;
  };

  async function loadCustomers() {
    const list = await api.customerImageCustomers();
    let remembered = '';
    try {
      remembered = localStorage.getItem(STORAGE_KEY) || '';
    } catch {
      // 只影響預設選項
    }
    const current = customerEl.value || remembered;
    const groups = Object.entries(TARGET_LABEL)
      .filter(([target]) => list[target]?.length)
      .map(([target, label]) => {
        const g = document.createElement('optgroup');
        g.label = label;
        g.append(
          ...list[target].map((c) => {
            const text = `${c.label === c.key ? c.key : `${c.label}（${c.key}）`}${c.configured ? '' : '（已不在設定中）'}`;
            return new Option(text, `${target}/${c.key}`);
          }),
        );
        return g;
      });
    customerEl.replaceChildren(...groups);
    if (!groups.length) customerEl.append(new Option('（沒有客戶）', ''));
    if ([...customerEl.options].some((o) => o.value === current)) customerEl.value = current;
  }

  function commitCell(img) {
    const td = el('td');
    if (!img.commit) {
      td.append(el('span', 'muted', '無法由檔名判斷'));
      return td;
    }
    const info = img.commitInfo;
    const head = el('div', 'nowrap');
    const hash = el('span', 'ci-mono', img.commit);
    hash.title = info?.full || '';
    head.append(hash);
    if (info?.author) head.append(` · ${info.author}`);
    td.append(head);
    if (info) {
      const subject = el('div', 'muted ci-subject', info.subject);
      subject.title = info.subject;
      td.append(subject);
    } else td.append(el('div', 'muted', '本機 clone 找不到此 commit'));
    return td;
  }

  function imageRow(img, sel) {
    const tr = el('tr');
    const repo = el('td');
    repo.append(repoTag(img.repo));
    const image = el('td');
    const name = el('div', 'ci-mono', img.file);
    name.title = img.envHash ? `env 雜湊 ${img.envHash}` : '';
    image.append(name, el('div', 'muted', formatSize(img.size)));
    const commitAt = el('td', 'nowrap', img.commitInfo ? formatDate(img.commitInfo.date) : '');
    if (img.commitInfo?.authorDate && img.commitInfo.authorDate !== img.commitInfo.date) commitAt.title = `作者時間 ${formatDate(img.commitInfo.authorDate)}`;
    const action = el('td', 'nowrap');
    const btn = el('button', 'btn-ghost', '顯示檔案');
    btn.type = 'button';
    btn.title = '在檔案總管中顯示';
    btn.addEventListener('click', async () => {
      try {
        await api.revealCustomerImage(sel.target, sel.customer, img.repo, img.file);
      } catch (err) {
        showError(cleanError(err));
      }
    });
    action.append(btn);
    tr.append(repo, image, el('td', 'nowrap', formatDate(img.builtAt)), commitCell(img), commitAt, action);
    return tr;
  }

  async function loadImages() {
    const my = ++seq;
    const sel = selected();
    showError('');
    bodyEl.replaceChildren();
    emptyEl.hidden = false;
    if (!sel) {
      emptyEl.textContent = '沒有客戶';
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, customerEl.value);
    } catch {
      // 只影響下次的預設選項
    }
    emptyEl.textContent = '載入中…';
    try {
      const { images } = await api.customerImages(sel.target, sel.customer);
      if (my !== seq) return;
      bodyEl.replaceChildren(...images.map((img) => imageRow(img, sel)));
      emptyEl.textContent = '沒有 image';
      emptyEl.hidden = images.length > 0;
    } catch (err) {
      if (my !== seq) return;
      emptyEl.hidden = true;
      showError(cleanError(err));
    }
  }

  async function open() {
    if (!dialog.open) dialog.showModal();
    showError('');
    try {
      await loadRepos(); // repository 標籤的顏色
    } catch {
      // 只影響顏色
    }
    try {
      await loadCustomers();
    } catch (err) {
      showError(cleanError(err));
      return;
    }
    loadImages();
  }

  const close = () => dialog.close();
  customerEl.addEventListener('change', loadImages);
  $('ci-reload').addEventListener('click', open);
  $('ci-close').addEventListener('click', close);
  $('ci-ok').addEventListener('click', close);

  return { open };
}
