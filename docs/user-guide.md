# AdoMaster 使用手冊

AdoMaster 是 Azure DevOps（ADO）的 Iteration / Work Item 檢視工具，也是 Requirement 從開發到正式發佈的流程看板。這份手冊說明各畫面與對話框的用法；在 app 中按 **F1** 或選單「說明 → 使用手冊」即可開啟。

> 開發者請看 `docs/requirement-flow.md`（流程的詳細規格）與專案根目錄的 `CLAUDE.md`。

## 第一次使用

1. 選單「設定 → 連線與機密設定…」填入 Azure DevOps 的 Organization、Project 與 Personal Access Token。
2. 選單「設定 → Repository 設定…」加入要追蹤的 repository（Requirement 流程需要）。
3. 在左側按「↻ 同步」取得 Iteration 清單。
4. 按「☰ 選擇 Iteration…」挑一個 Iteration，就會顯示它的 Requirement 流程。

設定檔都放在 data 資料夾：開發時是專案的 `data/`，安裝版是 `%APPDATA%\AdoMaster\data`（可用環境變數 `ADOMASTER_DATA_DIR` 指定）。

- `data/.env`：連線資訊與機密（PAT、Token、資料庫密碼）。
- `data/config.json`：其他非機密設定，每個功能一個區段（`repos`、`upagentRelease`、`upagentConnection`、`localDeploy`…）。

## Iteration 側欄

- **↻ 同步**：執行 `get_iterations.py` 從 ADO 重新取得 Iteration 清單（寫入 `data/iterations.json`）。若側欄顯示找不到 Iteration 資料，按這個即可。
- **☰ 選擇 Iteration…**：開啟完整的 Iteration 樹。上方輸入框可依名稱或路徑篩選；點選 Iteration 就切換顯示；按 ☆ 會把它**固定到左側清單**，之後直接在側欄點選即可。再按一次 ★（或側欄上的按鈕）取消固定。
- **收合側欄**：按側欄右上角的 « 或 **Ctrl + B**。
- 側欄寬度可以拖曳右邊緣調整。
- 右上角的「**不含子 Iteration**」：勾選時只看選取的 Iteration 本身，不包含它底下的子 Iteration。

## Work Items 分頁

列出 Iteration 中的所有 Work Item（ID、類型、標題、狀態、指派、剩餘 / 完成工時、最後修改）。滑鼠移到列上會顯示 Description 的開頭。

**Work Item 連結**（這裡和流程看板都一樣）：

- 點擊：在 app 內顯示 Description。
- **Ctrl（⌘）+ 點擊**：在瀏覽器開啟 ADO 頁面。Description 視窗中的「在瀏覽器開啟」也可以。

## Requirement 流程看板

預設分頁。每一列是一個 Requirement（依 Requirement **本身**的 Iteration 篩選；底下的 Task / Bug 即使在別的 Iteration 也會帶出來）。

### 階段

| 階段 | 內容 |
|---|---|
| 待處理 | 還沒有任何子項目（Task / Bug）。可「安排預設 Task」。 |
| 開發 + 規劃 | 子項目全部 Tested by Dev / Resolved / Closed，且「規劃」已確認，才進到下一階段。 |
| 測試環境佈版 | Confirm Commit → SaaS / Local 佈版。 |
| 測試與檢核 | 記錄測試場景 / 驗證方式並勾選完成。 |
| 正式環境佈版 | Confirm Commit → SaaS / Local 佈版。 |
| 功能發表 | Meeting / Record。 |

目前所在的階段會以橘色標示，已完成的是綠色，尚未到的會變淡。需求標題下方的彩色標籤是規劃中要修改的 repository。

### 勾選框的行為

- 只有點**勾選框本身**才會動作（點文字不會）。
- 在**進行中（橘色）的階段**點擊：執行正常流程（開對話框、檢查 merge…）。
- 在**其他階段**點擊：會先跳出確認（跳階段勾選），確定後**只切換勾選狀態**，不開對話框也不做 merge 檢查。

