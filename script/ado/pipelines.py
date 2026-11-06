"""
Pipeline 與 Pipeline Run 查詢（使用 Build API：Pipeline = build definition、Run = build）。

PAT 需要 Build (Read) 權限。

參考 API:
  - Definitions - List（依名稱找 Pipeline）
      GET {base}/{org}/{project}/_apis/build/definitions?name={name}&path={folder}&api-version=7.1
      https://learn.microsoft.com/en-us/rest/api/azure/devops/build/definitions/list?view=azure-devops-rest-7.1
  - Builds - List（Pipeline 的 Run，可依 definition 篩選）
      GET {base}/{org}/{project}/_apis/build/builds?definitions={id}&queryOrder=queueTimeDescending&$top={n}&api-version=7.1
      https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/list?view=azure-devops-rest-7.1
"""

import urllib.parse

from .client import api_request, api_url
from .errors import AdoError

# 尚未結束（進行中 / 排隊 / 停等）的 Run 狀態；其他（completed）視為已結束
ACTIVE_STATUSES = {"notStarted", "inProgress", "cancelling", "postponed"}


def _get(cfg, resource, params):
    """GET Build API；401 時提示 PAT 需要 Build (Read) 權限。

    params 另外組成 query string：Definitions - List 有 `path` 參數，和 api_url 的參數名稱衝突。
    """
    url = f"{api_url(cfg, resource)}&{urllib.parse.urlencode(params)}"
    try:
        return api_request(url, cfg["pat"])
    except AdoError as e:
        if "HTTP 401" in str(e):
            raise AdoError(f"{e}\nPAT 沒有讀取 Pipeline 的權限：請在 Azure DevOps 為 AZDO_PAT 加上 Build (Read) 權限。") from None
        raise


def _web_href(obj):
    return ((obj.get("_links") or {}).get("web") or {}).get("href")


def find_pipeline(cfg, name):
    """依名稱找 Pipeline。名稱可帶資料夾（`資料夾\\名稱`）以區分不同資料夾中的同名 Pipeline。"""
    name = (name or "").strip().replace("/", "\\")
    folder, _, base = name.rpartition("\\")
    if not base:
        raise AdoError("[錯誤] 未指定 Pipeline 名稱")
    params = {"name": base}
    if folder:
        params["path"] = "\\" + folder.strip("\\")
    defs = _get(cfg, "build/definitions", params).get("value", [])
    if not defs:
        raise AdoError(f"[錯誤] 找不到 Pipeline：{name}（請確認名稱，以及 PAT 是否有 Build (Read) 權限）")
    if len(defs) > 1:
        paths = "、".join(f"{d.get('path', '')}\\{d['name']}".replace("\\\\", "\\") for d in defs)
        raise AdoError(f"[錯誤] 有 {len(defs)} 個名為 {base} 的 Pipeline（{paths}），請以「資料夾\\名稱」指定")
    d = defs[0]
    return {"id": d["id"], "name": d["name"], "path": d.get("path"), "webUrl": _web_href(d)}


def to_run(b):
    """把 build 轉成 App 使用的 Run 欄位。"""
    status = b.get("status")
    return {
        "id": b["id"],
        "buildNumber": b.get("buildNumber"),
        "status": status,
        "result": b.get("result"),
        "active": status in ACTIVE_STATUSES,
        "reason": b.get("reason"),
        "sourceBranch": b.get("sourceBranch"),
        "sourceVersion": b.get("sourceVersion"),
        "requestedFor": (b.get("requestedFor") or {}).get("displayName"),
        "queueTime": b.get("queueTime"),
        "startTime": b.get("startTime"),
        "finishTime": b.get("finishTime"),
        "webUrl": _web_href(b),
    }


def list_runs(cfg, definition_id, top=30):
    """Pipeline 最近的 Run（依排入佇列時間新到舊）。"""
    params = {"definitions": definition_id, "queryOrder": "queueTimeDescending", "$top": top}
    builds = _get(cfg, "build/builds", params).get("value", [])
    return [to_run(b) for b in builds]
