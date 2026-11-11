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
    <# 執行 az，退出碼非 0 時拋出例外（含 az 的錯誤輸出）；回傳 stdout #>
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