### 會寫回 ADO 的操作

整個流程只有兩個動作會寫入 ADO，其餘勾選都只存在本機的 `data/requirement_flow_state.json`：

1. **安排預設 Task**：在 Requirement 底下建立一個**同名**的 Task，Area / Iteration 沿用 Requirement；Description 在對話框中填寫。
2. **更新狀態**：狀態標籤顯示「目前 → 應有狀態」並以醒目色標示時，點擊它會把 ADO 狀態更新成應有狀態（有人被指派 → Active；開發完成 → Resolved；整個流程完成 → Closed）。

### 開發欄

列出 Requirement 底下的 Task / Bug，滑鼠移上去可看狀態與指派人；尚未展開 Task 時會顯示提示。

### 規劃

點「規劃」開啟對話框：

- 勾選此需求**需要開發的 repository**，並為每個 repository 選擇要做在哪個 **feature branch**（選項來自 Repository 設定的 Feature branches）。
- **不需修改程式時**（例如只調整 database 資料）可以都不勾：Confirm Commit 會自動完成，兩個佈版階段也會顯示「不需佈版」。
- 「需要 migration」與「註解」為選填；註解會以 💬 圖示顯示在「規劃」旁，滑鼠移上去可看內容。
- 「取消確認」會清除規劃。

### Confirm Commit 與分支圖

測試環境佈版與正式環境佈版都從 Confirm Commit 開始：

- 為每個規劃中的 repository 填入此需求**開發測試通過版的 commit**（縮寫即可），按「**檢查**」確認 repository 中存在該 commit。找不到時會自動 `git fetch` 一次；commit 不在規劃的 feature branch 上時只會警告，不會擋下。
- 也可以展開「**分支圖**」直接點選 commit 帶入（會一併執行檢查）。分支圖顯示 feature branch 與它的 developer branch（`<feature>_<開發者>`）的 commit 關係，預設排除已進正式環境 branch 的 commit，可勾選「包含已進…」顯示；不在 feature branch 上的 commit 會標示「未進 <feature>」。按 ↻ 會從 remote 取得最新的 branch 後重畫。
- 正式環境佈版的 Confirm Commit 會預先帶入測試環境的 commit。
- 「取消確認」也會一併清除該階段的 SaaS / Local 勾選。

### 佈版前的 merge

勾選 SaaS / Local 前會先檢查：確認的 commit 是否都已進入該 repository 的環境 branch（測試環境 branch / 正式環境 branch）。

- 尚未 merge 時會詢問「要現在 merge 嗎」。確定後會在環境 branch **建立 merge commit**（即使可以 fast-forward 也一樣）並 push，**不會動到本機的 working tree**，也不會 `--force` push。
- merge 會發生**衝突**時無法繼續，請先手動處理後再勾選。
- **正式環境**：merge 進正式環境 branch 後，會把它**反向 merge 回所有 feature branch**（同樣一律建立 merge commit），讓 feature branch 保持以正式版為基礎。反向 merge 失敗或衝突時不影響已完成的佈版，結果會列在對話框中，請手動處理。

### SaaS 佈版（Pipeline）

push 環境 branch 會觸發 ADO Pipeline 自動佈版（在 Repository 設定填寫測試 / 正式環境 Pipeline；沒設定 = 只 merge、不監看）。勾選 SaaS 時：

1. 先等待 Pipeline 沒有進行中 / 停等的 Run；
2. 在環境 branch 建立 merge commit 並 push（觸發自動佈版）；
3. 監看新的 Run 直到結束（每 15 秒更新）；已全部 merge 時只等待 Run 結束；
4. **測試環境**的 Run 成功後會重啟該 repository 的測試環境 App Service 並等待網站回應（需先 `az login`）。**正式環境絕不會立即重啟**（客戶正在使用），只能排程重啟，見下方「正式環境排程重啟」。
5. 全部成功會自動勾選 SaaS；失敗時可選擇「仍然勾起」或「不勾選」。

