"""
Work Item 查詢與轉換。

參考 API:
  - Query By Wiql（依條件查出 Work Item id）
      POST {base}/{org}/{project}/_apis/wit/wiql?api-version=7.1
      https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1
  - Get Work Items Batch（依 ids 取得明細，每次最多 200 筆）
      POST {base}/{org}/{project}/_apis/wit/workitemsbatch?api-version=7.1
      https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items-batch?view=azure-devops-rest-7.1
  - Create Work Item（以 JSON Patch 建立）
      POST {base}/{org}/{project}/_apis/wit/workitems/${type}?api-version=7.1
      https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/create?view=azure-devops-rest-7.1
  - Update Work Item（以 JSON Patch 更新）
      PATCH {base}/{org}/{project}/_apis/wit/workitems/{id}?api-version=7.1
      https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1
  - Create Attachment（上傳附件，回傳可嵌入 HTML 欄位的 url）
      POST {base}/{org}/{project}/_apis/wit/attachments?fileName={name}&api-version=7.1
      https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/attachments/create?view=azure-devops-rest-7.1
  - Get Comments（Work Item 的留言，preview API）
      GET {base}/{org}/{project}/_apis/wit/workItems/{id}/comments?$top=N&order=desc&api-version=7.1-preview.4
      https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/get-comments?view=azure-devops-rest-7.1
  - Add Comment（新增 Work Item 留言，preview API）
      POST {base}/{org}/{project}/_apis/wit/workItems/{id}/comments?format=html&api-version=7.1-preview.4
      https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/add-work-item-comment?view=azure-devops-rest-7.1
"""

import html
import json
import os
import re

import urllib.parse

from .client import api_request, api_upload, api_url
from .errors import AdoError

BATCH_SIZE = 200  # workitemsbatch 單次上限

