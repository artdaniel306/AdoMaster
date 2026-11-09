<#
.SYNOPSIS
    UpAgent 發佈流程【子腳本 3／3】：把「已簽署 + 已重算 latest.yml」的地端檔案上傳到 Azure Blob 正式發佈位置。

.DESCRIPTION
    由 Release-UpAgent.ps1 的 Publish 步驟呼叫（複製自 crmapp_AI\.manage\scripts，路徑已改為 AdoMaster 專案內）。

    上傳完成後「把 UpAgentRelease.folder_url 指向這個版本子資料夾」的
    伺服器，其使用者才會開始收到這個版本更新（見下方「發佈佈局」）；本腳本不會、也不需要去改任何
    伺服器的發佈紀錄，那是資料庫操作（Release-UpAgent.ps1 的 Database 步驟）。
    因此本腳本以「寧可不上傳，也不要傳出壞掉的 manifest」為原則：

      1. 上傳前先驗證：manifest（latest*.yml）內每個 files[].url 與頂層 path 所指的檔案，
         其 sha512 / size 必須與地端實際檔案完全相符。只要有一項不符就中止，
         一個位元組都不會上傳。（漏掉重算 latest.yml 直接上傳，就是靠這道閘擋下來的）
      2. 實體檔案（.exe / .blockmap / .dmg / .zip / .AppImage / .deb）先上傳並逐檔驗證，
         最後才上傳 manifest —— 順序與 postRelease.js 一致，
         確保用戶端讀到 latest.yml 時，它指向的安裝檔早已完整存在。
      3. 覆寫既有 manifest 前，先把伺服器上的舊版下載到本機 _server-backup\ 留底。
      4. 中途失敗時自動回滾：刪除本次新建立的 Blob、把 manifest 還原成上傳前的版本，
         Blob 容器回到發佈前狀態，現有使用者不受影響。

    發佈佈局（每版一個子資料夾，取代舊的單一 releases/latest.yml 扁平清單——舊清單已下架、不存在）：
    本腳本一律上傳到 <DestFolder>/<版本號>/ 這個子資料夾，版本號**不是**由參數指定，
    而是從來源目錄內的 manifest（latest*.yml 的 version 欄位）自動讀出；多份 manifest 版號
    不一致會直接中止，不會用猜的。預設 DestFolder 是 releases，因此實際目的地形如
    https://updayservice.blob.core.windows.net/upagent/releases/0.7.0/ ——
    這個完整子資料夾網址，就是要回填到 UpAgentRelease.folder_url 的值。

    package.json 的 publish.url（仍是同一個 releases/ 前綴）現在只是「打包時產生 app-update.yml
    用的地基設定」，electron-updater 實際下載時讀的是 updaterService.js 依伺服器宣告動態
    setFeedURL() 到的 folder_url，不是這個固定前綴，不要再假設兩者相同。

.PARAMETER StorageAccountName
    Storage Account 名稱，預設 updayservice

.PARAMETER ContainerName
    Container 名稱，預設 upagent

.PARAMETER SourcePath
    要上傳的地端目錄。不指定時，自動取 <專案根>\data\upagent_release 底下「最近修改且含有 latest*.yml」的子目錄

.PARAMETER DestFolder
    目的資料夾的**基準**前綴，預設 releases；實際上傳位置是 <DestFolder>/<版本號>/，
    版本號自動從來源 manifest 讀出，不需要（也不應該）自行帶版本號進來

.PARAMETER AuthMode
    認證模式：
      - login（預設）：使用目前 az login 的登入身分，需具備 Storage Blob Data Contributor
      - key：使用 Storage Account 存取金鑰，需搭配 -AccountKey

.PARAMETER AccountKey
    當 -AuthMode key 時必填

.PARAMETER SkipVerify
    跳過「manifest 與地端檔案一致性」的前置檢查。除非你很清楚自己在做什麼，否則不要用

.PARAMETER Overwrite
    允許覆蓋目的地已存在的安裝檔（manifest 本來就一律覆蓋）。
    正常發佈新版不會撞名；會撞名通常代表版號沒更新，預設直接中止

.PARAMETER VerifyDownload
    每個實體檔案上傳後，重新下載整份內容比對 sha512。最嚴謹但很花時間（安裝檔約 550MB）

.PARAMETER Yes
    略過互動確認（Release-UpAgent.ps1 一律帶這個參數）

