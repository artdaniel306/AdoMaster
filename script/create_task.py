"""
在指定的 Requirement 底下建立一個預設 Task：標題與 Requirement 相同，Area / Iteration 沿用 Requirement。

用法:
  python create_task.py --parent 12345
  python create_task.py --parent 12345 --description "說明文字"
  python create_task.py --parent 12345 --description-file desc.txt --out D:\\task.json

輸出（有指定 --out 時）: 新建 Task 的 JSON（欄位同 get_requirement_flow.py 的 children）
  { id, type, title, state, ..., webUrl }

進度訊息輸出在 stdout，錯誤訊息輸出在 stderr（exit code 1）。
設定沿用同層資料夾的 .env，只使用 Python 標準函式庫。
"""

import argparse
import os

from ado.cli import run
from ado.client import web_url
from ado.config import get_config
from ado.errors import AdoError
from ado.output import write_json
from ado.work_items import create_child_task, to_row


def main():
    parser = argparse.ArgumentParser(description="在 Requirement 底下建立與其同名的預設 Task")
    parser.add_argument("--parent", required=True, type=int, help="父項目（Requirement）的 id")
    parser.add_argument("--type", default="Task", help="要建立的 Work Item Type（預設 Task）")
    desc = parser.add_mutually_exclusive_group()
    desc.add_argument("--description", default="", help="Task 的 Description（純文字）")
    desc.add_argument("--description-file", help="從 UTF-8 文字檔讀取 Description")
    parser.add_argument("--out", help="把新建的 Task 輸出成 JSON")
    args = parser.parse_args()

    description = args.description
    if args.description_file:
        try:
            with open(args.description_file, encoding="utf-8-sig") as f:
                description = f.read()
        except OSError as e:
            raise AdoError(f"[錯誤] 無法讀取 Description 檔案：{e}") from None
    description = description.strip()

    cfg = get_config()
    print(f"在 #{args.parent} 底下建立 {args.type}…", flush=True)
    item = create_child_task(cfg, args.parent, description, type=args.type)
    row = {**to_row(item), "webUrl": web_url(cfg, item["id"])}
    print(f"完成，已建立 {row['type']} #{row['id']}：{row['title']}", flush=True)
    if args.out:
        write_json(os.path.abspath(args.out), row)


if __name__ == "__main__":
    run(main)
