"""
取得 Azure DevOps 專案中所有的 Iteration（Sprint），輸出到專案根目錄的 data/ 資料夾。

參考 API:
  - Classification Nodes - Get（取得 Iteration 樹狀結構，含起訖日）
      GET {base}/{org}/{project}/_apis/wit/classificationnodes/Iterations?$depth=20&api-version=7.1
      https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/classification-nodes/get?view=azure-devops-rest-7.1

輸出（預設檔名固定，每次執行會覆寫）:
  data/iterations.csv        扁平清單，Excel 可直接開啟
  data/iterations.json       扁平清單（JSON）
  data/iterations_tree.json  API 回傳的原始樹狀結構

用法:
  python get_iterations.py
  python get_iterations.py --out-dir D:\\somewhere   # 改輸出資料夾

csv 中的 iterationPath 與 Work Item 的 System.IterationPath 格式相同，
可直接給 get_tasks.py --iteration 使用。

設定沿用同層資料夾的 .env（AZDO_ORG / AZDO_PROJECT / AZDO_PAT ...）。
PAT 需有 Work Items (Read) 權限。
只使用 Python 標準函式庫，不需額外安裝套件。
"""

import argparse
import csv
import json
import os
from datetime import date, datetime

from get_tasks import SCRIPT_DIR, api_request, api_url, get_config

DEFAULT_OUT_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "data")
MAX_DEPTH = 20

CSV_COLUMNS = [
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


def write_outputs(out_dir, tree, rows):
    os.makedirs(out_dir, exist_ok=True)
    paths = {
        "csv": os.path.join(out_dir, "iterations.csv"),
        "json": os.path.join(out_dir, "iterations.json"),
        "tree": os.path.join(out_dir, "iterations_tree.json"),
    }
    # utf-8-sig：讓 Excel 直接開啟時中文不會亂碼
    with open(paths["csv"], "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    with open(paths["json"], "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    with open(paths["tree"], "w", encoding="utf-8") as f:
        json.dump(tree, f, ensure_ascii=False, indent=2)
    return paths


def main():
    parser = argparse.ArgumentParser(description="取得 Azure DevOps 所有 Iteration 並輸出到 data/")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR, help=f"輸出資料夾（預設 {DEFAULT_OUT_DIR}）")
    args = parser.parse_args()

    cfg = get_config()
    print(f"組織：{cfg['org']}  專案：{cfg['project']}")

    print("1. 取得 Iteration 樹狀結構 ...")
    tree = get_iteration_tree(cfg)
    rows = flatten(tree, date.today().isoformat())
    sprints = [r for r in rows if r["level"] > 0]
    print(f"   共 {len(sprints)} 個 Iteration（不含專案根節點）")

    current = [r["iterationPath"] for r in rows if r["timeFrame"] == "current"]
    if current:
        print(f"   目前進行中：{', '.join(current)}")

    print("2. 寫入檔案 ...")
    paths = write_outputs(os.path.abspath(args.out_dir), tree, rows)
    for p in paths.values():
        print(f"   {p}")
    print(f"完成（{datetime.now():%Y-%m-%d %H:%M:%S}）")


if __name__ == "__main__":
    main()