等待期間可以按「**背景執行**」關閉視窗，佈版結束時會再通知；SaaS 下方的狀態列可以重新開啟視窗。同一時間只能進行一個佈版。

### 正式環境排程重啟

正式環境的 App Service 只能透過 Azure Automation 排在固定時段重啟：**午休 12:30**、**下班 18:30**、**深夜 23:30**。設定方式見「正式環境排程重啟設定」（選單「設定 → 正式環境排程重啟設定…」，或排程重啟視窗的「設定…」）。需要先執行 `az login`，登入的帳號要有該 Automation Account 的權限。

- **Prod deploy 勾 SaaS**：佈版視窗的確認畫面有「正式環境排程重啟」，先選日期再選時段。預設是「不排程重啟」。這個區塊只會列出這次要 merge、而且有設定 Pipeline 的 repository，同時會列出這些 repository 在 Automation 中尚未執行的排程。
  - 排程不是馬上建立，要等 push 觸發的 Run **成功後**才建立。如果到那時選的時段已經過了，或距離現在不到 6 分鐘，就會建立失敗，佈版結果會顯示「佈版後動作失敗」。這時可以選「仍然勾起」，再從選單補排程。
- **手動佈版**：選「正式環境」加「SaaS」時，同樣可以選擇日期與時段。
- **選單「佈版 → 正式環境排程重啟…」**：
  - 會列出 Automation 中的重啟排程，勾「含已執行」可以看到已經執行過的排程。
  - 可以選 repository、日期和時段來新增排程，也可以刪除排程。
  - 滑鼠移到說明上，可以看到 Schedule 名稱、Runbook 參數和建立時間。
- **不會重複建立**：同一個 repository 在同一個時間只會有一個排程。Schedule 的名稱是 `<前綴>-<repository>-<日期>-<時間>`，如果已經排過，會顯示「已排程…未重複建立」。
- **紀錄**：Automation 本身就是紀錄。每個 Schedule 的說明會寫入 Requirement 編號（或「手動佈版」）、commit、建立者與建立時間。

### Local 佈版（地端 Docker）

勾選 Local 時：merge 檢查 → Local 佈版 → （需要時）UpAgent 發佈 → 勾選。

- 只有在 `data/config.json` 的 `localDeploy` 有設定的 repository 才會出現在佈版清單；預設勾選「這個階段還沒用目前的 Confirm Commit 佈版過」的 repository。全部取消勾選 = 略過佈版直接勾選。
- 每個 repository 依序執行：啟動 Docker → 在**專用的佈版 clone** 切到 `origin/<環境 branch>`（不是開發用的 clone）→ PreBuild → Docker build 成 image tar → Push 到 registry → 以 ssh 到主機上重新啟動 container。遇到失敗就停止。
- **重新 build**：預設同一個 commit 已 build 過的 image tar（`data/local_deploy/`）會直接拿來推送、不重新 build。若改了佈版 clone 的設定或 build 參數，請勾選「重新 build」。
- 可以按「背景執行」關閉視窗；「取消」會中止執行中的佈版。

### 測試與檢核

在進行中的階段勾選「測試 / 檢核完成」會開啟記錄視窗。記下這次的測試場景或驗證方式，之後才能回想起當時的狀況。可以從以下面向記錄：

- **時間**、**地點**、**人員**（誰測、誰陪同）
- **溝通管道**：Teams / SharePoint / Email…
- **裝置**、**連線**（網路、VPN、環境）、使用的**資料**
- 不是實際測試而是檢查時：**怎麼驗證**這件事沒問題（查了哪些資料 / 設定、比對的依據、結果）

範例：

- 11/7 14:00 在客戶會議室，與 PM 小王、使用者 A 透過 Teams 會議測試；使用客戶筆電 + 公司 Wi-Fi；以測試帳號 test01、訂單 #1234 驗證…
- 11/7 查詢正式 DB 的 Customer 資料表，確認 50 筆資料的 Region 已更新為新代碼，與客戶提供的清單逐筆比對一致…

