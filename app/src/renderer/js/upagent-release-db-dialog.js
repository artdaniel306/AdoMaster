import { api, cleanError } from './api.js';
import { $, el } from './dom.js';
import { bindFormDialog, envOverrideWarn, fieldRow as field, inputBox, secretInput, textInput as baseInput } from './form-dialog.js';

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
  const fileEl = $('urd-file');
  const dbsEl = $('urd-dbs');

  let rows = []; // [{ key, label, inputs: { psql, host, port, dbname, user, sslmode, password } }]

  const textInput = (value, placeholder = '') => baseInput(value, { placeholder });

  function dbSection(db, s) {
    const inputs = {
      host: textInput(db.host, 'xxx.postgres.database.azure.com'),
      port: textInput(db.port, String(s.defaults.port)),
      dbname: textInput(db.dbname),
      user: textInput(db.user),
      psql: textInput(db.psql, `${s.defaults.psql}（PATH 上的 psql）`),
      sslmode: el('select', 'urd-select'),
    };
    inputs.port.inputMode = 'numeric';
    const pw = secretInput(db.password);
    inputs.password = pw.input;

    inputs.sslmode.append(new Option(`（預設 ${s.defaults.sslmode}）`, ''), ...s.sslModes.map((m) => new Option(m, m)));
    // config.json 裡手動填了不在清單中的值：保留顯示，儲存時由 main 回報錯誤
    if (db.sslmode && !s.sslModes.includes(db.sslmode)) inputs.sslmode.append(new Option(db.sslmode, db.sslmode));
    inputs.sslmode.value = db.sslmode;

    const choose = el('button', 'btn-ghost', '選擇…');
    choose.type = 'button';
    choose.addEventListener('click', async () => {
      if (isBusy()) return;
      showError('');
      try {
        const picked = await api.pickPsql(inputs.psql.value.trim());
        if (picked) inputs.psql.value = picked;
      } catch (err) {
        showError(`選擇檔案失敗：${cleanError(err)}`);
      }
    });
    const psqlBox = inputBox(inputs.psql, choose);

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
      field('密碼', pw.box, { required: true, keyText: db.passwordKey, warn: db.envOverride ? envOverrideWarn(db.passwordKey) : '' }),
      field('SSL mode', inputs.sslmode, { keyText: 'sslmode' }),
      field('psql', psqlBox, { cls: 'urd-wide' }),
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

  const { open, showError, isBusy } = bindFormDialog({
    dialog,
    prefix: 'urd',
    reset() {
      rows = [];
      fileEl.textContent = '';
      dbsEl.replaceChildren(el('span', 'muted', '讀取設定中…'));
    },
    load: async () => render(await api.loadUpagentReleaseDbSettings()),
    loadFailed: () => dbsEl.replaceChildren(),
    focus: () => rows[0]?.inputs.host,
    validate() {
      const bad = rows.find(({ inputs }) => {
        const v = inputs.port.value.trim();
        return v && !(/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535);
      });
      return bad ? { message: `${bad.label} 的 Port 必須是 1 ~ 65535 的整數`, focus: bad.inputs.port } : null;
    },
    save() {
      const dbs = Object.fromEntries(
        rows.map(({ key, inputs }) => [key, Object.fromEntries(Object.entries(inputs).map(([f, input]) => [f, input.value.trim()]))]),
      );
      return api.saveUpagentReleaseDbSettings(dbs);
    },
  });

  api.onUpagentReleaseDbSettingsMenu(() => open());
  instance = { open };
  return instance;
}
