<#
.SYNOPSIS
    Local（地端）佈版：在部署用資料夾切到環境 branch → (前置指令) → docker buildx build 成 .tar → docker load + push → ssh 到主機換掉 container。

.DESCRIPTION
    由 docs/reference/release/deploy-crmapp.ps1 / deploy-crmappui.ps1 改寫成 app 呼叫用的版本（非互動、設定從 config.json 讀取）。
    app 的呼叫時機：測試 / 正式環境佈版勾 Local，確認 commit 已 merge 進環境 branch 後，
    對規劃中有設定 localDeploy 的 repository 各執行一次（app/src/main/services/localDeploy.js）。

    步驟（stdout 標記 ::step::<步驟>）：
      1. (Docker)   確認 Docker engine 有回應；沒有時啟動 Docker Desktop 並等待（最多 180 秒）
      2. (Source)   部署用資料夾（projectDir，與開發用 clone 分開）git fetch 環境 branch，
                    確認 -ExpectedCommit 已在 origin/<branch> 中，git checkout --detach origin/<branch>。
                    資料夾內未提交的本機修改（地端專用設定）會保留；與新版本衝突時 git 會拒絕切換 → 失敗（不強制覆蓋）
      3. (PreBuild) 有設定 preBuild 時在 projectDir 以 cmd /c 執行（例如 crmapp 的 armor.bat aarch64）
      4. (Build)    docker buildx build --platform <platform> [--build-arg K=V …] -t <pushRegistry>/<appName>:<tag>
                    --output type=docker,dest=<tar>，tar = data\local_deploy\<Repo>\<appName>_<tag>.tar
                    （先寫 .partial，成功才改名，失敗不會留下不完整的 tar）
      5. (Push)     docker load -i <tar> → docker push <pushRegistry>/<appName>:<tag>
      6. (Deploy)   ssh <remoteHost>：docker pull → docker rm -f <appName> → docker run -d … → docker ps
                    （先 pull 再換 container，縮短停機時間；ssh 以 BatchMode 執行，需已設定金鑰登入）

    tag 含 commit，所以 Push / Deploy 失敗後重試時，同一個 commit 的 tar 已存在就略過 PreBuild / Build
    （-Rebuild 強制重新 build，例如改了部署用資料夾的本機設定或 buildArgs）。
    每個 repository 只保留最新的 $KeepTars 個 tar。

    設定讀取 data\config.json 的 localDeploy.repos.<Repo>，<test|prod> 子物件的欄位覆蓋外層同名欄位：
      projectDir     部署用資料夾（git clone，必填）
      appName        image / container 名稱（預設 = Repo）
      platform       docker buildx --platform（預設 linux/arm64）
      preBuild       build 前在 projectDir 執行的指令（cmd /c，選填）
      pushRegistry   本機 push 用的 registry（例如 192.168.1.139:5000，必填）
      pullRegistry   遠端主機 pull 用的 registry（預設 localhost:5000）
      remoteHost     ssh 目標（例如 admin@192.168.1.232，必填）
      network        docker network（選填）
      hostPort / appPort   -p <hostPort>:<appPort>（必填）
      buildArgs      { K: V } → --build-arg K=V
      runEnv         { K: V } → docker run -e K=V
    image tag = <Environment>-<deploy 的 commit 前 10 碼>（例如 test-1a2b3c4d5e）。

    慣例（見 shell/CLAUDE.md）：進度寫 stdout（docker / git 的進度在 stderr，app 也會即時顯示），
    結果 JSON 寫到 -Out，失敗時 ::error:: 標記 + stderr + exit 1。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File shell\Deploy-Local.ps1 -Repo crmapp -Environment test -Branch release_peach -ExpectedCommit abc1234 -ConfigPath data\config.json
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Repo,              # data/config.json 的 repos 的 key（crmapp / crmappui …）

    [Parameter(Mandatory = $true)]
    [ValidateSet("test", "prod")]
    [string]$Environment,

    [Parameter(Mandatory = $true)]
    [string]$Branch,            # 環境 branch（testBranch / prodBranch）

    [string]$ExpectedCommit,    # Confirm Commit 的 commit：必須已在 origin/<Branch> 中

    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [switch]$Rebuild,           # 忽略已存在的 tar，重新 build

    [string]$Out
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$DockerTimeoutSec = 180
$KeepTars = 3
$tarRoot = Join-Path (Split-Path -Parent $PSScriptRoot) "data\local_deploy"

