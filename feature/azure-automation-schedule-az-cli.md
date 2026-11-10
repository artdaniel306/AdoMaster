# 使用 az cli 為既有 Runbook 建立 Schedule 並指定參數

## 結論

可以做到，但不是全部都有現成的 `az automation` 指令：

| 動作 | az cli 支援方式 |
|---|---|
| 建立 Schedule | 原生指令 `az automation schedule create`（GA） |
| 將 Schedule 掛到 Runbook 並指定參數（Job Schedule） | 無原生指令，需透過 `az rest` 呼叫 REST API，或以 ARM/Bicep 部署 |

在 Azure Automation 中，「Schedule 掛到 Runbook 並帶參數」這個關聯物件稱為 **Job Schedule**（資源類型 `Microsoft.Automation/automationAccounts/jobSchedules`）。

---

## 1. 建立 Schedule

`az automation` 屬於 Azure CLI extension，第一次執行相關指令時會自動安裝。`schedule` 群組提供 `create`、`delete`、`list`、`show`、`update` 等指令。

```bash
az automation schedule create \
  --automation-account-name "myAutomationAccount" \
  --resource-group "rg" \
  -n mySchedule \
  --frequency Hour --interval 1 \
  --start-time "2026-11-10 09:00:00" \
  --time-zone "UTC+08:00"
```

---

## 2. 將 Schedule 掛到 Runbook 並指定參數

### 背景

`az automation` 目前的指令群組包含 account、hrwg、job、runbook、schedule、source-control 等，但**沒有** job-schedule 相關群組。

PowerShell 端的對應 cmdlet 為 `Register-AzAutomationScheduledRunbook`（透過 `-Parameters` 指定參數），az cli 並未包裝這個功能。不過底層 REST API（Job Schedule - Create）是存在的，因此可以用 `az rest` 直接呼叫。

### 使用 az rest 建立 Job Schedule

```bash
SUB=$(az account show --query id -o tsv)
RG=rg
AA=myAutomationAccount
JSID=$(uuidgen)   # Job Schedule 名稱必須是 GUID

az rest --method put \
  --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Automation/automationAccounts/$AA/jobSchedules/$JSID?api-version=2023-11-01" \
  --body '{
    "properties": {
      "runbook":  { "name": "MyRunbook" },
      "schedule": { "name": "mySchedule" },
      "parameters": {
        "TargetEnv": "prod",
        "BatchSize": "100"
      }
    }
  }'
```

Body 欄位說明：

| 欄位 | 說明 |
|---|---|
| `runbook.name` | 既有 Runbook 名稱 |
| `schedule.name` | 既有 Schedule 名稱 |
| `parameters` | Runbook 參數，key 為參數名稱，value 一律為字串 |
| `runOn` | （選填）指定在哪個 Hybrid Worker Group 執行 |

### 查詢既有的 Job Schedule

```bash
az rest --method get \
  --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Automation/automationAccounts/$AA/jobSchedules?api-version=2023-11-01"
```

### 刪除 Job Schedule

```bash
az rest --method delete \
  --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Automation/automationAccounts/$AA/jobSchedules/$JSID?api-version=2023-11-01"
```

---

## 注意事項

- **參數格式**：`parameters` 的 key 必須對應 Runbook 中定義的參數名稱，value 一律以字串傳入。
- **多組參數**：同一個 Runbook 可以連結到多個 Schedule，每個連結可指定不同參數值。需要多組參數時，建立多筆 Job Schedule 即可。
- **修改參數**：Job Schedule 一般無法直接修改參數，通常做法是先刪除再重新建立（建議實際測試確認）。
- **GUID**：每筆 Job Schedule 的名稱（路徑中的 ID）必須是 GUID，可用 `uuidgen` 產生。

---

## 替代做法

### ARM / Bicep 部署

若習慣 IaC，可將 `Microsoft.Automation/automationAccounts/jobSchedules` 寫成 ARM template 或 Bicep，再用 `az deployment group create` 部署，效果與 `az rest` 相同。

### 立即執行一次（不需排程）

若只是想用特定參數立刻執行 Runbook，可直接使用：

```bash
az automation runbook start \
  --automation-account-name "myAutomationAccount" \
  --resource-group "rg" \
  --name "MyRunbook" \
  --parameters TargetEnv=prod BatchSize=100
```

---

## 參考資料

- [az automation schedule（Azure CLI 文件）](https://learn.microsoft.com/cli/azure/automation/schedule)
- [Job Schedule - Create（REST API）](https://learn.microsoft.com/rest/api/automation/job-schedule/create)
- [Manage schedules in Azure Automation](https://learn.microsoft.com/azure/automation/shared-resources/schedules)
