# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

AdoMaster is an Azure DevOps (ADO) Iteration / Work Item viewer plus a Requirement release-flow board. Layers:

- `script/` — Python CLI scripts that call the ADO REST API (**standard library only**, no pip dependencies).
- `app/` — Electron desktop UI; runs the Python scripts via `main/python.js` and PowerShell scripts in `shell/` via `main/powershell.js`.
- `shell/` — PowerShell scripts run by the app (conventions in `shell/CLAUDE.md`).
- `docs/` — `user-guide.md` (end-user manual, shown in-app via 「說明 → 使用手冊」/ F1), `requirement-flow.md` (detailed flow spec — **read it before touching the flow**), `flow.pptx` (original flow design), `reference/` (scripts copied from other projects; reference only, never called by the app).
- `feature/restore_workitem/` — standalone older scripts (recycle-bin listing / restore) that do **not** use the `ado` package and read their own `.env` in that folder.

Code comments, docstrings, CLI messages, and UI strings are written in Traditional Chinese; keep that convention.

**Prefer existing packages over home-grown systems.** Before implementing a feature, check whether something existing fits: built-ins / standard library, a well-known npm package (for `app/`), an existing tool's CLI (e.g. `git`), or code already in this repo. Only build your own when nothing fits — and say why. `script/` is stdlib-only, so there "existing" means stdlib. **A failed or denied package install is not a reason to abandon the package** — ask the user to install it (e.g. `! cd app && npm install <pkg>`).

**Communication:** The user prefers Traditional Chinese (繁體中文) — reply in Chinese.

## Commands

```bash
# Configure (required before anything works)
cp templates/env_example.txt data/.env              # connection identity + secrets (AZDO_*, GITHUB_TOKEN, DB passwords…)
cp templates/config_example.json data/config.json   # structured, non-secret settings (repos, upagentRelease…)

# Python scripts (run from script/ so the `ado` package is importable)
cd script
python get_iterations.py                                   # writes data/iterations.{csv,json}, data/iterations_tree.json
python get_iteration_work_items.py --iteration "Proj\\Sprint 1" [--exact] [--out path.json]
python get_requirement_flow.py --iteration "Proj\\Sprint 1" [--exact] [--type Requirement] [--out path.json]
python create_task.py --parent 12345 [--description "..." | --description-file f.txt] [--out task.json]
python update_state.py --id 12345 --state Active [--out item.json]
python get_pipeline_runs.py --pipeline "Folder\name" [--top 30] [--out runs.json]   # needs PAT Build (Read)
python get_tasks.py [ids/ranges] [--type Bug] [--state Active] [--assigned-to @Me] [--iteration ...] [--json]

# Electron app
cd app && npm install && npm start    # set PYTHON / POWERSHELL env vars to override the executables
cd app && npm run dist                 # Windows installer → app/dist/AdoMaster-Setup-<version>.exe (electron-builder; `npm run pack` = unpacked folder only)
```

There is no test suite, linter, or build step. Verify JS syntax with `node --check` (main, CommonJS) or `node --input-type=module --check < file.js` (renderer / shared, ESM).

## Architecture

