<#
.SYNOPSIS
    正式環境佈版後的動作：依選擇的日期 / 時段，在 Azure Automation 排程重啟該 repository 的正式環境 App Service。

.DESCRIPTION
    app 的呼叫時機：正式環境佈版勾 SaaS（或手動佈版到正式環境 SaaS），push 觸發的 Pipeline Run 成功後，
    對每個 Run 成功的 repository 各呼叫一次（app/src/main/services/afterDeploy.js）。

    正式環境有客戶在使用，絕不立即重啟 App Service：
      - 有 -RestartDate / -RestartTime → 交給 Restart-Schedule.ps1 -Action Create 建立一次性 Schedule 並連結重啟用的 Runbook
        （設定在 data/config.json 的 prodRestart；同一 repo 同一時間已排程時不重複建立）
      - 沒有 → 不做任何事（佈版時選了「不排程重啟」）
    之後若要加其他正式環境佈版後的動作，寫在這裡。

    慣例（見 shell/CLAUDE.md）：進度寫 stdout，結果 JSON 寫到 -Out，失敗時 stderr + exit 1。
    結果 JSON：{ message, restart? }，message 會顯示在佈版 dialog 該 repository 的 Pipeline 底下。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File shell\After-ProdDeploy.ps1 -Repo crmapp -Commit abc1234 -RestartDate 2026-11-12 -RestartTime 23:30 -Note "Requirement #123" -Out result.json
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Repo,         # data/config.json 的 repos 的 key（crmapp / crmappui …）

    [string]$Commit,       # 這次 push 到正式環境 branch 的 merge commit

    [string]$RestartDate,  # 排程重啟的日期 yyyy-MM-dd（空白 = 不排程）
    [string]$RestartTime,  # 排程重啟的時間 HH:mm
    [string]$Note,         # 寫進 Schedule 說明（例如 Requirement #123）

    [string]$Out
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'Common.ps1')

try {
    if (-not $RestartDate) {
        Write-Result ([ordered]@{ message = '未排程重啟（正式環境不立即重啟）' })
        exit 0
    }
    if (-not $RestartTime) { throw '有 -RestartDate 時必須指定 -RestartTime' }

    $notes = @($Note, $(if ($Commit) { "commit $($Commit.Substring(0, [Math]::Min(10, $Commit.Length)))" })) | Where-Object { $_ }
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        # 同一個 PowerShell 執行：子腳本的 stdout / stderr 直接成為本腳本的輸出，失敗時以 $LASTEXITCODE 回報
        $global:LASTEXITCODE = 0
        &(Join-Path $PSScriptRoot 'Restart-Schedule.ps1') -Action Create -Repo $Repo -Date $RestartDate -Time $RestartTime -Note ($notes -join ' · ') -Out $tmp
        if ($LASTEXITCODE -ne 0) { exit 1 }   # 錯誤訊息已由 Restart-Schedule.ps1 寫到 stderr
        $schedule = [System.IO.File]::ReadAllText($tmp) | ConvertFrom-Json
    }
    finally {
        Remove-Item $tmp -ErrorAction SilentlyContinue
    }
    Write-Result ([ordered]@{ message = $schedule.message; restart = $schedule })
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
