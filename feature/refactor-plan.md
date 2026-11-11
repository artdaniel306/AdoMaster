# 架構優化計畫：第二批、第三批

進度：第一步（2-5、2-6、3-7）、第二步（2-1、2-2）、第三步（2-3、2-4）已完成（2-1 ~ 2-4 待手動驗證）。下一步：3-2。

第一批（bug 修正、共用常數、`Common.ps1`、`runPowerShellLines`、`exclusiveRunner`、`findRepo`）已在 commit `e2f35ab refactor` 完成。
本文件列出剩下的項目，依建議順序排列。每項都標了成本 / 效益與驗證方式；做完一項就勾起來，並同步更新 CLAUDE.md / 文件。

> 原則：以「容易理解、方便維護」為主，不做純粹的搬移或改名。每一項都應該讓「改一個規則只需要改一個地方」。

---

## 第二批：去除重複的 UI 與拆大檔（成本中，風險中）

### 2-1. ✅ 設定 dialog 共用 `form-dialog.js`
- 完成情況：`form-dialog.js` 提供 `textInput` / `secretInput` / `inputBox` / `fieldRow` / `envOverrideWarn` / `bindFormDialog`（依 `<prefix>-*` id 接線；儲存中「取消」、✕、Esc 都不能關閉；任何輸入改變時清錯誤）。5 個設定 dialog 978 → 710 行。
  `errorSetter` 放在 `dom.js`（不只設定 dialog 用），另外 9 個模組的 `showError` 也改用它（`requirement-flow.js` 的 `showError(prefix, err)` 簽名不同，保留）。
- **現況**：15 個 renderer 模組各自定義 `showError`；`textInput`、`field()`、密碼 👁 切換、「讀取中 → load → render → 啟用確定」「busy → save → 關閉 / 顯示錯誤」流程在 5 個設定 dialog 重複
  （`env-settings-dialog.js`、`repo-settings-dialog.js`、`upagent-connection-settings-dialog.js`、`upagent-release-db-dialog.js`、`prod-restart-settings-dialog.js`）。
- **問題**：行為已經不一致 —— `env-settings-dialog.js`、`repo-settings-dialog.js` 沒有「儲存中不能關閉」（`cancel` 事件）的防護，和之前修過的「關不掉 dialog」是同一類問題。
- **做法**：新增 `renderer/js/form-dialog.js`：
  - 元件：`errorSetter(el)`、`textInput(value, opts)`、`secretInput(value)`、`fieldRow(label, control, { required, keyText, warn })`
  - 流程：`bindFormDialog({ dialog, form, okBtn, closeIds, load, render, validate, save })`，統一 busy 狀態與 cancel 防護
  - 一次改一個 dialog，改完手動開關、存檔、存檔失敗各測一次
- **效益**：每個設定 dialog 約少 30–50 行；之後新增設定畫面只需寫欄位與 save。
- **成本**：中

### 2-2. ✅ 背景工作 dialog 共用元件
- 完成情況：`background-job-dialog.js`（`createBackgroundJobDialog`，依 `<prefix>-*` id 接線；專屬部分用 `init` / `confirm` / `render` / `runningText` hook）、`log-view.js`（`createLogView`，`deploy-progress-dialog.js` 收合時只累積、展開才繪製）、`dom.js` 的 `notify`。
  `finish` 統一用 `!ok || !dialog.open || phase !== 'done'`（UpAgent 原本少了 phase 判斷，但只會在 done 時以 ok 呼叫，行為相同）。Local 佈版「執行中」文字改用 repository 顯示名稱。
- **現況**：`local-deploy-dialog.js`（266 行）與 `upagent-release-dialog.js`（262 行）約七成相同：`appendLog`、`run` 的 catch、`finish`、`dismiss`、停止 / 背景 / 關閉按鈕接線、`open` 的 job 骨架、`statusOf` / `show` / `summary`。
  兩份已開始分岔（`local-deploy-dialog.js` 的 `finish` 多了 `j.phase !== 'done'` 判斷）。
- **做法**：
  - `createBackgroundJobDialog({ dialog, logEl, cancelFn, refreshStatusFn, render, label })`：job 狀態機、`LOG_MAX_LINES`、通知
  - `createLogView(el)`：「捲到底才自動捲動」的 log 區（`deploy-progress-dialog.js`、`repo-sync-dialog.js` 也各有一份）
  - `notify(title, body)` 放 `dom.js`，取代散在 5 處的 `new Notification(...)`
