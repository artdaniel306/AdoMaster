"""
重啟 Azure App Service（或其 deployment slot）。

用法:
  python restart_app_service.py --app my-app
  python restart_app_service.py --app my-app --resource-group my-rg --slot staging
  python restart_app_service.py --app my-app --soft --sync --out D:\\restart.json

設定（script/.env）:
  AZURE_SUBSCRIPTION_ID   必填
  AZURE_RESOURCE_GROUP    選填，沒加 --resource-group 時使用
  AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
                          選填，Service Principal；沒設定時改用 Azure CLI（需先 az login）

輸出（有指定 --out 時）: { app, resourceGroup, slot, soft }

進度訊息輸出在 stdout，錯誤訊息輸出在 stderr（exit code 1）。只使用 Python 標準函式庫。
"""

import argparse
import os

from ado.app_service import get_azure_config, restart_app
from ado.cli import run
from ado.output import write_json


def main():
    parser = argparse.ArgumentParser(description="重啟 Azure App Service")
    parser.add_argument("--app", required=True, help="App Service 名稱")
    parser.add_argument("--resource-group", help="Resource Group（預設為 .env 的 AZURE_RESOURCE_GROUP）")
    parser.add_argument("--slot", help="Deployment slot 名稱（不指定則重啟 production）")
    parser.add_argument("--soft", action="store_true", help="Soft restart：重新套用設定，不重啟整個 worker process")
    parser.add_argument("--sync", action="store_true", help="等重啟完成才結束")
    parser.add_argument("--out", help="把結果輸出成 JSON")
    args = parser.parse_args()

    cfg = get_azure_config()
    target = args.app + (f"（slot: {args.slot}）" if args.slot else "")
    print(f"重啟 App Service {target}…", flush=True)
    result = restart_app(cfg, args.app, args.resource_group, args.slot, soft=args.soft, synchronous=args.sync)
    print("完成" if args.sync else "已送出重啟要求", flush=True)
    if args.out:
        write_json(os.path.abspath(args.out), result)


if __name__ == "__main__":
    run(main)
