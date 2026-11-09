<#
.SYNOPSIS
    UpAgent 一鍵發佈：從更版、等 GitHub Action、抓檔、簽署、重算 latest.yml、上傳、清 staging 到寫入資料庫，一次跑完。

.DESCRIPTION
    依序執行以下步驟（括號內為 -StartFrom 可用的步驟名稱）：

      1. (Bump)         upagent 切到 main、pull、npm version <minor|patch>，push commit 與 tag 觸發 Release action
      2. (WaitAction)   以 GitHub REST API 輪詢該 tag 對應的 Release workflow，直到成功（失敗即中止）
      3. (Download)     呼叫 1-Get-BlobArtifacts.ps1 把 staging/<版號>/ 抓回 .manage\release\<版號>\
      4. (Sign)         等待插上 HSM USB，以 signtool 重簽 Windows 安裝檔（只簽 .exe），並驗證簽章
      5. (UpdateYml)    呼叫 2-Update-LatestYml.ps1 依簽署後的 exe 重算 latest.yml / .blockmap
      6. (Publish)      呼叫 3-Publish-BlobArtifacts.ps1 上傳到 releases/<版號>/，並確認 latest.yml 確實已在 Blob 上
      7. (CleanStaging) 刪除 Blob 中 staging/ 底下的所有檔案
      8. (Database)     在 public.public_db_upagentrelease 新增此版本紀錄，並把執行的 SQL 附加到 upagent_release.sql

    連線資訊一律讀取同目錄下的 .config（INI 格式），用到的區段：
      [upagent_release]  storage_account / container / staging_folder / release_folder
      [github]           owner / repo / workflow_file / token
      [codesign]         signtool / cert_subject / timestamp_url
      [upagent_db]       psql / host / port / dbname / user / password / sslmode
    GitHub token 與資料庫密碼也可改用環境變數 GITHUB_TOKEN / PGPASSWORD，環境變數優先度高於 .config。

    需要人工介入的地方：
      - 開始前確認一次執行計畫（-Yes 可略過）
      - 步驟 4 插上 HSM 並輸入 PIN（無法略過）
      - 步驟 6 上傳前 3-Publish-BlobArtifacts.ps1 的確認（-Yes 可略過）
      - 步驟 8 寫入資料庫前確認 SQL（-Yes 可略過）
    備註（remark）會在開始時先問，之後的步驟就能無人值守跑到簽署。

    執行位置：
      cd C:\Users\DanielLi\Documents\crmapp_AI
      .\.manage\scripts\Release-UpAgent.ps1 -Bump minor

.PARAMETER Bump
    版號遞增方式：minor 或 patch。從 Bump 步驟開始時必填

.PARAMETER StartFrom
    從哪一步開始（中途失敗修正後接續用），預設 Bump。
    從 Bump 之後的步驟開始時，版號取 upagent\package.json 目前的 version（npm version 已改過它），或用 -Version 指定

.PARAMETER Version
    接續執行時明確指定版號，例如 1.3.0。從 Bump 開始時不可指定

.PARAMETER Remark
    寫入資料庫的備註；不指定時於開始時詢問（可留空）

.PARAMETER ConfigPath
    設定檔路徑，預設與本腳本同目錄的 .config

.PARAMETER Yes
    略過所有互動確認（HSM 插入與 PIN 輸入除外）

.EXAMPLE
    # 正式發佈 minor 版
    .\.manage\scripts\Release-UpAgent.ps1 -Bump minor -Remark "新增檔案上傳功能"

.EXAMPLE
    # 簽署那步失敗，排除後從簽署接續
    .\.manage\scripts\Release-UpAgent.ps1 -StartFrom Sign

.EXAMPLE
    # 只補寫資料庫紀錄
    .\.manage\scripts\Release-UpAgent.ps1 -StartFrom Database -Version 1.3.0 -Remark "Sprint 20 Release"
#>

[CmdletBinding()]
param(
    [ValidateSet("minor", "patch")]
    [string]$Bump,

    [ValidateSet("Bump", "WaitAction", "Download", "Sign", "UpdateYml", "Publish", "CleanStaging", "Database")]
    [string]$StartFrom = "Bump",

    [string]$Version,

    [string]$Remark,

    [string]$ConfigPath,

    [switch]$Yes
)

$ErrorActionPreference = "Stop"

$Steps = @("Bump", "WaitAction", "Download", "Sign", "UpdateYml", "Publish", "CleanStaging", "Database")

# GitHub Action 輪詢設定
$ActionPollSeconds    = 30
$ActionAppearMinutes  = 10    # push tag 後多久內必須出現 workflow run
$ActionTimeoutMinutes = 120   # 整個 workflow 最長等待時間（macOS 建置較久）

