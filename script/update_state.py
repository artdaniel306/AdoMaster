"""
更新指定 Work Item 的狀態（System.State）。

用法:
  python update_state.py --id 12345 --state Active
  python update_state.py --id 12345 --state Resolved --out D:\\item.json

輸出（有指定 --out 時）: 更新後的 Work Item JSON（欄位同 get_requirement_flow.py 的 requirements，不含 children）
  { id, type, title, state, reason, ..., webUrl }

進度訊息輸出在 stdout，錯誤訊息輸出在 stderr（exit code 1）。
設定沿用同層資料夾的 .env，只使用 Python 標準函式庫。
"""

import argparse
import os

from ado.cli import run
from ado.client import web_url
from ado.config import get_config
from ado.output import write_json
from ado.work_items import close_child_tasks, to_row, update_state


def main():
    parser = argparse.ArgumentParser(description="更新 Work Item 的狀態")
    parser.add_argument("--id", required=True, type=int, help="Work Item id")
    parser.add_argument("--state", required=True, help="新狀態，如 Active / Resolved / Closed")
    parser.add_argument("--close-child-tasks", action="store_true",
                        help="先把子 Task 都改成 Closed（未 Closed / Removed 的）")
    parser.add_argument("--out", help="把更新後的 Work Item 輸出成 JSON")
    args = parser.parse_args()

    cfg = get_config()
    closed = []
    if args.close_child_tasks:
        print(f"關閉 #{args.id} 底下的子 Task…", flush=True)
        closed = [{**to_row(t), "webUrl": web_url(cfg, t["id"])} for t in close_child_tasks(cfg, args.id)]
        ids = "、".join(f"#{t['id']}" for t in closed)
        print(f"已關閉 {len(closed)} 個子 Task" + (f"：{ids}" if closed else ""), flush=True)
    print(f"更新 #{args.id} 的狀態為 {args.state}…", flush=True)
    item = update_state(cfg, args.id, args.state)
    row = {**to_row(item), "webUrl": web_url(cfg, item["id"])}
    if args.close_child_tasks:
        row["closedTasks"] = closed
    print(f"完成，#{row['id']} 目前狀態：{row['state']}（{row['reason']}）", flush=True)
    if args.out:
        write_json(os.path.abspath(args.out), row)


if __name__ == "__main__":
    run(main)
