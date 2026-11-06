"""
取得指定 Iteration 底下的所有 Work Item（不限類型），輸出成 JSON，供 app 讀取顯示。

用法:
  python get_iteration_work_items.py --iteration "ART Project Build\\Walsin CRM ＷC\\Phase 2 Sprint 1"
  python get_iteration_work_items.py --iteration "..." --exact      # 不含子 Iteration
  python get_iteration_work_items.py --iteration "..." --out D:\\wi.json

輸出（預設）: data/work_items/iteration_work_items.json
  {
    "iterationPath": "...", "exact": false, "fetchedAt": "...", "count": N,
    "items": [ { id, type, title, state, assignedTo, ..., webUrl }, ... ]
  }

進度訊息輸出在 stdout，錯誤訊息輸出在 stderr（exit code 1）。
設定沿用同層資料夾的 .env，只使用 Python 標準函式庫。
"""

import argparse
import json
import os
import urllib.parse
from datetime import datetime

from get_tasks import SCRIPT_DIR, get_config, get_work_items, query_ids, to_row

DEFAULT_OUT = os.path.join(os.path.dirname(SCRIPT_DIR), "data", "work_items", "iteration_work_items.json")


def web_url(cfg, item_id):
    org = urllib.parse.quote(cfg["org"], safe="")
    project = urllib.parse.quote(cfg["project"], safe="")
    return f"{cfg['base_url']}/{org}/{project}/_workitems/edit/{item_id}"


def main():
    parser = argparse.ArgumentParser(description="取得指定 Iteration 的 Work Item 並輸出 JSON")
    parser.add_argument("--iteration", required=True, help="Iteration Path，如 \"MyProject\\Sprint 5\"")
    parser.add_argument("--exact", action="store_true", help="只取此 Iteration，不含子 Iteration")
    parser.add_argument("--out", default=DEFAULT_OUT, help=f"輸出 JSON 路徑（預設 {DEFAULT_OUT}）")
    args = parser.parse_args()

    cfg = get_config()
    query = argparse.Namespace(
        type=None, state=None, assigned_to=None, area=None, changed_since=None, top=None,
        iteration=args.iteration, iteration_exact=args.exact,
    )

    print(f"查詢 Iteration：{args.iteration}（{'不含' if args.exact else '含'}子 Iteration）", flush=True)
    ids = query_ids(cfg, query)
    print(f"共 {len(ids)} 筆", flush=True)

    items = sorted(get_work_items(cfg, ids), key=lambda x: x.get("id", 0)) if ids else []
    rows = []
    for item in items:
        row = to_row(item)
        row["webUrl"] = web_url(cfg, item.get("id"))
        rows.append(row)

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump({
            "iterationPath": args.iteration,
            "exact": args.exact,
            "fetchedAt": datetime.now().isoformat(timespec="seconds"),
            "count": len(rows),
            "items": rows,
        }, f, ensure_ascii=False, indent=2)
    print(f"完成，已輸出 {len(rows)} 筆至：{out}", flush=True)


if __name__ == "__main__":
    main()
