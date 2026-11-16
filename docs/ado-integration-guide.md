# Azure DevOps 串接架構手冊

> 本手冊整理 AdoMaster 串接 Azure DevOps（以下簡稱 ADO）REST API 的架構與慣例，供其他需要串接 ADO 的專案參考。
> 範例程式碼取自 AdoMaster 並略作精簡，可直接複製改用。

---

## 1. 架構總覽

```
┌──────────────────────────────┐
│  UI（Electron renderer）      │  只呼叫 window.api.xxx()，不碰檔案、不碰 API
└──────────────┬───────────────┘
               │ IPC（contextBridge / ipcRenderer.invoke）
┌──────────────▼───────────────┐
│  Main process                │  services/*.js：驗證參數 → 執行 Python 腳本 → 讀回 JSON
│  python.js: runScriptJson()  │
└──────────────┬───────────────┘
               │ 子行程（argv 參數 + --out 暫存檔）
┌──────────────▼───────────────┐
│  script/*.py（CLI 進入點）    │  只負責：解析參數 → 呼叫 ado 套件 → 寫出 JSON
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│  script/ado/（共用套件）      │  config / client / work_items / iterations / pipelines / output / cli
└──────────────┬───────────────┘
               │ HTTPS + PAT（Basic auth）
┌──────────────▼───────────────┐
│  Azure DevOps REST API        │
└──────────────────────────────┘
```

設計原則：

| 原則 | 說明 |
|---|---|
| **ADO 串接只放在一層** | 所有 REST 呼叫都在 `script/ado/` 這個 Python 套件內；UI、Node、PowerShell 都不直接打 ADO API。換 UI 或換成排程 / CI 使用時，Python 層可直接沿用。 |
| **只用標準函式庫** | `urllib.request`、`json`、`base64`、`argparse`、`csv`。不需要 `pip install`，任何裝了 Python 的機器都能跑。 |
| **每支腳本都是獨立 CLI** | 可以在命令列單獨執行與除錯，App 只是其中一個呼叫端。 |
| **設定與機密分離** | 機密（PAT 等）放 `data/.env`；結構化、非機密的設定放 `data/config.json`。同名環境變數永遠優先。 |
| **輸出與進度分離** | stdout = 進度訊息（給人看）；結果 JSON 寫到 `--out` 指定的檔案（給程式讀）；錯誤 → stderr + exit 1。 |

---

## 2. 目錄結構

```
<repo>/
├─ script/                       # Python（ADO 串接）
│  ├─ ado/                       # 共用套件：所有邏輯都在這裡
│  │  ├─ __init__.py
│  │  ├─ errors.py               # AdoError
│  │  ├─ config.py               # 讀 .env、組連線設定、DATA_DIR
│  │  ├─ client.py               # URL 組裝、PAT 認證、HTTP / 錯誤處理
│  │  ├─ work_items.py           # WIQL、批次取明細、建立 / 更新 Work Item
│  │  ├─ iterations.py           # Iteration 樹
│  │  ├─ pipelines.py            # Pipeline / Run（Build API）
│  │  ├─ output.py               # 寫 CSV / JSON
│  │  └─ cli.py                  # run(main)：AdoError → stderr + exit 1
│  ├─ get_iterations.py          # 進入點：只解析參數、呼叫 ado、寫輸出
│  ├─ get_iteration_work_items.py
│  ├─ create_task.py
│  └─ update_state.py
├─ templates/
│  ├─ env_example.txt            # data/.env 範本（進 git）
│  └─ config_example.json        # data/config.json 範本（進 git）
├─ data/                         # 整個資料夾 gitignore：設定、機密、輸出
│  ├─ .env
│  └─ config.json
└─ app/                          # （選用）Electron UI
```

`.gitignore` 至少要有：

```gitignore
data/
__pycache__/
```

---

## 3. 設定檔

### 3.1 兩個檔案、各司其職

