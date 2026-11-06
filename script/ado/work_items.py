"""
Work Item 查詢與轉換。

參考 API:
  - Query By Wiql（依條件查出 Work Item id）
      POST {base}/{org}/{project}/_apis/wit/wiql?api-version=7.1
      https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1
  - Get Work Items Batch（依 ids 取得明細，每次最多 200 筆）
      POST {base}/{org}/{project}/_apis/wit/workitemsbatch?api-version=7.1
      https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items-batch?view=azure-devops-rest-7.1
"""

import html
import json
import re

from .client import api_request, api_url

BATCH_SIZE = 200  # workitemsbatch 單次上限

# (欄位名稱, Work Item field reference name)
ROW_FIELDS = [
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
ROW_COLUMNS = [c for c, _ in ROW_FIELDS]


# ---------------------------------------------------------------- 查詢

def wiql_str(value):
    """WIQL 字串常值：單引號跳脫。"""
    return "'" + value.replace("'", "''") + "'"


def build_wiql(*, type=None, ids=None, states=None, assigned_to=None,
               iteration=None, iteration_exact=False, area=None, changed_since=None):
    conds = ["[System.TeamProject] = @project"]
    if type:  # 為空時不限 Work Item Type
        conds.append(f"[System.WorkItemType] = {wiql_str(type)}")
    if ids:
        conds.append(f"[System.Id] IN ({', '.join(map(str, ids))})")
    if states:
        conds.append(f"[System.State] IN ({', '.join(wiql_str(s) for s in states)})")
    if assigned_to:
        who = "@Me" if assigned_to.lower() == "@me" else wiql_str(assigned_to)
        conds.append(f"[System.AssignedTo] = {who}")
    if iteration:
        op = "=" if iteration_exact else "UNDER"
        conds.append(f"[System.IterationPath] {op} {wiql_str(iteration)}")
    if area:
        conds.append(f"[System.AreaPath] UNDER {wiql_str(area)}")
    if changed_since:
        conds.append(f"[System.ChangedDate] >= {wiql_str(changed_since)}")
    return (
        "SELECT [System.Id] FROM WorkItems WHERE "
        + " AND ".join(conds)
        + " ORDER BY [System.Id]"
    )


def query_ids(cfg, top=None, **filters):
    """filters 同 build_wiql 的參數。回傳符合條件的 Work Item id 清單。"""
    wiql = build_wiql(**filters)
    params = {"$top": top} if top else {}
    data = api_request(api_url(cfg, "wit/wiql", **params), cfg["pat"], {"query": wiql})
    return [w["id"] for w in data.get("workItems", [])]


def get_work_items(cfg, ids, relations=False):
    """依 id 分批取得完整 Work Item，依 id 排序回傳。

    relations=True 時一併取回關聯（$expand=relations），可用 child_ids / parent_id 取得父子關係。
    注意：workitemsbatch 不指定 fields 時不會回傳 System.Parent，需靠 relations 取得 parent。
    """
    items = []
    url = api_url(cfg, "wit/workitemsbatch")
    for start in range(0, len(ids), BATCH_SIZE):
        chunk = ids[start:start + BATCH_SIZE]
        # 不指定 fields → 回傳所有欄位；errorPolicy=omit → 查無/無權限的 id 不會讓整批失敗
        payload = {"ids": chunk, "errorPolicy": "omit"}
        if relations:
            payload["$expand"] = "relations"
        data = api_request(url, cfg["pat"], payload)
        items.extend(i for i in data.get("value", []) if i)
        print(f"  已取得 {min(start + BATCH_SIZE, len(ids))}/{len(ids)}", flush=True)
    return sorted(items, key=lambda x: x.get("id", 0))


# ---------------------------------------------------------------- 關聯

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


def child_ids(item):
    """子 Work Item id（需以 relations=True 取得 item）。"""
    return _related_ids(item, HIERARCHY_FORWARD)


def parent_id(item):
    """父 Work Item id，沒有時回傳 None（需以 relations=True 取得 item）。"""
    ids = _related_ids(item, HIERARCHY_REVERSE)
    return ids[0] if ids else None


# ---------------------------------------------------------------- 轉換

def html_to_text(value):
    text = re.sub(r"<br\s*/?>|</(p|div|li|h\d)>", "\n", value, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def to_row(item):
    """把 API 回傳的 Work Item 轉成扁平 dict（欄位見 ROW_FIELDS）。"""
    fields = item.get("fields", {})
    row = {}
    for col, ref in ROW_FIELDS:
        val = item.get("id") if ref == "System.Id" else fields.get(ref, "")
        if isinstance(val, dict):  # identity 物件（AssignedTo / CreatedBy ...）
            val = val.get("displayName") or val.get("uniqueName") or json.dumps(val, ensure_ascii=False)
        elif ref == "System.Description" and val:
            val = html_to_text(val)
        row[col] = "" if val is None else val
    if not row["parent"] and item.get("relations"):
        row["parent"] = parent_id(item) or ""
    return row
