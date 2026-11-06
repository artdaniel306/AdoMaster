"""CLI 共用：統一錯誤處理。"""

import sys

from .errors import AdoError


def run(main):
    """執行 main()；AdoError 的訊息輸出到 stderr 並以 exit code 1 結束。"""
    try:
        main()
    except AdoError as e:
        sys.exit(str(e))
