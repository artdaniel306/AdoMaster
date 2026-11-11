<#
.SYNOPSIS
    UpAgent 發佈流程【子腳本 1／3】：把 GitHub Action 建置後上傳到 Azure Blob 的安裝檔抓回地端。

.DESCRIPTION
    由 Release-UpAgent.ps1 的 Download 步驟呼叫。
    完整發佈流程見 Release-UpAgent.ps1：

      1. 對 UpAgent 更版並 push tag 上 GitHub，觸發 Release action
         (action 以 --publish never 建置，再由 postRelease.js 上傳到 Blob 的 staging/ 前綴)
      2. 【本腳本】確認 action 執行完畢後，把 staging/ 的檔案抓到地端
      3. 以 HSM 簽署安裝檔
      4. 【2-Update-LatestYml.ps1】依「簽署後」的執行檔重算 sha512 / size，更新 latest.yml 與 .blockmap
      5. 【3-Publish-BlobArtifacts.ps1】把地端檔案上傳到 Blob 的 releases/ 前綴（用戶端自動更新讀取的位置）

    本腳本的行為：
      1. 列出來源前綴（預設 staging/）底下所有 Blob
      2. 判斷本次要抓哪個版號：staging/ 現在是「每版一個子資料夾」的佈局
         （對應 postRelease.js 的 versionFolder），且不刪舊檔，因此 staging/ 底下
         會累積多個版本子資料夾、每個都各自有一份 latest.yml。未指定 -Version 時，
         直接從子資料夾名稱（形如 x.y.z）收集候選並以數值比較取最大者，
         **不**依賴 Blob 列表的回傳順序（字典序在版號位數不同時會判斷錯誤，
         例如 "0.10.0" 會排在 "0.9.0" 之前）
      3. 以「版號」過濾要下載的檔案，下載到 <AdoMaster>\data\upagent_release\<版號>\
         （可用 -DestinationRoot 改；下載時會去掉來源路徑中的版本子資料夾這一層，
         不落地成 <版號>\<版號>\ 的雙層巢狀）
      4. 逐檔以 Content-Length 與伺服器端 Content-MD5 驗證下載結果
      5. 印出簽署對象與下一步指令

    執行位置：
      預設下載目錄為 data\upagent_release\（Get-DataRoot：app 以 ADOMASTER_DATA_DIR 指定，單獨執行時為專案根目錄的 data\），不受工作目錄影響；
      若自行指定 -DestinationRoot 相對路徑，則以「當前工作目錄」為基準。

.PARAMETER StorageAccountName
    Storage Account 名稱，預設 updayservice

.PARAMETER ContainerName
    Container 名稱，預設 upagent

.PARAMETER SourceFolder
    來源資料夾前綴，預設 staging（對應 release.yml 的 AZURE_BLOB_PREFIX）

.PARAMETER DestinationRoot
    地端下載根目錄，預設 <專案根>\data\upagent_release；實際檔案會放在該目錄下的 <版號> 子目錄

.PARAMETER Version
    指定要下載的版號（例如 0.6.15）。不指定時從 staging/ 底下的版本子資料夾名稱自動判斷最大版號

.PARAMETER All
    忽略版號過濾，下載來源前綴底下所有檔案（staging/ 累積歷史版本時會抓到很多大檔，請謹慎使用）

.PARAMETER Include
    額外的檔名萬用字元過濾（比對「檔名」，不含前綴路徑），例如 -Include '*.exe','*.blockmap','latest.yml'
    與版號過濾為「且」的關係

.PARAMETER AuthMode
    認證模式：
      - login（預設）：使用目前 az login 的登入身分，需具備 Storage Blob Data Reader 以上權限
      - key：使用 Storage Account 存取金鑰，需搭配 -AccountKey

.PARAMETER AccountKey
    當 -AuthMode key 時必填

.PARAMETER Force
    地端已有同名檔案且內容不符時，強制重新下載覆蓋（預設會略過並在結尾回報）

.PARAMETER DryRun
    僅列出將會下載的檔案與目的路徑，不實際下載

