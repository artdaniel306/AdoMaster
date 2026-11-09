<#
.SYNOPSIS
    UpAgent 發佈：從更版、等 GitHub Action、抓檔、簽署、重算 latest.yml、上傳、清 staging 到寫入資料庫。

.DESCRIPTION
    由 AdoMaster app 在「測試環境佈版 / 正式環境佈版」勾起 SaaS 或 Local、且規劃的 repository 含 upagent 時執行
    （app/src/main/services/upagentRelease.js）。依序執行以下步驟（括號內為 -StartFrom 可用的步驟名稱）：

      1. (Bump)         upagent 切到 -Branch（規劃選的 feature branch）、pull、確認 Confirm Commit 已在其中，
                        npm version <minor|patch>，push commit 與 tag 觸發 Release action，最後切回原本的 branch
      2. (WaitAction)   以 GitHub REST API 輪詢該 tag 對應的 Release workflow，直到成功（失敗即中止）；
                        指定 -RerunAction 時先重跑整個失敗的 workflow run
      3. (Download)     呼叫 1-Get-BlobArtifacts.ps1 把 staging/<版號>/ 抓回 data\upagent_release\<版號>\
      4. (Sign)         以 signtool 重簽 Windows 安裝檔（只簽 .exe；需先插上 HSM USB，簽署時會跳出 PIN 輸入視窗），並驗證簽章
      5. (UpdateYml)    呼叫 2-Update-LatestYml.ps1 依簽署後的 exe 重算 latest.yml / .blockmap
      6. (Publish)      呼叫 3-Publish-BlobArtifacts.ps1 上傳到 releases/<版號>/，並確認 latest.yml 確實已在 Blob 上
      7. (CleanStaging) 刪除 Blob 中 staging/ 底下的所有檔案
      8. (Database)     在 -Environment + -Target 對應資料庫（[upagent_db_<環境>_<saas|local>]）的
                        public.public_db_upagentrelease 新增此版本紀錄，
                        並把執行的 SQL 附加到 data\upagent_release.sql

    1-、2-、3- 子腳本與本檔同在 shell\ 底下（複製自 crmapp_AI\.manage\scripts），不呼叫其他專案的檔案。

    1～7 只需要做一次（同一個版本測試 / 正式環境共用 Blob 上的檔案）；之後其他環境 / 勾選只需以
    -StartFrom Database -Version <版號> 寫入該資料庫。測試 / 正式環境的 SaaS 與 Local 各有自己的資料庫（共 4 組連線）。

    設定讀取 data\config.json 的 upagentRelease（範本：templates\config_example.json）：
      storageAccount / container / stagingFolder / releaseFolder
      github     owner / repo / workflowFile
      codesign   signtool / certSubject / timestampUrl
      db.<test|prod>_<saas|local>   各環境 SaaS / Local 資料庫：psql / host / port / dbname / user / sslmode
    機密讀取 data\.env（範本：templates\env_example.txt），同名環境變數優先：
      GITHUB_TOKEN
      UPAGENT_DB_<TEST|PROD>_<SAAS|LOCAL>_PASSWORD   例如 UPAGENT_DB_TEST_SAAS_PASSWORD

    app 以 -NonInteractive 執行，本腳本不做任何互動確認：
      - 進度訊息走 stdout，並輸出以下標記行讓 app 記錄進度（中途失敗時下次可從失敗的步驟接續）：
          ::version::<版號>   確定版號時
          ::step::<步驟>      步驟開始
          ::done::<步驟>      步驟完成
          ::error::<訊息>     失敗原因
      - 結果以 JSON 寫到 -Out；失敗時訊息寫到 stderr 並以 exit code 1 結束。
    本檔需存成 UTF-8 with BOM，Windows PowerShell 5.1 才能正確讀取中文。

.PARAMETER Environment
    寫入哪個環境的資料庫：test 或 prod

.PARAMETER Target
    寫入 SaaS 或 Local 的資料庫：saas 或 local（與 -Environment 組成設定檔區段 [upagent_db_<Environment>_<Target>]）

.PARAMETER UpagentDir
    upagent repository 的本機 clone 路徑（data/config.json 的 repos 中 upagent 的 path）

.PARAMETER Branch
    更版、push tag 的 branch（規劃中 upagent 的 feature branch）。從 Bump 步驟開始時必填

.PARAMETER ExpectedCommit
    Confirm Commit 確認過的 upagent commit。有指定時，Bump 前確認它已在 -Branch 中（不在就中止）；
    -Branch 比它多出 commit 時列出警告（那些 commit 也會一起進到這個版本）

.PARAMETER Bump
    版號遞增方式：minor 或 patch。從 Bump 步驟開始時必填