- **驗證**：Local 佈版與 UpAgent 發佈各跑一次成功、一次中途停止、一次失敗後重試；關閉 dialog 後從「佈版進度」再打開。
- **成本**：中

### 2-3. ✅ 拆 `main/services/gitCommit.js`（660 行，四種職責）
- 完成情況：`git.js`（214 行）、`deployMerge.js`（279 行）、`branchGraph.js`（146 行）、`gitCommit.js`（57 行）。
  與原計畫的差異：`resolveRepo` 放在 `git.js`（`deployMerge` / `branchGraph` 都要用，放 `gitCommit.js` 會讓下層依賴上層），改用 `repoConfig.requireRepo`；另加 `gitError(err)`。
  `fetchOrigin(r, { all, tags, prune })` 取代 6 處 fetch + 錯誤包裝（失敗時 `err.detail` = git 原始訊息，給 `checkCommit` / `branchGraph` 自訂訊息）。
  `checkMerged` / `mergeNoFf` 的參數與回傳欄位 `envBranch` → `targetBranch`，branch 檢查改用 `remoteRef`（錯誤訊息改為「的 branch 名稱不正確」/「remote 沒有 branch …」）。
  行為不變：fetch 次數維持原樣（留給 3-2）。
- **拆法**：
  - `git.js`：`git`、`lookup`、`normalizeCommit`、`isAncestor`、`trialMerge`、`remoteRef`、`commitAndPush`、`restorePaths`，再加一個 `fetchOrigin(path, { tags, all, prune })`
    —— 目前 fetch + 錯誤包裝寫了 6 次（`:100`、`:171`、`:281`、`:312`、`:471`、`:590`）
  - `deployMerge.js`：`checkMerged`、`mergeNoFf`、`checkDeployMerge`、`mergeViaFeature`、`mergeBackToFeatures`、`featureEntry`、`extraCommits`
  - `branchGraph.js`：`branchRefs`、`parseGraph`、`branchGraph`
  - `gitCommit.js` 只留 `checkCommit`、`resolveRepo`、`remoteBranchHead`
- **順帶**：
  - `mergeNoFf` 的參數 `envBranch` 也用來 merge 進 feature branch，改名 `targetBranch`（錯誤訊息才不會出現「環境 branch」）
  - 檔頭註解只描述 Confirm Commit；`checkCommit` 的 JSDoc 掛錯位置（在 `resolveRepo` 上）
- **成本**：中（純搬移，但呼叫端多；用 `node --check` + 走一次流程 merge 驗證）

### 2-4. ✅ 拆 `main/services/manualDeploy.js`（588 行）
- 完成情況：`jobs.js` 的 `createJobStore({ channel, noun, doneText, keepFinished })`（工作清單、廣播、`add` / `runStep` / `finish` / `cancel` / `dismiss` / `list` / `getFinished`）+ `sleep`；
  `customerDeploy.js`（`previewCustomer`、`prodHead`、`customers`，ipc 直接呼叫）。`manualDeploy.js` 588 → 442 行；Pipeline 等待 / 監看（`pollRuns`、`waitIdle`、`watchRun`）仍在 `manualDeploy.js`，3-1 再搬到 `pipelineWatch.js`。
- `jobs.js`：`jobs` Map、`broadcast`、`snapshot`、`appendLog`、`runStep`、`finish`、`cancel` / `dismiss` / `list`、`sleep`
- `manualDeploy.js` 只留 `normalizeParams`、`preview`、`planSteps`、`execute`、`retry`
- 客戶環境的 `previewCustomer` 可再獨立成 `customerDeploy.js`
- 做 3-1 之前先拆，3-1 會直接重用 `jobs.js`
- **成本**：中

### 2-5. ✅ 精簡 CLAUDE.md、整理規格文件
- **CLAUDE.md**：「Local settings & data → In-app editors」把每個設定 dialog 的欄位 / 空值規則都寫進去，屬於實作規格。
  搬到 `docs/settings.md`，CLAUDE.md 只留原則（兩個設定檔、新 `.env` key 加進 `ENV_GROUPS`、新本地資料加進 `localData.js` 的 `FILES`、repo-keyed section 加進 `repoKeyedMaps`）。
- **`docs/requirement-flow.md`**：88 行卻約 33KB，最長一行 1600 多字元。改成短段落 / 子項目，diff 才看得懂。
  第 70 行「Manual deploy (runManualRelease) is unchanged」語意不清，順便改寫。
- 寫明 `script/get_tasks.py` 是給人手動用的 CLI，app 不呼叫。
- **成本**：低；不影響程式。

