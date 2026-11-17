"""
取得指定 Work Item 最新的幾筆留言（Discussion）。

用法:
  python get_comments.py --id 12345
  python get_comments.py --id 12345 --top 3 --out D:\comments.json

輸出（有指定 --out 時）:
  { id, totalCount, comments: [{ id, text, createdBy, createdDate, modifiedDate }] }（comments 新 → 舊）

進度訊息輸出在 stdout，錯誤訊息輸出在 stderr（exit code 1）。
設定沿用 data/.env，只使用 Python 標準函式庫。
"""

import argparse
import os

from ado.cli import run
from ado.config import get_config
from ado.output import write_json
from ado.work_items import get_comments


def main():
    parser = argparse.ArgumentParser(description="取得 Work Item 最新的留言")
    parser.add_argument("--id", required=True, type=int, help="Work Item id")
    parser.add_argument("--top", type=int, default=3, help="取幾筆（預設 3）")
    parser.add_argument("--out", help="把結果輸出成 JSON")
    args = parser.parse_args()

    cfg = get_config()
    print(f"取得 #{args.id} 最新 {args.top} 筆留言…", flush=True)
    result = {"id": args.id, **get_comments(cfg, args.id, args.top)}
    print(f"完成，共 {result['totalCount']} 則留言", flush=True)
    if args.out:
        write_json(os.path.abspath(args.out), result)
    else:
        for c in result["comments"]:
            print(f"\n[{c['createdDate']}] {c['createdBy']}\n{c['text']}")


if __name__ == "__main__":
    run(main)
