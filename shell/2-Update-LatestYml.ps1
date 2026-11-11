<#
.SYNOPSIS
    UpAgent 發佈流程【子腳本 2／3】：依「簽署後」的安裝檔重算 latest.yml 的 sha512 / size，並重建 .blockmap。

.DESCRIPTION
    由 Release-UpAgent.ps1 的 UpdateYml 步驟呼叫。

    為什麼一定要重算：
      electron-builder 是在「簽署前」產生 latest.yml 的，裡面的 sha512 與 size 對應的是未簽署的執行檔。
      程式碼簽署會把憑證寫進 PE 檔的簽章區段，檔案內容與大小都會改變，
      因此簽署後若沿用原本的 latest.yml，electron-updater 下載完會做完整性檢查並失敗，使用者永遠更新不了。
      同理 .blockmap（差分更新用的分塊索引）也是對「簽署前」的檔案算的，必須一併重建，
      否則差分下載會拼出錯誤的檔案，只能退回整包下載。

    本腳本的行為：
      1. 解析 latest.yml（可用 -AllManifests 一併處理 latest-mac.yml / latest-linux.yml）
      2. 對 manifest 內 files[].url 與頂層 path 指到的每個本機檔案：
           - 重算 sha512（base64）與 size
           - 若同目錄存在對應的 <檔名>.blockmap，以 electron-builder 內附的 app-builder 重建
             （app-builder 回報的 sha512 / size 會與本腳本自行計算的結果交叉比對）
           - 若 manifest 內有 blockMapSize 欄位，同步更新為新 blockmap 的檔案大小
      3. 更新 releaseDate 為目前 UTC 時間（可用 -PreserveReleaseDate 保留原值）
      4. 以「逐行取代」的方式改寫 manifest，其餘欄位、縮排、順序原樣保留
      5. 改寫前先備份原檔為 <manifest>.bak.<yyyyMMdd-HHmmss>

    這個步驟只動地端檔案，不碰 Azure Blob；上傳是 3-Publish-BlobArtifacts.ps1 的事。

.PARAMETER ReleasePath
    存放安裝檔與 latest.yml 的地端目錄。
    不指定時，自動取 <專案根>\data\upagent_release 底下「最近修改且含有 latest*.yml」的子目錄。

.PARAMETER ManifestName
    要處理的 manifest 檔名，預設 latest.yml；可傳多個

.PARAMETER AllManifests
    處理 ReleasePath 底下所有 latest*.yml（Windows / macOS / Linux 一次做完）

.PARAMETER UpagentDir
    upagent repository 的本機路徑（用來找 node_modules 裡的 app-builder.exe）。
    Release-UpAgent.ps1 會傳入 data/config.json 的 repos 中 upagent 的 path。

.PARAMETER AppBuilderPath
    app-builder.exe 的路徑。不指定時自動從 <UpagentDir>\node_modules\app-builder-bin\win\<arch>\ 找。
    找不到時會跳過 blockmap 重建並提出警告。

.PARAMETER SkipBlockmap
    明確跳過 .blockmap 重建（只更新 latest.yml）

.PARAMETER PreserveReleaseDate
    保留 manifest 原本的 releaseDate，不改成目前時間

.PARAMETER DryRun
    只列出將會變更的內容，不寫入 manifest、也不重建 blockmap

.EXAMPLE
    # 自動找最近一次下載的版本目錄，重算 latest.yml
    .\shell\2-Update-LatestYml.ps1 -UpagentDir C:\src\upagent

.EXAMPLE
    # 先看看會改成什麼
    .\shell\2-Update-LatestYml.ps1 -ReleasePath .\data\upagent_release\0.6.15 -UpagentDir C:\src\upagent -DryRun

.EXAMPLE
    # 三個平台的 manifest 一次處理
    .\shell\2-Update-LatestYml.ps1 -ReleasePath .\data\upagent_release\0.6.15 -UpagentDir C:\src\upagent -AllManifests
