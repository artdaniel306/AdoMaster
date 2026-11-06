"""
取得指定 Iteration 底下的 Requirement 及其子項目（Task / Bug…），輸出成 JSON，供 app 顯示 Requirement 流程階段。

子項目依父子關聯取得，即使子項目不在此 Iteration 也會一併取回。

用法:
  python get_requirement_flow.py --iteration "ART Project Build\\Walsin CRM ＷC\\WC Development 20261102~20261106"
  python get_requirement_flow.py --iteration "..." --exact      # 不含子 Iteration
  python get_requirement_flow.py --iteration "..." --type "User Story"
  python get_requirement_flow.py --iteration "..." --out D:\\flow.json

輸出（預設）: data/work_items/requirement_flow.json
  {
    "iterationPath": "...", "exact": false, "type": "Requirement", "fetchedAt": "...", "count": N,
    "requirements": [ { id, type, title, state, ..., webUrl, children: [ { id, type, title, state, ... } ] } ]
  }

進度訊息輸出在 stdout，錯誤訊息輸出在 stderr（exit code 1）。
設定沿用同層資料夾的 .env，只使用 Python 標準函式庫。
"""

import argparse
import os
from datetime import datetime

from ado.cli import run
from ado.client import web_url
from ado.config import DATA_DIR, get_config
from ado.output import write_json
from ado.work_items import child_ids, get_work_items, query_ids, to_row

DEFAULT_OUT = os.path.join(DATA_DIR, "work_items", "requirement_flow.json")
DEFAULT_TYPE = "Requirement"


def main():
    parser = argparse.ArgumentParser(description="取得指定 Iteration 的 Requirement 與其子項目並輸出 JSON")
    parser.add_argument("--iteration", required=True, help="Iteration Path，如 \"MyProject\\Sprint 5\"")
    parser.add_argument("--exact", action="store_true", help="只取此 Iteration，不含子 Iteration")
    parser.add_argument("--type", default=DEFAULT_TYPE, help=f"需求的 Work Item Type（預設 {DEFAULT_TYPE}）")
    parser.add_argument("--out", default=DEFAULT_OUT, help=f"輸出 JSON 路徑（預設 {DEFAULT_OUT}）")
    args = parser.parse_args()

    cfg = get_config()

    print(f"查詢 Iteration：{args.iteration}（{'不含' if args.exact else '含'}子 Iteration）的 {args.type}", flush=True)
    ids = query_ids(cfg, type=args.type, iteration=args.iteration, iteration_exact=args.exact)
    print(f"共 {len(ids)} 筆 {args.type}", flush=True)
    reqs = get_work_items(cfg, ids, relations=True) if ids else []

    kids_of = {r["id"]: child_ids(r) for r in reqs}
    all_kids = sorted({k for ks in kids_of.values() for k in ks})
    print(f"取得子項目 {len(all_kids)} 筆", flush=True)
    kid_rows = {}
    for item in get_work_items(cfg, all_kids) if all_kids else []:
        kid_rows[item["id"]] = {**to_row(item), "webUrl": web_url(cfg, item["id"])}

    rows = []
    for r in reqs:
        row = {**to_row(r), "webUrl": web_url(cfg, r["id"])}
        row["children"] = [kid_rows[k] for k in sorted(kids_of[r["id"]]) if k in kid_rows]
        rows.append(row)

    out = write_json(os.path.abspath(args.out), {
        "iterationPath": args.iteration,
        "exact": args.exact,
        "type": args.type,
        "fetchedAt": datetime.now().isoformat(timespec="seconds"),
        "count": len(rows),
        "requirements": rows,
    })
    print(f"完成，已輸出 {len(rows)} 筆至：{out}", flush=True)


if __name__ == "__main__":
    run(main)
