<#
.SYNOPSIS
    雲端同步 data/config.json 中所有 repository：git fetch，並把「只落後 remote」的 local branch 快轉到 remote 最新版。

.DESCRIPTION
    改寫自 feature/Fetch-AllGit.ps1（非互動、讀 config.json、結果輸出 JSON）。
    同步對象（相同路徑只做一次）：
      - repos[].path                     開發用 clone
      - localDeploy.repos.<key>.projectDir 部署用 clone
    對每個 repository：
      1. 路徑不存在 / 不是 git repo / 沒有 remote → 略過
      2. git fetch --all（不加 --prune：remote 上有只差大小寫的 branch 時，
         Windows 不分大小寫的檔案系統會讓 prune 撞 ref lock 而整個 fetch 失敗）；失敗則略過該 repo
      3. 逐一檢查 upstream 為 remote branch 的 local branch：
         - 沒落後                     → 不動
         - 只落後（可快轉）           → 快轉
         - 同時領先又落後（分岔）     → 略過，不做 merge / rebase
         - upstream 已刪除（[gone]）  → 略過
      4. 快轉方式：
         - 該 branch 正被某個 worktree checkout：在該 worktree 執行 git merge --ff-only
           （未提交的修改會被覆蓋時 git 會拒絕 → 記為失敗，不動工作目錄）
         - 沒被 checkout：git update-ref 移動 branch 指標（帶舊值比對，不碰工作目錄）
    -FetchOnly：只 fetch 並列出會快轉的 branch，不移動 local branch。

    進度 → stdout；結果 JSON → -Out：
      { "repos": [ { "key", "kind": "dev"|"deploy", "path", "status": "ok"|"skipped"|"fetchFailed",
                     "message", "upToDate": <沒落後的 branch 數>,
                     "branches": [ { "branch", "upstream", "status", "detail" } ] } ] }
      branch status：updated / wouldUpdate / diverged / upstreamGone / failed
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [switch]$FetchOnly,

    [string]$Out
)

# git 的 stderr 常是一般進度訊息，不能讓它觸發終止錯誤；一律以 exit code 判斷成敗
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Exit-WithError {
    param([string]$Message)
    [Console]::Error.WriteLine($Message)
    exit 1
}

function Invoke-Git {
    param([string]$Repo, [string[]]$GitArgs)
    # Windows PowerShell 5.1 會把 stderr 空行轉成內容為 RemoteException 類別名稱的 ErrorRecord，濾掉
    $global:LASTEXITCODE = 0
    $output = & git -C $Repo @GitArgs 2>&1 |
        ForEach-Object { "$_" } |
        Where-Object { $_ -ne 'System.Management.Automation.RemoteException' }
    [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output   = @($output)
    }
}

