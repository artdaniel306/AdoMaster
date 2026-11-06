"""設定：路徑常數與 .env 讀取。"""

import os

from .errors import AdoError

SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # script/
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(ROOT_DIR, "data")
ENV_PATH = os.path.join(SCRIPT_DIR, ".env")


def load_env(path):
    """簡易 .env 解析：KEY=VALUE，支援 # 註解與引號。"""
    if not os.path.isfile(path):
        raise AdoError(f"[錯誤] 找不到設定檔：{path}（可複製 env_example.txt 為 .env 後填入設定）")
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
    """連線設定。另外保留原始 env，讓各 CLI 讀取自己專用的選填設定。"""

    def __init__(self, values, env):
        super().__init__(values)
        self.env = env

    def opt(self, key, default=None):
        return self.env.get(key) or os.environ.get(key) or default


def get_config(env_path=ENV_PATH):
    env = load_env(env_path)

    def need(key):
        val = env.get(key) or os.environ.get(key)
        if not val:
            raise AdoError(f"[錯誤] .env 缺少必要設定：{key}")
        return val

    def opt(key, default):
        return env.get(key) or os.environ.get(key) or default

    return Config({
        "base_url": opt("AZDO_BASE_URL", "https://dev.azure.com").rstrip("/"),
        "org": need("AZDO_ORG"),
        "project": need("AZDO_PROJECT"),
        "pat": need("AZDO_PAT"),
        "api_version": opt("AZDO_API_VERSION", "7.1"),
    }, env)
