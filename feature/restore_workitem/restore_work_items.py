"""
依 ID 還原 Azure DevOps 回收筒 (Recycle Bin) 中被刪除的 Work Items。

參考 API:
  - Restore Work Item
      PATCH {base}/{org}/{project}/_apis/wit/recyclebin/{id}?api-version=7.1
      Body: {"isDeleted": false}
  https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/recyclebin/restore-work-item?view=azure-devops-rest-7.1

用法:
  python restore_work_items.py 31 32 40-45          # 直接指定 ID（支援空白/逗號分隔與範圍）
  python restore_work_items.py --csv deleted.csv    # 從 get_deleted_work_items.py 輸出的 CSV 讀取 id 欄位
  python restore_work_items.py                      # 互動輸入 ID
  加上 -y / --yes 可略過確認。

設定沿用同層資料夾的 .env（AZDO_ORG / AZDO_PROJECT / AZDO_PAT ...）。
PAT 需有 Work Items (Read & Write) 權限。
只使用 Python 標準函式庫，不需額外安裝套件。
"""

import argparse
import base64
import csv
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

from get_deleted_work_items import SCRIPT_DIR, get_config, get_deleted_items


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
                sys.exit(f"[錯誤] 無法解析的 ID：{part}")
    return sorted(i for i in ids if i > 0)


def read_ids_from_csv(path):
    if not os.path.isabs(path) and not os.path.isfile(path):
        path = os.path.join(SCRIPT_DIR, path)
    if not os.path.isfile(path):
        sys.exit(f"[錯誤] 找不到 CSV：{path}")
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if "id" not in (reader.fieldnames or []):
            sys.exit("[錯誤] CSV 缺少 id 欄位")
        return parse_ids([row["id"] for row in reader if row.get("id")])


def restore_url(cfg, work_item_id):
    org = urllib.parse.quote(cfg["org"], safe="")
    project = urllib.parse.quote(cfg["project"], safe="")
    query = urllib.parse.urlencode({"api-version": cfg["api_version"]})
    return f"{cfg['base_url']}/{org}/{project}/_apis/wit/recyclebin/{work_item_id}?{query}"


def restore_work_item(cfg, work_item_id):
    """還原單一 Work Item，回傳 (成功與否, 訊息)。失敗不中斷，交由呼叫端彙整。"""
    token = base64.b64encode(f":{cfg['pat']}".encode("utf-8")).decode("ascii")
    req = urllib.request.Request(
        restore_url(cfg, work_item_id),
        data=json.dumps({"isDeleted": False}).encode("utf-8"),
        method="PATCH",
        headers={
            "Authorization": f"Basic {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            ctype = resp.headers.get("Content-Type", "")
            if "application/json" not in ctype:
                return False, (
                    f"回應不是 JSON（HTTP {resp.status}, {ctype}），"
                    "請確認 PAT 是否正確、是否過期，以及是否有 Work Items (Read & Write) 權限。"
                )
            data = json.loads(resp.read().decode("utf-8"))
            title = data.get("name") or data.get("resource", {}).get("fields", {}).get("System.Title", "")
            return True, f"[{data.get('type', '')}] {title}"
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(detail).get("message", detail)
        except ValueError:
            pass
        return False, f"HTTP {e.code} {e.reason}：{detail}"
    except urllib.error.URLError as e:
        return False, f"無法連線：{e.reason}"


def main():
    parser = argparse.ArgumentParser(description="依 ID 還原 Azure DevOps 回收筒中的 Work Items")
    parser.add_argument("ids", nargs="*", help="Work Item ID，可用空白或逗號分隔，支援範圍如 40-45")
    parser.add_argument("--csv", help="從 CSV 的 id 欄位讀取要還原的 ID")
    parser.add_argument("-y", "--yes", action="store_true", help="略過確認直接還原")
    args = parser.parse_args()

    ids = parse_ids(args.ids)
    if args.csv:
        ids = sorted(set(ids) | set(read_ids_from_csv(args.csv)))
    if not ids:
        ids = parse_ids([input("請輸入要還原的 Work Item ID（逗號/空白分隔，可用範圍如 40-45）：")])
    if not ids:
        sys.exit("[錯誤] 未提供任何 ID")

    cfg = get_config()
    print(f"組織：{cfg['org']}  專案：{cfg['project']}")

    # 先查回收筒確認這些 ID 的資訊，方便使用者確認
    print("查詢回收筒中的項目 ...")
    try:
        items = get_deleted_items(cfg, ids)
    except SystemExit as e:  # 查詢失敗（例如部分 ID 不在回收筒）不阻擋還原
        print(f"  （無法取得明細，略過預覽）{e}")
        items = []
    found = {item["id"]: item for item in items
             if item.get("id") and item.get("code", 200) == 200}
    print()
    for i in ids:
        item = found.get(i)
        if item:
            print(f"  {i:>7}  [{item.get('type', '')}] {item.get('name', '')}"
                  f"  (刪除者：{item.get('deletedBy', '')}，{item.get('deletedDate', '')})")
        else:
            print(f"  {i:>7}  （回收筒中查無此項目，仍會嘗試還原）")
    print()

    if not args.yes:
        answer = input(f"確定要還原以上 {len(ids)} 筆 Work Item？[y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            sys.exit("已取消")

    ok, failed = 0, []
    for i in ids:
        success, msg = restore_work_item(cfg, i)
        if success:
            ok += 1
            print(f"  [成功] {i} {msg}")
        else:
            failed.append(i)
            print(f"  [失敗] {i} {msg}")

    print(f"\n完成：成功 {ok} 筆，失敗 {len(failed)} 筆")
    if failed:
        print(f"失敗 ID：{', '.join(map(str, failed))}")
        sys.exit(1)


if __name__ == "__main__":
    main()