| 檔案 | 內容 | 格式 | 誰讀 |
|---|---|---|---|
| `data/.env` | 連線身分與**機密**（Org、Project、PAT、其他 token / 密碼） | 扁平 `KEY=VALUE` | Python、PowerShell、Node |
| `data/config.json` | **非機密**、結構化設定，每個功能一個 section（例如 `repos`、`pipelines`…） | JSON | Node（PowerShell 視需要） |

規則：

- **新功能只能在這兩個檔案加 key / section，不要新增設定檔。**
- **同名的環境變數永遠優先於 `.env`**：CI、排程、臨時測試時不用改檔案。
- 範本放 `templates/`（進 git），實際檔案放 `data/`（不進 git）。

### 3.2 `.env` 範本（`templates/env_example.txt`）

```ini
# 連線身分與機密（扁平 KEY=VALUE）。複製到 data/.env 後填入。
# 本檔含有存取憑證，請勿提交到版控或外流。同名的環境變數優先於本檔。

# --- Azure DevOps ---
AZDO_ORG=
AZDO_PROJECT=
AZDO_PAT=

# 選填
# AZDO_BASE_URL=https://dev.azure.com      # Azure DevOps Server (on-prem) 改成自己的網址
# AZDO_API_VERSION=7.1
```

| Key | 必填 | 說明 |
|---|---|---|
| `AZDO_ORG` | ✔ | Organization 名稱（`https://dev.azure.com/<org>`） |
| `AZDO_PROJECT` | ✔ | Project 名稱（可含空白、中文，組 URL 時會 encode） |
| `AZDO_PAT` | ✔ | Personal Access Token |
| `AZDO_BASE_URL` | | 預設 `https://dev.azure.com`；on-prem Azure DevOps Server 改成自己的網址 |
| `AZDO_API_VERSION` | | 預設 `7.1` |

### 3.3 PAT 權限

依用到的 API 給最小權限：

| 功能 | PAT Scope |
|---|---|
| 查詢 Work Item、Iteration | Work Items (Read) |
| 建立 / 更新 Work Item | Work Items (Read & Write) |
| 查詢 Pipeline / Run | Build (Read) |

### 3.4 data 資料夾位置可被覆寫

`DATA_DIR` 預設是 `<repo>/data`，可用環境變數（AdoMaster 為 `ADOMASTER_DATA_DIR`）覆寫。
桌面 App 的安裝版把 data 放在使用者資料夾（`%APPDATA%\<App>\data`），啟動時決定好位置後**寫回 `process.env`**，之後啟動的 Python / PowerShell 子行程就會讀到同一個位置。

### 3.5 `config.py`（讀設定）

```python
"""設定：路徑常數與 data/.env 讀取（同名環境變數優先）。"""

import os

from .errors import AdoError

SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # script/
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.environ.get("MYAPP_DATA_DIR") or os.path.join(ROOT_DIR, "data")
ENV_PATH = os.path.join(DATA_DIR, ".env")


def load_env(path):
    """簡易 .env 解析：KEY=VALUE，支援 # 註解、export 前綴與引號。檔案不存在時回傳 {}。"""
    if not os.path.isfile(path):
        return {}
    env = {}
    with open(path, encoding="utf-8-sig") as f:       # utf-8-sig：容忍 Windows 記事本的 BOM
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key.startswith("export "):
                key = key[len("export "):].strip()
            value = value.strip()
            if value[:1] not in ("'", '"'):              # 未加引號時，去除行尾 " # 註解"
                value = value.split(" #", 1)[0].strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            env[key] = value
    return env


class Config(dict):
    """連線設定；另外保留原始 env，讓各 CLI 讀自己專用的選填設定（同名環境變數優先）。"""

    def __init__(self, values, env):
        super().__init__(values)
        self.env = env

    def opt(self, key, default=None):
        return os.environ.get(key) or self.env.get(key) or default


def get_config(env_path=ENV_PATH):
    env = load_env(env_path)

    def need(key):
        val = os.environ.get(key) or env.get(key)
        if not val:
            raise AdoError(f"[錯誤] .env 缺少必要設定：{key}（設定檔：{env_path}）")
        return val

    def opt(key, default):
        return os.environ.get(key) or env.get(key) or default

    return Config({
        "base_url": opt("AZDO_BASE_URL", "https://dev.azure.com").rstrip("/"),
        "org": need("AZDO_ORG"),
        "project": need("AZDO_PROJECT"),
        "pat": need("AZDO_PAT"),
        "api_version": opt("AZDO_API_VERSION", "7.1"),
    }, env)
```