.PARAMETER StartFrom
    從哪一步開始（中途失敗修正後接續用），預設 Bump。
    從 Bump 之後的步驟開始時需指定 -Version（未指定時取 upagent\package.json 目前的 version）

.PARAMETER Version
    接續執行時明確指定版號，例如 1.3.0。從 Bump 開始時不可指定

.PARAMETER Remark
    寫入資料庫的備註（可留空）

.PARAMETER RerunAction
    從 WaitAction 開始時，先透過 GitHub API 重跑整個 workflow run（POST actions/runs/<id>/rerun），再等待結果。
    run 仍在執行中或已成功時不重跑。GitHub token 需要 Actions 寫入權限

.PARAMETER ConfigPath
    設定檔路徑，預設 <專案根目錄>\data\config.json

.PARAMETER EnvPath
    機密檔路徑，預設 <專案根目錄>\data\.env（不存在時只讀環境變數）

.PARAMETER Out
    結果 JSON 的輸出路徑

.EXAMPLE
    # 測試環境 SaaS：完整發佈 minor 版並寫入測試環境 SaaS 資料庫
    powershell -NoProfile -ExecutionPolicy Bypass -File shell\Release-UpAgent.ps1 -Environment test -Target saas -UpagentDir C:\src\upagent -Branch peach_upagent -Bump minor -Remark "新增檔案上傳功能"

.EXAMPLE
    # 正式環境 Local：Blob 已上傳過，只寫入正式環境 Local 資料庫
    powershell -NoProfile -ExecutionPolicy Bypass -File shell\Release-UpAgent.ps1 -Environment prod -Target local -UpagentDir C:\src\upagent -StartFrom Database -Version 1.3.0 -Remark "Sprint 20 Release"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("test", "prod")]
    [string]$Environment,

    [Parameter(Mandatory = $true)]
    [ValidateSet("saas", "local")]
    [string]$Target,

    [Parameter(Mandatory = $true)]
    [string]$UpagentDir,

    [string]$Branch,

    [string]$ExpectedCommit,

    [ValidateSet("minor", "patch")]
    [string]$Bump,

    [ValidateSet("Bump", "WaitAction", "Download", "Sign", "UpdateYml", "Publish", "CleanStaging", "Database")]
    [string]$StartFrom = "Bump",

    [string]$Version,

    [string]$Remark = "",

    [switch]$RerunAction,

    [string]$ConfigPath,

    [string]$EnvPath,

    [string]$Out
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Steps = @("Bump", "WaitAction", "Download", "Sign", "UpdateYml", "Publish", "CleanStaging", "Database")
$EnvLabel = "{0} {1}" -f @{ test = "測試環境"; prod = "正式環境" }[$Environment], @{ saas = "SaaS"; local = "Local" }[$Target]

# GitHub Action 輪詢設定
$ActionPollSeconds    = 30
$ActionAppearMinutes  = 10    # push tag 後多久內必須出現 workflow run
$ActionTimeoutMinutes = 120   # 整個 workflow 最長等待時間（macOS 建置較久）

$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDir     = Join-Path $projectRoot "data"

# ---------------------------------------------------------------------------
# 共用函式
# ---------------------------------------------------------------------------

function Exit-WithError {
    <# 輸出 ::error:: 標記（stdout）與錯誤訊息（stderr），以 exit code 1 結束 #>
    param([string]$Message)
    Write-Host "::error::$($Message -replace '\r?\n', ' ')"
    [Console]::Error.WriteLine($Message)
    exit 1
}

function Read-DotEnv {
    <#
      讀取 .env（KEY=VALUE），規則與 script/ado/config.py 的 load_env 相同：# 開頭為註解，可加 export 前綴；
      值有成對的引號時去掉引號（引號內的 # 不是註解），沒有引號時去掉行尾「 #」之後的註解。檔案不存在時回傳空表。
    #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $vars = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $vars }
    foreach ($raw in [System.IO.File]::ReadAllLines($Path)) {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        if ($line -notmatch '^(?:export\s+)?(?<k>[^=\s]+)\s*=\s*(?<v>.*)$') { continue }
        $key = $Matches['k']
        $value = $Matches['v']
        if ($value.Length -ge 2 -and $value[0] -eq $value[-1] -and ($value[0] -eq [char]"'" -or $value[0] -eq [char]'"')) {
            $value = $value.Substring(1, $value.Length - 2)
        } else {
            $value = ($value -split ' #', 2)[0].Trim()
        }
        $vars[$key] = $value
    }
    return $vars
}

