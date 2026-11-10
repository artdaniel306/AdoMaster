<#
.SYNOPSIS
    正式環境 App Service 的排程重啟：在 Azure Automation 建立 / 列出 / 刪除「一次性 Schedule + 連結 Runbook（Job Schedule）」。

.DESCRIPTION
    正式環境有客戶在使用，不立即重啟，而是排在指定時間由 Automation 的 Runbook 重啟。
    做法見 feature/azure-automation-schedule-az-cli.md：
      - Schedule：PUT .../automationAccounts/<aa>/schedules/<name>（frequency = OneTime）
      - Job Schedule（Schedule 掛到 Runbook 並帶參數）：PUT .../jobSchedules/<GUID>
    az cli 只負責登入身分（az account get-access-token），REST 呼叫用 Invoke-RestMethod：
    az 在 Windows 是 az.cmd，經 cmd.exe 轉手時 JSON body 的引號與 nextLink 中的 & 都會被破壞。

    -Action List    列出名稱以 schedulePrefix 開頭的 Schedule 與連結的 Runbook / 參數（含已過期的）
    -Action Create  為 -Repo 建立 -Date -Time 的重啟排程；同名 Schedule 已存在且已連結 Runbook 時不重複建立
                    （Schedule 名稱 = <schedulePrefix>-<repo>-<yyyyMMdd>-<HHmm>，同一 repo 同一時間只會有一個）
    -Action Delete  刪除 -Name 的 Schedule（先刪連結的 Job Schedule）；只接受 schedulePrefix 開頭的名稱

    設定讀取 data\config.json 的 prodRestart（範本：templates\config_example.json）：
      subscription       選填，空白 = az 目前的訂閱
      resourceGroup      Automation Account 所在的 Resource Group
      automationAccount  Automation Account 名稱
      runbook            重啟 App Service 的 Runbook 名稱（需已存在並發佈）
      runbookParameters  Runbook 參數：{ 參數名稱: 值 }，值中的 {欄位} 以 repos.<repo>.<欄位> 取代（{repo} = repo key）
      runOn              選填，Hybrid Worker Group
      timeZone           Schedule 的時區（預設 Asia/Taipei）
      utcOffset          -Date -Time 的 UTC 位移（預設 +08:00）
      schedulePrefix     Schedule 名稱前綴（預設 adomaster-restart）
      repos              { <repo key>: { appService, resourceGroup, … } }

    需先 az login（帳號需有該 Automation Account 的權限）。
    慣例（見 shell/CLAUDE.md）：進度寫 stdout，結果 JSON 寫到 -Out，失敗時 stderr + exit 1。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File shell\Restart-Schedule.ps1 -Action List -Out list.json
    powershell -NoProfile -ExecutionPolicy Bypass -File shell\Restart-Schedule.ps1 -Action Create -Repo crmapp -Date 2026-11-12 -Time 23:30 -Note "Requirement #123"
    powershell -NoProfile -ExecutionPolicy Bypass -File shell\Restart-Schedule.ps1 -Action Delete -Name adomaster-restart-crmapp-20261112-2330
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('List', 'Create', 'Delete')]
    [string]$Action,

    [string]$Repo,       # Create：data/config.json 的 prodRestart.repos 的 key（crmapp / crmappui …）
    [string]$Date,       # Create：yyyy-MM-dd
    [string]$Time,       # Create：HH:mm
    [string]$Note,       # Create：寫進 Schedule 說明（例如 Requirement #123、commit）
    [string]$Name,       # Delete：Schedule 名稱

    [string]$ConfigPath,
    [string]$Out
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$ApiVersion = '2023-11-01'
# Azure 要求 Schedule 的開始時間至少在 5 分鐘之後
$MinLeadMinutes = 6

function Write-Result {
    param($Result)
    if (-not $Out) { return }
    $json = ConvertTo-Json -InputObject $Result -Depth 10
    [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding $false))
}

function Get-Setting {
    param($Object, [string]$Field, [string]$Default)
    if ($Object -and $Object.PSObject.Properties[$Field] -and [string]$Object.$Field) { return [string]$Object.$Field }
    return $Default
}

