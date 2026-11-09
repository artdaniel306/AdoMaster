<#
.SYNOPSIS
    重啟指定的 Azure App Service，並等到網站重新回應為止。

.DESCRIPTION
    由 feature/release/Restart-AppService.ps1 改寫成 app 呼叫用的版本（非互動、不詢問確認）：
      1. 確認 Azure CLI 已登入（未登入請先執行 az login）；有指定 -Subscription 時先切換訂閱
      2. 未指定 -ResourceGroup 時，以 App Service 名稱在目前訂閱中查出所屬的 Resource Group
      3. 執行 az webapp restart
      4. 對 https://<defaultHostName><HealthPath> 輪詢，直到回應的 HTTP 狀態碼 < 500，
         或超過 -TimeoutSec 為止（-NoWait 可略過這步）
         4xx 也視為「已起來」：代表網站程式已在處理請求，只是該路徑需要驗證或不存在

    app 的呼叫時機：測試環境佈版勾 SaaS，push 觸發的 Pipeline Run 成功後，
    對 data/config.json 的 repos 中該 repository 設定的 testAppService 執行（app/src/main/services/afterDeploy.js）。
    正式環境不會呼叫本腳本。

    慣例同 shell/example.ps1：進度寫 stdout，結果 JSON 寫到 -Out，失敗時 stderr + exit 1。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File shell\Restart-AppService.ps1 -ResourceGroup UpDay_Prod_RG -Name crmapptest-service
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [string]$ResourceGroup,

    [string]$Slot,

    [string]$Subscription,

    [string]$HealthPath = "/",

    [int]$TimeoutSec = 300,

    [switch]$NoWait,

    [string]$Out
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Invoke-Az {
    <#
      執行 az 並在退出碼非 0 時拋出例外（含 az 的錯誤輸出）；回傳 stdout（字串陣列）。
    #>
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$Context = "az 指令"
    )
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $stdout = & az @Arguments 2> $errFile
        if ($LASTEXITCODE -ne 0) {
            $detail = (Get-Content -Raw -Encoding UTF8 $errFile)
            $detail = if ($detail) { "：$($detail.Trim())" } else { "" }
            throw "$Context 失敗（az 退出碼 $LASTEXITCODE）$detail"
        }
        return $stdout
    }
    finally {
        Remove-Item $errFile -ErrorAction SilentlyContinue
    }
}

function Get-HttpStatus {
    <#
      回傳指定網址的 HTTP 狀態碼；連線失敗、逾時則回傳 $null。
      Windows PowerShell 5.1 遇到 4xx / 5xx 會拋例外，需從例外中取出狀態碼。
    #>
    param([string]$Url)
    try {
        $resp = Invoke-WebRequest -Uri $Url -Method Get -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 0 -ErrorAction Stop
        return [int]$resp.StatusCode
    }
    catch {
        $response = $_.Exception.Response
        if ($null -ne $response -and $null -ne $response.StatusCode) {
            return [int]$response.StatusCode
        }
        return $null
    }
}

function Write-Result {
    param($Result)
    if (-not $Out) { return }
    $json = $Result | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding $false))
}

try {
    # ---- 1. 確認登入與訂閱 ----
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw "找不到 Azure CLI（az），請先安裝：https://aka.ms/installazurecliwindows"
    }

    az account show --output none 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "尚未登入 Azure CLI，請先執行 az login"
    }

    if ($Subscription) {
        Invoke-Az -Arguments @("account", "set", "--subscription", $Subscription) -Context "切換訂閱" | Out-Null
    }
    $subscriptionName = (Invoke-Az -Arguments @("account", "show", "--query", "name", "-o", "tsv") -Context "讀取目前訂閱") | Select-Object -First 1

    # ---- 2. 查出 Resource Group ----
    if (-not $ResourceGroup) {
        $groups = @(Invoke-Az -Arguments @(
                "webapp", "list",
                "--query", "[?name=='$Name'].resourceGroup",
                "-o", "tsv"
            ) -Context "查詢 App Service 所屬 Resource Group" | Where-Object { $_ })

        if ($groups.Count -eq 0) {
            throw "在訂閱「$subscriptionName」中找不到名為 $Name 的 App Service；請確認名稱，或以 -Subscription 指定正確的訂閱"
        }
        if ($groups.Count -gt 1) {
            throw "名為 $Name 的 App Service 同時存在於多個 Resource Group（$($groups -join ', ')），請以 -ResourceGroup 指定"
        }
        $ResourceGroup = $groups[0]
    }

    $targetArgs = @("--name", $Name, "--resource-group", $ResourceGroup)
    if ($Slot) { $targetArgs += @("--slot", $Slot) }

    $info = (Invoke-Az -Arguments (@("webapp", "show") + $targetArgs + @(
                "--query", "{state:state, host:defaultHostName}",
                "-o", "json"
            )) -Context "讀取 App Service 資訊") -join "`n" | ConvertFrom-Json

    $slotLabel = if ($Slot) { $Slot } else { "production" }

    Write-Output "重啟 App Service：$Name（訂閱 $subscriptionName / $ResourceGroup / $slotLabel，目前狀態 $($info.state)）"
    if ($info.state -ne "Running") {
        Write-Output "注意：目前狀態不是 Running，restart 不會啟動已停止的 App Service（需改用 az webapp start）"
    }

    # ---- 3. 重啟 ----
    $restartedAt = Get-Date
    Invoke-Az -Arguments (@("webapp", "restart") + $targetArgs) -Context "重啟 App Service" | Out-Null
    Write-Output "已送出重啟（$($restartedAt.ToString('yyyy-MM-dd HH:mm:ss'))）"

    $result = [ordered]@{
        name          = $Name
        resourceGroup = $ResourceGroup
        slot          = $slotLabel
        subscription  = $subscriptionName
        url           = "https://$($info.host)"
        restartedAt   = $restartedAt.ToString('o')
        status        = $null
        elapsedSec    = $null
    }

    if ($NoWait) {
        Write-Result $result
        exit 0
    }

    # ---- 4. 等待網站回應 ----
    if (-not $HealthPath.StartsWith("/")) { $HealthPath = "/$HealthPath" }
    $url = "https://$($info.host)$HealthPath"
    Write-Output "等待 $url 回應（上限 $TimeoutSec 秒）"

    $deadline = $restartedAt.AddSeconds($TimeoutSec)
    $lastStatus = $null
    while ((Get-Date) -lt $deadline) {
        $status = Get-HttpStatus -Url $url
        $elapsed = [int]((Get-Date) - $restartedAt).TotalSeconds

        if ($null -ne $status -and $status -lt 500) {
            Write-Output "$Name（$slotLabel）重啟完成：HTTP $status，共耗時 $elapsed 秒"
            $result.status = $status
            $result.elapsedSec = $elapsed
            Write-Result $result
            exit 0
        }

        $statusText = if ($null -eq $status) { "無回應" } else { "HTTP $status" }
        if ($statusText -ne $lastStatus) {
            Write-Output "  [$elapsed s] $statusText，持續等待..."
            $lastStatus = $statusText
        }
        Start-Sleep -Seconds 5
    }

    throw "已送出重啟，但 $TimeoutSec 秒內 $Name 仍未正常回應（最後狀態：$lastStatus）。請至 Azure Portal 查看 Log stream 或執行：az webapp log tail $($targetArgs -join ' ')"
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