重點：

- 檔案不存在**不是錯誤**——值可能全部由環境變數提供；真正缺值時才由 `need()` 報出明確訊息（告訴使用者缺哪個 key、去哪裡設定）。
- 若同時有 PowerShell 腳本，PowerShell 端的 `.env` 解析規則要**和 Python 完全一致**（AdoMaster 的 `shell/Common.ps1` → `Read-DotEnv`）。

---

## 4. 呼叫 ADO API（`client.py`）

### 4.1 URL 組裝

ADO REST API 的 project 層級 URL 格式：

```
{base_url}/{org}/{project}/_apis/{resource}?api-version={version}&...
```

```python
import urllib.parse

def _project_base(cfg):
    org = urllib.parse.quote(cfg["org"], safe="")
    project = urllib.parse.quote(cfg["project"], safe="")   # Project 名稱可能有空白 / 中文
    return f"{cfg['base_url']}/{org}/{project}"


def api_url(cfg, path, **params):
    params["api-version"] = cfg["api_version"]
    return f"{_project_base(cfg)}/_apis/{path}?{urllib.parse.urlencode(params)}"


def web_url(cfg, item_id):
    """Work Item 在瀏覽器中的網址（給 UI 做連結）。"""
    return f"{_project_base(cfg)}/_workitems/edit/{item_id}"
```

> 參數名稱含 `$`（如 `$top`、`$depth`、`$expand`）時用 `**{"$top": 100}` 傳入。
> 若 query 參數名稱和函式參數衝突（例如 Build Definitions 的 `path`），另外 `urlencode` 再接在 `api_url()` 後面。

### 4.2 認證：PAT → Basic auth

使用者名稱留空，密碼為 PAT：

```python
token = base64.b64encode(f":{pat}".encode("utf-8")).decode("ascii")
headers = {"Authorization": f"Basic {token}"}
```

### 4.3 HTTP 請求與錯誤處理

```python
import base64, json, urllib.error, urllib.request
from .errors import AdoError


def http_request(url, headers=None, data=None, method=None, not_json_hint=""):
    """送出請求並解析 JSON；空 body 回傳 None。data 為 None 時 GET，否則預設 POST。"""
    headers = {"Accept": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, method=method or ("GET" if data is None else "POST"), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            if not body.strip():
                return None
            ctype = resp.headers.get("Content-Type", "")
            if "application/json" not in ctype:
                raise AdoError(f"[錯誤] 回應不是 JSON（HTTP {resp.status}, {ctype}）{not_json_hint}")
            return json.loads(body)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail)
            err = parsed.get("error")
            # ADO: {"message"}；ARM: {"error": {"message"}}；Entra ID: {"error_description"}
            detail = (parsed.get("message")
                      or (err.get("message") if isinstance(err, dict) else None)
                      or parsed.get("error_description")
                      or detail)
        except (ValueError, AttributeError):
            pass
        raise AdoError(f"[錯誤] HTTP {e.code} {e.reason}\nURL: {url}\n{detail}") from None
    except urllib.error.URLError as e:
        raise AdoError(f"[錯誤] 無法連線：{e.reason}\nURL: {url}") from None


def api_request(url, pat, payload=None, content_type="application/json", method=None):
    """ADO API：payload 為 None 時 GET，否則以 JSON body 送 POST（可用 method 改成 PATCH 等）。"""
    token = base64.b64encode(f":{pat}".encode("utf-8")).decode("ascii")
    headers = {"Authorization": f"Basic {token}"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = content_type
    return http_request(url, headers, data, method,
                        not_json_hint="，請確認 PAT 是否正確、是否過期，以及權限是否足夠。")
```

