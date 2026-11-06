# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

AdoMaster is an Azure DevOps (ADO) Iteration / Work Item viewer. It has two layers:

- `script/` — Python CLI scripts that call the ADO REST API (**standard library only**, no pip dependencies).
- `app/` — an Electron desktop UI that shells out to those Python scripts via `python-shell` and renders the results.

Code comments, docstrings, CLI messages, and UI strings are written in Traditional Chinese; keep that convention.

**Communication:** The user prefers to communicate in Traditional Chinese (繁體中文) — reply in Chinese.

## Commands

```bash
# Configure (required before anything works): copy and fill AZDO_ORG / AZDO_PROJECT / AZDO_PAT
cp script/env_example.txt script/.env

# Python scripts (run from script/ so the `ado` package is importable)
cd script
python get_iterations.py                                   # writes data/iterations.{csv,json}, data/iterations_tree.json
python get_iteration_work_items.py --iteration "Proj\\Sprint 1" [--exact] [--out path.json]
python get_requirement_flow.py --iteration "Proj\\Sprint 1" [--exact] [--type Requirement] [--out path.json]
python get_tasks.py [ids/ranges] [--type Bug] [--state Active] [--assigned-to @Me] [--iteration ...] [--json]

# Electron app
cd app
npm install
npm start          # electron .   (set PYTHON env var to override the python executable)
```

There is no test suite, linter, or build step configured.

## Architecture

### Python (`script/`)
- `script/ado/` is the shared package; `get_*.py` entry points only parse args and write output — all logic lives in `ado/`.
  - `config.py` — hand-rolled `.env` parser; reads `script/.env` (env vars are the fallback). `Config.opt()` for script-specific optional keys (e.g. `OUTPUT_CSV`).
  - `client.py` — `api_url` / `api_request` (Basic auth with PAT, GET when no payload else POST JSON). A non-JSON response (ADO returns 203 + HTML login page for a bad PAT) is treated as an error.
  - `work_items.py` — WIQL query → ids, then `workitemsbatch` in chunks of 200; `ROW_FIELDS` defines the flattened row schema used by both CSV and the app. Gotcha: `workitemsbatch` without a field list does **not** return `System.Parent`; pass `get_work_items(..., relations=True)` (`$expand=relations`) and use `child_ids` / `parent_id` for hierarchy (`to_row` then fills `parent` from relations).
  - `iterations.py` — fetches the Iterations classification-node tree and flattens it (depth-first, `parentId` links, `timeFrame` past/current/future). `to_iteration_path` strips the `\Iteration\` segment so paths match `System.IterationPath`.
  - `cli.run(main)` — wraps entry points: `AdoError` messages go to stderr with exit code 1. Raise `AdoError` for any user-facing failure.
- Output paths: `data/` at repo root (`ado.config.DATA_DIR`). `*.csv`, `*.json`, and `.env` are gitignored.

### Electron (`app/src/`)
- `main/` — `index.js` creates the window; `ipc.js` maps IPC channels → `services/*`; `python.js` runs `script/*.py` with `cwd=script/` and UTF-8 forced; `paths.js` resolves repo-root paths.
- `preload/index.js` — exposes `window.api` via `contextBridge` (contextIsolation on, nodeIntegration off; sandboxed, so it can only `require('electron')`).
- `renderer/` — plain ES modules (no bundler/framework), strict CSP (`'self'` only, no inline scripts/styles). `api.js` wraps `window.api` and `cleanError` strips the IPC error prefix.
- Data flow: services call a Python script, which writes JSON to disk; the service reads it back. `iterations:load` reads `data/iterations.json` (returns `null` if missing), `iterations:sync` reruns `get_iterations.py` first. `workitems:fetch` and `flow:fetch` write to a unique temp file per request and delete it afterward. The renderer builds the iteration tree from the flat list.
- Iteration picker (`iteration-tree.js`): the sidebar lists only pinned iterations (plus the current selection if it isn't pinned); the full tree lives in a `<dialog>` opened by「選擇 Iteration…」, where ☆ pins/unpins. Pins are stored in `localStorage` (`pinnedIterations`) by iteration `identifier` (GUID), so they survive renames.
- Content area has two tabs (`main.js` switches them and only refetches when iteration/exact changed): **Requirement 流程** (`requirement-flow.js`, default) and **Work Items** (`work-items.js`).
- **Adding a feature**: implement logic in `main/services/` (and a Python script if it needs ADO) → register the channel in `main/ipc.js` → add the method in `preload/index.js` → call via `api` in the renderer.

### Requirement 流程 (based on `feature/flow.pptx`)
- Stages: Pending → Implement + Manager understand (parallel; one "Implement" column split into top/bottom cells) → Test deploy (SaaS/Local) → Test → Prod deploy (SaaS/Local) → Release recap (meeting/record). The current stage cell is highlighted; past = green, future = dimmed.
- Requirements are selected by **their own** iteration (`get_requirement_flow.py`); children (Task/Bug) come via parent-child relations even if they sit in another iteration. Tasks without a parent are anomalies — ignore them.
- Pending = no non-Removed children. Implement is done when all children are Tested by Dev / Resolved / Closed (that cell turns green even while the stage is current). The stage advances only when Implement and Manager understand are both done.
- Manager understand is not a plain toggle: clicking it opens a dialog (`understand-dialog.js`) where the manager picks which repos (crmapp / crmappui / upagent, defined in `main/services/repoConfig.js`) need work and a feature branch for each. Branch choices come from `app/.env` (`CRMAPP_BRANCHES` / `CRMAPPUI_BRANCHES` / `UPAGENT_BRANCHES`, comma-separated; template `app/env_example.txt`), re-read every time the dialog opens. Saved via `flow:setUnderstand` as `understand: true` + `understandRepos: { repo: branch }`; `flow:setCheck` refuses the `understand` key.
- Steps other than Pending/Implement are not wired to real actions yet: they are checkboxes stored locally in `data/requirement_flow_state.json` (`{ "<reqId>": { "<checkKey>": true } }`, via `flow:loadState` / `flow:setCheck`; writes are serialized). Nothing is written back to ADO.

### `feature/restore_workitem/`
Standalone, older scripts (recycle-bin listing and restore) that do **not** use the `ado` package; they duplicate config/client code and read their own `.env` in that folder.