# ---------------------------------------------------------------------------
# 共用函式
# ---------------------------------------------------------------------------

function Read-IniFile {
    <# 讀取 INI：# 或 ; 開頭為註解，key = value，區段名稱與 key 皆不分大小寫 #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $ini = @{}
    $section = $null
    foreach ($raw in [System.IO.File]::ReadAllLines($Path)) {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#') -or $line.StartsWith(';')) { continue }
        if ($line -match '^\[(?<s>.+)\]$') {
            $section = $Matches['s'].Trim()
            if (-not $ini.ContainsKey($section)) { $ini[$section] = @{} }
            continue
        }
        if ($section -and $line -match '^(?<k>[^=]+?)\s*=\s*(?<v>.*)$') {
            $ini[$section][$Matches['k']] = $Matches['v'].Trim()
        }
    }
    return $ini
}

function Get-Setting {
    param(
        [Parameter(Mandatory = $true)][string]$Section,
        [Parameter(Mandatory = $true)][string]$Key,
        [string]$Default,
        [string]$EnvName,
        [switch]$Required
    )
    $value = $null
    if ($EnvName) { $value = [Environment]::GetEnvironmentVariable($EnvName) }
    if (-not $value -and $config.ContainsKey($Section)) { $value = $config[$Section][$Key] }
    if (-not $value) { $value = $Default }
    if ($Required -and -not $value) {
        throw ".config 缺少 [$Section] $Key$(if ($EnvName) { "（或環境變數 $EnvName）" })"
    }
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
    <# 呼叫 1/2/3 腳本；它們以 exit <碼> 回報結果 #>
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [hashtable]$Arguments = @{}
    )
    $global:LASTEXITCODE = 0
    & (Join-Path $PSScriptRoot $Name) @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Name 失敗（退出碼 $LASTEXITCODE）"
    }
}

function Confirm-OrExit {
    param([string]$Message)
    if ($Yes) { return }
    $answer = Read-Host "$Message 請輸入 yes 繼續"
    if ($answer -ne "yes") {
        Write-Host "已取消。" -ForegroundColor Yellow
        exit 0
    }
}

function Test-StepEnabled {
    param([string]$Step)
    return ($Steps.IndexOf($Step) -ge $Steps.IndexOf($StartFrom))
}

function Write-StepHeader {
    param([string]$Step, [string]$Title)
    Write-Host ""
    Write-Host ("==== [{0}/{1}] {2}（{3}）====" -f ($Steps.IndexOf($Step) + 1), $Steps.Count, $Title, $Step) -ForegroundColor Cyan
}

function Get-PackageVersion {
    $json = [System.IO.File]::ReadAllText((Join-Path $upagentDir "package.json")) | ConvertFrom-Json
    return $json.version
}

function Get-NextVersion {
    param([string]$Current, [string]$Kind)
    $parts = $Current -split '\.' | ForEach-Object { [int]$_ }
    if ($Kind -eq "minor") { return "{0}.{1}.0" -f $parts[0], ($parts[1] + 1) }
    return "{0}.{1}.{2}" -f $parts[0], $parts[1], ($parts[2] + 1)
}

function Invoke-GitHubApi {
    param([Parameter(Mandatory = $true)][string]$Path)
    $headers = @{
        "Authorization"        = "Bearer $githubToken"
        "Accept"               = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent"           = "upagent-release-script"
    }
    return Invoke-RestMethod -Uri "https://api.github.com/repos/$githubOwner/$githubRepo/$Path" -Headers $headers -Method Get
}

function Invoke-Psql {
    <# 以 .config 的連線資訊執行 psql；密碼走 PGPASSWORD，執行完還原成原值，不留在目前的 PowerShell 工作階段 #>
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

$repoRoot   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$upagentDir = Join-Path $repoRoot "upagent"

if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot ".config" }
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-Host "找不到設定檔：$ConfigPath" -ForegroundColor Red
    exit 1
}
$config = Read-IniFile -Path $ConfigPath

if ($StartFrom -eq "Bump") {
    if (-not $Bump) {
        Write-Host "從 Bump 開始時必須指定 -Bump minor 或 -Bump patch。" -ForegroundColor Red
        exit 1
    }
    if ($Version) {
        Write-Host "從 Bump 開始時版號由 npm version 決定，不可指定 -Version。" -ForegroundColor Red
        exit 1
    }
} elseif (-not $Version) {
    $Version = Get-PackageVersion
}