.EXAMPLE
    # 先確認會抓哪些檔案
    .\shell\1-Get-BlobArtifacts.ps1 -DryRun

.EXAMPLE
    # 正式抓檔（使用目前 az login 身分）
    .\shell\1-Get-BlobArtifacts.ps1

.EXAMPLE
    # 只抓 Windows 相關檔案
    .\shell\1-Get-BlobArtifacts.ps1 -Include '*.exe','*.blockmap','latest.yml'

.EXAMPLE
    # 指定版號並使用 Access Key
    .\shell\1-Get-BlobArtifacts.ps1 -Version 0.6.15 -AuthMode key -AccountKey "xxxxxxxx=="
#>

[CmdletBinding()]
param(
    [string]$StorageAccountName = "updayservice",

    [string]$ContainerName = "upagent",

    [string]$SourceFolder = "staging",

    [string]$DestinationRoot,

    [string]$Version,

    [switch]$All,

    [string[]]$Include,

    [ValidateSet("login", "key")]
    [string]$AuthMode = "login",

    [string]$AccountKey,

    [switch]$Force,

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'Common.ps1')

# ---------------------------------------------------------------------------
# 參數整理與前置檢查
# ---------------------------------------------------------------------------

$dataRoot = Get-DataRoot

if (-not $DestinationRoot) {
    $DestinationRoot = Join-Path $dataRoot "upagent_release"
}

$SourceFolder = $SourceFolder.TrimEnd('/') + '/'

if ($AuthMode -eq "key" -and [string]::IsNullOrWhiteSpace($AccountKey)) {
    Write-Host "AuthMode 為 key 時，必須提供 -AccountKey 參數" -ForegroundColor Red
    exit 1
}

Write-Host "=== 檢查 Azure CLI 登入狀態 ===" -ForegroundColor Cyan
$account = az account show 2>$null
if (-not $account) {
    Write-Host "尚未登入 Azure CLI，請先執行 az login" -ForegroundColor Red
    exit 1
}

$authArgs = if ($AuthMode -eq "key") { @("--account-key", $AccountKey) } else { @("--auth-mode", "login") }

# ---------------------------------------------------------------------------
# 列出來源檔案
# ---------------------------------------------------------------------------

Write-Host "=== 列出 $ContainerName/$SourceFolder 底下的檔案 ===" -ForegroundColor Cyan
$blobJson = Invoke-AzCli -Context "列出 Blob" -Arguments (@(
    "storage", "blob", "list",
    "--account-name", $StorageAccountName,
    "--container-name", $ContainerName,
    "--prefix", $SourceFolder
) + $authArgs + @("--output", "json"))

# PowerShell 5.1 的 ConvertFrom-Json 會把整個 JSON 陣列當成「一個物件」輸出，
# 直接寫 @(... | ConvertFrom-Json) 會得到「只含一個陣列的陣列」，必須先落地成變數再包 @()
$blobList = ($blobJson -join "`n") | ConvertFrom-Json
# 排除「資料夾佔位」用的空 Blob
$blobs = @(@($blobList) | Where-Object { $_.name -ne $SourceFolder -and -not $_.name.EndsWith('/') })

if ($blobs.Count -eq 0) {
    Write-Host "來源前綴內沒有任何檔案，結束執行。" -ForegroundColor Yellow
    exit 0
}

Write-Host "共找到 $($blobs.Count) 個檔案。" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 決定版號（未指定時從 staging/ 底下的版本子資料夾名稱判斷）
# ---------------------------------------------------------------------------

$versionFolderPattern = '^(\d+)\.(\d+)\.(\d+)$'

