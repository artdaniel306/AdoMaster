"""
在 Work Item 留言 @ 指派的開發人員，提醒開發完成後附上 repository 中對應的 commit。

用法:
  python remind_commit.py --id 12345 [--out result.json]

輸出（有指定 --out 時）:
  { id, webUrl, commentId, assignee: { email, displayName } }
（提醒紀錄由 app 記在 data/reminders.json，這支腳本只負責留言）

進度訊息輸出在 stdout，錯誤訊息輸出在 stderr（exit code 1）。
設定沿用 data/.env，只使用 Python 標準函式庫。需要 PAT 的 Work Items (Read & Write) 權限。
"""

import argparse
import os

from ado.cli import run
from ado.client import web_url
from ado.config import get_config
from ado.errors import AdoError
from ado.output import write_json
from ado.work_items import add_comment, get_work_items, mention_html

# 留言內容是 HTML（mention 是 <a> 標籤），換行用 <br>
MESSAGE = (
    "嗨 {mention}, 請記得在開發完成後附上 repository 中對應的 commit。<br>"
    "如果 crmapp 中有 migration 也請特別註記下來。"
)


def main():
    parser = argparse.ArgumentParser(description="留言提醒開發人員附上 commit")
    parser.add_argument("--id", required=True, type=int, help="Work Item id")
    parser.add_argument("--out", help="把結果輸出成 JSON")
    args = parser.parse_args()

    cfg = get_config()
    print(f"取得 #{args.id} 的指派對象…", flush=True)
    found = get_work_items(cfg, [args.id])
    if not found:
        raise AdoError(f"[錯誤] 找不到 Work Item #{args.id}（或沒有權限）")
    assignee = found[0].get("fields", {}).get("System.AssignedTo")
    if not isinstance(assignee, dict) or not assignee.get("uniqueName"):
        raise AdoError(f"[錯誤] Work Item #{args.id} 沒有指派對象，無法提醒")

    print(f"留言提醒 {assignee.get('displayName')}…", flush=True)
    comment = add_comment(cfg, args.id, MESSAGE.format(mention=mention_html(assignee)))
    result = {
        "id": args.id,
        "webUrl": web_url(cfg, args.id),
        "commentId": (comment or {}).get("id"),
        "assignee": {"email": assignee["uniqueName"], "displayName": assignee.get("displayName", "")},
    }
    print(f"完成，留言 id：{result['commentId']}", flush=True)
    if args.out:
        write_json(os.path.abspath(args.out), result)


if __name__ == "__main__":
    run(main)