if ($Version -and $Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Host "版號格式不符（應為 x.y.z）：$Version" -ForegroundColor Red
    exit 1
}

try {
    $storageAccount = Get-Setting -Section "upagent_release" -Key "storage_account" -Default "updayservice"
    $container      = Get-Setting -Section "upagent_release" -Key "container"       -Default "upagent"
    $stagingFolder  = (Get-Setting -Section "upagent_release" -Key "staging_folder" -Default "staging").TrimEnd('/')
    $releaseFolder  = (Get-Setting -Section "upagent_release" -Key "release_folder" -Default "releases").TrimEnd('/')

    if (Test-StepEnabled "WaitAction") {
        $githubOwner        = Get-Setting -Section "github" -Key "owner"         -Default "artsolutionsdev"
        $githubRepo         = Get-Setting -Section "github" -Key "repo"          -Default "upagent"
        $githubWorkflowFile = Get-Setting -Section "github" -Key "workflow_file" -Default "release.yml"
        $githubToken        = Get-Setting -Section "github" -Key "token" -EnvName "GITHUB_TOKEN" -Required
    }

    if (Test-StepEnabled "Sign") {
        $signtool     = Get-Setting -Section "codesign" -Key "signtool"      -Default "C:\Program Files (x86)\Windows Kits\8.1\bin\x86\signtool.exe"
        $certSubject  = Get-Setting -Section "codesign" -Key "cert_subject"  -Default "ART Solutions Limited"
        $timestampUrl = Get-Setting -Section "codesign" -Key "timestamp_url" -Default "http://timestamp.globalsign.com/tsa/r6advanced1"
        if (-not (Test-Path -LiteralPath $signtool)) { throw "找不到 signtool：$signtool" }
    }

    if (Test-StepEnabled "Database") {
        $psqlPath   = Get-Setting -Section "upagent_db" -Key "psql"     -Default "psql"
        $dbHost     = Get-Setting -Section "upagent_db" -Key "host"     -Required
        $dbPort     = Get-Setting -Section "upagent_db" -Key "port"     -Default "5432"
        $dbName     = Get-Setting -Section "upagent_db" -Key "dbname"   -Required
        $dbUser     = Get-Setting -Section "upagent_db" -Key "user"     -Required
        $dbPassword = Get-Setting -Section "upagent_db" -Key "password" -EnvName "PGPASSWORD" -Required
        $dbSslMode  = Get-Setting -Section "upagent_db" -Key "sslmode"  -Default "require"
        if (-not (Get-Command $psqlPath -ErrorAction SilentlyContinue)) { throw "找不到 psql：$psqlPath" }
    }
} catch {
    Write-Host "設定有誤：$_" -ForegroundColor Red
    exit 1
}

if ((Test-StepEnabled "Download") -or (Test-StepEnabled "Publish") -or (Test-StepEnabled "CleanStaging")) {
    $account = az account show 2>$null
    if (-not $account) {
        Write-Host "尚未登入 Azure CLI，請先執行 az login" -ForegroundColor Red
        exit 1
    }
}

# ---------------------------------------------------------------------------
# 執行計畫確認
# ---------------------------------------------------------------------------

$plannedVersion = if ($StartFrom -eq "Bump") { Get-NextVersion -Current (Get-PackageVersion) -Kind $Bump } else { $Version }

if ((Test-StepEnabled "Database") -and -not $PSBoundParameters.ContainsKey("Remark")) {
    $Remark = Read-Host "請輸入 $plannedVersion 的資料庫備註 remark（可留空）"
}

Write-Host ""
Write-Host "=== UpAgent 發佈計畫 ===" -ForegroundColor Cyan
if ($StartFrom -eq "Bump") {
    Write-Host "版號      : $(Get-PackageVersion) -> 預計 $plannedVersion（npm version $Bump，以 pull 後的實際結果為準）"
} else {
    Write-Host "版號      : $Version（從 $StartFrom 接續）"
}
Write-Host "執行步驟  : $(($Steps | Where-Object { Test-StepEnabled $_ }) -join ' -> ')"
Write-Host "Blob      : $storageAccount/$container（staging: $stagingFolder/，發佈: $releaseFolder/）"
if (Test-StepEnabled "Database") {
    Write-Host "資料庫    : $dbUser@${dbHost}:$dbPort/$dbName"
    Write-Host "備註      : $Remark"
}
Write-Host ""
Confirm-OrExit -Message "確認以上計畫？"

