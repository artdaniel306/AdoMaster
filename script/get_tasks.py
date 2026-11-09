"""
取得 Azure DevOps 專案中的 Task（Work Item），並輸出成 CSV（可選擇另存完整 JSON）。

用法:
  python get_tasks.py                                   # 取得專案內所有 Task
  python get_tasks.py 1201 1205 1300-1310               # 只取指定 ID（支援空白/逗號分隔與範圍）
  python get_tasks.py --state Active --assigned-to @Me  # 依狀態、指派對象篩選
  python get_tasks.py --iteration "MyProject\\Sprint 5"  # 依 Iteration（含子節點）篩選
  python get_tasks.py --changed-since 2026-10-01 --json # 依最後修改日篩選，並另存完整 JSON
  python get_tasks.py --type Bug                        # 改抓其他 Work Item Type

設定從 data/.env 讀取，見 templates/env_example.txt。
PAT 需有 Work Items (Read) 權限。
只使用 Python 標準函式庫，不需額外安裝套件。
"""

import argparse
import os
from datetime import datetime

from ado.cli import run
from ado.config import SCRIPT_DIR, get_config
from ado.errors import AdoError
from ado.output import write_csv, write_json
from ado.work_items import BATCH_SIZE, ROW_COLUMNS, get_work_items, query_ids, to_row


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
                raise AdoError(f"[錯誤] 無法解析的 ID：{part}") from None
    return sorted(i for i in ids if i > 0)


def resolve_path(path):
    return path if os.path.isabs(path) else os.path.join(SCRIPT_DIR, path)


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
            raise AdoError("[錯誤] --changed-since 格式須為 YYYY-MM-DD") from None

    cfg = get_config()
    print(f"組織：{cfg['org']}  專案：{cfg['project']}  類型：{args.type}")

    filters = dict(
        type=args.type, states=args.state, assigned_to=args.assigned_to,
        iteration=args.iteration, area=args.area, changed_since=args.changed_since,
    )
    ids = parse_ids(args.ids)
    print("1. 以 WIQL 查詢符合條件的 Work Item ID ...")
    # 指定 ID 時分批放進 WIQL，避免查詢字串過長
    found = []
    if ids:
        for start in range(0, len(ids), BATCH_SIZE):
            found.extend(query_ids(cfg, top=args.top, ids=ids[start:start + BATCH_SIZE], **filters))
        missing = sorted(set(ids) - set(found))
        if missing:
            print(f"   以下 ID 不存在、不是 {args.type} 或不符條件，已略過：{', '.join(map(str, missing))}")
    else:
        found = query_ids(cfg, top=args.top, **filters)
    print(f"   共 {len(found)} 筆")

    items = []
    if found:
        print("2. 取得 Work Item 明細 ...")
        items = get_work_items(cfg, found)

    output = args.output or cfg.opt("OUTPUT_CSV", f"tasks_{datetime.now():%Y%m%d_%H%M%S}.csv")
    out = write_csv(resolve_path(output), [to_row(i) for i in items], ROW_COLUMNS)
    print(f"完成，已輸出 {len(items)} 筆至：{out}")
    if args.json:
        jout = write_json(os.path.splitext(out)[0] + ".json", items)
        print(f"完整 JSON：{jout}")


if __name__ == "__main__":
    run(main)