function Get-ConfigValue {
    <# 從 config.json 的物件取值（$Label 用在錯誤訊息，例如 upagentRelease.db.test_saas.host） #>
    param(
        $Object,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Label,
        [string]$Default,
        [switch]$Required
    )
    $value = $null
    if ($Object -and $Object.PSObject.Properties[$Name]) { $value = [string]$Object.$Name }
    if (-not $value) { $value = $Default }
    if ($Required -and -not $value) { throw "$ConfigPath 缺少 $Label" }
    return $value
}

function Get-Secret {
    <# 機密：同名環境變數優先，其次 .env #>
    param([Parameter(Mandatory = $true)][string]$Name, [switch]$Required)
    $value = [Environment]::GetEnvironmentVariable($Name)
    if (-not $value) { $value = $secrets[$Name] }
    if ($Required -and -not $value) { throw "$EnvPath 缺少 $Name（也可設定同名環境變數）" }
    return $value
}

function Invoke-Native {
    <#
      執行外部指令並在退出碼非 0 時拋出例外。
      刻意不重導 stderr：PowerShell 5.1 一旦重導原生指令的 stderr 就會把警告轉成 ErrorRecord，
      在 $ErrorActionPreference = "Stop" 下會誤判為失敗。
    #>
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$Context = $FilePath
    )
    $stdout = & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Context 失敗（退出碼 $LASTEXITCODE），詳細錯誤請見上方輸出。"
    }
    return $stdout
}

function Invoke-ChildScript {
    <# 呼叫同資料夾（shell\）的 1/2/3 子腳本；它們以 exit <碼> 回報結果 #>
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [hashtable]$Arguments = @{}
    )
    $path = Join-Path $PSScriptRoot $Name
    if (-not (Test-Path -LiteralPath $path)) { throw "找不到 $path" }
    $global:LASTEXITCODE = 0
    & $path @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "$Name 失敗（退出碼 $LASTEXITCODE）"
    }
}

function Test-StepEnabled {
    param([string]$Step)
    return ($Steps.IndexOf($Step) -ge $Steps.IndexOf($StartFrom))
}

function Write-StepHeader {
    param([string]$Step, [string]$Title)
    Write-Host "::step::$Step"
    Write-Host ""
    Write-Host ("==== [{0}/{1}] {2}（{3}）====" -f ($Steps.IndexOf($Step) + 1), $Steps.Count, $Title, $Step)
}

function Complete-Step {
    param([string]$Step)
    $script:completedSteps += $Step
    Write-Host "::done::$Step"
}

function Get-PackageVersion {
    $json = [System.IO.File]::ReadAllText((Join-Path $UpagentDir "package.json")) | ConvertFrom-Json
    return $json.version
}

function Get-NextVersion {
    param([string]$Current, [string]$Kind)
    $parts = $Current -split '\.' | ForEach-Object { [int]$_ }
    if ($Kind -eq "minor") { return "{0}.{1}.0" -f $parts[0], ($parts[1] + 1) }
    return "{0}.{1}.{2}" -f $parts[0], $parts[1], ($parts[2] + 1)
}

function Invoke-GitHubApi {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Method = "Get")
    $headers = @{
        "Authorization"        = "Bearer $githubToken"
        "Accept"               = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent"           = "upagent-release-script"
    }
    return Invoke-RestMethod -Uri "https://api.github.com/repos/$githubOwner/$githubRepo/$Path" -Headers $headers -Method $Method
}

function Invoke-Psql {
    <# 以設定檔的連線資訊執行 psql；密碼走 PGPASSWORD，執行完還原成原值，不留在目前的 PowerShell 工作階段 #>
    param([string[]]$Arguments)
    $saved = @{}
    foreach ($name in @("PGPASSWORD", "PGSSLMODE", "PGCLIENTENCODING")) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
    $env:PGPASSWORD       = $dbPassword
    $env:PGSSLMODE        = $dbSslMode
    $env:PGCLIENTENCODING = "UTF8"
    try {
        return Invoke-Native -FilePath $psqlPath -Context "psql" -Arguments (@(
            "-h", $dbHost, "-p", $dbPort, "-U", $dbUser, "-d", $dbName,
            "-v", "ON_ERROR_STOP=1", "-X"
        ) + $Arguments)
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    }
}

# ---------------------------------------------------------------------------
# 參數整理與設定讀取
# ---------------------------------------------------------------------------

$completedSteps = @()

if (-not (Test-Path -LiteralPath (Join-Path $UpagentDir "package.json"))) {
    Exit-WithError "upagent 路徑不正確（找不到 package.json）：$UpagentDir"
}