function Invoke-Az {
    <# 執行 az，退出碼非 0 時拋出例外（含 az 的錯誤輸出）；回傳 stdout #>
    param([Parameter(Mandatory = $true)][string[]]$Arguments, [string]$Context = 'az 指令')
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

function Invoke-Arm {
    <#
      呼叫 Azure Resource Manager REST API。-Path 為 automationAccounts/<aa> 之後的路徑（例 schedules/xxx），
      或以 -Url 指定完整網址（nextLink）。404 且 -AllowNotFound 時回傳 $null。
    #>
    param(
        [ValidateSet('GET', 'PUT', 'DELETE')][string]$Method = 'GET',
        [string]$Path,
        [string]$Url,
        $Body,
        [switch]$AllowNotFound
    )
    if (-not $Url) { $Url = "$script:baseUrl/$($Path)?api-version=$ApiVersion" }
    $params = @{
        Method      = $Method
        Uri         = $Url
        Headers     = @{ Authorization = "Bearer $script:token" }
        ErrorAction = 'Stop'
    }
    if ($null -ne $Body) {
        $json = ConvertTo-Json -InputObject $Body -Depth 10
        $params.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
        $params.ContentType = 'application/json; charset=utf-8'
    }
    try {
        return Invoke-RestMethod @params
    }
    catch {
        $response = $_.Exception.Response
        $status = if ($response) { [int]$response.StatusCode } else { 0 }
        if ($status -eq 404 -and $AllowNotFound) { return $null }
        $detail = ''
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            $detail = $_.ErrorDetails.Message
        }
        elseif ($response) {
            try {
                $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
                $detail = $reader.ReadToEnd()
            } catch { }
        }
        try {
            $parsed = $detail | ConvertFrom-Json
            if ($parsed.error.message) { $detail = $parsed.error.message } elseif ($parsed.message) { $detail = $parsed.message }
        } catch { }
        if (-not $detail) { $detail = $_.Exception.Message }
        throw "Azure Automation API $Method $($Path) 失敗（HTTP $status）：$detail"
    }
}

function Get-AllPages {
    <# GET 清單並跟著 nextLink 取完所有頁 #>
    param([string]$Path)
    $items = @()
    $page = Invoke-Arm -Path $Path
    while ($true) {
        if ($page.value) { $items += @($page.value) }
        if (-not $page.nextLink) { break }
        $page = Invoke-Arm -Url $page.nextLink
    }
    return $items
}

function Get-RestartSchedules {
    <# 名稱符合 <prefix>-<repo>-<yyyyMMdd>-<HHmm> 的 Schedule，連同連結的 Job Schedule #>
    $pattern = '^' + [regex]::Escape($script:prefix) + '-(?<repo>.+)-(?<d>\d{8})-(?<t>\d{4})$'
    $jobSchedules = Get-AllPages -Path 'jobSchedules'
    $now = [DateTimeOffset]::Now
    $result = @()
    foreach ($s in (Get-AllPages -Path 'schedules')) {
        $m = [regex]::Match([string]$s.name, $pattern)
        if (-not $m.Success) { continue }
        $links = @($jobSchedules | Where-Object { $_.properties.schedule.name -eq $s.name })
        # pwsh 的 ConvertFrom-Json 會把日期轉成 DateTime；Windows PowerShell 5.1 則保留字串
        $raw = $s.properties.startTime
        $start = if ($raw -is [DateTime]) { [DateTimeOffset]$raw } else { [DateTimeOffset]::Parse([string]$raw, [Globalization.CultureInfo]::InvariantCulture) }
        $d = $m.Groups['d'].Value
        $t = $m.Groups['t'].Value
        $result += [ordered]@{
            name        = $s.name
            repo        = $m.Groups['repo'].Value
            date        = "$($d.Substring(0, 4))-$($d.Substring(4, 2))-$($d.Substring(6, 2))"
            time        = "$($t.Substring(0, 2)):$($t.Substring(2, 2))"
            startTime   = $start.ToString('o')
            expired     = ($start -le $now)
            enabled     = [bool]$s.properties.isEnabled
            timeZone    = $s.properties.timeZone
            description = $s.properties.description
            createdAt   = $s.properties.creationTime
            links       = @($links | ForEach-Object {
                    [ordered]@{
                        jobScheduleId = $_.properties.jobScheduleId
                        runbook       = $_.properties.runbook.name
                        parameters    = $_.properties.parameters
                    }
                })
        }
    }
    return @($result | Sort-Object { $_.startTime })
}