function Exit-WithError {
    <# 輸出 ::error:: 標記（stdout）與錯誤訊息（stderr），以 exit code 1 結束 #>
    param([string]$Message)
    Write-Host "::error::$($Message -replace '\r?\n', ' ')"
    [Console]::Error.WriteLine($Message)
    exit 1
}

function Invoke-Native {
    <#
      執行外部指令，stdout 即時輸出；退出碼非 0 時拋出例外。
      刻意不重導 stderr（docker / git 的進度在 stderr，直接交給 app 顯示）：
      PowerShell 5.1 重導原生指令的 stderr 會轉成 ErrorRecord，在 $ErrorActionPreference = "Stop" 下會誤判為失敗。
    #>
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$Context = $FilePath
    )
    $global:LASTEXITCODE = 0
    & $FilePath @Arguments | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        throw "$Context 失敗（退出碼 $LASTEXITCODE），詳細錯誤請見上方輸出。"
    }
}

function Get-NativeOutput {
    <# 執行外部指令並回傳 stdout（字串陣列），不拋例外；退出碼放在 $LASTEXITCODE。stderr 丟棄。 #>
    param([Parameter(Mandatory = $true)][string]$FilePath, [string[]]$Arguments = @())
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $global:LASTEXITCODE = 0
        return @(& $FilePath @Arguments 2> $null)
    }
    finally {
        $ErrorActionPreference = $prev
    }
}

function Write-Step {
    param([string]$Step, [string]$Title)
    Write-Host "::step::$Step"
    Write-Host ""
    Write-Host "==> $Title"
}

function Get-Setting {
    <# 先找 <test|prod> 子物件，再找外層 #>
    param([string]$Name, $Default = $null, [switch]$Required)
    foreach ($obj in @($envSettings, $repoSettings)) {
        if ($obj -and $obj.PSObject.Properties[$Name] -and $null -ne $obj.$Name -and "$($obj.$Name)" -ne "") {
            return $obj.$Name
        }
    }
    if ($Required) { throw "$ConfigPath 缺少 localDeploy.repos.$Repo 的 $Name（可放在外層或 $Environment 子物件）" }
    return $Default
}

function Get-Pairs {
    <# { K: V } 物件（外層 + <test|prod> 子物件合併）→ @("K=V", …) #>
    param([string]$Name)
    $map = [ordered]@{}
    foreach ($obj in @($repoSettings, $envSettings)) {
        if ($obj -and $obj.PSObject.Properties[$Name] -and $obj.$Name) {
            foreach ($p in $obj.$Name.PSObject.Properties) { $map[$p.Name] = [string]$p.Value }
        }
    }
    return @($map.Keys | ForEach-Object { "$_=$($map[$_])" })
}

function Test-DockerReady {
    Get-NativeOutput -FilePath "docker" -Arguments @("info", "--format", "{{.ServerVersion}}") | Out-Null
    return ($LASTEXITCODE -eq 0)
}