**圖片**：直接按 **Ctrl + V** 貼上截圖、拖曳圖片到對話框，或按「上傳圖片…」（png / jpeg / gif / webp / bmp，每張 10 MB 以內，最多 30 張）。點縮圖可放大。

取消勾選不會刪除記錄；「📝 測試 / 檢核記錄」連結可以修改記錄而不改變勾選狀態。

### 切換 UpAgent 連線

規劃中包含 `upagent` 時，測試與檢核欄會出現「🔌 設定 UpAgent 連線」與目前連線。

- 選擇要連到的環境（Local Test / Local Prod / SaaS Test / SaaS Prod）後按「切換連線」：會**刪除 UpAgent 的設定檔**，並顯示該環境的 Activation Code（可按「複製」）。
- 重新開啟 UpAgent 後會要求輸入 Activation Code，輸入後即自動連線到對應的環境。
- 沒有設定 Activation Code 的環境無法選擇，請按「編輯設定…」填入。

### UpAgent 發佈

規劃中包含 `upagent` 時，勾選佈版階段的 SaaS / Local 會先進行 UpAgent 發佈：版號遞增 → 等待 GitHub Action → 下載 → 簽署 → 更新 latest.yml → 發佈到 Azure Blob → 寫入資料庫。

- **版號遞增**：patch（x.y.Z）或 minor（x.Y.0）。資料庫備註（remark）可留空。
- **簽署需要 HSM**：請先插上 HSM USB，簽署時會跳出 PIN 輸入視窗。
- 失敗時再勾選會從下一個步驟接續；GitHub Action 失敗時可以按「**重跑 GitHub Action**」，透過 GitHub API 重跑整個 workflow run 後接續等待結果（Token 需要 Actions 寫入權限）。
- 同一個 upagent feature branch 上的多個 Requirement 會**共用版號**：Confirm Commit 已包含在某個已發佈的版本中時，會沿用該版本（顯示「沿用 #id」），只補寫尚未寫入的資料庫。
- 可以按「背景執行」關閉視窗。

## 設定

### 連線與機密設定

編輯 `data/.env`。

- 欄位清空 = 從 `.env` 刪除該設定；未列出的設定與檔案中的註解會保留。
- 標示 ⚠ 的欄位代表已設定同名的**環境變數**，腳本會優先使用環境變數，這裡的值不會生效。

**Azure DevOps**（Python 腳本取得 Iteration / Work Items / Requirement 流程 / Pipeline 時使用）

| 欄位 | 說明 |
|---|---|
| Organization | `https://dev.azure.com/<organization>` 中的 organization |
| Project | ADO 專案名稱 |
| Personal Access Token | 需 Work Items (Read & write)；讀取 Pipeline 需 Build (Read) |
| Base URL | 選填；Azure DevOps Server（on-prem）才需要改 |
| API version | 選填 |

**UpAgent 發佈**（`shell/Release-UpAgent.ps1` 使用）

| 欄位 | 說明 |
|---|---|
| GitHub Token | 需能讀取 upagent repo 的 Actions；「重跑 GitHub Action」需要 Actions 寫入權限 |
| 各環境資料庫密碼 | 也可以在「UpAgent 發佈資料庫設定…」與連線資訊一起編輯 |

### Repository 設定

編輯 `data/config.json` 的 `repos`。可上移 / 下移 / 刪除 repository，並設定代表色。

> **key** 是流程紀錄使用的識別名稱，已有紀錄的 repository **請勿修改 key**，否則舊紀錄會對不上。

| 欄位 | 說明 |
|---|---|
| 本機資料夾 | Confirm Commit 檢查 commit、merge / push 使用的本機 clone |
| Feature branches | 規劃時可選的 branch，一行一個 |
| 測試環境 branch / 正式環境 branch | 佈版時 merge 的目標 branch |
| 測試環境 Pipeline / 正式環境 Pipeline | push 後觸發的 Pipeline，可寫「資料夾\名稱」；空白 = 不監看 |
| 測試環境 App Service | 測試環境 Pipeline Run 成功後重啟（需先 `az login`）；正式環境只能排程重啟（見「正式環境排程重啟設定」） |
| 測試環境 Resource Group | App Service 所在的 Resource Group；空白時自動查詢 |