function Get-RunbookParameters {
    <# 依 runbookParameters 範本產生參數（{欄位} → prodRestart.repos.<repo>.<欄位>；{repo} = repo key） #>
    param($RepoConfig, [string]$RepoKey)
    $template = $script:cfg.runbookParameters
    if (-not $template) { throw "$ConfigPath 缺少 prodRestart.runbookParameters（Runbook 的參數，例：{ ""AppServiceName"": ""{appService}"" }）" }
    $params = [ordered]@{}
    foreach ($p in $template.PSObject.Properties) {
        $value = [string]$p.Value
        foreach ($m in [regex]::Matches($value, '\{(\w+)\}')) {
            $field = $m.Groups[1].Value
            $v = if ($field -eq 'repo') { $RepoKey } elseif ($RepoConfig.PSObject.Properties[$field]) { [string]$RepoConfig.$field } else { '' }
            if (-not $v) { throw "$ConfigPath 的 prodRestart.repos.$RepoKey 缺少 $field（runbookParameters.$($p.Name) 用到）" }
            $value = $value.Replace($m.Value, $v)
        }
        $params[$p.Name] = $value
    }
    return $params
}

try {
    # ---- 設定 ----
    $dataRoot = if ($env:ADOMASTER_DATA_DIR) { $env:ADOMASTER_DATA_DIR } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'data' }  # app 會以 ADOMASTER_DATA_DIR 指定 data 資料夾
    if (-not $ConfigPath) { $ConfigPath = Join-Path $dataRoot 'config.json' }
    if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "找不到設定檔：$ConfigPath（範本：templates\config_example.json）" }
    try {
        $config = [System.IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
    } catch {
        throw "$ConfigPath 格式錯誤：$($_.Exception.Message)"
    }
    $script:cfg = $config.prodRestart
    if (-not $script:cfg) { throw "$ConfigPath 缺少 prodRestart（正式環境排程重啟的設定，範本：templates\config_example.json）" }
    $resourceGroup = Get-Setting $script:cfg 'resourceGroup'
    $account = Get-Setting $script:cfg 'automationAccount'
    $runbook = Get-Setting $script:cfg 'runbook'
    foreach ($pair in @(@('resourceGroup', $resourceGroup), @('automationAccount', $account), @('runbook', $runbook))) {
        if (-not $pair[1]) { throw "$ConfigPath 缺少 prodRestart.$($pair[0])" }
    }
    $subscription = Get-Setting $script:cfg 'subscription'
    $timeZone = Get-Setting $script:cfg 'timeZone' 'Asia/Taipei'
    $utcOffset = Get-Setting $script:cfg 'utcOffset' '+08:00'
    $script:prefix = Get-Setting $script:cfg 'schedulePrefix' 'adomaster-restart'
    $runOn = Get-Setting $script:cfg 'runOn'

    # ---- 登入（az 取得 ARM token） ----
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw '找不到 Azure CLI（az），請先安裝：https://aka.ms/installazurecliwindows'
    }
    $tokenArgs = @('account', 'get-access-token', '--resource', 'https://management.azure.com/', '-o', 'json')
    if ($subscription) { $tokenArgs += @('--subscription', $subscription) }
    try {
        $tok = (Invoke-Az -Arguments $tokenArgs -Context '取得 Azure 存取權杖') -join "`n" | ConvertFrom-Json
    } catch {
        throw "無法取得 Azure 存取權杖，請先執行 az login（$($_.Exception.Message)）"
    }
    $script:token = $tok.accessToken
    $subId = $tok.subscription
    if (-not $subId) { throw '無法取得訂閱 ID，請確認 az login 的帳號或 prodRestart.subscription' }
    $script:baseUrl = "https://management.azure.com/subscriptions/$subId/resourceGroups/$resourceGroup/providers/Microsoft.Automation/automationAccounts/$account"
    $target = "Automation $account（$resourceGroup）"

    switch ($Action) {
        'List' {
            Write-Output "查詢 $target 的重啟排程"
            $items = Get-RestartSchedules
            Write-Result ([ordered]@{ automationAccount = $account; runbook = $runbook; items = @($items) })
        }

        'Create' {
            if (-not $Repo) { throw 'Create 需要 -Repo' }
            if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') { throw "日期格式錯誤：$Date（yyyy-MM-dd）" }
            if ($Time -notmatch '^\d{2}:\d{2}$') { throw "時間格式錯誤：$Time（HH:mm）" }
            $repoCfg = if ($script:cfg.repos -and $script:cfg.repos.PSObject.Properties[$Repo]) { $script:cfg.repos.$Repo } else { $null }
            if (-not $repoCfg) { throw "$ConfigPath 的 prodRestart.repos 沒有設定 $Repo" }
            $appService = Get-Setting $repoCfg 'appService'
            $parameters = Get-RunbookParameters -RepoConfig $repoCfg -RepoKey $Repo

            try {
                $start = [DateTimeOffset]::ParseExact("$($Date)T$($Time)$utcOffset", "yyyy-MM-dd'T'HH:mmzzz", [Globalization.CultureInfo]::InvariantCulture)
            } catch {
                throw "無法解析時間：$Date $Time（utcOffset = $utcOffset）"
            }
            $earliest = [DateTimeOffset]::Now.AddMinutes($MinLeadMinutes)
            if ($start -lt $earliest) {
                throw "$Date $Time 已過或距離現在不到 $MinLeadMinutes 分鐘，Azure Automation 無法排程；請選之後的時間"
            }
            $scheduleName = "$($script:prefix)-$Repo-$($start.ToString('yyyyMMdd'))-$($start.ToString('HHmm'))"
            $label = "$Date $Time 重啟 $(if ($appService) { $appService } else { $Repo })"

            $existing = Invoke-Arm -Path "schedules/$scheduleName" -AllowNotFound
            $state = 'created'
            if ($existing) {
                $links = @(Get-AllPages -Path 'jobSchedules' | Where-Object { $_.properties.schedule.name -eq $scheduleName })
                if ($links.Count) {
                    Write-Output "已有排程 $scheduleName，不重複建立"
                    Write-Result ([ordered]@{ state = 'exists'; name = $scheduleName; repo = $Repo; appService = $appService; startTime = $start.ToString('o'); message = "已排程 $label（$scheduleName，未重複建立）" })
                    exit 0
                }
                Write-Output "Schedule $scheduleName 已存在但未連結 Runbook，補上連結"
                $state = 'linked'
            }
            else {
                $desc = @("AdoMaster：$label", $Note, "建立者 $env:USERNAME@$env:COMPUTERNAME $([DateTimeOffset]::Now.ToString('yyyy-MM-dd HH:mm'))") | Where-Object { $_ }
                Write-Output "建立 Schedule $scheduleName（$($start.ToString('yyyy-MM-dd HH:mm zzz')) $timeZone）"
                Invoke-Arm -Method PUT -Path "schedules/$scheduleName" -Body ([ordered]@{
                        name       = $scheduleName
                        properties = [ordered]@{
                            description = ($desc -join ' · ')
                            startTime   = $start.ToString("yyyy-MM-dd'T'HH:mm:sszzz")
                            frequency   = 'OneTime'
                            timeZone    = $timeZone
                        }
                    }) | Out-Null
            }

            $jobScheduleId = [guid]::NewGuid().ToString()
            $props = [ordered]@{
                runbook    = @{ name = $runbook }
                schedule   = @{ name = $scheduleName }
                parameters = $parameters
            }
            if ($runOn) { $props.runOn = $runOn }
            Write-Output "連結 Runbook $runbook（參數：$(($parameters.Keys | ForEach-Object { "$_=$($parameters[$_])" }) -join ', ')）"
            try {
                Invoke-Arm -Method PUT -Path "jobSchedules/$jobScheduleId" -Body ([ordered]@{ properties = $props }) | Out-Null
            } catch {
                # 剛建立的 Schedule 沒連結成功就刪掉，避免留下不會執行的排程
                if ($state -eq 'created') { Invoke-Arm -Method DELETE -Path "schedules/$scheduleName" -AllowNotFound | Out-Null }
                throw
            }
            Write-Output "已排程 $label"
            Write-Result ([ordered]@{
                    state         = $state
                    name          = $scheduleName
                    repo          = $Repo
                    appService    = $appService
                    startTime     = $start.ToString('o')
                    jobScheduleId = $jobScheduleId
                    message       = "已排程 $label（Automation $account / $runbook）"
                })
        }

        'Delete' {
            if (-not $Name) { throw 'Delete 需要 -Name' }
            if (-not $Name.StartsWith("$($script:prefix)-")) { throw "只能刪除 $($script:prefix)- 開頭的排程：$Name" }
            $links = @(Get-AllPages -Path 'jobSchedules' | Where-Object { $_.properties.schedule.name -eq $Name })
            foreach ($l in $links) {
                Write-Output "刪除 Job Schedule $($l.properties.jobScheduleId)（$($l.properties.runbook.name)）"
                Invoke-Arm -Method DELETE -Path "jobSchedules/$($l.properties.jobScheduleId)" -AllowNotFound | Out-Null
            }
            Write-Output "刪除 Schedule $Name"
            Invoke-Arm -Method DELETE -Path "schedules/$Name" -AllowNotFound | Out-Null
            Write-Result ([ordered]@{ name = $Name; message = "已刪除排程 $Name" })
        }
    }
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