try {
# ---------------------------------------------------------------------------
# 1. Bump：更版並 push tag
# ---------------------------------------------------------------------------

if (Test-StepEnabled "Bump") {
    Write-StepHeader -Step "Bump" -Title "更版並 push tag"
    Push-Location $upagentDir
    try {
        Invoke-Native -FilePath "git" -Arguments @("checkout", "main") -Context "git checkout main" | Out-Null
        if (Invoke-Native -FilePath "git" -Arguments @("status", "--porcelain") -Context "git status") {
            throw "upagent 有未提交的變更，npm version 需要乾淨的工作目錄。"
        }
        Invoke-Native -FilePath "git" -Arguments @("pull", "--ff-only", "--tags", "origin", "main") -Context "git pull" | Out-Null

        Invoke-Native -FilePath "npm" -Arguments @("version", $Bump) -Context "npm version $Bump" | Out-Null
        $Version = Get-PackageVersion
        $tag = "v$Version"
        Write-Host "已更版為 $Version（tag $tag）" -ForegroundColor Green

        # --atomic：commit 與 tag 要嘛一起上去、要嘛都不上去，避免 tag 指向遠端不存在的 commit
        Invoke-Native -FilePath "git" -Arguments @("push", "--atomic", "origin", "main", $tag) -Context "git push" | Out-Null
        Write-Host "已 push main 與 $tag" -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

$releaseDir = Join-Path $repoRoot ".manage\release\$Version"

# ---------------------------------------------------------------------------
# 2. WaitAction：等待 GitHub Release workflow 成功
# ---------------------------------------------------------------------------

if (Test-StepEnabled "WaitAction") {
    Write-StepHeader -Step "WaitAction" -Title "等待 GitHub Action"

    $sha = (Invoke-Native -FilePath "git" -Arguments @("-C", $upagentDir, "rev-list", "-n", "1", "v$Version") -Context "取得 v$Version 的 commit").Trim()
    $runsPath = "actions/workflows/$githubWorkflowFile/runs?event=push&head_sha=$sha"

    $run = $null
    $deadline = (Get-Date).AddMinutes($ActionAppearMinutes)
    while (-not $run) {
        $runs = Invoke-GitHubApi -Path $runsPath
        $run = @($runs.workflow_runs | Sort-Object created_at -Descending) | Select-Object -First 1
        if ($run) { break }
        if ((Get-Date) -gt $deadline) {
            Write-Host "$ActionAppearMinutes 分鐘內沒有出現 v$Version 的 workflow run，請確認 tag 是否已 push。" -ForegroundColor Red
            exit 1
        }
        Write-Host "  尚未看到 workflow run，$ActionPollSeconds 秒後重試..." -ForegroundColor DarkGray
        Start-Sleep -Seconds $ActionPollSeconds
    }

    Write-Host "Workflow run：$($run.html_url)" -ForegroundColor Cyan

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
            Write-Host "等待超過 $ActionTimeoutMinutes 分鐘仍未完成，請至 $($run.html_url) 確認；完成後以 -StartFrom Download 接續。" -ForegroundColor Red
            exit 1
        }
        Start-Sleep -Seconds $ActionPollSeconds
    }

    if ($run.conclusion -ne "success") {
        Write-Host "Workflow 結果為 $($run.conclusion)，中止發佈：$($run.html_url)" -ForegroundColor Red
        exit 1
    }
    Write-Host "GitHub Action 執行成功。" -ForegroundColor Green
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
        }
        # 1-Get-BlobArtifacts.ps1 在「找不到檔案」時以 exit 0 結束，這裡要自己確認真的抓到了
        if (-not (Test-Path -LiteralPath (Join-Path $releaseDir "latest.yml"))) {
            throw "$releaseDir 底下沒有 latest.yml，staging/$Version/ 可能尚未上傳完成。"
        }
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
            Write-Host "已是由 $certSubject 簽署的有效簽章，略過簽署：$exe" -ForegroundColor DarkGray
        } else {
            Write-Host "簽署對象：$exe" -ForegroundColor Yellow
            Read-Host "請插上 HSM USB，準備好後按 Enter（簽署時會跳出 PIN 輸入視窗）" | Out-Null

            while ($true) {
                $global:LASTEXITCODE = 0
                & $signtool sign /v /n $certSubject /tr $timestampUrl /td SHA256 $exe
                if ($LASTEXITCODE -eq 0) { break }
                $answer = Read-Host "signtool 失敗（退出碼 $LASTEXITCODE）。確認 HSM 已插上後輸入 r 重試，其他鍵中止"
                if ($answer -ne "r") { throw "簽署中止。" }
            }

            $signature = Get-AuthenticodeSignature -LiteralPath $exe
            if ($signature.Status -ne "Valid") {
                throw "簽署後驗證失敗：$($signature.Status) $($signature.StatusMessage)"
            }
            Write-Host "簽署完成，簽章有效（$($signature.SignerCertificate.Subject)）。" -ForegroundColor Green
        }
    }

    # -----------------------------------------------------------------------
    # 5. UpdateYml：依簽署後的 exe 重算 latest.yml
    # -----------------------------------------------------------------------

    if (Test-StepEnabled "UpdateYml") {
        Write-StepHeader -Step "UpdateYml" -Title "重算 latest.yml"
        Invoke-ChildScript -Name "2-Update-LatestYml.ps1" -Arguments @{ ReleasePath = $releaseDir }
    }

    # -----------------------------------------------------------------------
    # 6. Publish：上傳到 releases/<版號>/
    # -----------------------------------------------------------------------

    if (Test-StepEnabled "Publish") {
        Write-StepHeader -Step "Publish" -Title "上傳到正式發佈位置"
        $publishArgs = @{
            SourcePath         = $releaseDir
            StorageAccountName = $storageAccount
            ContainerName      = $container
            DestFolder         = $releaseFolder
        }
        if ($Yes) { $publishArgs["Yes"] = $true }
        Invoke-ChildScript -Name "3-Publish-BlobArtifacts.ps1" -Arguments $publishArgs

        # 3-Publish-BlobArtifacts.ps1 在使用者取消時以 exit 0 結束，必須確認 manifest 真的上去了，
        # 否則接下來清掉 staging 就沒有回頭路
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
            Write-Host "$stagingFolder/ 已是空的。" -ForegroundColor DarkGray
        } else {
            Invoke-Native -FilePath "az" -Context "刪除 staging" -Arguments @(
                "storage", "blob", "delete-batch",
                "--account-name", $storageAccount,
                "--source", $container,
                "--pattern", "$stagingFolder/*",
                "--auth-mode", "login",
                "--output", "none"
            ) | Out-Null
            Write-Host "已刪除 $stagingFolder/ 底下 $count 個檔案。" -ForegroundColor Green
        }
    }

    # -----------------------------------------------------------------------
    # 8. Database：新增 UpAgentRelease 紀錄
    # -----------------------------------------------------------------------

    if (Test-StepEnabled "Database") {
        Write-StepHeader -Step "Database" -Title "寫入 public_db_upagentrelease"

        # $Version 已通過 x.y.z 格式檢查，可直接嵌入 SQL
        $existing = Invoke-Psql -Arguments @("-tA", "-c", "SELECT count(*) FROM public.public_db_upagentrelease WHERE version = '$Version'")
        if ([int](($existing -join "").Trim()) -gt 0) {
            Write-Host "資料庫已有 $Version 的紀錄，略過寫入。" -ForegroundColor Yellow
        } else {
            $folderUrl  = "https://$storageAccount.blob.core.windows.net/$container/$releaseFolder/$Version/"
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
            Confirm-OrExit -Message "確認寫入以上紀錄到 $dbName？"

            # 備註可能含中文，走 UTF-8 檔案 + psql -f，避開 PowerShell 5.1 傳原生指令參數時的編碼轉換
            $sqlFile = Join-Path ([System.IO.Path]::GetTempPath()) ("upagent-release-{0}.sql" -f ([guid]::NewGuid().ToString('N')))
            [System.IO.File]::WriteAllText($sqlFile, $sql, (New-Object System.Text.UTF8Encoding($false)))
            try {
                Invoke-Psql -Arguments @("-f", $sqlFile) | Out-Host
            } finally {
                Remove-Item -LiteralPath $sqlFile -Force -ErrorAction SilentlyContinue
            }

            [System.IO.File]::AppendAllText((Join-Path $PSScriptRoot "upagent_release.sql"), "`n`n$sql", (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "已寫入資料庫，並附加到 upagent_release.sql。" -ForegroundColor Green
        }
    }
} catch {
    Write-Host ""
    Write-Host "=== 發佈中止：$_ ===" -ForegroundColor Red
    Write-Host "排除問題後可用以下指令從失敗的步驟接續：" -ForegroundColor Yellow
    Write-Host "  .\.manage\scripts\Release-UpAgent.ps1 -StartFrom <步驟>$(if ($Version) { " -Version $Version" })" -ForegroundColor Yellow
    Write-Host "  步驟：$($Steps -join ' / ')" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "=== UpAgent $Version 發佈完成 ===" -ForegroundColor Green
Write-Host "請以一台已安裝舊版的機器實測更新流程，確認能抓到新版並安裝成功。" -ForegroundColor Cyan