# (欄位名稱, Work Item field reference name)
ROW_FIELDS = [
    ("id", "System.Id"),
    ("type", "System.WorkItemType"),
    ("title", "System.Title"),
    ("state", "System.State"),
    ("reason", "System.Reason"),
    ("assignedTo", "System.AssignedTo"),
    ("assignedToEmail", "System.AssignedTo"),  # identity 的 uniqueName（通常是 email）
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
    ("reproSteps", "Microsoft.VSTS.TCM.ReproSteps"),  # Bug 的主要敘述（Bug 通常不填 Description）
]
HTML_FIELDS = {"System.Description", "Microsoft.VSTS.TCM.ReproSteps"}
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
    text = re.sub(r"<img\b[^>]*>", "[圖片]", value, flags=re.I)
    text = re.sub(r"<br\s*/?>|</(p|div|li|h\d)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def to_row(item):
    """把 API 回傳的 Work Item 轉成扁平 dict（欄位見 ROW_FIELDS）。"""
    fields = item.get("fields", {})
    row = {}
    for col, ref in ROW_FIELDS:
        val = item.get("id") if ref == "System.Id" else fields.get(ref, "")
        if col == "assignedToEmail":
            val = val.get("uniqueName", "") if isinstance(val, dict) else ""
        elif isinstance(val, dict):  # identity 物件（AssignedTo / CreatedBy ...）
            val = val.get("displayName") or val.get("uniqueName") or json.dumps(val, ensure_ascii=False)
        elif ref in HTML_FIELDS and val:
            val = html_to_text(val)
        row[col] = "" if val is None else val
    if not row["parent"] and item.get("relations"):
        row["parent"] = parent_id(item) or ""
    return row


def comments_api_version(cfg):
    """Comments API 只有 preview 版：7.1 → 7.1-preview.4，其他版本（如 7.0 / 6.0）→ {版本}-preview.3。"""
    version = cfg["api_version"].split("-", 1)[0]
    return f"{version}-preview.4" if version == "7.1" else f"{version}-preview.3"


def get_comments(cfg, item_id, top=3):
    """取得 Work Item 最新的 top 筆留言（新 → 舊）。

    回傳 { totalCount, comments: [{ id, text（純文字）, createdBy, createdDate, modifiedDate }] }。
    """
    url = api_url(cfg, f"wit/workItems/{int(item_id)}/comments",
                  **{"$top": int(top), "order": "desc", "api-version": comments_api_version(cfg)})
    data = api_request(url, cfg["pat"]) or {}
    comments = []
    for c in data.get("comments", []):
        if c.get("isDeleted"):
            continue
        by = c.get("createdBy") or {}
        comments.append({
            "id": c.get("id"),
            "text": html_to_text(c.get("text") or ""),
            "createdBy": by.get("displayName") or by.get("uniqueName") or "",
            "createdDate": c.get("createdDate") or "",
            "modifiedDate": c.get("modifiedDate") or "",
        })
    return {"totalCount": data.get("totalCount", len(comments)), "comments": comments}


def mention_html(identity):
    """identity（如 System.AssignedTo）→ ADO 留言中 @ 提及的 HTML（對方會收到通知）。"""
    name = html.escape(identity.get("displayName") or identity.get("uniqueName") or "")
    if not identity.get("id"):
        return f"@{name}"
    return f'<a href="#" data-vss-mention="version:2.0,{html.escape(identity["id"])}">@{name}</a>'


def add_comment(cfg, item_id, html_text):
    """在 Work Item 新增一則 HTML 格式的留言，回傳 API 回傳的 Comment。"""
    url = api_url(cfg, f"wit/workItems/{int(item_id)}/comments",
                  **{"format": "html", "api-version": comments_api_version(cfg)})
    return api_request(url, cfg["pat"], {"text": html_text})


# ---------------------------------------------------------------- 建立

def text_to_html(value):
    """純文字轉成 Description 欄位用的 HTML（跳脫特殊字元、換行轉 <br>）。"""
    return "<br>".join(html.escape(line) for line in value.splitlines())


def _add(path, value):
    return {"op": "add", "path": path, "value": value}


def _get_parent(cfg, parent_id, relations=False):
    found = get_work_items(cfg, [parent_id], relations=relations)
    if not found:
        raise AdoError(f"[錯誤] 找不到 Work Item #{parent_id}（或沒有權限）")
    return found[0]


def _create_child(cfg, parent, type, ops):
    """在 parent（Work Item）底下建立 type 的子項目：Area / Iteration 沿用 parent，ops 為其餘欄位的 JSON Patch。"""
    fields = parent.get("fields", {})
    ops = [
        *ops,
        _add("/fields/System.AreaPath", fields.get("System.AreaPath", "")),
        _add("/fields/System.IterationPath", fields.get("System.IterationPath", "")),
        _add("/relations/-", {
            "rel": HIERARCHY_REVERSE,
            "url": parent.get("url") or api_url(cfg, f"wit/workItems/{parent['id']}").split("?", 1)[0],
        }),
    ]
    url = api_url(cfg, f"wit/workitems/${urllib.parse.quote(type)}")
    return api_request(url, cfg["pat"], ops, content_type="application/json-patch+json")


def create_child_task(cfg, parent_id, description="", type="Task"):
    """在 parent 底下建立一個子 Work Item：標題與 parent 相同，Area / Iteration 沿用 parent。

    回傳 API 回傳的新 Work Item（含 relations）。
    """
    parent = _get_parent(cfg, parent_id)
    ops = [_add("/fields/System.Title", parent.get("fields", {}).get("System.Title", ""))]
    if description:
        ops.append(_add("/fields/System.Description", text_to_html(description)))
    return _create_child(cfg, parent, type, ops)


def upload_attachment(cfg, file_path):
    """上傳檔案成為 Work Item 附件，回傳 API 回傳的 { id, url }（url 可嵌入 HTML 欄位的 <img>）。"""
    try:
        with open(file_path, "rb") as f:
            data = f.read()
    except OSError as e:
        raise AdoError(f"[錯誤] 無法讀取附件檔案：{e}") from None
    url = api_url(cfg, "wit/attachments", fileName=os.path.basename(file_path))
    result = api_upload(url, cfg["pat"], data)
    if not isinstance(result, dict) or not result.get("url"):
        raise AdoError("[錯誤] 上傳附件失敗：回應沒有 url")
    return result


def child_assignees(cfg, parent_id, type="Task"):
    """parent 底下 type（預設 Task）子項目的指派對象：{ uniqueName（小寫）: identity }。"""
    kids = child_ids(_get_parent(cfg, parent_id, relations=True))
    result = {}
    for k in get_work_items(cfg, kids) if kids else []:
        f = k.get("fields", {})
        who = f.get("System.AssignedTo")
        if f.get("System.WorkItemType") == type and isinstance(who, dict) and who.get("uniqueName"):
            result.setdefault(who["uniqueName"].lower(), who)
    return result


def create_child_bug(cfg, parent_id, title, repro_text="", images=(), assigned_to=""):
    """在 parent（Requirement）底下建立 Bug：Area / Iteration 沿用 parent。

    repro_text（純文字）與 images（本機圖片檔路徑，上傳成附件後以 <img> 嵌入）組成 Repro Steps；
    assigned_to 為 email（uniqueName），必須是 parent 底下某個 Task 的指派對象。
    回傳 API 回傳的新 Work Item。
    """
    title = " ".join(title.split())
    if not title:
        raise AdoError("[錯誤] Bug 標題不能是空白")
    parent = _get_parent(cfg, parent_id)

    ops = [_add("/fields/System.Title", title)]
    if assigned_to:
        who = child_assignees(cfg, parent_id).get(assigned_to.lower())
        if not who:
            raise AdoError(f"[錯誤] {assigned_to} 不是 #{parent_id} 底下 Task 的指派對象")
        ops.append(_add("/fields/System.AssignedTo", who["uniqueName"]))

    parts = [text_to_html(repro_text)] if repro_text else []
    for i, path in enumerate(images, 1):
        print(f"上傳圖片 {i}/{len(images)}…", flush=True)
        att = upload_attachment(cfg, path)
        parts.append(f'<img src="{html.escape(att["url"])}" alt="{html.escape(os.path.basename(path))}">')
    if parts:
        ops.append(_add("/fields/Microsoft.VSTS.TCM.ReproSteps", "<br><br>".join(parts)))
    return _create_child(cfg, parent, "Bug", ops)


# ---------------------------------------------------------------- 更新

def update_state(cfg, item_id, state):
    """把 Work Item 的 System.State 改成 state（Reason 由 ADO 依流程規則帶入預設值）。

    回傳 API 回傳的更新後 Work Item。
    """
    ops = [{"op": "add", "path": "/fields/System.State", "value": state}]
    url = api_url(cfg, f"wit/workitems/{int(item_id)}")
    return api_request(url, cfg["pat"], ops, content_type="application/json-patch+json", method="PATCH")


# 關閉子 Task 時略過的狀態（小寫比對）
CLOSE_SKIP_STATES = {"closed", "removed"}


def close_child_tasks(cfg, parent_id, type="Task", state="Closed"):
    """把 parent 底下尚未 Closed / Removed 的子 Task 逐一改成 state。

    回傳 [被更新的子 Work Item（API 回傳）]；任何一筆失敗即丟出例外（已更新的不會還原，再執行一次會略過）。
    """
    found = get_work_items(cfg, [parent_id], relations=True)
    if not found:
        raise AdoError(f"[錯誤] 找不到 Work Item #{parent_id}（或沒有權限）")
    kids = child_ids(found[0])
    if not kids:
        return []
    targets = [
        k for k in get_work_items(cfg, kids)
        if k.get("fields", {}).get("System.WorkItemType") == type
        and str(k.get("fields", {}).get("System.State", "")).lower() not in CLOSE_SKIP_STATES
    ]
    updated = []
    for k in targets:
        try:
            updated.append(update_state(cfg, k["id"], state))
        except AdoError as e:
            raise AdoError(f"[錯誤] 無法把子 {type} #{k['id']} 改為 {state}：{e}") from e
    return updated
