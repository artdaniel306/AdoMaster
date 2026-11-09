"""設定：路徑常數與 data/.env 讀取（同名環境變數優先）。"""

import os

from .errors import AdoError

SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # script/
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
# app（尤其安裝版）會以環境變數 ADOMASTER_DATA_DIR 指定 data 資料夾
DATA_DIR = os.environ.get("ADOMASTER_DATA_DIR") or os.path.join(ROOT_DIR, "data")
ENV_PATH = os.path.join(DATA_DIR, ".env")
# 舊位置：app 啟動時會自動搬到 data/.env；還沒搬之前單獨執行 CLI 時沿用
LEGACY_ENV_PATH = os.path.join(SCRIPT_DIR, ".env")


def load_env(path):
    """簡易 .env 解析：KEY=VALUE，支援 # 註解與引號。"""
    if path == ENV_PATH and not os.path.isfile(path) and os.path.isfile(LEGACY_ENV_PATH):
        path = LEGACY_ENV_PATH
    if not os.path.isfile(path):
        raise AdoError(f"[錯誤] 找不到設定檔：{path}（可在 App 的「設定 → 連線與機密設定…」填入，或複製 templates/env_example.txt 為 data/.env 後填入設定）")
    env = {}
    with open(path, encoding="utf-8-sig") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key.startswith("export "):
                key = key[len("export "):].strip()
            value = value.strip()
            if value[:1] not in ("'", '"'):  # 未加引號時，去除行尾 " # 註解"
                value = value.split(" #", 1)[0].strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            env[key] = value
    return env


class Config(dict):
    """連線設定。另外保留原始 env，讓各 CLI 讀取自己專用的選填設定（同名環境變數優先）。"""

    def __init__(self, values, env):
        super().__init__(values)
        self.env = env

    def opt(self, key, default=None):
        return os.environ.get(key) or self.env.get(key) or default


def get_config(env_path=ENV_PATH):
    env = load_env(env_path)

    def need(key):
        val = os.environ.get(key) or env.get(key)
        if not val:
            raise AdoError(f"[錯誤] .env 缺少必要設定：{key}（可在 App 的「設定 → 連線與機密設定…」填入）")
        return val

    def opt(key, default):
        return os.environ.get(key) or env.get(key) or default

    return Config({
        "base_url": opt("AZDO_BASE_URL", "https://dev.azure.com").rstrip("/"),
        "org": need("AZDO_ORG"),
        "project": need("AZDO_PROJECT"),
        "pat": need("AZDO_PAT"),
        "api_version": opt("AZDO_API_VERSION", "7.1"),
    }, env)
