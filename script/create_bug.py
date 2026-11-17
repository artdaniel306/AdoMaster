"""
在指定的 Requirement 底下建立 Bug（測試與檢核時「記錄問題」）：Area / Iteration 沿用 Requirement，
敘述與圖片組成 Repro Steps（圖片先上傳成附件再以 <img> 嵌入）。

用法:
  python create_bug.py --parent 12345 --title "標題" [--assigned-to dev@example.com]
                       [--repro "敘述" | --repro-file repro.txt] [--image a.png --image b.png] [--out bug.json]

--assigned-to 必須是 Requirement 底下某個 Task 的指派對象。

輸出（有指定 --out 時）: 新建 Bug 的 JSON（欄位同 get_requirement_flow.py 的 children）
  { id, type, title, state, ..., reproSteps, webUrl }

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
from ado.work_items import create_child_bug, to_row


def main():
    parser = argparse.ArgumentParser(description="在 Requirement 底下建立 Bug")
    parser.add_argument("--parent", required=True, type=int, help="父項目（Requirement）的 id")
    parser.add_argument("--title", required=True, help="Bug 標題")
    parser.add_argument("--assigned-to", default="", help="指派對象的 email（須為 Requirement 底下 Task 的指派對象）")
    repro = parser.add_mutually_exclusive_group()
    repro.add_argument("--repro", default="", help="Repro Steps 的敘述（純文字）")
    repro.add_argument("--repro-file", help="從 UTF-8 文字檔讀取 Repro Steps 的敘述")
    parser.add_argument("--image", action="append", default=[], help="要附在 Repro Steps 的圖片檔（可指定多次）")
    parser.add_argument("--out", help="把新建的 Bug 輸出成 JSON")
    args = parser.parse_args()

    text = args.repro
    if args.repro_file:
        try:
            with open(args.repro_file, encoding="utf-8-sig") as f:
                text = f.read()
        except OSError as e:
            raise AdoError(f"[錯誤] 無法讀取 Repro Steps 檔案：{e}") from None

    cfg = get_config()
    print(f"在 #{args.parent} 底下建立 Bug…", flush=True)
    item = create_child_bug(cfg, args.parent, args.title, text.strip(), args.image, args.assigned_to.strip())
    row = {**to_row(item), "webUrl": web_url(cfg, item["id"])}
    print(f"完成，已建立 Bug #{row['id']}：{row['title']}", flush=True)
    if args.out:
        write_json(os.path.abspath(args.out), row)


if __name__ == "__main__":
    run(main)