### 2-6. ✅ 小型整理（各自低成本，可順手做）
- 完成情況：`upagentRelease.js` 合併 `markDbWritten`、共用 `versionTagsContaining` / `baseScriptArgs`；`flow-rules.js` 加 `planRepoKeys`；`buildTarget` 補上與 Deploy-Local.ps1 相同的遠端安全字元檢查；`appConfig.js` 加 `readSection` / `updateSection` / `str` / `isObj` / `assertSingleLine`（沒有另開 `settingsUtil.js`；`repoConfig.js` 的 `str` 只接受字串，刻意保留）
- `upagentRelease.js`：`markDbWritten` 與 `markVersionDbWritten` 合併；`findCoveringRelease` 與 `versionContaining` 都跑 `git tag --contains`，共用 `tagsContaining()`；`runRelease` / `runManualRelease` 組 `args` 的重複
- 「規劃的 repo 清單」`checks[PLAN_KEY] ? Object.keys(checks[PLAN_REPOS_KEY] || {}) : []` 寫了三次（`afterDeploy.js`、`localDeploy.js`、`pipelines.js`）→ `flow-rules.js` 加 `planRepoKeys(checks)`
- `localDeploy.buildTarget` 不檢查 `appName` 字元，`customerTarget` 有檢查 → 統一
- `renderer/js/deploy-dialog.js` 註解「正式環境為預留 shell」已過時（現在會排程重啟）
- `settingsUtil.js`：`str`、`isObj`、`assertSingleLine`、`setOrDelete` 在 `repoConfig.js`、`upagentReleaseDb.js`、`prodRestart.js`、`localDeploy.js` 各定義一次；`appConfig` 加 `readSection(name)` / `updateSection(name, mutate)`

---

## 第三批：統一佈版引擎與資料結構（成本高，效益最大）

### 3-1. 流程 SaaS 佈版搬到 main，與手動佈版共用 job engine
- **現況**：Pipeline 等待 / 監看寫了兩份 —— renderer `deploy-dialog.js`（流程用）與 main `manualDeploy.js`（手動佈版用）。
  常數與文字已在第一批集中到 `flow-rules.js`，但 `waitIdle`、`watchRun`、找 push 觸發的 Run 仍各寫一份。
  流程的 SaaS 佈版在 renderer 跑，**重新載入視窗就中斷**。
- **做法**：
  1. 抽 `main/services/pipelineWatch.js`：`waitForIdle(repo, stage, { signal, onUpdate })`、`watchTriggeredRun(repo, stage, commit, { signal, onUpdate })`
  2. 手動佈版改用它（行為不變，先驗證）
  3. 流程 SaaS 佈版改成 main 的 job（重用 2-4 的 `jobs.js`），`deploy-dialog.js` 只收 `update` 事件繪製
  4. 「佈版進度」dialog 合併成一種 job 來源
- **驗證**：流程測試 / 正式環境 SaaS 各一次（含重新載入視窗）、手動佈版一次、中途停止一次。
- **前置**：2-3、2-4

### 3-2. 同一個 clone 的 git 操作排隊、merge 只 fetch 一次
- **排隊**：流程 `flow:mergeStatus`（`Promise.all`）、手動佈版、`Sync-Repos.ps1` 可能同時對同一個 clone fetch / push，有 ref lock 失敗的機會。
  在 `git()` 外包一層以 `cwd` 為 key 的 promise queue（main 內）；`Sync-Repos.ps1` 執行時可以讓同一批 path 等待。
- **fetch 次數**：一次 merge 會 fetch 5～6 次（`mergeDeploy` → `mergeViaFeature` → 兩次 `mergeNoFf` 各自呼叫 `checkMerged`）。
  `mergeNoFf` / `checkMerged` 改由最外層 fetch 一次，內部傳 `fetch: false`。網路慢時差異明顯。
- **前置**：2-3（有 `fetchOrigin` 之後比較好改）

### 3-3. 設定資料結構
- **孤兒 key 檢查**：`appConfig` 加 `validateConfig()`，列出 `localDeploy.repos`、`prodRestart.repos`、`customerDeploy.*.*.repos` 中不在 `repos[]` 的 key，在設定畫面或啟動時顯示警告（`repoConfig.repoKeyedMaps` 已可重用）。
- **環境代號順序統一**：`upagentRelease.db` 用 `test_saas`（env_target），`upagentConnection.activationCodes` 用 `local_test`（target_env）。
  統一成 env_target，`appConfig` 讀取時把舊 key 轉換（像 `flowState` 的 `LEGACY_KEYS`）。
