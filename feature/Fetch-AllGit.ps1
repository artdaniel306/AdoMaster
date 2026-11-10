<#
.SYNOPSIS
    把指定根目錄下所有有 remote 的 git repo 中「落後 remote」的 local branch 快轉到 remote 最新版。

.DESCRIPTION
    對每個根目錄（預設 crmapp_AI 與 crmapp_deploy）：
      1. 找出根目錄本身與其第一層子資料夾中的 git repo，沒有設定任何 remote 的直接略過
      2. git fetch --all 更新 remote-tracking branch（fetch 失敗則整個 repo 略過）
         不加 --prune：remote 上有只差大小寫的 branch（如 Daniel / daniel）時，
         Windows 不分大小寫的檔案系統會讓 prune 撞 ref lock 而整個 fetch 失敗
      3. 逐一檢查有設定 upstream（且 upstream 為 remote branch）的 local branch：
         - 沒落後                         → 不動
         - 只落後、沒有領先（可快轉）      → 快轉到 upstream
         - 同時領先又落後（分岔）          → 略過，不做任何 merge / rebase
         - upstream 已被刪除（[gone]）     → 略過
      4. 快轉方式：
         - 該 branch 正被某個 worktree checkout：在該 worktree 執行 git merge --ff-only，
           若工作目錄的未提交修改會被覆蓋，git 會拒絕，此時略過
         - 沒被 checkout：直接以 git update-ref 移動 branch 指標（帶舊值比對，不碰工作目錄）
      5. 最後印出摘要

    執行位置：
      C:\Users\DanielLi\Documents\crmapp_AI\.manage\scripts\Fetch-AllGit.ps1
      cd C:\Users\DanielLi\Documents\crmapp_AI
      .\.manage\scripts\Fetch-AllGit.ps1
      .\.manage\scripts\Fetch-AllGit.ps1 -WhatIf     # 只 fetch remote 並列出會快轉哪些 branch，不移動 local branch

.PARAMETER Roots
    要掃描的根目錄，預設 C:\Users\DanielLi\Documents\crmapp_AI 與 C:\Users\DanielLi\Documents\crmapp_deploy

.EXAMPLE
    .\.manage\scripts\Fetch-AllGit.ps1 -Roots 'C:\Users\DanielLi\Documents\crmapp_AI'
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string[]]$Roots = @(
        'C:\Users\DanielLi\Documents\crmapp_AI',
        'C:\Users\DanielLi\Documents\crmapp_deploy'
    )
)

# git 的 stderr 常是一般進度訊息，不能讓它觸發終止錯誤；一律以 exit code 判斷成敗
$ErrorActionPreference = 'Continue'

function Invoke-Git {
    param([string]$Repo, [string[]]$GitArgs)
    # Windows PowerShell 5.1 會把 stderr 空行轉成內容為 RemoteException 類別名稱的 ErrorRecord，濾掉
    $output = & git -C $Repo @GitArgs 2>&1 |
        ForEach-Object { "$_" } |
        Where-Object { $_ -ne 'System.Management.Automation.RemoteException' }
    [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output   = @($output)
    }
}

function Get-ErrorSummary {
    # 摘要表只放一行：優先取 error: / fatal: 開頭的那行，否則取最後一行
    param([string[]]$Lines)
    $hit = $Lines | Where-Object { $_ -match '^(error|fatal):' } | Select-Object -First 1
    if ($hit) { $hit } else { $Lines | Select-Object -Last 1 }
}

function Get-GitRepos {
    param([string[]]$RootPaths)
    $candidates = foreach ($root in $RootPaths) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            Write-Warning "根目錄不存在，略過：$root"
            continue
        }
        Get-Item -LiteralPath $root
        Get-ChildItem -LiteralPath $root -Directory
    }
    foreach ($dir in $candidates) {
        # 只認 repo 根目錄（.git 可能是資料夾，也可能是 worktree / submodule 的 .git 檔）
        if (Test-Path -LiteralPath (Join-Path $dir.FullName '.git')) {
            $dir.FullName
        }
    }
}

function Get-WorktreeBranchMap {
    # 回傳 refs/heads/<branch> → 該 branch 被 checkout 的 worktree 路徑
    param([string]$Repo)
    $map = @{}
    $result = Invoke-Git $Repo @('worktree', 'list', '--porcelain')
    $current = $null
    foreach ($line in $result.Output) {
        if ($line -like 'worktree *') { $current = $line.Substring(9) }
        elseif ($line -like 'branch *') { $map[$line.Substring(7)] = $current }
    }
    $map
}