> ⚠ **最重要的陷阱**：PAT 錯誤或過期時，ADO 常常**不回 401**，而是回 **HTTP 203 + HTML 登入頁**。
> 所以「回應不是 JSON」一定要當成錯誤處理，否則會拿 HTML 去 `json.loads` 或誤以為成功。

依 API 補充權限提示（例如 Build API 收到 401 時提示要加 Build (Read)）：

```python
try:
    return api_request(url, cfg["pat"])
except AdoError as e:
    if "HTTP 401" in str(e):
        raise AdoError(f"{e}\nPAT 沒有讀取 Pipeline 的權限：請加上 Build (Read)。") from None
    raise
```

### 4.4 錯誤模型

```python
# errors.py
class AdoError(Exception):
    """可預期的錯誤（設定缺漏、API 失敗等）。訊息會原樣顯示給使用者。"""

# cli.py
import sys
def run(main):
    """AdoError 的訊息輸出到 stderr，exit code 1。其他例外照常 traceback（代表 bug）。"""
    try:
        main()
    except AdoError as e:
        sys.exit(str(e))
```

- **使用者能處理的錯誤** → `raise AdoError("...")`，訊息寫清楚原因與解法。
- **程式 bug** → 不攔截，讓 traceback 出現，方便除錯。

---

## 5. 常用 API 模式

### 5.1 查詢 Work Item：WIQL → 批次取明細（兩段式）

WIQL 只回傳 id，明細要再用 `workitemsbatch` 取（**每批最多 200 筆**）。

```python
BATCH_SIZE = 200

def wiql_str(value):
    """WIQL 字串常值：單引號跳脫（避免注入 / 語法錯誤）。"""
    return "'" + value.replace("'", "''") + "'"


def build_wiql(*, type=None, states=None, iteration=None, iteration_exact=False, assigned_to=None):
    conds = ["[System.TeamProject] = @project"]
    if type:
        conds.append(f"[System.WorkItemType] = {wiql_str(type)}")
    if states:
        conds.append(f"[System.State] IN ({', '.join(wiql_str(s) for s in states)})")
    if assigned_to:
        who = "@Me" if assigned_to.lower() == "@me" else wiql_str(assigned_to)
        conds.append(f"[System.AssignedTo] = {who}")
    if iteration:
        op = "=" if iteration_exact else "UNDER"     # UNDER = 含子 Iteration
        conds.append(f"[System.IterationPath] {op} {wiql_str(iteration)}")
    return "SELECT [System.Id] FROM WorkItems WHERE " + " AND ".join(conds) + " ORDER BY [System.Id]"


def query_ids(cfg, top=None, **filters):
    params = {"$top": top} if top else {}
    data = api_request(api_url(cfg, "wit/wiql", **params), cfg["pat"], {"query": build_wiql(**filters)})
    return [w["id"] for w in data.get("workItems", [])]


def get_work_items(cfg, ids, relations=False):
    items = []
    url = api_url(cfg, "wit/workitemsbatch")
    for start in range(0, len(ids), BATCH_SIZE):
        payload = {"ids": ids[start:start + BATCH_SIZE], "errorPolicy": "omit"}   # 查無 / 無權限的 id 不讓整批失敗
        if relations:
            payload["$expand"] = "relations"
        data = api_request(url, cfg["pat"], payload)
        items.extend(i for i in data.get("value", []) if i)
        print(f"  已取得 {min(start + BATCH_SIZE, len(ids))}/{len(ids)}", flush=True)
    return sorted(items, key=lambda x: x.get("id", 0))
```

### 5.2 父子關係：用 relations，不要靠 `System.Parent`

> ⚠ `workitemsbatch` **不指定 fields 時不會回傳 `System.Parent`**。
> 要父子關係時請用 `$expand=relations`，從 relation 的 URL 尾端解析 id。