if (-not $ConfigPath) { $ConfigPath = Join-Path $dataDir "config.json" }
if (-not $EnvPath) { $EnvPath = Join-Path $dataDir ".env" }
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Exit-WithError "找不到設定檔：$ConfigPath（範本：templates\config_example.json）"
}
try {
    $config = [System.IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
} catch {
    Exit-WithError "$ConfigPath 格式錯誤：$($_.Exception.Message)"
}
$release = $config.upagentRelease
if (-not $release) { Exit-WithError "$ConfigPath 缺少 upagentRelease（範本：templates\config_example.json）" }
$secrets = Read-DotEnv -Path $EnvPath

if ($StartFrom -eq "Bump") {
    if (-not $Bump) { Exit-WithError "從 Bump 開始時必須指定 -Bump minor 或 -Bump patch。" }
    if (-not $Branch) { Exit-WithError "從 Bump 開始時必須指定 -Branch（upagent 的 feature branch）。" }
    if ($Version) { Exit-WithError "從 Bump 開始時版號由 npm version 決定，不可指定 -Version。" }
} elseif (-not $Version) {
    $Version = Get-PackageVersion
}
if ($RerunAction -and $StartFrom -ne "WaitAction") {
    Exit-WithError "-RerunAction 只能在從 WaitAction 開始時使用。"
}

if ($Version -and $Version -notmatch '^\d+\.\d+\.\d+$') {
    Exit-WithError "版號格式不符（應為 x.y.z）：$Version"
}

try {
    $storageAccount = Get-ConfigValue $release -Name "storageAccount" -Label "upagentRelease.storageAccount" -Default "updayservice"
    $container      = Get-ConfigValue $release -Name "container"      -Label "upagentRelease.container"      -Default "upagent"
    $stagingFolder  = (Get-ConfigValue $release -Name "stagingFolder" -Label "upagentRelease.stagingFolder" -Default "staging").TrimEnd('/')
    $releaseFolder  = (Get-ConfigValue $release -Name "releaseFolder" -Label "upagentRelease.releaseFolder" -Default "releases").TrimEnd('/')

    if (Test-StepEnabled "WaitAction") {
        $github             = $release.github
        $githubOwner        = Get-ConfigValue $github -Name "owner"        -Label "upagentRelease.github.owner"        -Default "artsolutionsdev"
        $githubRepo         = Get-ConfigValue $github -Name "repo"         -Label "upagentRelease.github.repo"         -Default "upagent"
        $githubWorkflowFile = Get-ConfigValue $github -Name "workflowFile" -Label "upagentRelease.github.workflowFile" -Default "release.yml"
        $githubToken        = Get-Secret -Name "GITHUB_TOKEN" -Required
    }

    if (Test-StepEnabled "Sign") {
        $codesign     = $release.codesign
        $signtool     = Get-ConfigValue $codesign -Name "signtool"     -Label "upagentRelease.codesign.signtool"     -Default "C:\Program Files (x86)\Windows Kits\8.1\bin\x86\signtool.exe"
        $certSubject  = Get-ConfigValue $codesign -Name "certSubject"  -Label "upagentRelease.codesign.certSubject"  -Default "ART Solutions Limited"
        $timestampUrl = Get-ConfigValue $codesign -Name "timestampUrl" -Label "upagentRelease.codesign.timestampUrl" -Default "http://timestamp.globalsign.com/tsa/r6advanced1"
        if (-not (Test-Path -LiteralPath $signtool)) { throw "找不到 signtool：$signtool" }
    }

    # 每個環境的 SaaS / Local 各自的資料庫：upagentRelease.db.test_saas / test_local / prod_saas / prod_local，
    # 密碼在 .env 的 UPAGENT_DB_<代號>_PASSWORD
    $dbKey      = "${Environment}_$Target"
    $db         = if ($release.db) { $release.db.$dbKey } else { $null }
    $dbLabel    = "upagentRelease.db.$dbKey"
    $psqlPath   = Get-ConfigValue $db -Name "psql"    -Label "$dbLabel.psql"    -Default "psql"
    $dbHost     = Get-ConfigValue $db -Name "host"    -Label "$dbLabel.host"    -Required
    $dbPort     = Get-ConfigValue $db -Name "port"    -Label "$dbLabel.port"    -Default "5432"
    $dbName     = Get-ConfigValue $db -Name "dbname"  -Label "$dbLabel.dbname"  -Required
    $dbUser     = Get-ConfigValue $db -Name "user"    -Label "$dbLabel.user"    -Required
    $dbPassword = Get-Secret -Name "UPAGENT_DB_$($dbKey.ToUpper())_PASSWORD" -Required
    $dbSslMode  = Get-ConfigValue $db -Name "sslmode" -Label "$dbLabel.sslmode" -Default "require"
    if (-not (Get-Command $psqlPath -ErrorAction SilentlyContinue)) { throw "找不到 psql：$psqlPath" }
} catch {
    Exit-WithError "設定有誤：$($_.Exception.Message)"
}

if ((Test-StepEnabled "Download") -and $Steps.IndexOf($StartFrom) -le $Steps.IndexOf("CleanStaging")) {
    $account = az account show 2>$null
    if (-not $account) { Exit-WithError "尚未登入 Azure CLI，請先執行 az login" }
}

# ---------------------------------------------------------------------------
# 執行計畫
# ---------------------------------------------------------------------------

$plannedVersion = if ($StartFrom -eq "Bump") { Get-NextVersion -Current (Get-PackageVersion) -Kind $Bump } else { $Version }

Write-Host "=== UpAgent 發佈計畫（$EnvLabel）==="
if ($StartFrom -eq "Bump") {
    Write-Host "版號      : $(Get-PackageVersion) -> 預計 $plannedVersion（$Branch 上 npm version $Bump，以 pull 後的實際結果為準）"
} else {
    Write-Host "::version::$Version"
    Write-Host "版號      : $Version（從 $StartFrom 接續）"
}
Write-Host "執行步驟  : $(($Steps | Where-Object { Test-StepEnabled $_ }) -join ' -> ')"
Write-Host "Blob      : $storageAccount/$container（staging: $stagingFolder/，發佈: $releaseFolder/）"
Write-Host "資料庫    : $dbUser@${dbHost}:$dbPort/$dbName（$EnvLabel）"
Write-Host "備註      : $Remark"

try {
    # -----------------------------------------------------------------------
    # 1. Bump：更版並 push tag
    # -----------------------------------------------------------------------

    if (Test-StepEnabled "Bump") {
        Write-StepHeader -Step "Bump" -Title "更版並 push tag"
        Push-Location $UpagentDir
        # 記下原本所在的 branch，做完切回去（detached HEAD 時為 "HEAD"，就不切回）
        $originalBranch = "$(Invoke-Native -FilePath "git" -Arguments @("rev-parse", "--abbrev-ref", "HEAD") -Context "取得目前 branch")".Trim()
        try {
            if (Invoke-Native -FilePath "git" -Arguments @("status", "--porcelain") -Context "git status") {
                throw "upagent 有未提交的變更，切換 branch 與 npm version 需要乾淨的工作目錄。"
            }
            Invoke-Native -FilePath "git" -Arguments @("fetch", "--tags", "origin") -Context "git fetch" | Out-Null
            Invoke-Native -FilePath "git" -Arguments @("checkout", $Branch) -Context "git checkout $Branch" | Out-Null
            Invoke-Native -FilePath "git" -Arguments @("pull", "--ff-only", "origin", $Branch) -Context "git pull" | Out-Null

            # 確認 Confirm Commit 的 commit 已在 feature branch 中：這個版本必須包含測試通過的程式
            if ($ExpectedCommit) {
                $expected = "$(Invoke-Native -FilePath "git" -Arguments @("rev-parse", "--verify", "$ExpectedCommit^{commit}") -Context "找不到 Confirm Commit 的 $ExpectedCommit")".Trim()
                $global:LASTEXITCODE = 0
                & git merge-base --is-ancestor $expected HEAD
                if ($LASTEXITCODE -ne 0) {
                    throw "Confirm Commit 的 $ExpectedCommit 不在 $Branch 中，請先把它 merge 進 $Branch 再發佈。"
                }
                $extra = @(Invoke-Native -FilePath "git" -Arguments @("log", "--oneline", "--no-decorate", "$expected..HEAD") -Context "列出多出的 commit" | Where-Object { $_ })
                if ($extra.Count) {
                    Write-Host "⚠ $Branch 比 Confirm Commit（$ExpectedCommit）多出 $($extra.Count) 個 commit，會一起進到這個版本："
                    $extra | Select-Object -First 20 | ForEach-Object { Write-Host "    $_" }
                }
            }

            Invoke-Native -FilePath "npm" -Arguments @("version", $Bump) -Context "npm version $Bump" | Out-Null
            $Version = Get-PackageVersion
            $tag = "v$Version"
            Write-Host "::version::$Version"
            Write-Host "已在 $Branch 更版為 $Version（tag $tag）"

            # --atomic：commit 與 tag 要嘛一起上去、要嘛都不上去，避免 tag 指向遠端不存在的 commit
            Invoke-Native -FilePath "git" -Arguments @("push", "--atomic", "origin", $Branch, $tag) -Context "git push" | Out-Null
            Write-Host "已 push $Branch 與 $tag"
        } finally {
            if ($originalBranch -and $originalBranch -ne "HEAD" -and $originalBranch -ne $Branch) {
                $global:LASTEXITCODE = 0
                & git checkout $originalBranch | Out-Null
                if ($LASTEXITCODE -eq 0) { Write-Host "已切回 $originalBranch" }
                else { Write-Host "⚠ 無法切回原本的 branch $originalBranch，請手動處理" }
            }
            Pop-Location
        }
        Complete-Step "Bump"
    }

    # 下載 / 簽署的檔案放在 data\upagent_release\<版號>\（data\ 不進 git）
    $releaseRoot = Join-Path $dataDir "upagent_release"
    $releaseDir  = Join-Path $releaseRoot $Version

    # -----------------------------------------------------------------------
    # 2. WaitAction：等待 GitHub Release workflow 成功
    # -----------------------------------------------------------------------

    if (Test-StepEnabled "WaitAction") {
        Write-StepHeader -Step "WaitAction" -Title "等待 GitHub Action"

        $sha = (Invoke-Native -FilePath "git" -Arguments @("-C", $UpagentDir, "rev-list", "-n", "1", "v$Version") -Context "取得 v$Version 的 commit").Trim()
        $runsPath = "actions/workflows/$githubWorkflowFile/runs?event=push&head_sha=$sha"

        $run = $null
        $deadline = (Get-Date).AddMinutes($ActionAppearMinutes)
        while (-not $run) {
            $runs = Invoke-GitHubApi -Path $runsPath
            $run = @($runs.workflow_runs | Sort-Object created_at -Descending) | Select-Object -First 1
            if ($run) { break }
            if ((Get-Date) -gt $deadline) {
                throw "$ActionAppearMinutes 分鐘內沒有出現 v$Version 的 workflow run，請確認 tag 是否已 push。"
            }
            Write-Host "  尚未看到 workflow run，$ActionPollSeconds 秒後重試..."
            Start-Sleep -Seconds $ActionPollSeconds
        }

        Write-Host "Workflow run：$($run.html_url)"

        if ($RerunAction) {
            # 整個 run 重跑（同一個 run id，run_attempt + 1）；只有已結束且未成功的 run 才需要
            $run = Invoke-GitHubApi -Path "actions/runs/$($run.id)"
            if ($run.status -ne "completed") {
                Write-Host "Workflow run 仍在執行中（$($run.status)），不重跑，直接等待結果。"
            } elseif ($run.conclusion -eq "success") {
                Write-Host "Workflow run 已成功，不需重跑。"
            } else {
                $prevAttempt = [int]$run.run_attempt
                Write-Host "重跑整個 workflow run（目前第 $prevAttempt 次，結果 $($run.conclusion)）..."
                try {
                    Invoke-GitHubApi -Path "actions/runs/$($run.id)/rerun" -Method Post | Out-Null
                } catch {
                    $code = $_.Exception.Response.StatusCode.value__
                    if ($code -eq 403 -or $code -eq 404) {
                        throw "重跑 workflow 失敗（HTTP $code）：GitHub token 需要 upagent repo 的 Actions 寫入權限（Fine-grained: Actions Read and write；Classic: repo）。"
                    }
                    throw "重跑 workflow 失敗：$($_.Exception.Message)"
                }
                # 送出後 API 可能還回傳上一次的結果；等 run_attempt 變大後才開始判斷，避免誤判又失敗
                $attemptDeadline = (Get-Date).AddMinutes(2)
                while ([int]$run.run_attempt -le $prevAttempt) {
                    if ((Get-Date) -gt $attemptDeadline) {
                        throw "已送出重跑，但 2 分鐘內沒有看到新的執行（attempt $($prevAttempt + 1)），請至 $($run.html_url) 確認後再重試。"
                    }
                    Start-Sleep -Seconds 5
                    $run = Invoke-GitHubApi -Path "actions/runs/$($run.id)"
                }
                Write-Host "已開始第 $($run.run_attempt) 次執行。"
            }
        }

        $started    = Get-Date
        $deadline   = $started.AddMinutes($ActionTimeoutMinutes)
        $lastStatus = $null
        while ($true) {
            $run  = Invoke-GitHubApi -Path "actions/runs/$($run.id)"
            $jobs = Invoke-GitHubApi -Path "actions/runs/$($run.id)/jobs"
            $status = ($jobs.jobs | ForEach-Object { "$($_.name)=$(if ($_.conclusion) { $_.conclusion } else { $_.status })" }) -join ", "
            if ($status -ne $lastStatus) {
                Write-Host ("  [{0:mm\:ss}] {1}" -f ((Get-Date) - $started), $status)
                $lastStatus = $status
            }

            if ($run.status -eq "completed") { break }
            if ((Get-Date) -gt $deadline) {
                throw "等待超過 $ActionTimeoutMinutes 分鐘仍未完成，請至 $($run.html_url) 確認；完成後重試即可接續。"
            }
            Start-Sleep -Seconds $ActionPollSeconds
        }

        if ($run.conclusion -ne "success") {
            throw "Workflow 結果為 $($run.conclusion)，中止發佈：$($run.html_url)"
        }
        Write-Host "GitHub Action 執行成功。"
        Complete-Step "WaitAction"
    }

    # -----------------------------------------------------------------------
    # 3. Download：把 staging/<版號>/ 抓回地端
    # -----------------------------------------------------------------------

    if (Test-StepEnabled "Download") {
        Write-StepHeader -Step "Download" -Title "下載 staging 檔案"
        Invoke-ChildScript -Name "1-Get-BlobArtifacts.ps1" -Arguments @{
            Version            = $Version
            StorageAccountName = $storageAccount
            ContainerName      = $container
            SourceFolder       = $stagingFolder
            DestinationRoot    = $releaseRoot
        }
        # 1-Get-BlobArtifacts.ps1 在「找不到檔案」時以 exit 0 結束，這裡要自己確認真的抓到了
        if (-not (Test-Path -LiteralPath (Join-Path $releaseDir "latest.yml"))) {
            throw "$releaseDir 底下沒有 latest.yml，staging/$Version/ 可能尚未上傳完成。"
        }
        Complete-Step "Download"
    }

    # -----------------------------------------------------------------------
    # 4. Sign：HSM 簽署 Windows 安裝檔
    # -----------------------------------------------------------------------

    if (Test-StepEnabled "Sign") {
        Write-StepHeader -Step "Sign" -Title "簽署 Windows 安裝檔"
        $exes = @(Get-ChildItem -LiteralPath $releaseDir -Filter "*.exe" -File)
        if ($exes.Count -ne 1) {
            throw "$releaseDir 底下應恰有一個 .exe，實際找到 $($exes.Count) 個。"
        }
        $exe = $exes[0].FullName

        $signature = Get-AuthenticodeSignature -LiteralPath $exe
        if ($signature.Status -eq "Valid" -and $signature.SignerCertificate.Subject -like "*$certSubject*") {
            Write-Host "已是由 $certSubject 簽署的有效簽章，略過簽署：$exe"
        } else {
            # 非互動執行：不等使用者按 Enter，HSM 需在開始前插上；簽署時 HSM 驅動程式會跳出 PIN 輸入視窗
            Write-Host "簽署對象：$exe（請在跳出的視窗輸入 HSM PIN）"
            $global:LASTEXITCODE = 0
            & $signtool sign /v /n $certSubject /tr $timestampUrl /td SHA256 $exe | Out-Host
            if ($LASTEXITCODE -ne 0) {
                throw "signtool 失敗（退出碼 $LASTEXITCODE）。請確認 HSM USB 已插上，再重試即可從簽署步驟接續。"
            }

            $signature = Get-AuthenticodeSignature -LiteralPath $exe
            if ($signature.Status -ne "Valid") {
                throw "簽署後驗證失敗：$($signature.Status) $($signature.StatusMessage)"
            }
            Write-Host "簽署完成，簽章有效（$($signature.SignerCertificate.Subject)）。"
        }
        Complete-Step "Sign"
    }

    # -----------------------------------------------------------------------
    # 5. UpdateYml：依簽署後的 exe 重算 latest.yml
    # -----------------------------------------------------------------------

    if (Test-StepEnabled "UpdateYml") {
        Write-StepHeader -Step "UpdateYml" -Title "重算 latest.yml"
        Invoke-ChildScript -Name "2-Update-LatestYml.ps1" -Arguments @{ ReleasePath = $releaseDir; UpagentDir = $UpagentDir }
        Complete-Step "UpdateYml"
    }

    # -----------------------------------------------------------------------
    # 6. Publish：上傳到 releases/<版號>/
    # -----------------------------------------------------------------------

    if (Test-StepEnabled "Publish") {
        Write-StepHeader -Step "Publish" -Title "上傳到正式發佈位置"
        # 非互動執行：一律帶 -Yes 略過 3-Publish-BlobArtifacts.ps1 的確認
        Invoke-ChildScript -Name "3-Publish-BlobArtifacts.ps1" -Arguments @{
            SourcePath         = $releaseDir
            StorageAccountName = $storageAccount
            ContainerName      = $container
            DestFolder         = $releaseFolder
            Yes                = $true
        }

        # 必須確認 manifest 真的上去了，否則接下來清掉 staging 就沒有回頭路
        $exists = Invoke-Native -FilePath "az" -Context "確認 latest.yml 已發佈" -Arguments @(
            "storage", "blob", "exists",
            "--account-name", $storageAccount,
            "--container-name", $container,
            "--name", "$releaseFolder/$Version/latest.yml",
            "--auth-mode", "login",
            "--query", "exists", "--output", "tsv"
        )
        if (($exists -join "").Trim() -ne "true") {
            throw "$releaseFolder/$Version/latest.yml 不在 Blob 上，發佈未完成，停止後續步驟。"
        }
        Complete-Step "Publish"
    }

    # -----------------------------------------------------------------------
    # 7. CleanStaging：清空 staging/
    # -----------------------------------------------------------------------

    if (Test-StepEnabled "CleanStaging") {
        Write-StepHeader -Step "CleanStaging" -Title "清空 staging"
        # --query 不可含括號：az 在 Windows 是 az.cmd，參數裡的 ) 會被 cmd 當成區塊結尾而解析失敗
        $names = Invoke-Native -FilePath "az" -Context "列出 staging" -Arguments @(
            "storage", "blob", "list",
            "--account-name", $storageAccount,
            "--container-name", $container,
            "--prefix", "$stagingFolder/",
            "--auth-mode", "login",
            "--query", "[].name", "--output", "tsv"
        )
        $count = @($names | Where-Object { $_ -and $_.Trim() }).Count
        if ($count -eq 0) {
            Write-Host "$stagingFolder/ 已是空的。"
        } else {
            Invoke-Native -FilePath "az" -Context "刪除 staging" -Arguments @(
                "storage", "blob", "delete-batch",
                "--account-name", $storageAccount,
                "--source", $container,
                "--pattern", "$stagingFolder/*",
                "--auth-mode", "login",
                "--output", "none"
            ) | Out-Null
            Write-Host "已刪除 $stagingFolder/ 底下 $count 個檔案。"
        }
        Complete-Step "CleanStaging"
    }

    # -----------------------------------------------------------------------
    # 8. Database：在指定環境的資料庫新增 UpAgentRelease 紀錄
    # -----------------------------------------------------------------------

    $folderUrl = "https://$storageAccount.blob.core.windows.net/$container/$releaseFolder/$Version/"

    if (Test-StepEnabled "Database") {
        Write-StepHeader -Step "Database" -Title "寫入 $EnvLabel public_db_upagentrelease"

        # $Version 已通過 x.y.z 格式檢查，可直接嵌入 SQL
        $existing = Invoke-Psql -Arguments @("-tA", "-c", "SELECT count(*) FROM public.public_db_upagentrelease WHERE version = '$Version'")
        if ([int](($existing -join "").Trim()) -gt 0) {
            Write-Host "$EnvLabel 資料庫已有 $Version 的紀錄，略過寫入。"
        } else {
            $releasedOn = Get-Date -Format "yyyy-MM-dd HH:mm:ss"   # naive timestamp（USE_TZ=False，不要帶時區）
            $remarkSql  = $Remark -replace "'", "''"
            $sql = @"
INSERT INTO public.public_db_upagentrelease
    (version, folder_url, released_on, remark, created_on)
VALUES
    (
        '$Version',
        '$folderUrl',
        '$releasedOn',
        '$remarkSql'
        , now()
    );
"@
            Write-Host $sql

            # 備註可能含中文，走 UTF-8 檔案 + psql -f，避開 PowerShell 5.1 傳原生指令參數時的編碼轉換
            $sqlFile = Join-Path ([System.IO.Path]::GetTempPath()) ("upagent-release-{0}.sql" -f ([guid]::NewGuid().ToString('N')))
            [System.IO.File]::WriteAllText($sqlFile, $sql, (New-Object System.Text.UTF8Encoding($false)))
            try {
                Invoke-Psql -Arguments @("-f", $sqlFile) | Out-Host
            } finally {
                Remove-Item -LiteralPath $sqlFile -Force -ErrorAction SilentlyContinue
            }

            $log = "`n`n-- [${Environment}_$Target] $dbUser@${dbHost}:$dbPort/$dbName $releasedOn`n$sql"
            [System.IO.File]::AppendAllText((Join-Path $dataDir "upagent_release.sql"), $log, (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "已寫入 $EnvLabel 資料庫，並附加到 data\upagent_release.sql。"
        }
        Complete-Step "Database"
    }
} catch {
    Exit-WithError "UpAgent 發佈中止（$($_.Exception.Message)）"
}

if ($Out) {
    $result = [ordered]@{
        version     = $Version
        environment = $Environment
        target      = $Target
        startFrom   = $StartFrom
        steps       = $completedSteps
        folderUrl   = $folderUrl
    }
    [System.IO.File]::WriteAllText($Out, ($result | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))
}

Write-Host ""
Write-Host "=== UpAgent $Version 發佈完成（$EnvLabel）==="