### Python (`script/`)
- Entry points only parse args and write output; all logic lives in the `ado/` package (`config`, `client`, `work_items`, `iterations`, `pipelines`, `output`, `cli`). Raise `AdoError` for user-facing failures; `cli.run(main)` prints it to stderr with exit 1.
- `config.py` reads `data/.env` (legacy fallback `script/.env`); environment variables override the file.
- `client.py`: PAT Basic auth; a non-JSON response (ADO returns 203 + HTML login page for a bad PAT) is treated as an error.
- Gotcha: `workitemsbatch` without a field list does **not** return `System.Parent` — use `get_work_items(..., relations=True)` and `child_ids` / `parent_id`.
- `iterations.to_iteration_path` strips the `\Iteration\` segment so paths match `System.IterationPath`.
- Output goes to `data/` at repo root (the whole `data/` folder is gitignored).
- The data folder can be overridden with `ADOMASTER_DATA_DIR` (Python `config.DATA_DIR`, PowerShell `$dataRoot`); the app always sets it for child processes.

### Electron (`app/src/`)
- `main/` — `index.js` (window, runs `migrateLegacyConfig()`), `ipc.js` (channel → `services/*`), `python.js` (`runScriptJson(script, args)`: appends `--out <temp>`, returns parsed JSON, deletes the temp file), `powershell.js`, `paths.js`, `atomicWrite.js` (temp file + rename), `menu.js`.
- `preload/index.js` — exposes `window.api` via `contextBridge` (contextIsolation on, nodeIntegration off, sandboxed: can only `require('electron')`).
- `renderer/` — plain ES modules, no bundler/framework, strict CSP (`'self'` only, no inline scripts/styles — set dynamic styles via CSSOM / CSS variables). `api.js` wraps `window.api`; `cleanError` strips the IPC error prefix.
- `shared/flow-rules.js` — flow-state keys and pure rules shared by main (`require()` of ESM) and renderer. Change rules here, never duplicate them.
- Content area has two tabs: **Requirement 流程** (default, `requirement-flow.js`) and **Work Items** (`work-items.js`); only refetches when iteration/exact changed.
- Iteration picker (`iteration-tree.js`): sidebar shows pinned iterations; full tree in a `<dialog>`. Pins live in `localStorage` (`pinnedIterations`) keyed by iteration GUID.
- Work item links (`description-dialog.js`): click = show Description in-app; Ctrl/⌘ + click = open in browser.
- **No usage-explanation text in the UI** (instruction paragraphs, field hints, "how to" empty states): keep the UI to labels, state, warnings and errors, and document usage in `docs/user-guide.md` — update it when a feature changes. Tooltips (`title`) are fine. The manual opens in its own window (`main/helpWindow.js` → `renderer/help.html` + `js/help.js`; `main/services/userGuide.js` renders the Markdown with `marked` via `help:load`); it ships as an `extraResources` file (`resources/docs/user-guide.md`, path `USER_GUIDE_FILE` in `paths.js`).
- Notices / confirmations use the in-app `confirm-dialog.js` (`alert` mode = OK only) — not Electron's `dialog.showMessageBox`; native dialogs are only for file/folder pickers.
- **Adding a feature**: logic in `main/services/` (+ a Python script if it needs ADO, or a `shell/*.ps1`) → channel in `main/ipc.js` → method in `preload/index.js` → call via `api` in the renderer.

### Local settings & data
- **Installed build** (`app.isPackaged`, see `main/paths.js`): `script/` and `shell/` ship as electron-builder `extraResources` (outside asar) under `resources/`; data lives in `%APPDATA%\AdoMaster\data` (or `ADOMASTER_DATA_DIR`), not in the repo. Always build data paths from `paths.js`, never from `ROOT_DIR + 'data'`. Python must still be installed on the machine. Icon: `feature/build/icon.ico`.
- **Settings = exactly two files** in `data/`, owned by `main/services/appConfig.js`:
  - `data/config.json` — non-secret, **one section per feature** (`repos`, `upagentRelease`, `localDeploy`, …); Node uses `readConfig()` / `updateConfig(mutate)` (serialized, atomic, other sections preserved). Template `templates/config_example.json`.
  - `data/.env` — identity and secrets as flat `KEY=VALUE`; read by Python and PowerShell; a same-named **environment variable always wins**. Template `templates/env_example.txt`.
  - A new feature adds a section to `config.json` and/or keys to `.env` — **never a new config file**.
  - In-app editors (menu 「設定」): 「連線與機密設定…」 edits `.env` (`env-settings-dialog.js` → `appConfig.loadEnvSettings` / `saveEnvSettings`; only keys listed in `ENV_GROUPS` — **a new `.env` key must be added there**; empty = remove the line; other lines/comments kept). 「Repository 設定…」 edits `config.json` `repos`. 「UpAgent 連線設定…」 edits `upagentConnection` (`upagent-connection-settings-dialog.js` → `upagentConnection.loadConnectionSettings` / `saveConnectionSettings`; also reachable from the switch dialog's 「編輯設定…」; config file paths are chosen only with a file picker, `pickConfigFile` folds the user folders back to `%APPDATA%` / `%LOCALAPPDATA%` / `%USERPROFILE%`). 「UpAgent 發佈資料庫設定…」 edits `upagentRelease.db.<test|prod>_<saas|local>` **and** the matching `UPAGENT_DB_*_PASSWORD` in `.env` (`upagent-release-db-dialog.js` → `upagentReleaseDb.loadReleaseDbSettings` / `saveReleaseDbSettings`; empty field = key removed so the script default applies; other `upagentRelease` fields kept). `localDeploy` and the rest of `upagentRelease` (storage / github / codesign) have no UI yet (edit the file).
  - Legacy files (`script/.env`, `data/repos.json`, `data/upagent_release.config`) are converted by `migrateLegacyConfig()` (originals renamed to `*.bak`) and by `applyLegacy` on import. The old INI is parsed by hand on purpose: npm `ini` treats `#` / `;` in values as comments and would truncate passwords.
- 「檔案 → 匯出 / 匯入本地資料」(`main/services/localData.js`, `adm-zip`; renderer `local-data.js`) zips data that is neither in git nor recoverable from the API: `data/.env`, `data/config.json`, `data/requirement_flow_state.json`, `data/test_records/`, `feature/restore_workitem/.env`, plus renderer `localStorage`. Import accepts only a whitelist, validates JSON before writing, and writes flow state through `replaceFlowState`. **New local-only data must be added to `FILES` there** (settings don't need this).

### Requirement 流程
Full spec: **`docs/requirement-flow.md`**. Key invariants:
- Stages: Pending → Implement + 規劃 (`plan`) → Test deploy → Test → Prod deploy → Release recap. Manual steps are checkboxes in `data/requirement_flow_state.json`, read/written only through `main/services/flowState.js` (serialized queue).
- Only two actions write to ADO: creating the default Task and updating the Requirement state. Pipelines are only read; SaaS deploys are triggered by git push. Local (on-prem) deploys run `shell/Deploy-Local.ps1` (Docker build + ssh) from a dedicated deploy clone, never the dev clone.
- Deploy merges never touch the local working tree and never `--force` push; conflicting merges are refused.
- Prod deploy **never restarts** the App Service (customers are live); there is deliberately no `prodAppService` field.
- A repo's `key` in `repos` is what the flow state stores — renaming it orphans old records.