```python
HIERARCHY_FORWARD = "System.LinkTypes.Hierarchy-Forward"  # 子項目
HIERARCHY_REVERSE = "System.LinkTypes.Hierarchy-Reverse"  # 父項目

def _related_ids(item, rel_type):
    ids = []
    for rel in item.get("relations") or []:
        if rel.get("rel") == rel_type:
            tail = rel.get("url", "").rstrip("/").rsplit("/", 1)[-1]
            if tail.isdigit():
                ids.append(int(tail))
    return ids

def child_ids(item):  return _related_ids(item, HIERARCHY_FORWARD)
def parent_id(item):
    ids = _related_ids(item, HIERARCHY_REVERSE)
    return ids[0] if ids else None
```

「取 Requirement 與其子項目」的典型流程：WIQL 查 Requirement id → 批次取明細（`relations=True`）→ 收集所有 child id → 再批次取一次明細 → 組回樹狀結構。子項目即使不在同一個 Iteration 也會取到。

### 5.3 轉成扁平資料列

ADO 回傳的 `fields` 是 `{reference name: value}`，identity 欄位（AssignedTo、CreatedBy…）是物件、Description 是 HTML。統一轉成 UI / CSV 好用的扁平 dict：

```python
ROW_FIELDS = [
    ("id", "System.Id"), ("type", "System.WorkItemType"), ("title", "System.Title"),
    ("state", "System.State"), ("assignedTo", "System.AssignedTo"),
    ("iterationPath", "System.IterationPath"), ("description", "System.Description"),
    # ...依需求增加
]

def to_row(item):
    fields = item.get("fields", {})
    row = {}
    for col, ref in ROW_FIELDS:
        val = item.get("id") if ref == "System.Id" else fields.get(ref, "")
        if isinstance(val, dict):                       # identity 物件
            val = val.get("displayName") or val.get("uniqueName")
        elif ref == "System.Description" and val:
            val = html_to_text(val)
        row[col] = "" if val is None else val
    return row
```

輸出時一併附上 `webUrl`（`web_url(cfg, id)`），UI 就能直接連到 ADO。

### 5.4 建立 / 更新 Work Item：JSON Patch

- Content-Type 必須是 **`application/json-patch+json`**。
- 建立：`POST _apis/wit/workitems/${type}`（`$` 是字面字元，type 要 URL encode）。
- 更新：`PATCH _apis/wit/workitems/{id}`。
- 指定父項目：加一筆 `/relations/-`，`rel` = `Hierarchy-Reverse`，`url` = 父項目的 API URL。

```python
def add(path, value):
    return {"op": "add", "path": path, "value": value}

# 建立子 Task（標題 / Area / Iteration 沿用 parent）
ops = [
    add("/fields/System.Title", parent_fields["System.Title"]),
    add("/fields/System.AreaPath", parent_fields["System.AreaPath"]),
    add("/fields/System.IterationPath", parent_fields["System.IterationPath"]),
    add("/relations/-", {"rel": HIERARCHY_REVERSE, "url": parent["url"]}),
]
url = api_url(cfg, f"wit/workitems/${urllib.parse.quote('Task')}")
api_request(url, cfg["pat"], ops, content_type="application/json-patch+json")

# 更新狀態（Reason 由 ADO 依流程規則帶預設值）
ops = [add("/fields/System.State", "Resolved")]
api_request(api_url(cfg, f"wit/workitems/{item_id}"), cfg["pat"], ops,
            content_type="application/json-patch+json", method="PATCH")
```

寫入 Description 時把純文字轉 HTML（`html.escape` 每行 + `<br>` 連接）。

### 5.5 Iteration 樹

```python
url = api_url(cfg, "wit/classificationnodes/Iterations", **{"$depth": 20})
tree = api_request(url, cfg["pat"])
```

