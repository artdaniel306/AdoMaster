<#
.SYNOPSIS
    正式環境佈版後的動作（預留位置，目前沒有任何邏輯）。

.DESCRIPTION
    app 的呼叫時機：正式環境佈版勾 SaaS，push 觸發的 Pipeline Run 成功後，
    對每個 Run 成功的 repository 各呼叫一次（app/src/main/services/afterDeploy.js）。

    正式環境有客戶在使用，不可以直接重啟 App Service；之後要安排的操作寫在這裡。
    目前不做任何事，只回傳說明訊息。

    慣例同 shell/example.ps1：進度寫 stdout，結果 JSON 寫到 -Out，失敗時 stderr + exit 1。
    結果 JSON：{ message }，message 會顯示在佈版 dialog 該 repository 的 Pipeline 底下。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File shell\After-ProdDeploy.ps1 -Repo crmapp -Commit abc1234 -Out result.json
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Repo,       # data/repos.json 的 key（crmapp / crmappui …）

    [string]$Commit,     # 這次 push 到正式環境 branch 的 merge commit

    [string]$Out
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    # TODO: 正式環境佈版後的動作（尚未決定，先不做任何事）

    $result = [ordered]@{
        message = '正式環境佈版後動作尚未設定（shell/After-ProdDeploy.ps1），未做任何事'
    }
    if ($Out) {
        [System.IO.File]::WriteAllText($Out, ($result | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
