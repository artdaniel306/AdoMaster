# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

AdoMaster is an Azure DevOps (ADO) Iteration / Work Item viewer. It has two layers:

- `script/` — Python CLI scripts that call the ADO REST API (**standard library only**, no pip dependencies).
- `app/` — an Electron desktop UI that shells out to those Python scripts via `python-shell` and renders the results.

Code comments, docstrings, CLI messages, and UI strings are written in Traditional Chinese; keep that convention.

**Prefer existing packages over home-grown systems.** Before implementing any feature, first check whether something existing already fits: the language's built-ins / standard library, a well-known npm package (for `app/`), an existing tool's CLI (e.g. `git`), or code already in this repo. Only build your own mechanism when nothing fits the requirement or it can't reasonably be applied as-is — and say why in that case. Note that `script/` is restricted to the Python **standard library** (no pip packages), so there "existing" means stdlib only.

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
python create_task.py --parent 12345 [--description "..." | --description-file f.txt] [--out task.json]
python update_state.py --id 12345 --state Active [--out item.json]
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
  - `client.py` — `api_url` / `api_request` (Basic auth with PAT, GET when no payload else POST JSON; `method=` overrides, e.g. PATCH for updates). A non-JSON response (ADO returns 203 + HTML login page for a bad PAT) is treated as an error.
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
- Work item id links (`description-dialog.js` `workItemLink`): a plain click shows the item's Description (plain text from `to_row`) in an in-app `<dialog>`; Ctrl/⌘ + click opens `webUrl` in the browser.
- Content area has two tabs (`main.js` switches them and only refetches when iteration/exact changed): **Requirement 流程** (`requirement-flow.js`, default) and **Work Items** (`work-items.js`).
- **Adding a feature**: implement logic in `main/services/` (and a Python script if it needs ADO) → register the channel in `main/ipc.js` → add the method in `preload/index.js` → call via `api` in the renderer.

### Requirement 流程 (based on `feature/flow.pptx`)
- Stages: Pending → Implement + Manager understand (parallel; one "Implement" column split into top/bottom cells) → Test deploy (SaaS/Local) → Test → Prod deploy (SaaS/Local) → Release recap (meeting/record). The current stage cell is highlighted; past = green, future = dimmed.
- Requirements are selected by **their own** iteration (`get_requirement_flow.py`); children (Task/Bug) come via parent-child relations even if they sit in another iteration. Tasks without a parent are anomalies — ignore them.
- Pending = no non-Removed children. Implement is done when all children are Tested by Dev / Resolved / Closed (that cell turns green even while the stage is current). The stage advances only when Implement and Manager understand are both done.
- While a Requirement is Pending (no non-Removed children), its Pending cell shows「安排預設 Task」: a dialog (`task-dialog.js`) asks for a Description, then `flow:createTask` runs `create_task.py` (`ado.work_items.create_child_task`) to create a Task in ADO with the **same title** as the Requirement, its Area/Iteration, and a parent link. The description is passed via a temp file (`--description-file`) and converted to HTML. The new Task is appended to `req.children` in the renderer (no refetch).
- Requirement state chip (`stateChip` / `expectedState` in `requirement-flow.js`): the expected ADO state is Closed when the whole flow is done, else Resolved when Implement is done (all children dev-done), else Active when any non-Removed child is assigned, else none. When it differs from the current state (case-insensitive) the chip is highlighted (`state-mismatch`) and shows `current → expected`; clicking it runs `flow:updateState` → `update_state.py` (`ado.work_items.update_state`, PATCH `System.State`; Reason is left to ADO's default) and updates `req.state` in place (no refetch).
- Creating the default Task and updating the Requirement state are the only actions that write to ADO.
- Manager understand is not a plain toggle: clicking it opens a dialog (`understand-dialog.js`) where the manager picks which repos (crmapp / crmappui / upagent, defined in `main/services/repoConfig.js`) need work and a feature branch for each. Branch choices come from `app/.env` (`CRMAPP_BRANCHES` / `CRMAPPUI_BRANCHES` / `UPAGENT_BRANCHES`, comma-separated; template `app/env_example.txt`), re-read every time the dialog opens. The dialog also has a「需要 migration」checkbox and a free-text 註解 (shown as a 💬 tooltip next to the「Manager understand」heading). Saved via `flow:setUnderstand` as `understand: true` + `understandRepos: { repo: branch }` (+ `understandMigration: true` when checked, + `understandNote` when non-empty); `flow:setCheck` refuses the `understand` key.
- Test deploy / Prod deploy each start with a **Confirm Commit** step (`commit-dialog.js`): for every repo chosen in Manager understand, the manager enters the dev-tested commit (abbreviated hash OK) and can press「檢查」(`repos:checkCommit` → `main/services/gitCommit.js`). The check runs `git` in the local clone given by `app/.env` `<REPO>_REPO_PATH` (`CRMAPP_REPO_PATH` etc.), runs `git fetch --all` once if the commit is missing or not on the understand feature branch, and warns (does not block) when it isn't on that branch. Saved via `flow:setCommits` as `"<stage>.commits": { repo: commit }`, re-verifying every commit first; clearing it also clears that stage's SaaS/Local. `flow:setCheck` refuses `*.commits` keys and refuses checking SaaS/Local until commits cover all understand repos. Prod deploy's dialog prefills from Test deploy's commits.
- Checking a deploy stage's SaaS/Local also requires every confirmed commit to already be in that repo's environment branch (`app/.env` `<REPO>_TEST_BRANCH` / `<REPO>_PROD_BRANCH`, checked as `origin/<branch>` via `git merge-base --is-ancestor`, so a merge commit or a fast-forward both count). The renderer calls `flow:mergeStatus` (git fetch) first; if anything is missing, `merge-dialog.js` asks「要現在 merge 嗎」and on confirm `flow:mergeDeploy` always creates a merge commit (`--no-ff` semantics, even when a fast-forward is possible) without touching the local working tree: `git merge-tree --write-tree` (git 2.38+) → `git commit-tree -p origin/<env> -p <commit>` → `git push origin <merge>:refs/heads/<env>` (no `--force`). Merges that would conflict are refused and must be resolved by hand. `flow:setCheck` re-verifies merge status (without fetching) before saving.
- Steps other than Pending/Implement are not wired to real actions yet: they are checkboxes stored locally in `data/requirement_flow_state.json` (`{ "<reqId>": { "<checkKey>": true } }`, via `flow:loadState` / `flow:setCheck`; writes are serialized). Nothing else in these steps is written back to ADO.

### `feature/restore_workitem/`
Standalone, older scripts (recycle-bin listing and restore) that do **not** use the `ado` package; they duplicate config/client code and read their own `.env` in that folder.