> ⚠ Classification node 的 `path` 形如 `\Project\Iteration\Sprint 1`，而 Work Item 的 `System.IterationPath` 是 `Project\Sprint 1`。
> 要拿來查 WIQL 前，必須去掉開頭的 `\` 與第二段的 `Iteration`：

```python
def to_iteration_path(node_path):
    parts = [p for p in node_path.split("\\") if p]
    if len(parts) >= 2 and parts[1] == "Iteration":
        del parts[1]
    return "\\".join(parts)
```

### 5.6 Pipeline / Run（Build API）

Pipeline = build definition、Run = build。PAT 需 Build (Read)。

```python
# 依名稱找 Pipeline（可用「資料夾\名稱」區分同名 Pipeline）
GET _apis/build/definitions?name={name}&path=\{folder}
# 最近的 Run
GET _apis/build/builds?definitions={id}&queryOrder=queueTimeDescending&$top={n}
```

`status` 為 `notStarted / inProgress / cancelling / postponed` 時視為進行中，其他（`completed`）看 `result`。網頁連結取 `_links.web.href`。

### 5.7 API 參考

| 用途 | Method / Path | 文件 |
|---|---|---|
| WIQL 查詢 | `POST wit/wiql` | [Query By Wiql](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1) |
| 批次取明細 | `POST wit/workitemsbatch` | [Get Work Items Batch](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items-batch?view=azure-devops-rest-7.1) |
| 建立 Work Item | `POST wit/workitems/${type}` | [Create](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/create?view=azure-devops-rest-7.1) |
| 更新 Work Item | `PATCH wit/workitems/{id}` | [Update](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1) |
| Iteration 樹 | `GET wit/classificationnodes/Iterations` | [Classification Nodes - Get](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/classification-nodes/get?view=azure-devops-rest-7.1) |
| Pipeline 清單 | `GET build/definitions` | [Definitions - List](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/definitions/list?view=azure-devops-rest-7.1) |
| Run 清單 | `GET build/builds` | [Builds - List](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/list?view=azure-devops-rest-7.1) |

建議在每個模組的 docstring 開頭列出它用到的 API 與文件連結（AdoMaster 的 `work_items.py`、`iterations.py`、`pipelines.py` 都這樣做）。

---

## 6. CLI 進入點慣例

每支 `script/*.py` 都長得一樣：**解析參數 → `get_config()` → 呼叫 `ado` 套件 → 寫 JSON**。

```python
"""
更新指定 Work Item 的狀態（System.State）。

用法:
  python update_state.py --id 12345 --state Active [--out item.json]

輸出（有指定 --out 時）: 更新後的 Work Item JSON { id, type, title, state, ..., webUrl }
進度訊息輸出在 stdout，錯誤訊息輸出在 stderr（exit code 1）。
"""

import argparse
import os

from ado.cli import run
from ado.client import web_url
from ado.config import get_config
from ado.output import write_json
from ado.work_items import to_row, update_state


def main():
    parser = argparse.ArgumentParser(description="更新 Work Item 的狀態")
    parser.add_argument("--id", required=True, type=int)
    parser.add_argument("--state", required=True)
    parser.add_argument("--out", help="把結果輸出成 JSON")
    args = parser.parse_args()

    cfg = get_config()
    print(f"更新 #{args.id} 的狀態為 {args.state}…", flush=True)        # 進度 → stdout
    item = update_state(cfg, args.id, args.state)
    row = {**to_row(item), "webUrl": web_url(cfg, item["id"])}
    print(f"完成，#{row['id']} 目前狀態：{row['state']}", flush=True)
    if args.out:
        write_json(os.path.abspath(args.out), row)                     # 結果 → --out 檔案


if __name__ == "__main__":
    run(main)                                                          # AdoError → stderr + exit 1
```

慣例清單：

1. **只用具名參數**（`--id`、`--iteration`…），呼叫端傳的都是字串。
2. **結果寫到 `--out` 檔案**，不要印在 stdout（stdout 混著進度訊息，不適合解析）。查詢類腳本可提供預設輸出路徑（`DATA_DIR` 底下）。
3. `print(..., flush=True)`：讓呼叫端即時看到進度。
4. 寫 JSON 用 `ensure_ascii=False, indent=2`；寫 CSV 用 `utf-8-sig`（Excel 直接開中文不亂碼）。
5. **長文字（如 Description）用檔案傳**（`--description-file`），避免命令列長度、換行、引號問題。讀檔用 `utf-8-sig`。
6. 檔案開頭 docstring 寫：用途、用法範例、輸出格式。
7. 輸出物件附 `fetchedAt`（ISO 時間）與 `count`，方便 UI 顯示與除錯。

手動執行（從 `script/` 執行，`ado` 套件才 import 得到）：

```bash
cd script
python get_iteration_work_items.py --iteration "MyProject\\Sprint 1" --out D:\wi.json
```

---

## 7. 從 App（Node / Electron）呼叫 Python

### 7.1 `runScriptJson()`：附加 `--out <暫存檔>`，讀回 JSON

```js
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PythonShell } = require('python-shell');
const { SCRIPT_DIR } = require('./paths');

/** 執行 script/ 底下的 Python 腳本；exit code 非 0 時 reject（訊息為 stderr）。 */
function runScript(scriptName, args = []) {
  return PythonShell.run(scriptName, {
    scriptPath: SCRIPT_DIR,
    pythonPath: process.env.PYTHON,           // 可用環境變數指定 Python 執行檔
    args,
    cwd: SCRIPT_DIR,                          // 讓 `from ado...` 可 import
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },   // Windows 中文不亂碼
    windowsHide: true,
  });
}