$summary = New-Object System.Collections.Generic.List[object]
function Add-Result {
    param([string]$Repo, [string]$Branch, [string]$Status, [string]$Detail = '')
    $summary.Add([pscustomobject]@{ Repo = $Repo; Branch = $Branch; Status = $Status; Detail = $Detail })
}

$repos = @(Get-GitRepos $Roots)
if ($repos.Count -eq 0) {
    Write-Host '找不到任何 git repo。'
    return
}

foreach ($repo in $repos) {
    $remotes = (Invoke-Git $repo @('remote')).Output | Where-Object { $_ }
    if (-not $remotes) {
        Write-Host "[略過] $repo（沒有 remote）" -ForegroundColor DarkGray
        continue
    }

    Write-Host ''
    Write-Host "== $repo" -ForegroundColor Cyan

    $fetch = Invoke-Git $repo @('fetch', '--all')
    if ($fetch.ExitCode -ne 0) {
        Write-Host '  fetch 失敗，略過此 repo：' -ForegroundColor Red
        $fetch.Output | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
        Add-Result $repo '-' 'FetchFailed' (Get-ErrorSummary $fetch.Output)
        continue
    }

    $worktreeMap = Get-WorktreeBranchMap $repo
    $refs = (Invoke-Git $repo @('for-each-ref', '--format=%(refname)%09%(upstream)%09%(upstream:track)', 'refs/heads')).Output

    foreach ($line in $refs) {
        $parts = $line -split "`t"
        if ($parts.Count -lt 3) { continue }
        $ref, $upstream, $track = $parts
        $branch = $ref -replace '^refs/heads/', ''

        # 沒有 upstream，或 upstream 是另一個 local branch，都不在本腳本處理範圍
        if ($upstream -notlike 'refs/remotes/*') { continue }
        $upstreamShort = $upstream -replace '^refs/remotes/', ''

        if ($track -like '*gone*') {
            Write-Host "  [略過] $branch：upstream $upstreamShort 已不存在" -ForegroundColor DarkYellow
            Add-Result $repo $branch 'UpstreamGone' $upstreamShort
            continue
        }

        $count = Invoke-Git $repo @('rev-list', '--left-right', '--count', "$ref...$upstream")
        if ($count.ExitCode -ne 0) {
            Write-Host "  [失敗] $branch：無法比較與 $upstreamShort 的差異" -ForegroundColor Red
            Add-Result $repo $branch 'Failed' (Get-ErrorSummary $count.Output)
            continue
        }
        $ahead, $behind = [int[]]($count.Output[0] -split '\s+')

        if ($behind -eq 0) { continue }

        if ($ahead -gt 0) {
            Write-Host "  [略過] $branch：與 $upstreamShort 分岔（領先 $ahead / 落後 $behind）" -ForegroundColor Yellow
            Add-Result $repo $branch 'Diverged' "ahead $ahead / behind $behind"
            continue
        }

        $action = "快轉 $branch 到 $upstreamShort（落後 $behind）"
        if (-not $PSCmdlet.ShouldProcess($repo, $action)) {
            Add-Result $repo $branch 'WouldUpdate' "behind $behind"
            continue
        }

        if ($worktreeMap.ContainsKey($ref)) {
            $worktree = $worktreeMap[$ref]
            $ff = Invoke-Git $worktree @('merge', '--ff-only', '--quiet', $upstream)
        }
        else {
            $oldSha = (Invoke-Git $repo @('rev-parse', $ref)).Output[0]
            $newSha = (Invoke-Git $repo @('rev-parse', $upstream)).Output[0]
            $ff = Invoke-Git $repo @('update-ref', '-m', "Fetch-AllGit: fast-forward to $upstreamShort", $ref, $newSha, $oldSha)
        }

        if ($ff.ExitCode -eq 0) {
            Write-Host "  [更新] $branch：已快轉到 $upstreamShort（+$behind）" -ForegroundColor Green
            Add-Result $repo $branch 'Updated' "+$behind"
        }
        else {
            Write-Host "  [略過] $branch：快轉失敗" -ForegroundColor Yellow
            $ff.Output | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
            Add-Result $repo $branch 'Failed' (Get-ErrorSummary $ff.Output)
        }
    }
}

Write-Host ''
Write-Host '======== 摘要 ========' -ForegroundColor Cyan
if ($summary.Count -eq 0) {
    Write-Host '所有 local branch 都沒有落後 remote。'
}
else {
    $summary | Format-Table Status, Repo, Branch, Detail -AutoSize -Wrap
}
