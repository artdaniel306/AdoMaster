"""
Iteration（Sprint）樹狀結構。

參考 API:
  - Classification Nodes - Get（取得 Iteration 樹狀結構，含起訖日）
      GET {base}/{org}/{project}/_apis/wit/classificationnodes/Iterations?$depth=20&api-version=7.1
      https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/classification-nodes/get?view=azure-devops-rest-7.1
"""

from .client import api_request, api_url

MAX_DEPTH = 20

ROW_COLUMNS = [
    "id",
    "identifier",
    "name",
    "iterationPath",
    "level",
    "parentId",
    "hasChildren",
    "startDate",
    "finishDate",
    "timeFrame",
    "url",
]


def get_iteration_tree(cfg):
    url = api_url(cfg, "wit/classificationnodes/Iterations", **{"$depth": MAX_DEPTH})
    return api_request(url, cfg["pat"])


def to_iteration_path(node_path):
    """API 的 path 形如 \\Project\\Iteration\\Sprint 1，轉成 Project\\Sprint 1。"""
    parts = [p for p in node_path.split("\\") if p]
    if len(parts) >= 2 and parts[1] == "Iteration":
        del parts[1]
    return "\\".join(parts)


def date_part(value):
    return value[:10] if value else ""


def time_frame(start, finish, today):
    if not start or not finish:
        return ""
    if today < start:
        return "future"
    if today > finish:
        return "past"
    return "current"


def flatten(node, today, level=0, parent_id=None, out=None):
    """深度優先展開樹狀結構。根節點（專案本身）也保留，level=0。"""
    if out is None:
        out = []
    attrs = node.get("attributes") or {}
    start, finish = date_part(attrs.get("startDate")), date_part(attrs.get("finishDate"))
    out.append({
        "id": node.get("id"),
        "identifier": node.get("identifier", ""),
        "name": node.get("name", ""),
        "iterationPath": to_iteration_path(node.get("path", "")),
        "level": level,
        "parentId": parent_id if parent_id is not None else "",
        "hasChildren": bool(node.get("children")),
        "startDate": start,
        "finishDate": finish,
        "timeFrame": time_frame(start, finish, today),
        "url": node.get("url", ""),
    })
    for child in node.get("children") or []:
        flatten(child, today, level + 1, node.get("id"), out)
    return out