.PARAMETER DryRun
    只做前置驗證並列出將上傳的檔案，不實際寫入任何 Blob

.EXAMPLE
    # 先驗證與預覽（強烈建議每次都先跑一次）
    .\shell\3-Publish-BlobArtifacts.ps1 -DryRun

.EXAMPLE
    # 正式發佈
    .\shell\3-Publish-BlobArtifacts.ps1 -SourcePath .\data\upagent_release\0.6.15

.EXAMPLE
    # 使用 Access Key，且上傳後重新下載比對雜湊
    .\shell\3-Publish-BlobArtifacts.ps1 -AuthMode key -AccountKey "xxxxxxxx==" -VerifyDownload
#>

[CmdletBinding()]
param(
    [string]$StorageAccountName = "updayservice",

    [string]$ContainerName = "upagent",

    [string]$SourcePath,

    [string]$DestFolder = "releases",

    [ValidateSet("login", "key")]
    [string]$AuthMode = "login",

    [string]$AccountKey,

    [switch]$SkipVerify,

    [switch]$Overwrite,

    [switch]$VerifyDownload,

    [switch]$Yes,

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$ArtifactExtensions = @(".exe", ".blockmap", ".dmg", ".zip", ".AppImage", ".deb")
$BackupDirName      = "_server-backup"

# ---------------------------------------------------------------------------
# 共用函式
# ---------------------------------------------------------------------------

function Invoke-AzCli {
    <#
      執行 az 並在退出碼非 0 時拋出例外。
      刻意不重導 stderr：PowerShell 5.1 一旦重導原生指令的 stderr 就會把警告轉成 ErrorRecord，
      在 $ErrorActionPreference = "Stop" 下會誤判為失敗，同時也會污染 JSON 輸出。
    #>
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$Context = "az 指令"
    )
    $stdout = & az @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Context 失敗（az 退出碼 $LASTEXITCODE），詳細錯誤請見上方輸出。"
    }
    return $stdout
}

function Get-Sha512Base64 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $hasher = [System.Security.Cryptography.SHA512]::Create()
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        return [Convert]::ToBase64String($hasher.ComputeHash($stream))
    } finally {
        $stream.Dispose()
        $hasher.Dispose()
    }
}

function Format-Size {
    param([long]$Bytes)
    if ($Bytes -ge 1GB) { return "{0:N2} GB" -f ($Bytes / 1GB) }
    if ($Bytes -ge 1MB) { return "{0:N2} MB" -f ($Bytes / 1MB) }
    if ($Bytes -ge 1KB) { return "{0:N2} KB" -f ($Bytes / 1KB) }
    return "$Bytes B"
}

function Resolve-ManifestFile {
    param([string]$Url, [string]$Folder)
    $name = $Url.Trim().Trim("'", '"')
    $candidates = @($name)
    $decoded = [System.Uri]::UnescapeDataString($name)
    if ($decoded -ne $name) { $candidates += $decoded }
    foreach ($c in $candidates) {
        $p = Join-Path $Folder $c
        if (Test-Path -LiteralPath $p -PathType Leaf) { return (Get-Item -LiteralPath $p) }
    }
    return $null
}

function Get-EmbeddedBlockMapSize {
    <#
      讀取「內嵌式 blockmap」的長度。
      AppImage 不像 NSIS 另存 <檔名>.blockmap 旁檔，而是把 blockmap 以 raw deflate
      接在安裝檔尾端，再用最後 4 bytes（big-endian UInt32）記下它的長度；
      manifest 裡的 blockMapSize 指的就是這段內嵌資料。
      參見 electron-updater 的 FileWithEmbeddedBlockMapDifferentialDownloader：
        offset = fileSize - (blockMapSize + 4)、sizeBuffer.readUInt32BE(0)
      讀不到（檔案太小）時回傳 $null。
    #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        if ($fs.Length -lt 4) { return $null }
        [void]$fs.Seek(-4, [System.IO.SeekOrigin]::End)
        $buf = New-Object byte[] 4
        if ($fs.Read($buf, 0, 4) -ne 4) { return $null }
        [Array]::Reverse($buf)   # big-endian -> 本機位元序
        return [long][System.BitConverter]::ToUInt32($buf, 0)
    } finally {
        $fs.Dispose()
    }
}

