"""
取得 Azure DevOps 專案中所有的 Iteration（Sprint），輸出到專案根目錄的 data/ 資料夾。

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
import os
from datetime import date, datetime

from ado.cli import run
from ado.config import DATA_DIR, get_config
from ado.iterations import ROW_COLUMNS, flatten, get_iteration_tree
from ado.output import write_csv, write_json


def write_outputs(out_dir, tree, rows):
    return {
        "csv": write_csv(os.path.join(out_dir, "iterations.csv"), rows, ROW_COLUMNS),
        "json": write_json(os.path.join(out_dir, "iterations.json"), rows),
        "tree": write_json(os.path.join(out_dir, "iterations_tree.json"), tree),
    }


def main():
    parser = argparse.ArgumentParser(description="取得 Azure DevOps 所有 Iteration 並輸出到 data/")
    parser.add_argument("--out-dir", default=DATA_DIR, help=f"輸出資料夾（預設 {DATA_DIR}）")
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
    run(main)