- ~~`activationCodes` 是否算機密~~ —— **已確認不算機密**，維持放在 `config.json` 的 `upagentConnection`，不搬到 `.env`。
- **（暫不建議）** 把 `testAppService` / `testResourceGroup` 與 `prodRestart.repos.<key>.{appService, resourceGroup}` 改成對稱結構 —— 搬動成本高，先靠孤兒檢查。

### 3-4. 流程狀態檔加版本號
- `data/requirement_flow_state.json` 沒有版本號，遷移只靠讀檔時的 `LEGACY_KEYS`。
- 取消某階段時以 `startsWith('<stage>.')` 整批刪除 —— 之後新增的 `testDeploy.xxx` 不論該不該保留都會被清掉。
- **做法**：
  - 先加 `"_v": 1`（最外層），遷移集中在 `loadFlowState`；`localData` 匯入時一併處理
  - 在 `docs/requirement-flow.md` 寫明「`<stage>.` 前綴下的 key 取消時會整批刪除」
  - **（長期）** 改成以 stage 為巢狀物件 —— 成本高，等真的需要再做
- 順帶：已結案的 Requirement 與 `test_records/` 只增不減；匯出也會帶出 state 已不引用的圖片。可考慮「清除已結案紀錄」功能。

### 3-5. `.env` 解析三套 → 一套
- JS（`appConfig.readEnvValues`）、Python（`config.load_env`）、PowerShell（`Common.ps1` 的 `Read-DotEnv`）規則已有細微差異
  （單一未成對引號時的 ` #` 處理、PS 的 key 不能含空白）。
- **做法**：main 啟動子程序時把 `.env` 解析後注入環境變數（環境變數本來就優先），PowerShell 不再自己解析；Python 保留讀檔（CLI 單獨執行需要）。
  不做的話，至少把三邊的差異對齊並加測試案例到註解。

### 3-6. 移除舊版設定轉換
- `appConfig.js` 的 INI / `repos.json` 轉換（`parseLegacyIni`、`convertLegacy*`、`applyLegacy`、`migrateLegacyConfig`）、`localData.js` 的 `LEGACY_FILES`、`config.py` 的 `LEGACY_ENV_PATH`、`flowState.js` 的 `understand*` 轉換、`paths.js` 的 `LEGACY_*`，約 150 行。
- **做法**：在 `user-guide.md` 宣告「舊版設定自動轉換支援到 vX.Y」，之後一起刪除。

### 3-7. ✅ `1-` / `2-` / `3-*BlobArtifacts.ps1` 內部重複併入 `Common.ps1`
- **已確認不需要跟原版對照**，可以直接整理。
- 搬進 `Common.ps1`：`Format-Size`（3 份）、`Get-Sha512Base64`、`Invoke-AzCli`、`Resolve-ManifestFile`（各 2 份）；`$dataRoot`（3 份）改用 `Get-DataRoot`。
- 三支腳本在 `param()` 後加 `. (Join-Path $PSScriptRoot 'Common.ps1')`；檔頭「從其他專案複製」的說明改掉。
- 同步更新 `shell/CLAUDE.md`：拿掉「`1-` / `2-` / `3-*.ps1` are copied from another project and kept as-is (they don't load it)」。
- `Invoke-AzCli`（不重導 stderr）與 `Invoke-Az`（stderr 寫暫存檔、帶進錯誤訊息）行為不同，兩個都保留，各加一行註解說明何時用哪個。
- **驗證**：PowerShell 解析檢查；UpAgent 發佈從 `Download` 接續跑一次（會經過 1-、2-、3-）。
- **成本**：低

---

## 不建議做

- 把 `renderer/index.html` 的 22 個 `<dialog>` 拆成多個檔案：沒有 bundler、CSP 只允許 `'self'`，拆檔需要另外 fetch / template 載入，複雜度反而增加。
  做完 2-1 之後可以考慮讓設定類 dialog 共用一個 `<template>` 骨架。

## 建議順序

| 順序 | 項目 | 理由 |
|---|---|---|
| 1 | 2-5、2-6、3-7 | 低成本，馬上降低閱讀負擔 |
| 2 | 2-1、2-2 | UI 重複最多，也修掉 cancel 防護不一致 |
| 3 | 2-3、2-4 | 3-1、3-2 的前置 |
| 4 | 3-2 | 降低同時操作 git 的風險 |
| 5 | 3-1 | 效益最大、成本最高；做完要完整手動測試流程與手動佈版 |
| 6 | 3-3、3-4、3-5、3-6 | 資料結構，可依需要穿插 |