function Read-UpdateManifest {
    <# 解析 electron-builder 的 latest*.yml，取出版號、files[] 與頂層 path / sha512 #>
    param([Parameter(Mandatory = $true)][string]$Path)

    $result = [pscustomobject]@{
        Version    = $null
        Entries    = New-Object System.Collections.ArrayList
        TopPath    = $null
        TopSha512  = $null
    }

    $inFiles = $false
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match '^(?<k>[A-Za-z][A-Za-z0-9_]*):\s*(?<v>.*)$') {
            $key = $Matches['k']
            $val = $Matches['v'].Trim().Trim("'", '"')
            $inFiles = ($key -eq 'files')
            switch ($key) {
                'version' { $result.Version   = $val }
                'path'    { $result.TopPath   = $val }
                'sha512'  { $result.TopSha512 = $val }
            }
            continue
        }

        if (-not $inFiles) { continue }

        if ($line -match '^\s*-\s*url:\s*(?<v>.+)$') {
            [void]$result.Entries.Add([pscustomobject]@{
                Url          = $Matches['v'].Trim().Trim("'", '"')
                Sha512       = $null
                Size         = $null
                BlockMapSize = $null
            })
            continue
        }

        if ($result.Entries.Count -gt 0) {
            $e = $result.Entries[$result.Entries.Count - 1]
            if ($line -match '^\s*sha512:\s*(?<v>.+)$')          { $e.Sha512       = $Matches['v'].Trim(); continue }
            if ($line -match '^\s*size:\s*(?<v>\d+)\s*$')        { $e.Size         = [long]$Matches['v']; continue }
            if ($line -match '^\s*blockMapSize:\s*(?<v>\d+)\s*$'){ $e.BlockMapSize = [long]$Matches['v']; continue }
        }
    }

    return $result
}

# ---------------------------------------------------------------------------
# 參數整理與前置檢查
# ---------------------------------------------------------------------------

# shell\ 的上一層 = AdoMaster 專案根目錄
$projectRoot = Split-Path -Parent $PSScriptRoot

if (-not $SourcePath) {
    $releaseRoot = Join-Path $projectRoot "data\upagent_release"
    if (-not (Test-Path -LiteralPath $releaseRoot)) {
        Write-Host "找不到預設的發佈目錄 $releaseRoot，請先執行 1-Get-BlobArtifacts.ps1 / 2-Update-LatestYml.ps1，或用 -SourcePath 指定。" -ForegroundColor Red
        exit 1
    }
    $candidate = Get-ChildItem -LiteralPath $releaseRoot -Directory |
        Where-Object { Get-ChildItem -LiteralPath $_.FullName -Filter "latest*.yml" -File -ErrorAction SilentlyContinue } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($candidate) {
        $SourcePath = $candidate.FullName
    } elseif (Get-ChildItem -LiteralPath $releaseRoot -Filter "latest*.yml" -File -ErrorAction SilentlyContinue) {
        $SourcePath = $releaseRoot
    } else {
        Write-Host "$releaseRoot 底下找不到任何含 latest*.yml 的目錄，請用 -SourcePath 指定。" -ForegroundColor Red
        exit 1
    }
    Write-Host "自動選用來源目錄：$SourcePath" -ForegroundColor Cyan
}

if (-not (Test-Path -LiteralPath $SourcePath -PathType Container)) {
    Write-Host "來源目錄不存在：$SourcePath" -ForegroundColor Red
    exit 1
}
$SourcePath = (Resolve-Path -LiteralPath $SourcePath).Path

# $DestFolder 目前收到的只是基準前綴（例如 releases）；實際版本子資料夾要等
# manifest 讀出版本號後才能組出，見下方「決定版本子資料夾」。
$BaseFolder = $DestFolder.TrimEnd('/')

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
# 盤點要上傳的檔案
# ---------------------------------------------------------------------------

$localFiles = @(Get-ChildItem -LiteralPath $SourcePath -File | Where-Object { $_.Name -notmatch '\.bak' })

$artifacts = @($localFiles | Where-Object { $ArtifactExtensions -contains $_.Extension } | Sort-Object Name)
$manifests = @($localFiles | Where-Object { $_.Name -match '^latest(-[a-z0-9]+)?\.ya?ml$' } | Sort-Object Name)

