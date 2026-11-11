# Settings — in-app editors

Developer reference for the settings dialogs (menu 「設定」). Rules that apply to all settings (two files, no new config file, env var wins) are in `CLAUDE.md` → *Local settings & data*. End-user instructions are in `user-guide.md`.

## Shared helpers (`main/services/appConfig.js`)

- `readConfig()` / `updateConfig(mutate)` — whole `config.json` (serialized queue, atomic write, other sections preserved).
- `readSection(name)` / `updateSection(name, mutate)` — one section; `mutate` gets a shallow copy (`{}` when missing) and may modify it or return a new object. Use these in new services.
- `str(v)`, `isObj(v)`, `assertSingleLine(value, label)` — the value helpers every settings service uses; don't redefine them locally.
- `.env`: `loadEnvSettings` / `saveEnvSettings` (dialog), `readEnvFile`, `writeEnvKeys(values)` (empty value = line removed; other lines and comments kept).

Common save rules (all dialogs):
- Everything is validated first; nothing is written if any field is invalid.
- An empty optional field removes the key, so the script's default applies.
- Fields the dialog doesn't manage (added by hand) are kept.

## Dialogs

Every settings dialog uses `renderer/js/form-dialog.js`: `bindFormDialog({ dialog, prefix, reset, load, validate, save, … })` wires open → load → enable 「儲存」, submit → validate → save → close, and blocks closing while saving; `textInput` / `secretInput` / `inputBox` / `fieldRow` build the fields. HTML ids follow `<prefix>-form / -ok / -cancel / -close / -error`. A new settings dialog only writes its fields, `load` and `save`.

| Menu item | Edits | Renderer → service |
|---|---|---|
| 連線與機密設定… | `data/.env` | `env-settings-dialog.js` → `appConfig.loadEnvSettings` / `saveEnvSettings` |
| Repository 設定… | `config.json` `repos` | `repo-settings-dialog.js` → `repoConfig.loadRepoSettings` / `saveRepoSettings` |
| UpAgent 連線設定… | `upagentConnection` | `upagent-connection-settings-dialog.js` → `upagentConnection.loadConnectionSettings` / `saveConnectionSettings` |
| UpAgent 發佈資料庫設定… | `upagentRelease.db.*` + `UPAGENT_DB_*_PASSWORD` in `.env` | `upagent-release-db-dialog.js` → `upagentReleaseDb.loadReleaseDbSettings` / `saveReleaseDbSettings` |
| 正式環境排程重啟設定… | `prodRestart` | `prod-restart-settings-dialog.js` → `prodRestart.loadSettings` / `saveSettings` |

### 連線與機密設定（`.env`）
- Only keys listed in `ENV_GROUPS` (`appConfig.js`) are shown — **a new `.env` key must be added there**.
- Empty = the line is removed; other lines and comments are kept.
- A field whose same-named environment variable is set shows that the script will use the env var (`envOverride`).

### Repository 設定（`repos`）
- Rows are matched back to the stored objects by their original key (`origKey`), so extra fields are kept.
- Renaming a key also renames it in `localDeploy.repos`, `prodRestart.repos`, `customerDeploy.*.*.repos` (`renameRepoKeys`); flow-state records are **not** renamed.

### UpAgent 連線設定（`upagentConnection`）
- Also reachable from the switch dialog's 「編輯設定…」.
- Config file paths are chosen only with a file picker; `pickConfigFile` folds the user folders back to `%APPDATA%` / `%LOCALAPPDATA%` / `%USERPROFILE%` so the setting still works on another machine / account.
- `configFile` is stored as a string when there is one path, an array when there are several.
- Activation codes are not secrets and stay in `config.json`; codes for keys not in `UPAGENT_CONNECTIONS` are kept.

### UpAgent 發佈資料庫設定（`upagentRelease.db.<test|prod>_<saas|local>`）
- Connection fields go to `config.json`; the password goes to `.env` as `UPAGENT_DB_<代號>_PASSWORD`.
- Empty field = key removed so the script default applies (`psql` on PATH, port 5432, sslmode `require`); `host` / `dbname` / `user` have no default and are required at release time.
- Other `upagentRelease` fields (storage / github / codesign) are kept.

### 正式環境排程重啟設定（`prodRestart`）
- Also reachable from the restart dialog's 「設定…」.
- Empty optional field = key removed so the script default applies.
- Per-repo checkbox = the repo is in `prodRestart.repos` (unchecked = removed).
- The per-repo columns are the `{field}` placeholders used in `runbookParameters` (`runbookParamFields` in `shared/flow-rules.js`); all are required for checked repos. Unknown fields are kept.

## No UI yet (edit `config.json` by hand)

- `localDeploy` — Local (on-prem) deploy per repo / environment.
- `customerDeploy` — 手動佈版's 客戶環境 builds.
- The rest of `upagentRelease` — storage / github / codesign.

## Legacy files

`script/.env`, `data/repos.json`, `data/upagent_release.config` are converted by `migrateLegacyConfig()` at startup (originals renamed to `*.bak`) and by `applyLegacy` when importing an old zip. The old INI is parsed by hand on purpose: npm `ini` treats `#` / `;` in values as comments and would truncate passwords.