function Get-ErrorSummary {
    # 結果只放一行：優先取 error: / fatal: 開頭的那行，否則取最後一行
    param([string[]]$Lines)
    $hit = $Lines | Where-Object { $_ -match '^(error|fatal):' } | Select-Object -First 1
    if ($hit) { $hit } else { $Lines | Select-Object -Last 1 }
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

function Sync-Repo {
    param([string]$Key, [string]$Kind, [string]$Path)
    $result = [ordered]@{
        key      = $Key
        kind     = $Kind
        path     = $Path
        status   = 'ok'
        message  = ''
        upToDate = 0
        branches = New-Object System.Collections.Generic.List[object]
    }
    $kindText = if ($Kind -eq 'deploy') { '部署用 clone' } else { '開發用 clone' }
    Write-Host ''
    Write-Host "== $Key（$kindText）$Path"

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        $result.status = 'skipped'; $result.message = '資料夾不存在'
        Write-Host "  [略過] 資料夾不存在"
        return $result
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Path '.git'))) {
        $result.status = 'skipped'; $result.message = '不是 git repository'
        Write-Host "  [略過] 不是 git repository"
        return $result
    }
    $remotes = (Invoke-Git $Path @('remote')).Output | Where-Object { $_ }
    if (-not $remotes) {
        $result.status = 'skipped'; $result.message = '沒有設定 remote'
        Write-Host "  [略過] 沒有設定 remote"
        return $result
    }

    Write-Host "  git fetch --all"
    $fetch = Invoke-Git $Path @('fetch', '--all')
    if ($fetch.ExitCode -ne 0) {
        $fetch.Output | ForEach-Object { Write-Host "    $_" }
        $result.status = 'fetchFailed'; $result.message = [string](Get-ErrorSummary $fetch.Output)
        Write-Host "  [失敗] fetch 失敗，略過此 repository"
        return $result
    }

    $worktreeMap = Get-WorktreeBranchMap $Path
    $refs = (Invoke-Git $Path @('for-each-ref', '--format=%(refname)%09%(upstream)%09%(upstream:track)', 'refs/heads')).Output

    foreach ($line in $refs) {
        $parts = $line -split "`t"
        if ($parts.Count -lt 3) { continue }
        $ref, $upstream, $track = $parts
        $branch = $ref -replace '^refs/heads/', ''

        # 沒有 upstream，或 upstream 是另一個 local branch，都不處理
        if ($upstream -notlike 'refs/remotes/*') { continue }
        $upstreamShort = $upstream -replace '^refs/remotes/', ''
        $add = {
            param($status, $detail)
            $result.branches.Add([ordered]@{ branch = $branch; upstream = $upstreamShort; status = $status; detail = [string]$detail })
        }

        if ($track -like '*gone*') {
            Write-Host "  [略過] $branch：upstream $upstreamShort 已不存在"
            & $add 'upstreamGone' "upstream $upstreamShort 已不存在"
            continue
        }

        $count = Invoke-Git $Path @('rev-list', '--left-right', '--count', "$ref...$upstream")
        if ($count.ExitCode -ne 0) {
            Write-Host "  [失敗] $branch：無法比較與 $upstreamShort 的差異"
            & $add 'failed' (Get-ErrorSummary $count.Output)
            continue
        }
        $ahead, $behind = [int[]]($count.Output[0] -split '\s+')

        if ($behind -eq 0) { $result.upToDate++; continue }

        if ($ahead -gt 0) {
            Write-Host "  [略過] $branch：與 $upstreamShort 分岔（領先 $ahead / 落後 $behind）"
            & $add 'diverged' "領先 $ahead / 落後 $behind"
            continue
        }

        if ($FetchOnly) {
            Write-Host "  [可快轉] $branch：落後 $upstreamShort $behind 個 commit"
            & $add 'wouldUpdate' "落後 $behind"
            continue
        }

        if ($worktreeMap.ContainsKey($ref)) {
            $ff = Invoke-Git $worktreeMap[$ref] @('merge', '--ff-only', '--quiet', $upstream)
        }
        else {
            $oldSha = (Invoke-Git $Path @('rev-parse', $ref)).Output[0]
            $newSha = (Invoke-Git $Path @('rev-parse', $upstream)).Output[0]
            $ff = Invoke-Git $Path @('update-ref', '-m', "AdoMaster Sync-Repos: fast-forward to $upstreamShort", $ref, $newSha, $oldSha)
        }

        if ($ff.ExitCode -eq 0) {
            Write-Host "  [更新] $branch：已快轉到 $upstreamShort（+$behind）"
            & $add 'updated' "+$behind"
        }
        else {
            Write-Host "  [失敗] $branch：快轉失敗"
            $ff.Output | ForEach-Object { Write-Host "    $_" }
            & $add 'failed' (Get-ErrorSummary $ff.Output)
        }
    }
    return $result
}

# ---- 讀取設定 ----
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Exit-WithError '找不到 git，請先安裝 Git 並加入 PATH' }
if (-not (Test-Path -LiteralPath $ConfigPath)) { Exit-WithError "找不到設定檔 $ConfigPath" }
try {
    $config = [System.IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
}
catch {
    Exit-WithError "設定檔格式錯誤：$ConfigPath（$($_.Exception.Message)）"
}

$targets = New-Object System.Collections.Generic.List[object]
$seen = @{}
function Add-Target {
    param([string]$Key, [string]$Kind, [string]$Path)
    $Path = "$Path".Trim()
    if (-not $Path) { return }
    $norm = [System.IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant()
    if ($seen.ContainsKey($norm)) { return }
    $seen[$norm] = $true
    $targets.Add([pscustomobject]@{ Key = $Key; Kind = $Kind; Path = $Path })
}
foreach ($r in @($config.repos)) {
    if ($r -and $r.key) { Add-Target ([string]$r.key) 'dev' ([string]$r.path) }
}
if ($config.localDeploy -and $config.localDeploy.repos) {
    foreach ($p in $config.localDeploy.repos.PSObject.Properties) {
        if ($p.Value -and $p.Value.PSObject.Properties['projectDir']) { Add-Target $p.Name 'deploy' ([string]$p.Value.projectDir) }
    }
}
if ($targets.Count -eq 0) { Exit-WithError "$ConfigPath 的 repos / localDeploy 沒有設定任何 repository 路徑" }

$mode = if ($FetchOnly) { '（只 fetch，不快轉）' } else { '' }
Write-Host "同步 $($targets.Count) 個 repository$mode"

$results = New-Object System.Collections.Generic.List[object]
foreach ($t in $targets) {
    $results.Add((Sync-Repo -Key $t.Key -Kind $t.Kind -Path $t.Path))
}

Write-Host ''
Write-Host '完成'

if ($Out) {
    $json = ConvertTo-Json -InputObject ([ordered]@{ repos = $results.ToArray() }) -Depth 6
    [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding $false))
}
