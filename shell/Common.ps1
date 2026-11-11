<#
.SYNOPSIS
    shell/ 腳本共用的函式。各腳本在 param() 之後以 `. (Join-Path $PSScriptRoot 'Common.ps1')` 載入。
    不是給 app 直接執行的腳本（沒有 -Out，也不做任何事）。

    共用的函式只放在這裡，不要在各腳本重新定義（行為不同的同名函式例外，例如 Invoke-Native / Get-Setting）。
#>

function Get-DataRoot {
    <# data 資料夾：app 會以環境變數 ADOMASTER_DATA_DIR 指定（安裝版在使用者資料夾）；單獨執行時為專案根目錄的 data\ #>
    if ($env:ADOMASTER_DATA_DIR) { return $env:ADOMASTER_DATA_DIR }
    return Join-Path (Split-Path -Parent $PSScriptRoot) 'data'
}

function Write-Result {
    <# 把結果以 JSON（UTF-8 無 BOM）寫到呼叫端腳本的 -Out 檔案；沒有指定 -Out 時不寫 #>
    param($Result, [int]$Depth = 10)
    if (-not $Out) { return }
    [System.IO.File]::WriteAllText($Out, (ConvertTo-Json -InputObject $Result -Depth $Depth), (New-Object System.Text.UTF8Encoding $false))
}

function Exit-WithError {
    <# 輸出 ::error:: 標記（stdout，app 以它作為錯誤訊息）與錯誤訊息（stderr），以 exit code 1 結束 #>
    param([string]$Message)
    Write-Host "::error::$($Message -replace '\r?\n', ' ')"
    [Console]::Error.WriteLine($Message)
    exit 1
}

function Invoke-Az {
    <#
      執行 az，退出碼非 0 時拋出例外（含 az 的錯誤輸出）；回傳 stdout。
      stderr 寫到暫存檔：錯誤訊息可帶進例外，但 az 的警告不會即時顯示。要即時顯示 az 輸出時改用 Invoke-AzCli。
    #>
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$Context = 'az 指令'
    )
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $stdout = & az @Arguments 2> $errFile
        if ($LASTEXITCODE -ne 0) {
            $detail = (Get-Content -Raw -Encoding UTF8 $errFile)
            $detail = if ($detail) { "：$($detail.Trim())" } else { '' }
            throw "$Context 失敗（az 退出碼 $LASTEXITCODE）$detail"
        }
        return $stdout
    }
    finally {
        Remove-Item $errFile -ErrorAction SilentlyContinue
    }
}

function Invoke-AzCli {
    <#
      執行 az，退出碼非 0 時拋出例外；回傳 stdout。
      刻意不重導 stderr（az 的進度 / 錯誤直接顯示在輸出中）：PowerShell 5.1 一旦重導原生指令的 stderr 就會把警告轉成 ErrorRecord，
      在 $ErrorActionPreference = "Stop" 下會誤判為失敗，同時也會污染 JSON 輸出。錯誤訊息要帶進例外時改用 Invoke-Az。
    #>
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$Context = 'az 指令'
    )
    $stdout = & az @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Context 失敗（az 退出碼 $LASTEXITCODE），詳細錯誤請見上方輸出。"
    }
    return $stdout
}

function Get-FileHashBase64 {
    <# 檔案雜湊（base64）：SHA512 = electron-updater 的 latest.yml；MD5 = Blob 的 Content-MD5 #>
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateSet('MD5', 'SHA512')][string]$Algorithm = 'SHA512'
    )
    $hasher = if ($Algorithm -eq 'MD5') { [System.Security.Cryptography.MD5]::Create() } else { [System.Security.Cryptography.SHA512]::Create() }
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        return [Convert]::ToBase64String($hasher.ComputeHash($stream))
    } finally {
        $stream.Dispose()
        $hasher.Dispose()
    }
}

function Format-Size {
    <# 位元組數 → 顯示用大小（例：12.34 MB） #>
    param([long]$Bytes)
    if ($Bytes -ge 1GB) { return '{0:N2} GB' -f ($Bytes / 1GB) }
    if ($Bytes -ge 1MB) { return '{0:N2} MB' -f ($Bytes / 1MB) }
    if ($Bytes -ge 1KB) { return '{0:N2} KB' -f ($Bytes / 1KB) }
    return "$Bytes B"
}

function Resolve-ManifestFile {
    <# latest*.yml 內的 url 可能是原樣檔名，也可能是 URL 編碼過的（空白變 %20），兩種都試；找不到回傳 $null #>
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

function Read-DotEnv {
    <#
      讀取 .env（KEY=VALUE），規則與 script/ado/config.py 的 load_env 相同：# 開頭為註解，可加 export 前綴；
      值有成對的引號時去掉引號（引號內的 # 不是註解），沒有引號時去掉行尾「 #」之後的註解。檔案不存在時回傳空表。
      同名環境變數優先：由呼叫端決定（例如 `if ($env:X) { $env:X } else { $secrets['X'] }`）。
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