if (-not $All -and -not $Version) {
    # staging/ 底下是「每版一個子資料夾」且會累積歷史版本，每個版本各自有一份 latest.yml，
    # 因此不能再假設「第一筆」就是本次要發的版本，也不能信任 Blob 列表的回傳順序
    # （預設是字典序，"0.10.0" 會排在 "0.9.0" 之前）。改為直接收集所有路徑第一層
    # 看起來像 x.y.z 的資料夾名稱，以數值比較取最大者。
    $versionCandidates = @(
        $blobs |
            ForEach-Object { ($_.name.Substring($SourceFolder.Length) -split '/')[0] } |
            Where-Object { $_ -match $versionFolderPattern } |
            Select-Object -Unique
    )
    if ($versionCandidates.Count -eq 0) {
        Write-Host "$SourceFolder 底下找不到任何形如 x.y.z 的版本子資料夾，無法自動判斷版號。" -ForegroundColor Red
        Write-Host "請改用 -Version <版號> 指定，或用 -All 下載全部檔案。" -ForegroundColor Red
        exit 1
    }

    $Version = $versionCandidates | Sort-Object `
        @{Expression = { [int]($_ -split '\.')[0] }}, `
        @{Expression = { [int]($_ -split '\.')[1] }}, `
        @{Expression = { [int]($_ -split '\.')[2] }} |
        Select-Object -Last 1

    if (-not ($blobs | Where-Object { $_.name -eq "$SourceFolder$Version/latest.yml" })) {
        Write-Host "版本子資料夾 $Version 底下找不到 latest.yml，無法確認這是完整的一次發佈。" -ForegroundColor Red
        Write-Host "請改用 -Version <版號> 指定，或用 -All 下載全部檔案。" -ForegroundColor Red
        exit 1
    }

    Write-Host "從 $SourceFolder 底下的版本子資料夾判斷本次發佈版號為 $Version（候選版本共 $($versionCandidates.Count) 個）" -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# 過濾要下載的檔案
# ---------------------------------------------------------------------------

$selected = $blobs

if (-not $All) {
    # staging/ 現在是「每版一個子資料夾」且會累積歷史版本，每個版本子資料夾底下
    # 都各自有一份固定檔名的 latest.yml；因此不能再靠「檔名是否叫 latest.yml」
    # 來篩選（那樣會連同其他版本的 manifest 一起選中），改成直接比對路徑第一層
    # 的版本子資料夾名稱是否等於目標版號。
    $selected = @($selected | Where-Object {
        (($_.name.Substring($SourceFolder.Length)) -split '/')[0] -eq $Version
    })
}

if ($Include) {
    $selected = @($selected | Where-Object {
        $leaf = Split-Path $_.name -Leaf
        $hit = $false
        foreach ($pattern in $Include) { if ($leaf -like $pattern) { $hit = $true; break } }
        $hit
    })
}

if ($selected.Count -eq 0) {
    Write-Host "過濾後沒有任何檔案符合條件（版號 $Version），結束執行。" -ForegroundColor Yellow
    exit 0
}

$destDir = if ($All -and -not $Version) { $DestinationRoot } else { Join-Path $DestinationRoot $Version }

# $destDir 在有版號時已經是 <DestinationRoot>\<版號>，而來源路徑本身也帶著
# "<版號>/" 這一層（staging/ 的每版子資料夾佈局），兩者相加會落地成
# <版號>\<版號>\ 的雙層巢狀，因此下載時要把來源路徑的版本子資料夾這一層去掉。
$stripVersionSegment = -not ($All -and -not $Version)

Write-Host ""
Write-Host "=== 將下載以下 $($selected.Count) 個檔案 ===" -ForegroundColor Cyan
Write-Host "目的目錄: $destDir" -ForegroundColor Cyan
foreach ($blob in ($selected | Sort-Object name)) {
    Write-Host ("  {0,-12} {1}" -f (Format-Size $blob.properties.contentLength), $blob.name)
}

if ($DryRun) {
    Write-Host ""
    Write-Host "=== DryRun 模式，未實際下載任何檔案 ===" -ForegroundColor Yellow
    exit 0
}

if (-not (Test-Path -LiteralPath $destDir)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
}

# ---------------------------------------------------------------------------
# 逐檔下載並驗證
# ---------------------------------------------------------------------------

$downloaded = 0
$skipped    = 0
$problems   = @()

foreach ($blob in ($selected | Sort-Object name)) {
    $relative = $blob.name.Substring($SourceFolder.Length)
    if ($stripVersionSegment -and $Version -and $relative.StartsWith("$Version/")) {
        $relative = $relative.Substring("$Version/".Length)
    }
    $localPath = Join-Path $destDir $relative
    $localDir  = Split-Path -Parent $localPath
    if (-not (Test-Path -LiteralPath $localDir)) {
        New-Item -ItemType Directory -Path $localDir -Force | Out-Null
    }

    $remoteLength = [long]$blob.properties.contentLength
    $remoteMd5    = $blob.properties.contentSettings.contentMd5

    Write-Host ""
    Write-Host "[下載] $($blob.name)" -ForegroundColor Green

    if ((Test-Path -LiteralPath $localPath) -and -not $Force) {
        $localLength = (Get-Item -LiteralPath $localPath).Length
        $same = ($localLength -eq $remoteLength)
        if ($same -and $remoteMd5) {
            $same = ((Get-FileHashBase64 -Path $localPath -Algorithm MD5) -eq $remoteMd5)
        }
        if ($same) {
            Write-Host "  地端已有相同內容的檔案，略過下載。" -ForegroundColor DarkGray
            $skipped++
            continue
        }
        Write-Host "  地端已有同名但內容不同的檔案，略過下載（需覆蓋請加 -Force）。" -ForegroundColor Yellow
        $problems += "$relative：地端檔案與 Blob 內容不符，未下載"
        continue
    }

    if (Test-Path -LiteralPath $localPath) {
        Remove-Item -LiteralPath $localPath -Force
    }

    try {
        Invoke-AzCli -Context "下載 $($blob.name)" -Arguments (@(
            "storage", "blob", "download",
            "--account-name", $StorageAccountName,
            "--container-name", $ContainerName,
            "--name", $blob.name,
            "--file", $localPath,
            "--no-progress"
        ) + $authArgs + @("--output", "none")) | Out-Null

        $localLength = (Get-Item -LiteralPath $localPath).Length
        if ($localLength -ne $remoteLength) {
            throw "檔案大小不符：Blob $remoteLength bytes，地端 $localLength bytes"
        }
        if ($remoteMd5) {
            $localMd5 = Get-FileHashBase64 -Path $localPath -Algorithm MD5
            if ($localMd5 -ne $remoteMd5) {
                throw "Content-MD5 不符：Blob $remoteMd5，地端 $localMd5"
            }
            Write-Host "  已下載並通過 MD5 驗證（$(Format-Size $localLength)）" -ForegroundColor Green
        } else {
            Write-Host "  已下載，大小相符（$(Format-Size $localLength)）；Blob 未帶 Content-MD5，略過雜湊比對。" -ForegroundColor Green
        }
        $downloaded++
    } catch {
        Write-Host "  下載失敗: $_" -ForegroundColor Red
        $problems += "$relative：$_"
        if (Test-Path -LiteralPath $localPath) { Remove-Item -LiteralPath $localPath -Force }
    }
}

# ---------------------------------------------------------------------------
# 結果與下一步
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "=== 下載結果 ===" -ForegroundColor Cyan
Write-Host "新下載: $downloaded 個檔案" -ForegroundColor Green
Write-Host "略過  : $skipped 個檔案" -ForegroundColor DarkGray
Write-Host "問題  : $($problems.Count) 個檔案" -ForegroundColor $(if ($problems.Count -gt 0) { "Red" } else { "Green" })
foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }

if ($problems.Count -gt 0) {
    Write-Host ""
    Write-Host "有檔案未成功取得，請先排除後再進行簽署。" -ForegroundColor Red
    exit 1
}

$installers = @(Get-ChildItem -LiteralPath $destDir -File | Where-Object { $_.Extension -in @(".exe", ".dmg", ".AppImage", ".deb") })

Write-Host ""
Write-Host "=== 下一步：簽署 ===" -ForegroundColor Cyan
Write-Host "簽署對象："
foreach ($f in $installers) {
    Write-Host "  $($f.FullName)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "簽署完成後重算 latest.yml：" -ForegroundColor Cyan
Write-Host "  .\shell\2-Update-LatestYml.ps1 -ReleasePath `"$destDir`"" -ForegroundColor Yellow
