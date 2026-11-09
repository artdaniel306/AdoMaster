import { api, cleanError } from './api.js';
import { $, el } from './dom.js';

/**
 * 選單「設定 → UpAgent 發佈資料庫設定…」：在 App 內編輯 UpAgent 發佈寫入 public.public_db_upagentrelease 的 4 個資料庫。
 * 連線資訊存在 config.json 的 upagentRelease.db.<代號>，密碼存在 .env 的 UPAGENT_DB_<代號>_PASSWORD。
 * 讀寫都在 main（services/upagentReleaseDb.js 的 loadReleaseDbSettings / saveReleaseDbSettings / pickPsql）；
 * 欄位留空 = 刪掉該設定（psql / port / sslmode 改用預設值）。
 */
let instance = null;

export function initUpagentReleaseDbSettings() {
  if (instance) return instance;

  const dialog = $('upagent-release-db-dialog');
  const form = $('urd-form');
  const fileEl = $('urd-file');
  const dbsEl = $('urd-dbs');
  const errorEl = $('urd-error');
  const okBtn = $('urd-ok');

  let rows = []; // [{ key, label, inputs: { psql, host, port, dbname, user, sslmode, password } }]
  let busy = false;
  let onSaved = null;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function textInput(value, placeholder = '', type = 'text') {
    const input = el('input', 'es-input');
    input.type = type;
    input.value = value || '';
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.addEventListener('input', () => showError(''));
    return input;
  }

  /** 一個欄位：標籤（* = 發佈時必填）+ 輸入元件 + 警告 */
  function field(labelText, control, { required = false, keyText = '', wide = false, warn = '' } = {}) {
    const wrap = el('label', `rs-field${wide ? ' urd-wide' : ''}`);
    const label = el('span', 'rs-label', labelText);
    if (required) label.append(el('span', 'es-required', ' *'));
    if (keyText) label.append(el('span', 'es-key', keyText));
    wrap.append(label, control);
    if (warn) wrap.append(el('span', 'rs-warn', warn));
    return wrap;
  }

  function dbSection(db, s) {
    const inputs = {
      host: textInput(db.host, 'xxx.postgres.database.azure.com'),
      port: textInput(db.port, String(s.defaults.port)),
      dbname: textInput(db.dbname),
      user: textInput(db.user),
      password: textInput(db.password, '', 'password'),
      psql: textInput(db.psql, `${s.defaults.psql}（PATH 上的 psql）`),
      sslmode: el('select', 'urd-select'),
    };
    inputs.port.inputMode = 'numeric';

    inputs.sslmode.append(new Option(`（預設 ${s.defaults.sslmode}）`, ''), ...s.sslModes.map((m) => new Option(m, m)));
    // config.json 裡手動填了不在清單中的值：保留顯示，儲存時由 main 回報錯誤
    if (db.sslmode && !s.sslModes.includes(db.sslmode)) inputs.sslmode.append(new Option(db.sslmode, db.sslmode));
    inputs.sslmode.value = db.sslmode;
    inputs.sslmode.addEventListener('change', () => showError(''));

    const pwBox = el('div', 'es-input-box');
    const eye = el('button', 'btn-icon', '👁');
    eye.type = 'button';
    eye.title = '顯示 / 隱藏';
    eye.addEventListener('click', () => {
      inputs.password.type = inputs.password.type === 'password' ? 'text' : 'password';
    });
    pwBox.append(inputs.password, eye);

    const psqlBox = el('div', 'es-input-box');
    const choose = el('button', 'btn-ghost', '選擇…');
    choose.type = 'button';
    choose.addEventListener('click', async () => {
      if (busy) return;
      showError('');
      try {
        const picked = await api.pickPsql(inputs.psql.value.trim());
        if (picked) inputs.psql.value = picked;
      } catch (err) {
        showError(`選擇檔案失敗：${cleanError(err)}`);
      }
    });
    psqlBox.append(inputs.psql, choose);

    const sec = el('section', 'rs-repo');
    const title = el('h4', 'es-title', db.label);
    title.append(el('span', 'es-key', db.key));
    sec.append(title);
    const grid = el('div', 'es-grid');
    grid.append(
      field('Host', inputs.host, { required: true }),
      field('Port', inputs.port),
      field('Database', inputs.dbname, { required: true, keyText: 'dbname' }),
      field('User', inputs.user, { required: true }),
      field('密碼', pwBox, {
        required: true,
        keyText: db.passwordKey,
        warn: db.envOverride ? `⚠ 已設定同名環境變數 ${db.passwordKey}，腳本會優先使用環境變數，這裡的值不會生效` : '',
      }),
      field('SSL mode', inputs.sslmode, { keyText: 'sslmode' }),
      field('psql', psqlBox, { wide: true }),
    );
    sec.append(grid);
    rows.push({ key: db.key, label: db.label, inputs });
    return sec;
  }

  function render(s) {
    rows = [];
    fileEl.textContent = s.exists ? '' : `${s.file} 尚未設定 upagentRelease，儲存後會自動建立（其他欄位使用預設值）。`;
    fileEl.hidden = s.exists;
    dbsEl.replaceChildren(...s.dbs.map((db) => dbSection(db, s)));
  }

  $('urd-cancel').addEventListener('click', () => dialog.close());
  $('urd-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (e) => {
    if (busy) e.preventDefault();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const bad = rows.find(({ inputs }) => {
      const v = inputs.port.value.trim();
      return v && !(/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535);
    });
    if (bad) {
      showError(`${bad.label} 的 Port 必須是 1 ~ 65535 的整數`);
      bad.inputs.port.focus();
      return;
    }
    const dbs = Object.fromEntries(
      rows.map(({ key, inputs }) => [key, Object.fromEntries(Object.entries(inputs).map(([f, input]) => [f, input.value.trim()]))]),
    );
    busy = true;
    okBtn.disabled = true;
    try {
      await api.saveUpagentReleaseDbSettings(dbs);
      dialog.close();
      onSaved?.();
    } catch (err) {
      showError(`儲存失敗：${cleanError(err)}`);
    } finally {
      busy = false;
      okBtn.disabled = false;
    }
  });

  /** @param savedFn 儲存成功後呼叫（例如讓「UpAgent 發佈」dialog 重新檢查設定） */
  async function open(savedFn = null) {
    if (dialog.open) return;
    onSaved = savedFn;
    rows = [];
    showError('');
    fileEl.textContent = '';
    dbsEl.replaceChildren(el('span', 'muted', '讀取設定中…'));
    okBtn.disabled = true;
    dialog.showModal();
    try {
      render(await api.loadUpagentReleaseDbSettings());
      okBtn.disabled = false;
      rows[0]?.inputs.host.focus();
    } catch (err) {
      dbsEl.replaceChildren();
      showError(`讀取設定失敗：${cleanError(err)}`);
    }
  }

  api.onUpagentReleaseDbSettingsMenu(() => open());
  instance = { open };
  return instance;
}
