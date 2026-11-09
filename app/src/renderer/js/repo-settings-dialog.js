import { api, cleanError } from './api.js';
import { $, el } from './dom.js';
import { setRepoConfig } from './repos.js';

/**
 * 選單「設定 → Repository 設定…」：在 App 內編輯 data/config.json 的 repos。
 * 讀寫在 main（services/repoConfig.js 的 loadRepoSettings / saveRepoSettings），資料夾用原生選擇視窗（repos:pickFolder）。
 * 顏色用 <input type="color">（只接受 #rrggbb），既有的其他 CSS 顏色寫法若沒動過會原樣保留。
 * @param onSaved 儲存成功後呼叫（例如重繪流程表的 repository 名稱 / 顏色）
 */
export function initRepoSettings({ onSaved } = {}) {
  const dialog = $('repo-settings-dialog');
  const form = $('rs-form');
  const listEl = $('rs-repos');
  const errorEl = $('rs-error');
  const okBtn = $('rs-ok');
  const DEFAULT_COLOR = '#2f6feb';

  let rows = []; // [{ box, origKey, get: () => repo }]
  let busy = false;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  /** 任何 CSS 顏色 → #rrggbb（canvas 會把不透明色正規化成 hex；無法轉換時回傳 null） */
  function toHex(color) {
    if (!color) return null;
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.fillStyle = '#000001';
    ctx.fillStyle = color;
    return /^#[0-9a-f]{6}$/i.test(ctx.fillStyle) && ctx.fillStyle !== '#000001' ? ctx.fillStyle : null;
  }

  function input(value, placeholder, cls = '') {
    const i = el('input', cls);
    i.type = 'text';
    i.value = value || '';
    if (placeholder) i.placeholder = placeholder;
    i.spellcheck = false;
    return i;
  }

  function field(label, control, hint) {
    const wrap = el('label', 'rs-field');
    wrap.append(el('span', 'rs-label', label), control);
    if (hint) wrap.append(el('span', 'muted', hint));
    return wrap;
  }

  function repoRow(repo = {}) {
    const box = el('section', 'rs-repo');
    const origKey = repo.origKey || '';

    // 代表色：hasColor = false 代表不設定（存成空字串）
    const origColor = repo.color || '';
    let hasColor = !!origColor;
    let colorTouched = false;
    const color = el('input', 'rs-color');
    color.type = 'color';
    color.value = toHex(origColor) || DEFAULT_COLOR;
    color.title = '代表色';
    const clearColor = el('button', 'btn-icon rs-color-clear', '⊘');
    clearColor.type = 'button';
    clearColor.title = '不設定代表色';
    const syncColor = () => {
      color.classList.toggle('no-color', !hasColor);
      clearColor.hidden = !hasColor;
    };
    color.addEventListener('input', () => {
      hasColor = true;
      colorTouched = true;
      syncColor();
    });
    clearColor.addEventListener('click', () => {
      hasColor = false;
      colorTouched = true;
      syncColor();
    });
    syncColor();

    const key = input(repo.key, 'key（必填，英數字與 _ . -）', 'rs-key');
    const label = input(repo.label, '顯示名稱（預設 = key）');
    const keyWarn = el('p', 'rs-warn', `⚠ 改 key 會讓既有流程紀錄中的「${origKey}」對不上`);
    keyWarn.hidden = true;
    key.addEventListener('input', () => {
      keyWarn.hidden = !origKey || key.value.trim() === origKey;
      showError('');
    });

    const up = el('button', 'btn-icon', '↑');
    const down = el('button', 'btn-icon', '↓');
    const del = el('button', 'btn-icon rs-del', '🗑');
    up.title = '上移';
    down.title = '下移';
    del.title = '刪除這個 repository';
    for (const b of [up, down, del]) b.type = 'button';
    up.addEventListener('click', () => move(row, -1));
    down.addEventListener('click', () => move(row, 1));
    del.addEventListener('click', () => {
      rows = rows.filter((r) => r !== row);
      box.remove();
      renderEmpty();
    });

    const head = el('div', 'rs-head');
    const colorBox = el('span', 'rs-color-box');
    colorBox.append(color, clearColor);
    head.append(colorBox, key, label, up, down, del);

    // 本機路徑：可直接輸入，或按「選擇…」開資料夾選擇視窗
    const pathInput = input(repo.path, 'C:\\source\\repo');
    const pick = el('button', 'btn-ghost', '選擇…');
    pick.type = 'button';
    pick.addEventListener('click', async () => {
      try {
        const dir = await api.pickRepoFolder(pathInput.value.trim());
        if (dir) pathInput.value = dir;
      } catch (err) {
        showError(`選擇資料夾失敗：${cleanError(err)}`);
      }
    });
    const pathBox = el('div', 'rs-path');
    pathBox.append(pathInput, pick);

    const branches = el('textarea', 'rs-branches');
    branches.rows = 3;
    branches.spellcheck = false;
    branches.placeholder = 'feature/xxx\nfeature/yyy';
    branches.value = (repo.branches || []).join('\n');

    const testBranch = input(repo.testBranch, 'test');
    const prodBranch = input(repo.prodBranch, 'master');
    const testPipeline = input(repo.testPipeline, '空白 = 沒有自動佈版');
    const prodPipeline = input(repo.prodPipeline, '空白 = 沒有自動佈版');
    const testAppService = input(repo.testAppService, '空白 = 不重啟');
    const testResourceGroup = input(repo.testResourceGroup, '空白 = 自動查詢');

    const grid = el('div', 'rs-grid');
    grid.append(
      field('本機資料夾', pathBox, 'Confirm Commit 檢查 commit、merge / push 用的本機 clone'),
      field('Feature branches', branches, '規劃 時可選的 branch，一行一個'),
      field('測試環境 branch', testBranch),
      field('正式環境 branch', prodBranch),
      field('測試環境 Pipeline', testPipeline, '可寫「資料夾\\名稱」'),
      field('正式環境 Pipeline', prodPipeline, '可寫「資料夾\\名稱」'),
      field('測試環境 App Service', testAppService, '測試環境 Pipeline Run 成功後重啟（需先 az login）；正式環境不會重啟'),
      field('測試環境 Resource Group', testResourceGroup, 'App Service 所在的 Resource Group'),
    );

    box.append(head, keyWarn, grid);

    const row = {
      box,
      key,
      get: () => ({
        origKey,
        key: key.value.trim(),
        label: label.value.trim(),
        color: !hasColor ? '' : colorTouched ? color.value : origColor,
        path: pathInput.value.trim(),
        branches: branches.value.split(/[\r\n,]/).map((b) => b.trim()).filter(Boolean),
        testBranch: testBranch.value.trim(),
        prodBranch: prodBranch.value.trim(),
        testPipeline: testPipeline.value.trim(),
        prodPipeline: prodPipeline.value.trim(),
        testAppService: testAppService.value.trim(),
        testResourceGroup: testResourceGroup.value.trim(),
      }),
    };
    return row;
  }

  function move(row, delta) {
    const i = rows.indexOf(row);
    const j = i + delta;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    listEl.replaceChildren(...rows.map((r) => r.box));
  }

  function renderEmpty() {
    if (!rows.length) listEl.replaceChildren(el('p', 'muted', '尚未設定任何 repository，按「＋ 新增 repository」開始。'));
  }

  function addRow(repo) {
    if (!rows.length) listEl.replaceChildren();
    const row = repoRow(repo);
    rows.push(row);
    listEl.append(row.box);
    return row;
  }

  function validate(repos) {
    const seen = new Set();
    for (const [i, r] of repos.entries()) {
      const name = r.key || `第 ${i + 1} 個`;
      if (!/^[A-Za-z0-9_.-]+$/.test(r.key)) return [i, `${name} 的 key 不正確（必填，只能用英數字與 _ . -）`];
      if (seen.has(r.key)) return [i, `key 重複：${r.key}`];
      seen.add(r.key);
    }
    return null;
  }

  $('rs-add').addEventListener('click', () => {
    const row = addRow({ testBranch: 'test', prodBranch: 'master' });
    row.box.scrollIntoView({ block: 'nearest' });
    row.key.focus();
  });
  $('rs-cancel').addEventListener('click', () => dialog.close());
  $('rs-close').addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const repos = rows.map((r) => r.get());
    const bad = validate(repos);
    if (bad) {
      showError(bad[1]);
      rows[bad[0]].key.focus();
      return;
    }
    busy = true;
    okBtn.disabled = true;
    try {
      const config = await api.saveRepoSettings(repos);
      setRepoConfig(config);
      dialog.close();
      onSaved?.(config);
    } catch (err) {
      showError(`儲存失敗：${cleanError(err)}`);
    } finally {
      busy = false;
      okBtn.disabled = false;
    }
  });

  async function open() {
    if (dialog.open) return;
    rows = [];
    showError('');
    listEl.replaceChildren(el('span', 'muted', '讀取 data/config.json 的 repos 中…'));
    okBtn.disabled = true;
    dialog.showModal();
    try {
      const { repos } = await api.loadRepoSettings();
      listEl.replaceChildren();
      for (const r of repos) addRow(r);
      renderEmpty();
      okBtn.disabled = false;
    } catch (err) {
      listEl.replaceChildren();
      showError(`讀取設定失敗：${cleanError(err)}（請先修正 data/config.json 的 repos）`);
    }
  }

  api.onRepoSettingsMenu(open);
  return { open };
}
