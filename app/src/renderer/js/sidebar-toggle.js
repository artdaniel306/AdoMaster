import { $ } from './dom.js';

const STORAGE_KEY = 'sidebarCollapsed';

/** 側欄收合 / 展開；狀態記在 localStorage，支援 Ctrl+B 快捷鍵 */
export function initSidebarToggle() {
  const sidebar = $('sidebar');
  const btn = $('side-toggle');

  function apply(collapsed) {
    sidebar.classList.toggle('collapsed', collapsed);
    btn.textContent = collapsed ? '»' : '«';
    btn.title = collapsed ? '展開側欄 (Ctrl+B)' : '收合側欄 (Ctrl+B)';
    btn.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); } catch { /* 忽略 */ }
  }

  const toggle = () => apply(!sidebar.classList.contains('collapsed'));

  let initial = false;
  try { initial = localStorage.getItem(STORAGE_KEY) === '1'; } catch { /* 忽略 */ }
  apply(initial);

  btn.addEventListener('click', toggle);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggle();
    }
  });
}