try {
    if ($Repo -notmatch '^[A-Za-z0-9_.-]+$') { throw "Repo 名稱不正確：$Repo" }
    if ($ExpectedCommit -and $ExpectedCommit -notmatch '^[0-9a-fA-F]{4,40}$') { throw "ExpectedCommit 格式不正確：$ExpectedCommit" }

    # ---- 讀取設定 ----
    if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "找不到設定檔 $ConfigPath" }
    $config = [System.IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
    $repoSettings = $null
    if ($config.localDeploy -and $config.localDeploy.repos -and $config.localDeploy.repos.PSObject.Properties[$Repo]) {
        $repoSettings = $config.localDeploy.repos.$Repo
    }
    if (-not $repoSettings) { throw "$ConfigPath 尚未設定 localDeploy.repos.$Repo" }
    $envSettings = $null
    if ($repoSettings.PSObject.Properties[$Environment]) { $envSettings = $repoSettings.$Environment }
    if (-not $envSettings) { throw "$ConfigPath 尚未設定 localDeploy.repos.$Repo.$Environment" }

    $projectDir   = [string](Get-Setting "projectDir" -Required)
    $appName      = [string](Get-Setting "appName" $Repo)
    $platform     = [string](Get-Setting "platform" "linux/arm64")
    $preBuild     = [string](Get-Setting "preBuild" "")
    $pushRegistry = [string](Get-Setting "pushRegistry" -Required)
    $pullRegistry = [string](Get-Setting "pullRegistry" "localhost:5000")
    $remoteHost   = [string](Get-Setting "remoteHost" -Required)
    $network      = [string](Get-Setting "network" "")
    $hostPort     = [string](Get-Setting "hostPort" -Required)
    $appPort      = [string](Get-Setting "appPort" -Required)
    $buildArgs    = Get-Pairs "buildArgs"
    $runEnv       = Get-Pairs "runEnv"

    # 會組進遠端 shell 指令的值，只允許安全字元
    foreach ($pair in @(@("appName", $appName), @("pullRegistry", $pullRegistry), @("network", $network), @("hostPort", $hostPort), @("appPort", $appPort))) {
        if ($pair[1] -notmatch '^[A-Za-z0-9_.:/-]*$') { throw "localDeploy.repos.$Repo 的 $($pair[0]) 含有不允許的字元：$($pair[1])" }
    }
    foreach ($kv in $runEnv) {
        if ($kv -notmatch '^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.:/@%+,-]*$') { throw "localDeploy.repos.$Repo 的 runEnv 含有不允許的字元：$kv" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDir ".git"))) { throw "部署用資料夾不是 git repository：$projectDir" }

    $label = @{ test = "測試環境"; prod = "正式環境" }[$Environment]
    Write-Host "Local 佈版：$Repo → $label（$remoteHost，port $hostPort）"

    # ---- 1. Docker ----
    Write-Step "Docker" "確認 Docker engine"
    if (Test-DockerReady) {
        Write-Host "Docker engine 已啟動"
    } else {
        $candidates = @(
            [string]$config.localDeploy.dockerDesktop,
            (Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"),
            (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe")
        ) | Where-Object { $_ }
        $exe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if (-not $exe) { throw "Docker engine 沒有回應，也找不到 Docker Desktop（可在 $ConfigPath 的 localDeploy.dockerDesktop 指定路徑）" }
        Write-Host "啟動 Docker Desktop：$exe"
        Start-Process -FilePath $exe
        $elapsed = 0
        while ($true) {
            Start-Sleep -Seconds 5
            $elapsed += 5
            if (Test-DockerReady) { Write-Host "Docker engine 已就緒（$elapsed 秒）"; break }
            if ($elapsed -ge $DockerTimeoutSec) { throw "Docker Desktop 在 $DockerTimeoutSec 秒內沒有就緒" }
            Write-Host "  等待 Docker engine…（$elapsed 秒）"
        }
    }

    # ---- 2. Source ----
    Write-Step "Source" "部署用資料夾切到 origin/$Branch（$projectDir）"
    Set-Location -LiteralPath $projectDir
    Invoke-Native -FilePath "git" -Arguments @("fetch", "origin", "+refs/heads/${Branch}:refs/remotes/origin/$Branch") -Context "git fetch origin $Branch"
    $target = (Get-NativeOutput -FilePath "git" -Arguments @("rev-parse", "--verify", "--quiet", "refs/remotes/origin/$Branch^{commit}")) | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $target) { throw "找不到 origin/$Branch" }
    if ($ExpectedCommit) {
        $expected = (Get-NativeOutput -FilePath "git" -Arguments @("rev-parse", "--verify", "--quiet", "$ExpectedCommit^{commit}")) | Select-Object -First 1
        if ($LASTEXITCODE -ne 0 -or -not $expected) { throw "部署用資料夾找不到 commit $ExpectedCommit" }
        Get-NativeOutput -FilePath "git" -Arguments @("merge-base", "--is-ancestor", $expected, $target) | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "commit $ExpectedCommit 不在 origin/$Branch 中" }
    }
    $dirty = Get-NativeOutput -FilePath "git" -Arguments @("status", "--porcelain", "--untracked-files=no")
    if ($dirty) {
        Write-Host "保留部署用資料夾的本機修改："
        $dirty | ForEach-Object { Write-Host "  $_" }
    }
    # 不加 --force：本機修改與新版本衝突時 git 會拒絕，不會覆蓋
    Invoke-Native -FilePath "git" -Arguments @("checkout", "--detach", $target) -Context "git checkout origin/$Branch（若是本機修改衝突，請手動處理 $projectDir）"
    $short = $target.Substring(0, 10)
    Write-Host "目前版本：$short（origin/$Branch）"

    $tag = "$Environment-$short"
    # tar 內的 image 名稱不含 registry：改了 pushRegistry 也能沿用已 build 的 tar
    $localImage = "${appName}:$tag"
    $pushImage = "$pushRegistry/$localImage"
    $pullImage = "$pullRegistry/$localImage"
    $tarDir = Join-Path $tarRoot $Repo
    $tarPath = Join-Path $tarDir "${appName}_$tag.tar"

    if ((Test-Path -LiteralPath $tarPath) -and -not $Rebuild) {
        Write-Host ""
        Write-Host "已有此版本的 image tar，略過前置指令與 build：$tarPath"
    } else {
        # ---- 3. PreBuild ----
        if ($preBuild) {
            Write-Step "PreBuild" "執行前置指令：$preBuild"
            Invoke-Native -FilePath "cmd.exe" -Arguments @("/d", "/c", $preBuild) -Context "前置指令 $preBuild"
        }

        # ---- 4. Build ----
        Write-Step "Build" "Build $localImage → $tarPath"
        New-Item -ItemType Directory -Force -Path $tarDir | Out-Null
        $partial = "$tarPath.partial"
        Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
        $dockerArgs = @("buildx", "build", "--progress=plain", "--platform", $platform)
        foreach ($kv in $buildArgs) { $dockerArgs += @("--build-arg", $kv) }
        $dockerArgs += @("-t", $localImage, "--output", "type=docker,dest=$partial", ".")
        try {
            Invoke-Native -FilePath "docker" -Arguments $dockerArgs -Context "docker buildx build"
        } catch {
            Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
            throw
        }
        Move-Item -LiteralPath $partial -Destination $tarPath -Force
        Write-Host ("已輸出 {0}（{1:N0} MB）" -f $tarPath, ((Get-Item -LiteralPath $tarPath).Length / 1MB))

        # 只保留最新的 $KeepTars 個 tar
        Get-ChildItem -LiteralPath $tarDir -Filter "*.tar" |
            Sort-Object LastWriteTime -Descending |
            Select-Object -Skip $KeepTars |
            ForEach-Object {
                Write-Host "刪除舊的 image tar：$($_.Name)"
                Remove-Item -LiteralPath $_.FullName -Force
            }
    }

    # ---- 5. Push ----
    Write-Step "Push" "docker load + push $pushImage"
    Invoke-Native -FilePath "docker" -Arguments @("load", "-i", $tarPath) -Context "docker load"
    Invoke-Native -FilePath "docker" -Arguments @("tag", $localImage, $pushImage) -Context "docker tag"
    Invoke-Native -FilePath "docker" -Arguments @("push", $pushImage) -Context "docker push $pushImage"

    # ---- 6. Deploy ----
    Write-Step "Deploy" "在 $remoteHost 更新 container $appName"
    $runArgs = @("docker run -d --name $appName")
    if ($network) { $runArgs += "--network $network" }
    $runArgs += "-p ${hostPort}:$appPort"
    foreach ($kv in $runEnv) { $runArgs += "-e $kv" }
    $runArgs += "--restart unless-stopped $pullImage"
    # 先 pull 再換 container，縮短停機時間；container 不存在時 docker rm -f 也不會失敗
    $remoteCmd = @(
        "docker pull $pullImage",
        "(docker rm -f $appName >/dev/null 2>&1 || true)",
        ($runArgs -join " "),
        "docker ps --filter name=^/$appName`$"
    ) -join " && "
    Invoke-Native -FilePath "ssh" -Arguments @("-o", "BatchMode=yes", "-o", "ConnectTimeout=15", $remoteHost, $remoteCmd) -Context "ssh $remoteHost"

    Write-Host ""
    Write-Host "完成：$appName（$tag）已在 $remoteHost 執行（port $hostPort）"
    $result = [ordered]@{
        repo        = $Repo
        environment = $Environment
        commit      = $target
        image       = $pushImage
        tar         = $tarPath
        remoteHost  = $remoteHost
        hostPort    = $hostPort
    }
    if ($Out) {
        [System.IO.File]::WriteAllText($Out, ($result | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))
    }
}
catch {
    Exit-WithError $_.Exception.Message
}
