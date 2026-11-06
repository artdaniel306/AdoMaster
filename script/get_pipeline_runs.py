"""
取得指定 Pipeline 最近的 Run（含進行中 / 停等的 Run）。

用法:
  python get_pipeline_runs.py --pipeline crmapp-test
  python get_pipeline_runs.py --pipeline "Deploy\\crmapp-test" --top 50 --out D:\\runs.json

輸出（有指定 --out 時）:
  { pipeline: { id, name, path, webUrl },
    runs: [ { id, buildNumber, status, result, active, reason, sourceBranch, sourceVersion,
              requestedFor, queueTime, startTime, finishTime, webUrl } ],   # 新到舊
    fetchedAt }

PAT 需要 Build (Read) 權限。
進度訊息輸出在 stdout，錯誤訊息輸出在 stderr（exit code 1）。
設定沿用同層資料夾的 .env，只使用 Python 標準函式庫。
"""

import argparse
import datetime
import os

from ado.cli import run
from ado.config import get_config
from ado.output import write_json
from ado.pipelines import find_pipeline, list_runs


def main():
    parser = argparse.ArgumentParser(description="取得 Pipeline 最近的 Run")
    parser.add_argument("--pipeline", required=True, help="Pipeline 名稱（可帶資料夾：資料夾\\名稱）")
    parser.add_argument("--top", type=int, default=30, help="最多取幾筆 Run（預設 30）")
    parser.add_argument("--out", help="輸出 JSON 的路徑")
    args = parser.parse_args()

    cfg = get_config()
    pipeline = find_pipeline(cfg, args.pipeline)
    runs = list_runs(cfg, pipeline["id"], top=max(1, min(args.top, 200)))
    active = sum(r["active"] for r in runs)
    print(f"Pipeline {pipeline['name']}（#{pipeline['id']}）：取得 {len(runs)} 筆 Run，{active} 筆尚未結束", flush=True)
    if args.out:
        write_json(os.path.abspath(args.out), {
            "pipeline": pipeline,
            "runs": runs,
            "fetchedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        })


if __name__ == "__main__":
    run(main)
