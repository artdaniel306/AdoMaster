import { api, cleanError } from './api.js';
import { $, el } from './dom.js';
import { bindFormDialog, fieldRow, textInput } from './form-dialog.js';

/**
 * 選單「設定 → UpAgent 連線設定…」：在 App 內編輯 config.json 的 upagentConnection
 * （切換連線時要刪除的 UpAgent 設定檔路徑 + 各環境的 Activation Code）。
 * 設定檔路徑只能用檔案選擇器選（不能手動輸入）；main 會把使用者資料夾換回 %APPDATA% 等，匯出 / 匯入到別台電腦仍有效。
 * 讀寫都在 main（services/upagentConnection.js 的 loadConnectionSettings / saveConnectionSettings / pickConfigFile）；
 * 「設定 UpAgent 連線」dialog 也可以從這裡開啟後再重新讀取。
 */
let instance = null;

export function initUpagentConnectionSettings() {
  if (instance) return instance;

  const dialog = $('upagent-conn-settings-dialog');
  const fileEl = $('ucs-file');
  const pathsEl = $('ucs-paths');
  const addBtn = $('ucs-add');
  const codesEl = $('ucs-codes');

  let codeInputs = []; // [{ key, input }]
  let paths = []; // 設定檔路徑（可含 %VAR%）

  /** 開啟檔案選擇器；index = 要取代的那一列（省略 = 新增）。多選時第一個取代、其餘加在後面 */
  async function pick(index) {
    if (isBusy()) return;
    showError('');
    try {
      const picked = await api.pickUpagentConfigFile(paths[index] ?? paths[0] ?? '');
      if (!picked) return;
      const next = [...paths];
      if (index == null) next.push(...picked);
      else next.splice(index, 1, ...picked);
      paths = [...new Set(next)];
      renderPaths();
    } catch (err) {
      showError(`選擇檔案失敗：${cleanError(err)}`);
    }
  }

  function renderPaths() {
    if (!paths.length) {
      pathsEl.replaceChildren(el('span', 'muted', '尚未選擇檔案'));
      return;
    }
    pathsEl.replaceChildren(
      ...paths.map((p, i) => {
        const input = textInput(p);
        input.readOnly = true;
        input.tabIndex = -1;
        input.title = p;
        const choose = el('button', 'btn-ghost', '選擇…');
        choose.type = 'button';
        choose.addEventListener('click', () => pick(i));
        const del = el('button', 'btn-icon rs-del', '🗑');
        del.type = 'button';
        del.title = '移除';
        del.addEventListener('click', () => {
          paths.splice(i, 1);
          showError('');
          renderPaths();
        });
        const row = el('div', 'ucs-path-row');
        row.append(input, choose, del);
        return row;
      }),
    );
  }

  function codeRow(t) {
    const input = textInput(t.code);
    codeInputs.push({ key: t.key, input });
    return fieldRow(t.label, input, { keyText: t.key });
  }

  function render(s) {
    fileEl.textContent = s.exists ? '' : `${s.file} 尚未設定 upagentConnection，儲存後會自動建立。`;
    fileEl.hidden = s.exists;
    // 尚未設定時先帶入預設路徑（檔案不存在也可以，切換時會略過）
    paths = s.configFile.length ? [...s.configFile] : [s.defaultConfigFile];
    renderPaths();
    codeInputs = [];
    codesEl.replaceChildren(...s.targets.map(codeRow));
  }

  const { open, showError, isBusy } = bindFormDialog({
    dialog,
    prefix: 'ucs',
    reset() {
      codeInputs = [];
      paths = [];
      fileEl.textContent = '';
      pathsEl.replaceChildren();
      codesEl.replaceChildren(el('span', 'muted', '讀取設定中…'));
    },
    load: async () => render(await api.loadUpagentConnectionSettings()),
    loadFailed: () => codesEl.replaceChildren(),
    focus: () => codeInputs[0]?.input,
    validate: () => (paths.length ? null : { message: '請至少選擇一個 UpAgent 設定檔', focus: addBtn }),
    save: () => api.saveUpagentConnectionSettings([...paths], Object.fromEntries(codeInputs.map(({ key, input }) => [key, input.value.trim()]))),
  });

  addBtn.addEventListener('click', () => pick());

  api.onUpagentConnectionSettingsMenu(() => open());
  instance = { open };
  return instance;
}
