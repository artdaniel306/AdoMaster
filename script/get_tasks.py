"""
取得 Azure DevOps 專案中的 Task（Work Item），並輸出成 CSV（可選擇另存完整 JSON）。

參考 API:
  - Query By Wiql（依條件查出 Work Item id）
      POST {base}/{org}/{project}/_apis/wit/wiql?api-version=7.1
      https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1
  - Get Work Items Batch（依 ids 取得明細，每次最多 200 筆）
      POST {base}/{org}/{project}/_apis/wit/workitemsbatch?api-version=7.1
      https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items-batch?view=azure-devops-rest-7.1

用法:
  python get_tasks.py                                   # 取得專案內所有 Task
  python get_tasks.py 1201 1205 1300-1310               # 只取指定 ID（支援空白/逗號分隔與範圍）
  python get_tasks.py --state Active --assigned-to @Me  # 依狀態、指派對象篩選
  python get_tasks.py --iteration "MyProject\\Sprint 5"  # 依 Iteration（含子節點）篩選
  python get_tasks.py --changed-since 2026-10-01 --json # 依最後修改日篩選，並另存完整 JSON
  python get_tasks.py --type Bug                        # 改抓其他 Work Item Type

設定從同一層資料夾的 .env 讀取，見 env_example.txt。
PAT 需有 Work Items (Read) 權限。
只使用 Python 標準函式庫，不需額外安裝套件。
"""

import argparse
import base64
import csv
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(SCRIPT_DIR, ".env")
BATCH_SIZE = 200  # workitemsbatch 單次上限

# (CSV 欄位名稱, Work Item field reference name)
CSV_FIELDS = [
    ("id", "System.Id"),
    ("type", "System.WorkItemType"),
    ("title", "System.Title"),
    ("state", "System.State"),
    ("reason", "System.Reason"),
    ("assignedTo", "System.AssignedTo"),
    ("parent", "System.Parent"),
    ("areaPath", "System.AreaPath"),
    ("iterationPath", "System.IterationPath"),
    ("priority", "Microsoft.VSTS.Common.Priority"),
    ("activity", "Microsoft.VSTS.Common.Activity"),
    ("originalEstimate", "Microsoft.VSTS.Scheduling.OriginalEstimate"),
    ("remainingWork", "Microsoft.VSTS.Scheduling.RemainingWork"),
    ("completedWork", "Microsoft.VSTS.Scheduling.CompletedWork"),
    ("startDate", "Microsoft.VSTS.Scheduling.StartDate"),
    ("finishDate", "Microsoft.VSTS.Scheduling.FinishDate"),
    ("tags", "System.Tags"),
    ("createdBy", "System.CreatedBy"),
    ("createdDate", "System.CreatedDate"),
    ("changedBy", "System.ChangedBy"),
    ("changedDate", "System.ChangedDate"),
    ("closedDate", "Microsoft.VSTS.Common.ClosedDate"),
    ("description", "System.Description"),
]


# ---------------------------------------------------------------- 設定

def load_env(path):
    """簡易 .env 解析：KEY=VALUE，支援 # 註解與引號。"""
    if not os.path.isfile(path):
        sys.exit(f"[錯誤] 找不到設定檔：{path}（可複製 env_example.txt 為 .env 後填入設定）")
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
            if value[:1] not in ("'", '"'):  # 未加引號時，去除行尾 " # 註解"
                value = value.split(" #", 1)[0].strip()
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
        "output": opt("OUTPUT_CSV", f"tasks_{datetime.now():%Y%m%d_%H%M%S}.csv"),
    }


# ---------------------------------------------------------------- API

def api_url(cfg, path, **params):
    org = urllib.parse.quote(cfg["org"], safe="")
    project = urllib.parse.quote(cfg["project"], safe="")
    params["api-version"] = cfg["api_version"]
    query = urllib.parse.urlencode(params)
    return f"{cfg['base_url']}/{org}/{project}/_apis/{path}?{query}"


def api_post(url, pat, payload):
    token = base64.b64encode(f":{pat}".encode("utf-8")).decode("ascii")
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Basic {token}",
            "Content-Type": "application/json",
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
        try:
            detail = json.loads(detail).get("message", detail)
        except ValueError:
            pass
        sys.exit(f"[錯誤] HTTP {e.code} {e.reason}\nURL: {url}\n{detail}")
    except urllib.error.URLError as e:
        sys.exit(f"[錯誤] 無法連線：{e.reason}\nURL: {url}")


# ---------------------------------------------------------------- 查詢

def wiql_str(value):
    """WIQL 字串常值：單引號跳脫。"""
    return "'" + value.replace("'", "''") + "'"


def build_wiql(args, ids=None):
    conds = [
        "[System.TeamProject] = @project",
        f"[System.WorkItemType] = {wiql_str(args.type)}",
    ]
    if ids:
        conds.append(f"[System.Id] IN ({', '.join(map(str, ids))})")
    if args.state:
        states = ", ".join(wiql_str(s) for s in args.state)
        conds.append(f"[System.State] IN ({states})")
    if args.assigned_to:
        who = args.assigned_to
        conds.append("[System.AssignedTo] = " + ("@Me" if who.lower() == "@me" else wiql_str(who)))
    if args.iteration:
        conds.append(f"[System.IterationPath] UNDER {wiql_str(args.iteration)}")
    if args.area:
        conds.append(f"[System.AreaPath] UNDER {wiql_str(args.area)}")
    if args.changed_since:
        conds.append(f"[System.ChangedDate] >= {wiql_str(args.changed_since)}")
    return (
        "SELECT [System.Id] FROM WorkItems WHERE "
        + " AND ".join(conds)
        + " ORDER BY [System.Id]"
    )


