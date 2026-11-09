<#
.SYNOPSIS
    重啟指定的 Azure App Service，並等到網站重新回應為止。

.DESCRIPTION
    本腳本的行為：
      1. 確認 Azure CLI 已登入（未登入請先執行 az login）；有指定 -Subscription 時先切換訂閱
      2. 未指定 -ResourceGroup 時，以 App Service 名稱在目前訂閱中查出所屬的 Resource Group
      3. 顯示目標（訂閱 / Resource Group / App Service / Slot / 目前狀態）並確認一次（-Yes 可略過）
      4. 執行 az webapp restart
      5. 對 https://<defaultHostName><HealthPath> 輪詢，直到回應的 HTTP 狀態碼 < 500，
         或超過 -TimeoutSec 為止（-NoWait 可略過這步）
         4xx 也視為「已起來」：代表網站程式已在處理請求，只是該路徑需要驗證或不存在

    執行位置：
      cd C:\Users\DanielLi\Documents\crmapp_AI
      .\.manage\scripts\Restart-AppService.ps1 -Name <App Service 名稱>
      .\.manage\scripts\Restart-AppService.ps1 -ResourceGroup UpDay_Prod_RG -Name crmapptest-service
      .\.manage\scripts\Restart-AppService.ps1 -ResourceGroup UpDay_Prod_RG -Name crmapptestui-service


.PARAMETER Name
    App Service 名稱（必填）

.PARAMETER ResourceGroup
    App Service 所在的 Resource Group。不指定時自動查詢

.PARAMETER Slot
    部署位置（Deployment Slot）名稱，例如 staging。不指定時重啟正式（production）位置

.PARAMETER Subscription
    訂閱名稱或 ID。不指定時使用 az account show 目前的訂閱

.PARAMETER HealthPath
    重啟後用來確認網站回應的路徑，預設 /

.PARAMETER TimeoutSec
    等待網站回應的上限秒數，預設 300

.PARAMETER NoWait
    送出重啟後立即結束，不等待網站回應

.PARAMETER Yes
    略過重啟前的確認

.EXAMPLE
    .\.manage\scripts\Restart-AppService.ps1 -Name upday-crmapp

.EXAMPLE
    .\.manage\scripts\Restart-AppService.ps1 -Name upday-crmapp -Slot staging -HealthPath /api/health/ -Yes
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

    [switch]$Yes
)

$ErrorActionPreference = 'Stop'

function Invoke-Az {
    <#
      執行 az 並在退出碼非 0 時拋出例外；回傳 stdout（字串陣列）。
    #>
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$Context = "az 指令"
    )
    $stdout = & az @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Context 失敗（az 退出碼 $LASTEXITCODE），詳細錯誤請見上方輸出。"
    }
    return $stdout
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

    # ---- 3. 確認 ----
    Write-Host ""
    Write-Host "即將重啟以下 App Service：" -ForegroundColor Cyan
    Write-Host "  訂閱           : $subscriptionName"
    Write-Host "  Resource Group : $ResourceGroup"
    Write-Host "  App Service    : $Name"
    Write-Host "  Slot           : $slotLabel"
    Write-Host "  目前狀態       : $($info.state)"
    Write-Host "  網址           : https://$($info.host)"
    Write-Host ""

    if ($info.state -ne "Running") {
        Write-Host "注意：目前狀態不是 Running，restart 不會啟動已停止的 App Service（需改用 az webapp start）" -ForegroundColor Yellow
    }

    if (-not $Yes) {
        $answer = Read-Host "確定要重啟嗎？(y/N)"
        if ($answer -notmatch '^(y|yes)$') {
            Write-Host "已取消，未做任何變更。" -ForegroundColor Yellow
            exit 0
        }
    }

    # ---- 4. 重啟 ----
    Write-Host "`n==> 重啟中..." -ForegroundColor Cyan
    $restartedAt = Get-Date
    Invoke-Az -Arguments (@("webapp", "restart") + $targetArgs) -Context "重啟 App Service" | Out-Null
    Write-Host "已送出重啟（$($restartedAt.ToString('yyyy-MM-dd HH:mm:ss'))）" -ForegroundColor Green

    if ($NoWait) {
        exit 0
    }

    # ---- 5. 等待網站回應 ----
    if (-not $HealthPath.StartsWith("/")) { $HealthPath = "/$HealthPath" }
    $url = "https://$($info.host)$HealthPath"
    Write-Host "`n==> 等待 $url 回應（上限 $TimeoutSec 秒）" -ForegroundColor Cyan

    $deadline = $restartedAt.AddSeconds($TimeoutSec)
    $lastStatus = $null
    while ((Get-Date) -lt $deadline) {
        $status = Get-HttpStatus -Url $url
        $elapsed = [int]((Get-Date) - $restartedAt).TotalSeconds

        if ($null -ne $status -and $status -lt 500) {
            Write-Host "  [$elapsed s] HTTP $status" -ForegroundColor Green
            Write-Host "`n$Name（$slotLabel）重啟完成，共耗時 $elapsed 秒。" -ForegroundColor Green
            exit 0
        }

        $statusText = if ($null -eq $status) { "無回應" } else { "HTTP $status" }
        if ($statusText -ne $lastStatus) {
            Write-Host "  [$elapsed s] $statusText，持續等待..."
            $lastStatus = $statusText
        }
        Start-Sleep -Seconds 5
    }

    Write-Host "`n已送出重啟，但 $TimeoutSec 秒內網站仍未正常回應（最後狀態：$lastStatus）。" -ForegroundColor Red
    Write-Host "請至 Azure Portal 查看 Log stream 或執行：az webapp log tail $($targetArgs -join ' ')" -ForegroundColor Red
    exit 2
}
catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
