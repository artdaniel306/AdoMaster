# shell/ — PowerShell scripts run by the app

Run by `app/src/main/powershell.js`: `runPowerShell(script, args)` / `runPowerShellJson(script, args)` → `child_process.execFile` with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, `cwd=shell/`. Only bare `*.ps1` names inside `shell/` are accepted (so no subfolders). Executable is `powershell.exe` unless the `POWERSHELL` env var overrides it (e.g. `pwsh`).

## Conventions (same as `script/*.py`)
- Named parameters only (the app passes every argument as a string).
- Progress → stdout; result JSON → the file given by `-Out` (UTF-8; a BOM is stripped on read).
- Failure → message to stderr + `exit 1`; the app shows stderr as the error message.
- Save every `.ps1` as **UTF-8 with BOM** (Windows PowerShell 5.1 needs it for Chinese) and set `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`.
- Non-interactive: no `Read-Host` / confirmation prompts.
- Settings: read `data/config.json` with `ConvertFrom-Json` and secrets from `data/.env` (`Read-DotEnv` in `Release-UpAgent.ps1` — same rules as Python: a same-named env var wins). Never add a new config file.
- To wire a new script: a service in `main/services/` calls `runPowerShellJson` → channel in `ipc.js` → method in `preload/index.js`.

## Scripts
- `Restart-AppService.ps1` — test-deploy after-deploy restart (Azure CLI, `az login`; waits until the site answers < 500). Non-interactive copy of `docs/reference/release/Restart-AppService.ps1`.
- `After-ProdDeploy.ps1` — placeholder for prod after-deploy; **intentionally empty** (prod is never restarted).
- `Release-UpAgent.ps1` + `1-Get-BlobArtifacts.ps1` / `2-Update-LatestYml.ps1` / `3-Publish-BlobArtifacts.ps1` — UpAgent release; steps, resume logic and stdout markers are in `docs/requirement-flow.md` (§ UpAgent 發佈).
