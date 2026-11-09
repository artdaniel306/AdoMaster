<#
.SYNOPSIS
  範例 PowerShell 腳本：示範 AdoMaster app 呼叫 shell/*.ps1 的慣例。

.DESCRIPTION
  慣例（與 script/*.py 相同）：
  - 參數用具名參數（app 以 -File 執行，參數一律以字串傳入）。
  - 進度訊息寫到 stdout；結果以 JSON 寫到 -Out 指定的檔案（UTF-8 無 BOM）。
  - 失敗時把訊息寫到 stderr 並以 exit code 1 結束，app 會把 stderr 當成錯誤訊息。
  - 本檔需存成 UTF-8 with BOM，Windows PowerShell 5.1 才能正確讀取中文。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File shell\example.ps1 -Name Daniel -Out result.json
#>
param(
    [string]$Name = 'AdoMaster',
    [string]$Out,
    [switch]$Fail  # 示範錯誤處理用
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    if ($Fail) { throw '這是示範用的錯誤（-Fail）' }

    Write-Output "Hello, $Name！正在收集環境資訊…"

    $result = [ordered]@{
        greeting          = "Hello, $Name！"
        powershellVersion = $PSVersionTable.PSVersion.ToString()
        edition           = $PSVersionTable.PSEdition
        computerName      = $env:COMPUTERNAME
        userName          = $env:USERNAME
        workingDirectory  = (Get-Location).Path
        timestamp         = (Get-Date).ToString('o')
    }
    $json = $result | ConvertTo-Json -Depth 10

    if ($Out) {
        [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding $false))
        Write-Output "已寫入 $Out"
    } else {
        Write-Output $json
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