const tempFile = (ext) => path.join(os.tmpdir(), `myapp-${randomUUID()}.${ext}`);   // 每次請求各用一個
const removeTemp = (file) => fs.rm(file, { force: true }).catch(() => {});

async function runScriptJson(scriptName, args = []) {
  const out = tempFile('json');
  try {
    await runScript(scriptName, [...args, '--out', out]);
    return JSON.parse(await fs.readFile(out, 'utf-8'));
  } finally {
    removeTemp(out);
  }
}

module.exports = { runScript, runScriptJson, tempFile, removeTemp };
```

重點：

- 參數用陣列傳給子行程（不經 shell），**不需要自己處理跳脫**。
- 子行程繼承 `process.env`，所以 `DATA_DIR` 覆寫、環境變數設定都會傳下去。
- Python 的 `AdoError` → stderr → `PythonShell` reject → Node 端拿到的 error message 就是給使用者看的訊息。

### 7.2 Service：驗證參數再呼叫

```js
// main/services/requirementFlow.js
async function updateRequirementStateInAdo({ id, state } = {}) {
  if (!Number.isInteger(id) || id <= 0 || !SYNC_STATES.includes(state)) throw new Error('參數錯誤');
  return runScriptJson('update_state.py', ['--id', String(id), '--state', state]);
}

