<#
.SYNOPSIS
    關閉正在執行的 UpAgent（「設定 UpAgent 連線」切換前呼叫，app 在 main/services/upagentConnection.js 執行）。

.DESCRIPTION
    以執行檔完整路徑（Win32_Process.ExecutablePath，不分大小寫）找出 UpAgent 的所有程序，同名但不同路徑的程式不會被關掉。
    先對每個程序送出正常關閉（CloseMainWindow），等到全部結束；超過 -TimeoutSeconds 仍未結束時強制結束（Stop-Process -Force）。
    結束後才回傳：UpAgent 關閉時可能會寫回設定檔，app 要等它完全結束後才刪除設定檔。
    只看得到目前使用者有權限讀取路徑的程序（其他使用者 / 系統管理員身分執行的程序會略過）。

.OUTPUTS
    -Out JSON：{ running, pids, forced }
      running = 執行前是否有 UpAgent 在執行；forced = 是否有程序被強制結束
#>
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [int]$TimeoutSeconds = 20,
    [string]$Out
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'Common.ps1')

try {
    $full = [System.IO.Path]::GetFullPath($ExePath)
    $name = [System.IO.Path]::GetFileName($full).Replace("'", "\'")

    function Get-TargetPids {
        @(Get-CimInstance Win32_Process -Filter "Name = '$name'" |
            Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $full) } |
            ForEach-Object { [int]$_.ProcessId })
    }

    function Get-Alive([int[]]$ids) {
        @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    }

    $pids = Get-TargetPids
    if (-not $pids.Count) {
        Write-Host "UpAgent 未在執行：$full"
        Write-Result @{ running = $false; pids = @(); forced = $false }
        exit 0
    }

    Write-Host "正在關閉 UpAgent（PID $($pids -join ', ')）"
    foreach ($p in (Get-Alive $pids)) {
        # 沒有主視窗的子程序（Electron 的 renderer / GPU 等）回傳 false，會隨主程序結束
        try { [void]$p.CloseMainWindow() } catch { }
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Alive $pids).Count -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
    }

    $forced = $false
    $alive = Get-Alive $pids
    if ($alive.Count) {
        Write-Host "UpAgent 在 $TimeoutSeconds 秒內未結束，強制結束（PID $(($alive | ForEach-Object Id) -join ', ')）"
        $forced = $true
        $alive | Stop-Process -Force -ErrorAction SilentlyContinue
        $deadline = (Get-Date).AddSeconds(10)
        while ((Get-Alive $pids).Count -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 300
        }
        $alive = Get-Alive $pids
        if ($alive.Count) {
            Exit-WithError "無法結束 UpAgent（PID $(($alive | ForEach-Object Id) -join ', ')），請手動關閉後再切換"
        }
    }

    Write-Host 'UpAgent 已關閉'
    Write-Result @{ running = $true; pids = $pids; forced = $forced }
}
catch {
    Exit-WithError "關閉 UpAgent 失敗：$($_.Exception.Message)"
}