### 正式環境排程重啟設定

選單「設定 → 正式環境排程重啟設定…」（或「正式環境排程重啟」視窗的「設定…」）編輯 `data/config.json` 的 `prodRestart`。需要事先在 Azure Automation 建好重啟 App Service 的 Runbook，並且已經發佈。標示 **\*** 的欄位必填。

| 區塊 / 欄位 | 說明 |
|---|---|
| Automation Account / Resource Group | Automation Account 名稱與它所在的 Resource Group |
| Runbook | 負責重啟的 Runbook 名稱 |
| 訂閱 | 選填，空白時使用 `az` 目前的訂閱 |
| Hybrid Worker Group | 選填，空白時在 Azure 雲端執行 Runbook |
| Runbook 參數 | 傳給 Runbook 的參數名稱與值，名稱要和 Runbook 定義的參數一致。值裡的 `{欄位}` 會換成下方該 repository 的同名欄位，`{repo}` 會換成 repository key。例如 `AppServiceName` = `{appService}`，或 `Release` = `{release}`、`Server` = `{server}` |
| Repository | 勾選 = 這個 repository 可以排程重啟（沒勾 = 從設定移除）。欄位會依 Runbook 參數用到的 `{欄位}` 自動產生（例如用了 `{release}`、`{server}` 就有 release、server 兩欄），勾選的 repository 每一欄都必填 |
| 時區 / UTC 位移 | Schedule 的時區（預設 `Asia/Taipei`）與時段的 UTC 位移（預設 `+08:00`），空白 = 預設值 |
| 排程名稱前綴 | Schedule 名稱的前綴（預設 `adomaster-restart`）。只會列出和刪除這個前綴開頭的排程，變更後舊前綴的排程要到 Azure Portal 管理 |

`repos.<repository>` 裡目前 Runbook 參數沒用到的欄位不會顯示，但儲存時會保留。

安裝版的設定檔在 `%APPDATA%\AdoMaster\data\config.json`（不是專案資料夾裡的 `data\config.json`），除非用環境變數 `ADOMASTER_DATA_DIR` 指定。

### UpAgent 連線設定

編輯 `data/config.json` 的 `upagentConnection`（也可從「設定 UpAgent 連線」視窗的「編輯設定…」開啟）。

- **UpAgent 設定檔**：切換連線時要刪除的檔案。只能用檔案選擇器選**既有的檔案**；若剛切換過連線（設定檔已被刪除），請先開啟 UpAgent 讓它重新產生。
- **Activation Code**：重新開啟 UpAgent 後輸入的代碼，決定連到哪個環境；空白 = 該環境無法切換。

### UpAgent 發佈資料庫設定

編輯 4 個發佈資料庫（測試 / 正式 × SaaS / Local）的連線：連線資訊存在 `data/config.json` 的 `upagentRelease.db`，密碼存在 `data/.env`。

- 標示 **\*** 的欄位在發佈到該環境時必填；整個資料庫留空 = 無法發佈到該環境。
- Port 空白 = 使用預設值（輸入框中的灰字）。
- psql 空白 = 使用 PATH 上的 psql；4 個資料庫通常用同一個。

`upagentRelease` 的其他欄位（storage / github / codesign）與 `localDeploy` 目前沒有設定畫面，請直接編輯 `data/config.json`（可參考 `templates/config_example.json`）。

## 匯出 / 匯入本地資料

選單「檔案 → 匯出本地資料… / 匯入本地資料…」：把不在 git、也無法從 ADO 取回的資料打包成 zip，方便換電腦或備份。內容包含 `data/.env`、`data/config.json`、流程勾選紀錄、測試記錄與圖片，以及畫面上的偏好（固定的 Iteration、目前的 UpAgent 連線等）。

匯入會覆蓋現有的同名資料，執行前會再確認一次。
