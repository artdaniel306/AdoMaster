class AdoError(Exception):
    """可預期的錯誤（設定缺漏、API 失敗等）。訊息會原樣顯示給使用者。"""