#>

[CmdletBinding()]
param(
    [string]$ReleasePath,

    [string[]]$ManifestName = @("latest.yml"),

    [switch]$AllManifests,

    [string]$UpagentDir,

    [string]$AppBuilderPath,

    [switch]$SkipBlockmap,

    [switch]$PreserveReleaseDate,

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'Common.ps1')

# ---------------------------------------------------------------------------
# 共用函式
# ---------------------------------------------------------------------------

function Resolve-AppBuilder {
    param([string]$Explicit, [string]$UpagentDir)
    if ($Explicit) {
        if (Test-Path -LiteralPath $Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
        throw "找不到指定的 app-builder：$Explicit"
    }
    if (-not $UpagentDir) { return $null }
    $base = Join-Path $UpagentDir "node_modules\app-builder-bin\win"
    foreach ($arch in @("x64", "arm64", "ia32")) {
        $p = Join-Path $base "$arch\app-builder.exe"
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return $null
}

function New-YamlLine {
    <# 產生取代用的整行內容，縮排沿用原行 #>
    param([string]$OriginalLine, [string]$Key, [string]$Value)
    $indent = [regex]::Match($OriginalLine, '^\s*').Value
    return "${indent}${Key}: ${Value}"
}

function Format-ShaPreview {
    param([string]$Sha)
    if ([string]::IsNullOrWhiteSpace($Sha)) { return "(無)" }
    if ($Sha.Length -le 16) { return $Sha }
    return $Sha.Substring(0, 16) + "..."
}

# ---------------------------------------------------------------------------
# 參數整理
# ---------------------------------------------------------------------------

$dataRoot = Get-DataRoot

if (-not $ReleasePath) {
    $releaseRoot = Join-Path $dataRoot "upagent_release"
    if (-not (Test-Path -LiteralPath $releaseRoot)) {
        Write-Host "找不到預設的發佈目錄 $releaseRoot，請先執行 1-Get-BlobArtifacts.ps1，或用 -ReleasePath 指定。" -ForegroundColor Red
        exit 1
    }
    $candidate = Get-ChildItem -LiteralPath $releaseRoot -Directory |
        Where-Object { Get-ChildItem -LiteralPath $_.FullName -Filter "latest*.yml" -File -ErrorAction SilentlyContinue } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($candidate) {
        $ReleasePath = $candidate.FullName
    } elseif (Get-ChildItem -LiteralPath $releaseRoot -Filter "latest*.yml" -File -ErrorAction SilentlyContinue) {
        $ReleasePath = $releaseRoot
    } else {
        Write-Host "$releaseRoot 底下找不到任何含 latest*.yml 的目錄，請用 -ReleasePath 指定。" -ForegroundColor Red
        exit 1
    }
    Write-Host "自動選用發佈目錄：$ReleasePath" -ForegroundColor Cyan
}

if (-not (Test-Path -LiteralPath $ReleasePath -PathType Container)) {
    Write-Host "發佈目錄不存在：$ReleasePath" -ForegroundColor Red
    exit 1
}
$ReleasePath = (Resolve-Path -LiteralPath $ReleasePath).Path

$manifests = if ($AllManifests) {
    @(Get-ChildItem -LiteralPath $ReleasePath -Filter "latest*.yml" -File |
        Where-Object { $_.Name -notmatch '\.bak' } |
        Sort-Object Name |
        ForEach-Object { $_.FullName })
} else {
    @($ManifestName | ForEach-Object { Join-Path $ReleasePath $_ })
}

$missing = @($manifests | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
if ($manifests.Count -eq 0 -or $missing.Count -gt 0) {
    Write-Host "找不到 manifest：" -ForegroundColor Red
    if ($manifests.Count -eq 0) { Write-Host "  $ReleasePath 底下沒有 latest*.yml" -ForegroundColor Red }
    foreach ($m in $missing) { Write-Host "  $m" -ForegroundColor Red }
    exit 1
}

$appBuilder = $null
if (-not $SkipBlockmap) {
    $appBuilder = Resolve-AppBuilder -Explicit $AppBuilderPath -UpagentDir $UpagentDir
    if (-not $appBuilder) {
        Write-Host "" -ForegroundColor Yellow
        Write-Host "警告：找不到 app-builder.exe（預期在 <upagent>\node_modules\app-builder-bin\win\x64\，請確認有傳入 -UpagentDir）。" -ForegroundColor Yellow
        Write-Host "      將跳過 .blockmap 重建。舊的 blockmap 對應的是簽署前的檔案，" -ForegroundColor Yellow
        Write-Host "      差分更新會校驗失敗並自動退回「整包下載」，更新仍可完成但流量較大。" -ForegroundColor Yellow
        Write-Host "      若要修正，請在 upagent\ 執行 npm install 後重跑本腳本。" -ForegroundColor Yellow
    } else {
        Write-Host "使用 app-builder：$appBuilder" -ForegroundColor DarkGray
    }
}

$timestamp   = Get-Date -Format "yyyyMMdd-HHmmss"
$releaseDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$utf8NoBom   = New-Object System.Text.UTF8Encoding($false)

# 同一個實體檔案可能同時被 files[] 與頂層 path 參照，算過就快取，避免對 550MB 的 exe 重複雜湊
$artifactCache = @{}

function Get-ArtifactInfo {
    param([System.IO.FileInfo]$File)

    if ($artifactCache.ContainsKey($File.FullName)) { return $artifactCache[$File.FullName] }

    $info = [pscustomobject]@{
        Sha512            = Get-FileHashBase64 -Path $File.FullName
        Size              = $File.Length
        BlockMapPath      = "$($File.FullName).blockmap"
        BlockMapSize      = $null
        BlockMapRebuilt   = $false
    }

    if (Test-Path -LiteralPath $info.BlockMapPath -PathType Leaf) {
        if ($appBuilder -and -not $DryRun) {
            $raw = & $appBuilder blockmap --input $File.FullName --output $info.BlockMapPath --compression gzip
            if ($LASTEXITCODE -ne 0) {
                throw "app-builder 重建 blockmap 失敗（退出碼 $LASTEXITCODE）：$($File.Name)"
            }
            $reported = ($raw -join "") | ConvertFrom-Json
            # app-builder 也會回報整檔的 sha512 / size，與自行計算的結果交叉比對，任一不符代表檔案在處理過程被動過
            if ($reported.sha512 -ne $info.Sha512 -or [long]$reported.size -ne $info.Size) {
                throw "app-builder 回報的雜湊／大小與本腳本計算結果不符（$($File.Name)），請確認檔案未被其他程式佔用或改動。"
            }
            $info.BlockMapRebuilt = $true
        }
        $info.BlockMapSize = (Get-Item -LiteralPath $info.BlockMapPath).Length
    }

    $artifactCache[$File.FullName] = $info
    return $info
}

# ---------------------------------------------------------------------------
# 逐一處理 manifest
# ---------------------------------------------------------------------------

$anyChange = $false
$failures  = @()

foreach ($manifestPath in $manifests) {
    $manifestName = Split-Path $manifestPath -Leaf
    Write-Host ""
    Write-Host "=== 處理 $manifestName ===" -ForegroundColor Cyan

    $lines = [System.IO.File]::ReadAllLines($manifestPath)

    # --- 解析：記下每個欄位所在的行號，改寫時逐行取代，其餘內容原樣保留 ---
    $entries         = New-Object System.Collections.ArrayList
    $version         = $null
    $topPath         = $null
    $topSha512Line   = -1
    $releaseDateLine = -1
    $inFiles         = $false

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]

        # 頂層鍵：行首沒有空白
        if ($line -match '^(?<k>[A-Za-z][A-Za-z0-9_]*):\s*(?<v>.*)$') {
            $key = $Matches['k']
            $val = $Matches['v']
            $inFiles = ($key -eq 'files')
            switch ($key) {
                'version'     { $version = $val.Trim().Trim("'", '"') }
                'path'        { $topPath = $val.Trim().Trim("'", '"') }
                'sha512'      { $topSha512Line = $i }
                'releaseDate' { $releaseDateLine = $i }
            }
            continue
        }

        if (-not $inFiles) { continue }

        if ($line -match '^\s*-\s*url:\s*(?<v>.+)$') {
            [void]$entries.Add([pscustomobject]@{
                Url              = $Matches['v'].Trim().Trim("'", '"')
                Sha512Line       = -1
                SizeLine         = -1
                BlockMapSizeLine = -1
                OldSha512        = $null
                OldSize          = $null
            })
            continue
        }

        if ($entries.Count -gt 0) {
            $e = $entries[$entries.Count - 1]
            if ($line -match '^\s*sha512:\s*(?<v>.+)$')       { $e.Sha512Line = $i; $e.OldSha512 = $Matches['v'].Trim(); continue }
            if ($line -match '^\s*size:\s*(?<v>\d+)\s*$')     { $e.SizeLine = $i;   $e.OldSize   = [long]$Matches['v']; continue }
            if ($line -match '^\s*blockMapSize:\s*\d+\s*$')   { $e.BlockMapSizeLine = $i; continue }
        }
    }

    if ($entries.Count -eq 0 -and -not $topPath) {
        Write-Host "  $manifestName 內既無 files: 也無 path:，格式不符預期，略過。" -ForegroundColor Red
        $failures += $manifestName
        continue
    }

    Write-Host "  version: $version" -ForegroundColor DarkGray

    # --- 重算 files[] ---
    $manifestChanged = $false
    $manifestFailed  = $false

    foreach ($entry in $entries) {
        $file = Resolve-ManifestFile -Url $entry.Url -Folder $ReleasePath
        if (-not $file) {
            Write-Host "  [缺檔] $($entry.Url) — 地端找不到這個檔案" -ForegroundColor Red
            $failures += "$manifestName / $($entry.Url)"
            $manifestFailed = $true
            continue
        }

        $info = Get-ArtifactInfo -File $file

        $shaChanged  = ($entry.OldSha512 -ne $info.Sha512)
        $sizeChanged = ($entry.OldSize -ne $info.Size)
        $shaMark     = $(if ($shaChanged)  { "  [已變更]" } else { "  [未變更]" })
        $sizeMark    = $(if ($sizeChanged) { "  [已變更]" } else { "  [未變更]" })

        Write-Host "  [檔案] $($file.Name)"
        Write-Host ("         sha512  {0} -> {1}{2}" -f (Format-ShaPreview $entry.OldSha512), (Format-ShaPreview $info.Sha512), $shaMark) `
            -ForegroundColor $(if ($shaChanged) { "Yellow" } else { "DarkGray" })
        Write-Host ("         size    {0} -> {1}{2}" -f $entry.OldSize, $info.Size, $sizeMark) `
            -ForegroundColor $(if ($sizeChanged) { "Yellow" } else { "DarkGray" })

        if ($null -ne $info.BlockMapSize) {
            if ($info.BlockMapRebuilt) {
                Write-Host "         blockmap 已重建（$(Format-Size $info.BlockMapSize)）" -ForegroundColor Yellow
            } elseif ($DryRun -and $appBuilder) {
                Write-Host "         blockmap 將重建（DryRun 未執行）" -ForegroundColor Yellow
            } else {
                Write-Host "         blockmap 未重建（沿用現有檔案）" -ForegroundColor Yellow
            }
        }

        if ($entry.Sha512Line -ge 0) {
            $lines[$entry.Sha512Line] = New-YamlLine -OriginalLine $lines[$entry.Sha512Line] -Key "sha512" -Value $info.Sha512
        }
        if ($entry.SizeLine -ge 0) {
            $lines[$entry.SizeLine] = New-YamlLine -OriginalLine $lines[$entry.SizeLine] -Key "size" -Value $info.Size
        }
        if ($entry.BlockMapSizeLine -ge 0 -and $null -ne $info.BlockMapSize) {
            $lines[$entry.BlockMapSizeLine] = New-YamlLine -OriginalLine $lines[$entry.BlockMapSizeLine] -Key "blockMapSize" -Value $info.BlockMapSize
        }

        if ($shaChanged -or $sizeChanged) { $manifestChanged = $true }
    }

    # --- 重算頂層 path / sha512 ---
    if ($topPath -and $topSha512Line -ge 0) {
        $topFile = Resolve-ManifestFile -Url $topPath -Folder $ReleasePath
        if (-not $topFile) {
            Write-Host "  [缺檔] path: $topPath — 地端找不到這個檔案" -ForegroundColor Red
            $failures += "$manifestName / path: $topPath"
            $manifestFailed = $true
        } else {
            $topInfo = Get-ArtifactInfo -File $topFile
            $oldTopSha = ($lines[$topSha512Line] -replace '^\s*sha512:\s*', '').Trim()
            if ($oldTopSha -ne $topInfo.Sha512) { $manifestChanged = $true }
            $lines[$topSha512Line] = New-YamlLine -OriginalLine $lines[$topSha512Line] -Key "sha512" -Value $topInfo.Sha512
        }
    }

    if ($manifestFailed) {
        Write-Host "  因為有缺檔，$manifestName 未寫入任何變更。" -ForegroundColor Red
        continue
    }

    if (-not $PreserveReleaseDate -and $releaseDateLine -ge 0) {
        $lines[$releaseDateLine] = New-YamlLine -OriginalLine $lines[$releaseDateLine] -Key "releaseDate" -Value "'$releaseDate'"
        Write-Host "  releaseDate 更新為 $releaseDate" -ForegroundColor DarkGray
    }

    if (-not $manifestChanged) {
        Write-Host "  sha512 / size 與地端檔案已一致（安裝檔可能尚未簽署，或先前已重算過）。" -ForegroundColor Yellow
    }

    if ($DryRun) {
        Write-Host "  DryRun：未寫入 $manifestName。" -ForegroundColor Yellow
        continue
    }

    $backupPath = "$manifestPath.bak.$timestamp"
    Copy-Item -LiteralPath $manifestPath -Destination $backupPath -Force
    [System.IO.File]::WriteAllText($manifestPath, (($lines -join "`n") + "`n"), $utf8NoBom)
    Write-Host "  已寫入 $manifestName（原檔備份為 $(Split-Path $backupPath -Leaf)）" -ForegroundColor Green
    $anyChange = $true
}

# ---------------------------------------------------------------------------
# 結果與下一步
# ---------------------------------------------------------------------------

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "=== 有項目未處理成功 ===" -ForegroundColor Red
    foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
    exit 1
}

Write-Host "=== 完成 ===" -ForegroundColor Cyan
if ($DryRun) {
    Write-Host "DryRun 模式，未變更任何檔案。" -ForegroundColor Yellow
    exit 0
}
if (-not $anyChange) {
    Write-Host "manifest 已是最新狀態。" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== 下一步：上傳 ===" -ForegroundColor Cyan
Write-Host "請確認 latest.yml 內容無誤後，執行："
Write-Host "  .\shell\3-Publish-BlobArtifacts.ps1 -SourcePath `"$ReleasePath`" -DryRun" -ForegroundColor Yellow
Write-Host "  .\shell\3-Publish-BlobArtifacts.ps1 -SourcePath `"$ReleasePath`"" -ForegroundColor Yellow