def query_ids(cfg, args, ids=None):
    wiql = build_wiql(args, ids)
    params = {"$top": args.top} if args.top else {}
    data = api_post(api_url(cfg, "wit/wiql", **params), cfg["pat"], {"query": wiql})
    return [w["id"] for w in data.get("workItems", [])]


def get_work_items(cfg, ids):
    items = []
    url = api_url(cfg, "wit/workitemsbatch")
    for start in range(0, len(ids), BATCH_SIZE):
        chunk = ids[start:start + BATCH_SIZE]
        # 不指定 fields → 回傳所有欄位；errorPolicy=omit → 查無/無權限的 id 不會讓整批失敗
        data = api_post(url, cfg["pat"], {"ids": chunk, "errorPolicy": "omit"})
        items.extend(i for i in data.get("value", []) if i)
        print(f"  已取得 {min(start + BATCH_SIZE, len(ids))}/{len(ids)}")
    return items


# ---------------------------------------------------------------- 輸出

def html_to_text(value):
    text = re.sub(r"<br\s*/?>|</(p|div|li|h\d)>", "\n", value, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def to_row(item):
    fields = item.get("fields", {})
    row = {}
    for col, ref in CSV_FIELDS:
        val = item.get("id") if ref == "System.Id" else fields.get(ref, "")
        if isinstance(val, dict):  # identity 物件（AssignedTo / CreatedBy ...）
            val = val.get("displayName") or val.get("uniqueName") or json.dumps(val, ensure_ascii=False)
        elif ref == "System.Description" and val:
            val = html_to_text(val)
        row[col] = "" if val is None else val
    return row


def resolve_path(path):
    return path if os.path.isabs(path) else os.path.join(SCRIPT_DIR, path)


def write_csv(path, items):
    path = resolve_path(path)
    # utf-8-sig：讓 Excel 直接開啟時中文不會亂碼
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=[c for c, _ in CSV_FIELDS])
        writer.writeheader()
        for item in items:
            writer.writerow(to_row(item))
    return path


def write_json(path, items):
    path = resolve_path(path)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    return path


# ---------------------------------------------------------------- main

def parse_ids(tokens):
    """將 ['31', '32,33', '40-45'] 解析為排序後不重複的 int 清單。"""
    ids = set()
    for token in tokens:
        for part in token.replace(",", " ").split():
            try:
                if "-" in part:
                    start, end = (int(x) for x in part.split("-", 1))
                    if start > end:
                        start, end = end, start
                    ids.update(range(start, end + 1))
                else:
                    ids.add(int(part))
            except ValueError:
                sys.exit(f"[錯誤] 無法解析的 ID：{part}")
    return sorted(i for i in ids if i > 0)


def main():
    parser = argparse.ArgumentParser(description="取得 Azure DevOps Task 內容並輸出 CSV")
    parser.add_argument("ids", nargs="*", help="指定 Work Item ID，可用空白或逗號分隔，支援範圍如 40-45")
    parser.add_argument("--type", default="Task", help="Work Item Type（預設 Task）")
    parser.add_argument("--state", action="append", help="狀態篩選，可重複指定，如 --state New --state Active")
    parser.add_argument("--assigned-to", help="指派對象（顯示名稱、Email 或 @Me）")
    parser.add_argument("--iteration", help="Iteration Path（含子節點），如 \"MyProject\\Sprint 5\"")
    parser.add_argument("--area", help="Area Path（含子節點）")
    parser.add_argument("--changed-since", help="最後修改日期 >= 此日期，格式 YYYY-MM-DD")
    parser.add_argument("--top", type=int, help="最多取幾筆（WIQL 上限 20000）")
    parser.add_argument("-o", "--output", help="CSV 輸出路徑（預設依 .env 的 OUTPUT_CSV 或加上時間戳記）")
    parser.add_argument("--json", action="store_true", help="另存一份含所有欄位的 JSON（與 CSV 同名）")
    args = parser.parse_args()

    if args.changed_since:
        try:
            datetime.strptime(args.changed_since, "%Y-%m-%d")
        except ValueError:
            sys.exit("[錯誤] --changed-since 格式須為 YYYY-MM-DD")

    cfg = get_config()
    print(f"組織：{cfg['org']}  專案：{cfg['project']}  類型：{args.type}")

    ids = parse_ids(args.ids)
    print("1. 以 WIQL 查詢符合條件的 Work Item ID ...")
    # 指定 ID 時分批放進 WIQL，避免查詢字串過長
    found = []
    if ids:
        for start in range(0, len(ids), BATCH_SIZE):
            found.extend(query_ids(cfg, args, ids[start:start + BATCH_SIZE]))
        missing = sorted(set(ids) - set(found))
        if missing:
            print(f"   以下 ID 不存在、不是 {args.type} 或不符條件，已略過：{', '.join(map(str, missing))}")
    else:
        found = query_ids(cfg, args)
    print(f"   共 {len(found)} 筆")

    items = []
    if found:
        print("2. 取得 Work Item 明細 ...")
        items = sorted(get_work_items(cfg, found), key=lambda x: x.get("id", 0))

    out = write_csv(args.output or cfg["output"], items)
    print(f"完成，已輸出 {len(items)} 筆至：{out}")
    if args.json:
        jout = write_json(os.path.splitext(out)[0] + ".json", items)
        print(f"完整 JSON：{jout}")


if __name__ == "__main__":
    main()