if ($manifests.Count -eq 0) {
    Write-Host "來源目錄內找不到 latest*.yml，無法發佈。" -ForegroundColor Red
    exit 1
}
if ($artifacts.Count -eq 0) {
    Write-Host "來源目錄內找不到任何安裝檔。" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# 決定版本子資料夾：一律從 manifest 的 version 欄位讀出，不接受手動指定版本號，
# 避免打錯版號把檔案傳到錯誤的子資料夾卻沒有任何檢查擋下來。
# ---------------------------------------------------------------------------

$releaseVersion = $null
foreach ($manifest in $manifests) {
    $parsedVersion = (Read-UpdateManifest -Path $manifest.FullName).Version
    if ([string]::IsNullOrWhiteSpace($parsedVersion)) {
        Write-Host "$($manifest.Name) 讀不到 version 欄位，無法決定要上傳到哪個版本子資料夾。" -ForegroundColor Red
        exit 1
    }
    if ($releaseVersion -and $releaseVersion -ne $parsedVersion) {
        Write-Host "來源目錄內的 manifest 版號不一致：$($manifest.Name) 是 $parsedVersion，其他 manifest 是 $releaseVersion。" -ForegroundColor Red
        Write-Host "請確認來源目錄沒有混到不同版本的檔案。" -ForegroundColor Red
        exit 1
    }
    $releaseVersion = $parsedVersion
}

$DestFolder = "$BaseFolder/$releaseVersion/"

# ---------------------------------------------------------------------------
# 前置驗證：manifest 必須與地端檔案完全相符
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "=== 驗證 manifest 與地端檔案是否相符 ===" -ForegroundColor Cyan

$verifyErrors  = @()
$referenced    = New-Object System.Collections.Generic.HashSet[string]
$shaCache      = @{}

function Get-CachedSha512 {
    param([System.IO.FileInfo]$File)
    if (-not $shaCache.ContainsKey($File.FullName)) {
        $shaCache[$File.FullName] = Get-Sha512Base64 -Path $File.FullName
    }
    return $shaCache[$File.FullName]
}

$manifestsToVerify = $(if ($SkipVerify) { @() } else { $manifests })
if ($SkipVerify) {
    Write-Host "  已指定 -SkipVerify，跳過一致性檢查（後續的「未被參照」提醒也會一併略過）。" -ForegroundColor Yellow
}

foreach ($manifest in $manifestsToVerify) {
    $parsed = Read-UpdateManifest -Path $manifest.FullName
    Write-Host "  $($manifest.Name)（version: $($parsed.Version)）"

    $targets = New-Object System.Collections.ArrayList
    foreach ($e in $parsed.Entries) {
        [void]$targets.Add([pscustomobject]@{ Url = $e.Url; Sha512 = $e.Sha512; Size = $e.Size; BlockMapSize = $e.BlockMapSize; Label = "files[].url" })
    }
    if ($parsed.TopPath -and $parsed.TopSha512) {
        [void]$targets.Add([pscustomobject]@{ Url = $parsed.TopPath; Sha512 = $parsed.TopSha512; Size = $null; BlockMapSize = $null; Label = "path" })
    }

    foreach ($t in $targets) {
        $file = Resolve-ManifestFile -Url $t.Url -Folder $SourcePath
        if (-not $file) {
            $verifyErrors += "$($manifest.Name) 的 $($t.Label) 指向 $($t.Url)，但地端找不到這個檔案"
            continue
        }
        [void]$referenced.Add($file.FullName)

        $actualSha = Get-CachedSha512 -File $file
        if ($t.Sha512 -and $t.Sha512 -ne $actualSha) {
            $verifyErrors += "$($manifest.Name)：$($file.Name) 的 sha512 不符（manifest 與實際檔案不同 —— 是否漏了重算 latest.yml？）"
        }
        if ($null -ne $t.Size -and $t.Size -ne $file.Length) {
            $verifyErrors += "$($manifest.Name)：$($file.Name) 的 size 不符（manifest $($t.Size) / 實際 $($file.Length)）"
        }
        # blockmap 有兩種擺法，manifest 上都只表現為 blockMapSize，不能一律當成旁檔來找：
        #   NSIS（.exe）：另存為 <檔名>.blockmap 旁檔
        #   AppImage    ：以 raw deflate 內嵌在安裝檔尾端，最後 4 bytes 是 big-endian 的長度
        # 內嵌的那段位元組已被整檔 sha512 涵蓋，所以這裡只需交叉比對長度是否與 manifest 一致。
        if ($null -ne $t.BlockMapSize) {
            $bm = "$($file.FullName).blockmap"
            if (Test-Path -LiteralPath $bm -PathType Leaf) {
                if ((Get-Item -LiteralPath $bm).Length -ne $t.BlockMapSize) {
                    $verifyErrors += "$($manifest.Name)：$(Split-Path $bm -Leaf) 的大小與 blockMapSize 不符"
                }
            } else {
                $embedded = Get-EmbeddedBlockMapSize -Path $file.FullName
                if ($null -eq $embedded) {
                    $verifyErrors += "$($manifest.Name)：$($file.Name) 既無 .blockmap 旁檔，也讀不到檔尾的內嵌 blockmap 長度"
                } elseif ($embedded -ne $t.BlockMapSize) {
                    $verifyErrors += "$($manifest.Name)：$($file.Name) 檔尾內嵌 blockmap 長度為 $embedded，與 manifest 的 blockMapSize $($t.BlockMapSize) 不符"
                }
            }
        }
    }
}

if ($verifyErrors.Count -gt 0) {
    Write-Host ""
    Write-Host "=== 驗證未通過，未上傳任何檔案 ===" -ForegroundColor Red
    # 同一個檔案可能同時被 files[].url 與頂層 path 參照，訊息會重覆，這裡收斂成一條
    foreach ($e in ($verifyErrors | Select-Object -Unique)) { Write-Host "  - $e" -ForegroundColor Red }
    Write-Host ""
    Write-Host "請先重算 latest.yml：" -ForegroundColor Red
    Write-Host "  .\shell\2-Update-LatestYml.ps1 -ReleasePath `"$SourcePath`"" -ForegroundColor Yellow
    exit 1
} elseif (-not $SkipVerify) {
    Write-Host "  全部相符。" -ForegroundColor Green
}

# manifest 沒提到、但也會一起上傳的檔案（.blockmap 本來就不列在 files[] 內，屬正常）
if (-not $SkipVerify) {
    $unreferenced = @($artifacts | Where-Object { -not $referenced.Contains($_.FullName) -and $_.Extension -ne ".blockmap" })
    if ($unreferenced.Count -gt 0) {
        Write-Host ""
        Write-Host "提醒：以下檔案不被任何 manifest 參照，仍會一併上傳：" -ForegroundColor Yellow
        foreach ($f in $unreferenced) { Write-Host "  - $($f.Name)" -ForegroundColor Yellow }
    }
}

# ---------------------------------------------------------------------------
# 檢查目的地是否已有同名安裝檔
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "=== 檢查目的地 $ContainerName/$DestFolder ===" -ForegroundColor Cyan

$existingBlobs = New-Object System.Collections.Generic.HashSet[string]
$blobJson = Invoke-AzCli -Context "列出目的地 Blob" -Arguments (@(
    "storage", "blob", "list",
    "--account-name", $StorageAccountName,
    "--container-name", $ContainerName,
    "--prefix", $DestFolder
) + $authArgs + @("--output", "json"))
# PowerShell 5.1 的 ConvertFrom-Json 會把整個 JSON 陣列當成「一個物件」輸出，
# 必須先落地成變數再包 @()，否則會拿到「只含一個陣列的陣列」
$destBlobList = ($blobJson -join "`n") | ConvertFrom-Json
foreach ($b in @($destBlobList)) {
    [void]$existingBlobs.Add($b.name)
}

$collisions = @($artifacts | Where-Object { $existingBlobs.Contains("$DestFolder$($_.Name)") })
if ($collisions.Count -gt 0 -and -not $Overwrite) {
    Write-Host "目的地已存在同名安裝檔，預設不覆蓋以免動到既有版本：" -ForegroundColor Red
    foreach ($f in $collisions) { Write-Host "  - $DestFolder$($f.Name)" -ForegroundColor Red }
    Write-Host ""
    Write-Host "若確定要覆蓋，請加上 -Overwrite；若是版號忘了更新，請回到更版步驟重來。" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# 上傳清單與確認
# ---------------------------------------------------------------------------

$totalBytes = ($artifacts | Measure-Object -Property Length -Sum).Sum

Write-Host ""
Write-Host "=== 即將上傳 ===" -ForegroundColor Cyan
Write-Host "來源: $SourcePath"
Write-Host "目的: https://$StorageAccountName.blob.core.windows.net/$ContainerName/$DestFolder"
Write-Host ""
Write-Host "安裝檔（先傳）：" -ForegroundColor Cyan
foreach ($f in $artifacts) {
    $mark = $(if ($existingBlobs.Contains("$DestFolder$($f.Name)")) { "  [覆蓋既有]" } else { "" })
    Write-Host ("  {0,-12} {1}{2}" -f (Format-Size $f.Length), $f.Name, $mark)
}
Write-Host "manifest（最後傳）：" -ForegroundColor Cyan
foreach ($f in $manifests) {
    $mark = $(if ($existingBlobs.Contains("$DestFolder$($f.Name)")) { "  [覆蓋既有]" } else { "" })
    Write-Host ("  {0,-12} {1}{2}" -f (Format-Size $f.Length), $f.Name, $mark)
}
Write-Host ""
Write-Host "合計 $($artifacts.Count + $manifests.Count) 個檔案，約 $(Format-Size $totalBytes)。" -ForegroundColor Cyan

if ($DryRun) {
    Write-Host ""
    Write-Host "=== DryRun 模式，未上傳任何檔案 ===" -ForegroundColor Yellow
    exit 0
}

if (-not $Yes) {
    Write-Host ""
    Write-Host "上傳完成後，只有把 UpAgentRelease.folder_url 指向這個子資料夾的伺服器，其使用者才會開始收到這個版本；" -ForegroundColor Yellow
    Write-Host "本腳本不會修改任何伺服器的發佈紀錄，那是資料庫操作。" -ForegroundColor Yellow
    $answer = Read-Host "確定要發佈嗎？請輸入 yes 繼續"
    if ($answer -ne "yes") {
        Write-Host "已取消，未上傳任何檔案。" -ForegroundColor Yellow
        exit 0
    }
}

# ---------------------------------------------------------------------------
# 上傳
# ---------------------------------------------------------------------------

$createdBlobs      = New-Object System.Collections.ArrayList   # 本次新建立的 Blob，失敗時刪除
$manifestBackups   = @{}                                       # blobName -> 伺服器舊版的本機備份路徑
$uploadedManifests = New-Object System.Collections.ArrayList

function Push-Blob {
    param(
        [Parameter(Mandatory = $true)][System.IO.FileInfo]$File,
        [Parameter(Mandatory = $true)][string]$BlobName,
        [string[]]$ExtraArgs = @()
    )
    $azArgs = @(
        "storage", "blob", "upload",
        "--account-name", $StorageAccountName,
        "--container-name", $ContainerName,
        "--name", $BlobName,
        "--file", $File.FullName,
        "--overwrite",
        "--validate-content",
        "--no-progress"
    ) + $ExtraArgs + $authArgs + @("--output", "none")
    Invoke-AzCli -Context "上傳 $BlobName" -Arguments $azArgs | Out-Null
}

function Get-BlobLength {
    param([string]$BlobName)
    $out = Invoke-AzCli -Context "查詢 $BlobName" -Arguments (@(
        "storage", "blob", "show",
        "--account-name", $StorageAccountName,
        "--container-name", $ContainerName,
        "--name", $BlobName,
        "--query", "properties.contentLength",
        "--output", "tsv"
    ) + $authArgs)
    return [long](($out -join "").Trim())
}

try {
    # --- 1. 實體檔案 ---
    foreach ($file in $artifacts) {
        $blobName = "$DestFolder$($file.Name)"
        $isNew    = -not $existingBlobs.Contains($blobName)

        Write-Host ""
        Write-Host "[上傳] $blobName（$(Format-Size $file.Length)）" -ForegroundColor Green

        if ($isNew) { [void]$createdBlobs.Add($blobName) }
        Push-Blob -File $file -BlobName $blobName

        $remoteLength = Get-BlobLength -BlobName $blobName
        if ($remoteLength -ne $file.Length) {
            throw "上傳後大小不符：本機 $($file.Length) bytes，Blob $remoteLength bytes"
        }

        if ($VerifyDownload) {
            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("upagent-verify-{0}" -f ([guid]::NewGuid().ToString('N')))
            try {
                Invoke-AzCli -Context "回讀 $blobName" -Arguments (@(
                    "storage", "blob", "download",
                    "--account-name", $StorageAccountName,
                    "--container-name", $ContainerName,
                    "--name", $blobName,
                    "--file", $tmp,
                    "--no-progress"
                ) + $authArgs + @("--output", "none")) | Out-Null

                $remoteSha = Get-Sha512Base64 -Path $tmp
                if ($remoteSha -ne (Get-CachedSha512 -File $file)) {
                    throw "上傳後回讀的 sha512 與本機檔案不符"
                }
                Write-Host "  已上傳並通過回讀雜湊驗證。" -ForegroundColor Green
            } finally {
                if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
            }
        } else {
            Write-Host "  已上傳（傳輸過程逐塊 MD5 校驗 + 大小比對通過）。" -ForegroundColor Green
        }
    }

    # --- 2. manifest（最後才傳） ---
    $backupDir = Join-Path $SourcePath $BackupDirName
    foreach ($file in $manifests) {
        $blobName = "$DestFolder$($file.Name)"

        Write-Host ""
        Write-Host "[上傳] $blobName" -ForegroundColor Green

        if ($existingBlobs.Contains($blobName)) {
            if (-not (Test-Path -LiteralPath $backupDir)) {
                New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
            }
            $backupPath = Join-Path $backupDir ("{0}.{1}.bak" -f $file.Name, (Get-Date -Format "yyyyMMdd-HHmmss"))
            Invoke-AzCli -Context "備份既有 $blobName" -Arguments (@(
                "storage", "blob", "download",
                "--account-name", $StorageAccountName,
                "--container-name", $ContainerName,
                "--name", $blobName,
                "--file", $backupPath,
                "--no-progress"
            ) + $authArgs + @("--output", "none")) | Out-Null
            $manifestBackups[$blobName] = $backupPath
            Write-Host "  伺服器上的舊版已備份至 $backupPath" -ForegroundColor DarkGray
        } else {
            [void]$createdBlobs.Add($blobName)
        }

        # manifest 會被反覆覆蓋，加上 no-cache 避免中介快取讓用戶端讀到舊版
        Push-Blob -File $file -BlobName $blobName -ExtraArgs @("--content-cache-control", "no-cache")
        [void]$uploadedManifests.Add($blobName)
        Write-Host "  已上傳。" -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "=== 發佈完成 ===" -ForegroundColor Cyan
    Write-Host "版本子資料夾：https://$StorageAccountName.blob.core.windows.net/$ContainerName/$DestFolder" -ForegroundColor Green
    Write-Host "此網址會由 Release-UpAgent.ps1 的 Database 步驟寫入 UpAgentRelease.folder_url（public_db）。" -ForegroundColor Cyan
}
catch {
    Write-Host ""
    Write-Host "=== 發佈失敗：$_ ===" -ForegroundColor Red
    Write-Host "開始回滾..." -ForegroundColor Yellow

    # 先還原 manifest（這才是影響使用者的關鍵），再刪掉本次新建立的 Blob
    foreach ($blobName in $uploadedManifests) {
        if ($manifestBackups.ContainsKey($blobName)) {
            try {
                Invoke-AzCli -Context "還原 $blobName" -Arguments (@(
                    "storage", "blob", "upload",
                    "--account-name", $StorageAccountName,
                    "--container-name", $ContainerName,
                    "--name", $blobName,
                    "--file", $manifestBackups[$blobName],
                    "--overwrite",
                    "--no-progress",
                    "--content-cache-control", "no-cache"
                ) + $authArgs + @("--output", "none")) | Out-Null
                Write-Host "  已還原 manifest: $blobName" -ForegroundColor Yellow
            } catch {
                Write-Host "  還原 manifest 失敗: $blobName — $_" -ForegroundColor Red
                Write-Host "  請手動把 $($manifestBackups[$blobName]) 上傳回 $blobName" -ForegroundColor Red
            }
        }
    }

    foreach ($blobName in $createdBlobs) {
        try {
            Invoke-AzCli -Context "刪除 $blobName" -Arguments (@(
                "storage", "blob", "delete",
                "--account-name", $StorageAccountName,
                "--container-name", $ContainerName,
                "--name", $blobName
            ) + $authArgs + @("--output", "none")) | Out-Null
            Write-Host "  已回滾（刪除）: $blobName" -ForegroundColor Yellow
        } catch {
            Write-Host "  回滾失敗: $blobName — $_" -ForegroundColor Red
        }
    }

    Write-Host ""
    Write-Host "Blob 容器已盡可能回復至本次發佈前的狀態，現有使用者不受影響。" -ForegroundColor Yellow
    Write-Host "請確認網路狀況後重新執行本腳本。" -ForegroundColor Yellow
    exit 1
}
