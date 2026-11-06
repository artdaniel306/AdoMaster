"""
取得 Azure DevOps 回收筒 (Recycle Bin) 中被刪除的 Work Items，並輸出成 CSV。

參考 API:
  - Get Deleted Work Item Shallow References (取得所有已刪除項目的 id)
      GET {base}/{org}/{project}/_apis/wit/recyclebin?api-version=7.1
  - Get Deleted Work Items (依 ids 取得明細)
      GET {base}/{org}/{project}/_apis/wit/recyclebin?ids={ids}&api-version=7.1
  https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/recyclebin/get-deleted-work-items?view=azure-devops-rest-7.1

設定從同一層資料夾的 .env 讀取，見 .env.example。
只使用 Python 標準函式庫，不需額外安裝套件。
"""

import base64
import csv
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(SCRIPT_DIR, ".env")
BATCH_SIZE = 200  # 每次查詢的 ids 數量，避免 URL 過長

CSV_COLUMNS = [
    "id",
    "name",
    "type",
    "project",
    "deletedBy",
    "deletedDate",
    "code",
    "message",
    "url",
]


def load_env(path):
    """簡易 .env 解析：KEY=VALUE，支援 # 註解與引號。"""
    if not os.path.isfile(path):
        sys.exit(f"[錯誤] 找不到設定檔：{path}（可複製 .env.example 為 .env 後填入設定）")
    env = {}
    with open(path, encoding="utf-8-sig") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key.startswith("export "):
                key = key[len("export "):].strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            env[key] = value
    return env


def get_config():
    env = load_env(ENV_PATH)

    def need(key):
        val = env.get(key) or os.environ.get(key)
        if not val:
            sys.exit(f"[錯誤] .env 缺少必要設定：{key}")
        return val

    def opt(key, default):
        return env.get(key) or os.environ.get(key) or default

    return {
        "base_url": opt("AZDO_BASE_URL", "https://dev.azure.com").rstrip("/"),
        "org": need("AZDO_ORG"),
        "project": need("AZDO_PROJECT"),
        "pat": need("AZDO_PAT"),
        "api_version": opt("AZDO_API_VERSION", "7.1"),
        "output": opt(
            "OUTPUT_CSV",
            f"deleted_work_items_{datetime.now():%Y%m%d_%H%M%S}.csv",
        ),
    }


def api_get(url, pat):
    token = base64.b64encode(f":{pat}".encode("utf-8")).decode("ascii")
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Basic {token}",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            ctype = resp.headers.get("Content-Type", "")
            # PAT 無效時 Azure DevOps 常回 203 + HTML 登入頁
            if "application/json" not in ctype:
                sys.exit(
                    f"[錯誤] 回應不是 JSON（HTTP {resp.status}, {ctype}），"
                    "請確認 PAT 是否正確、是否過期，以及是否有 Work Items (Read) 權限。"
                )
            return json.loads(body)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        sys.exit(f"[錯誤] HTTP {e.code} {e.reason}\nURL: {url}\n{detail}")
    except urllib.error.URLError as e:
        sys.exit(f"[錯誤] 無法連線：{e.reason}\nURL: {url}")


def recyclebin_url(cfg, ids=None):
    org = urllib.parse.quote(cfg["org"], safe="")
    project = urllib.parse.quote(cfg["project"], safe="")
    params = {"api-version": cfg["api_version"]}
    if ids:
        params["ids"] = ",".join(str(i) for i in ids)
    query = urllib.parse.urlencode(params, safe=",")
    return f"{cfg['base_url']}/{org}/{project}/_apis/wit/recyclebin?{query}"


def get_deleted_ids(cfg):
    data = api_get(recyclebin_url(cfg), cfg["pat"])
    return [item["id"] for item in data.get("value", []) if "id" in item]


def get_deleted_items(cfg, ids):
    items = []
    for start in range(0, len(ids), BATCH_SIZE):
        chunk = ids[start:start + BATCH_SIZE]
        data = api_get(recyclebin_url(cfg, chunk), cfg["pat"])
        items.extend(data.get("value", []))
        print(f"  已取得 {min(start + BATCH_SIZE, len(ids))}/{len(ids)}")
    return items


def to_row(item):
    row = {}
    for col in CSV_COLUMNS:
        val = item.get(col, "")
        if isinstance(val, dict):  # 保險起見：若為 identity 物件則取顯示名稱
            val = val.get("displayName") or val.get("uniqueName") or json.dumps(val, ensure_ascii=False)
        row[col] = "" if val is None else val
    return row


def write_csv(path, items):
    if not os.path.isabs(path):
        path = os.path.join(SCRIPT_DIR, path)
    # utf-8-sig：讓 Excel 直接開啟時中文不會亂碼
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for item in sorted(items, key=lambda x: x.get("id", 0)):
            writer.writerow(to_row(item))
    return path


def main():
    cfg = get_config()
    print(f"組織：{cfg['org']}  專案：{cfg['project']}")

    print("1. 取得回收筒中已刪除的 Work Item ID ...")
    ids = get_deleted_ids(cfg)
    print(f"   共 {len(ids)} 筆")

    items = []
    if ids:
        print("2. 取得已刪除 Work Item 明細 ...")
        items = get_deleted_items(cfg, ids)

    out = write_csv(cfg["output"], items)
    print(f"完成，已輸出 {len(items)} 筆至：{out}")


if __name__ == "__main__":
    main()