// 長文字先寫暫存檔，再以 --xxx-file 傳入
async function createDefaultTask({ id, description }) {
  const descFile = tempFile('txt');
  try {
    await fs.writeFile(descFile, description, 'utf-8');
    return await runScriptJson('create_task.py', ['--parent', String(id), '--description-file', descFile]);
  } finally {
    removeTemp(descFile);
  }
}
```

### 7.3 接到 UI

新增功能固定四步：

1. `main/services/xxx.js` — 邏輯（呼叫 `runScriptJson`）
2. `main/ipc.js` — `ipcMain.handle('flow:updateState', (_e, params) => svc.updateRequirementStateInAdo(params))`
3. `preload/index.js` — `updateRequirementState: (id, state) => ipcRenderer.invoke('flow:updateState', { id, state })`
4. renderer — `await api.updateRequirementState(id, state)`

Renderer 顯示錯誤前，去掉 Electron 加的前綴：

```js
export function cleanError(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
```

### 7.4 App 內編輯 `.env`

AdoMaster 在「設定 → 連線與機密設定…」提供 `.env` 編輯 dialog（`main/services/appConfig.js`）：

- 欄位清單集中定義在 `ENV_GROUPS`（`key`、`label`、`required`、`secret`、`placeholder`）；**新增 `.env` key 時要加進這裡**。
- 儲存時**只改清單內的 key**，其他行與註解保留；空值 = 刪掉該行。
- 值不得含換行；`AZDO_BASE_URL` 要是 `http(s)://` 開頭。
- 寫檔用「暫存檔 + rename」（atomic），且序列化，避免同時寫入損壞檔案。
- 若同名環境變數已設定，dialog 標示「環境變數優先」，避免使用者以為改了檔案卻沒生效。

---

## 8. PowerShell 腳本（選用）

若有 PowerShell 腳本也需要讀設定：

- 透過共用的 `Common.ps1` 取得 data 資料夾（`$env:<APP>_DATA_DIR` 優先）與讀 `.env`（`Read-DotEnv`，規則和 Python 相同）。
- 機密取值：`if ($env:X) { $env:X } else { $secrets['X'] }`（環境變數優先）。
- 結構化設定：`Get-Content data/config.json -Raw | ConvertFrom-Json`。
- 其餘慣例與 Python 相同：具名參數、進度 → stdout、結果 → `-Out` 檔案、失敗 → stderr + `exit 1`、不可互動（無 `Read-Host`）。
- `.ps1` 存成 **UTF-8 with BOM**（Windows PowerShell 5.1 讀中文需要），並設定 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`。

---

## 9. 常見陷阱一覽

| 陷阱 | 對策 |
|---|---|
| PAT 錯誤 / 過期時回 **203 + HTML 登入頁**，不是 401 | 回應不是 `application/json` 就當錯誤，並提示檢查 PAT |
| `workitemsbatch` 沒指定 fields 時**沒有 `System.Parent`** | 用 `$expand=relations` + `Hierarchy-Reverse/Forward` 解析 |
| `workitemsbatch` **單次最多 200 筆** | 分批，每批印進度 |
| 部分 id 已刪除 / 無權限導致整批失敗 | `errorPolicy: "omit"`，並過濾 `None` |
| Iteration node 的 path 多了 `\Iteration\` | `to_iteration_path()` 轉換後才拿去查 WIQL |
| WIQL 字串含單引號 | `wiql_str()`：`'` → `''` |
| 建立 / 更新 Work Item 回 400 / 415 | Content-Type 要 `application/json-patch+json`；更新用 `PATCH` |
| Project 名稱有空白 / 中文 | `urllib.parse.quote(..., safe="")` |
| Windows 中文亂碼 | 子行程設 `PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`；讀檔用 `utf-8-sig` |
| 命令列傳長文字（Description）出問題 | 寫暫存檔，以 `--xxx-file` 傳入 |
| 同時執行多個請求互相覆寫輸出 | 每次請求用 UUID 暫存檔，用完即刪 |
| Description 是 HTML | 讀取時 `html_to_text()`；寫入時 `html.escape` + `<br>` |
| 寫入動作誤觸 | 限縮會寫入 ADO 的動作（AdoMaster 只有「建立 Task」與「更新狀態」兩種），Node 端先驗證參數白名單 |

---

## 10. 新專案起手清單

1. 建立 `script/ado/`：複製 `errors.py`、`cli.py`、`config.py`、`client.py`、`output.py`，把 `DATA_DIR` 的環境變數名稱改成新專案的。
2. 建立 `templates/env_example.txt`、`templates/config_example.json`；`.gitignore` 加 `data/`。
3. 依需求加功能模組（`work_items.py` 等），每個模組 docstring 列出用到的 API 與文件連結。
4. 每個功能一支 `script/<動作>.py`，遵守第 6 節的 CLI 慣例；先在命令列測通。
5. 若有 UI：加 `runScriptJson()`，再依 service → IPC → preload → renderer 接上。
6. 申請 PAT 時只給需要的 scope（第 3.3 節）。
