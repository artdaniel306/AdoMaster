"""
Azure DevOps 共用模組（只使用 Python 標準函式庫）。

  config      讀取 .env、組出連線設定
  client      REST API 呼叫（URL 組裝、認證、錯誤處理）
  work_items  WIQL 查詢、批次取得明細、轉成扁平資料列
  iterations  Iteration 樹狀結構取得與展開
  pipelines   Pipeline / Run 查詢（Build API）
  app_service Azure App Service 操作（ARM API，Entra ID token）
  output      CSV / JSON 寫檔
  cli         CLI 進入點包裝（AdoError → stderr + exit 1）

script/ 底下的 get_*.py 只負責解析參數與輸出，邏輯都放在這裡。
"""

from .errors import AdoError

__all__ = ["AdoError"]
