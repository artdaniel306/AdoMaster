"""
Azure App Service 操作（Azure Resource Manager REST API，只使用標準函式庫）。

和 Azure DevOps 不同，這裡需要 Microsoft Entra ID（Azure AD）的 access token，不能用 AZDO_PAT。
token 取得方式（依序）：
  1. Service Principal：.env 有 AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET 時，
     走 OAuth 2.0 client credentials。該 SP 需要目標 App Service 的 Website Contributor（或 Contributor）角色。
  2. Azure CLI：否則執行 `az account get-access-token`（需先 `az login`）。

參考 API:
  - Web Apps - Restart / Restart Slot
      POST https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Web/sites/{name}[/slots/{slot}]/restart?softRestart=&synchronous=&api-version=2024-04-01
      https://learn.microsoft.com/en-us/rest/api/appservice/web-apps/restart
  - Microsoft identity platform client credentials flow
      https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow
"""

import shutil
import subprocess
import urllib.parse

from .client import http_request
from .config import ENV_PATH, Config, load_env
from .errors import AdoError

ARM_BASE = "https://management.azure.com"
ARM_SCOPE = f"{ARM_BASE}/.default"
ARM_API_VERSION = "2024-04-01"
LOGIN_BASE = "https://login.microsoftonline.com"


def get_azure_config(env_path=ENV_PATH):
    """讀取 Azure 設定（和 get_config 共用 script/.env，但不要求 AZDO_* 設定）。"""
    cfg = Config({}, load_env(env_path))
    sub = cfg.opt("AZURE_SUBSCRIPTION_ID")
    if not sub:
        raise AdoError("[錯誤] .env 缺少必要設定：AZURE_SUBSCRIPTION_ID")
    cfg.update({
        "subscription": sub,
        "tenant": cfg.opt("AZURE_TENANT_ID"),
        "client_id": cfg.opt("AZURE_CLIENT_ID"),
        "client_secret": cfg.opt("AZURE_CLIENT_SECRET"),
        "resource_group": cfg.opt("AZURE_RESOURCE_GROUP"),
    })
    return cfg


def _token_from_service_principal(cfg):
    url = f"{LOGIN_BASE}/{urllib.parse.quote(cfg['tenant'], safe='')}/oauth2/v2.0/token"
    form = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "scope": ARM_SCOPE,
    }).encode("ascii")
    data = http_request(url, {"Content-Type": "application/x-www-form-urlencoded"}, form)
    token = (data or {}).get("access_token")
    if not token:
        raise AdoError("[錯誤] Service Principal 取得 token 失敗：回應沒有 access_token")
    return token


def _token_from_azure_cli():
    az = shutil.which("az")  # Windows 上是 az.cmd，需要完整路徑才能用 subprocess 執行
    if not az:
        raise AdoError(
            "[錯誤] 無法取得 Azure token：.env 沒有設定 AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET，"
            "也找不到 Azure CLI（az）。請設定 Service Principal，或安裝 Azure CLI 後執行 az login。"
        )
    proc = subprocess.run(
        [az, "account", "get-access-token", "--scope", ARM_SCOPE, "--query", "accessToken", "-o", "tsv"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    token = proc.stdout.strip()
    if proc.returncode != 0 or not token:
        raise AdoError(f"[錯誤] az account get-access-token 失敗（是否已執行 az login？）\n{proc.stderr.strip()}")
    return token


def get_arm_token(cfg):
    """取得 Azure Resource Manager 的 access token。"""
    sp_keys = ("tenant", "client_id", "client_secret")
    if all(cfg.get(k) for k in sp_keys):
        return _token_from_service_principal(cfg)
    if any(cfg.get(k) for k in sp_keys):
        raise AdoError("[錯誤] AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET 需要三個都設定（或都不設定，改用 az login）")
    return _token_from_azure_cli()


def _site_url(cfg, resource_group, app, slot=None):
    q = lambda s: urllib.parse.quote(s, safe="")  # noqa: E731
    url = (
        f"{ARM_BASE}/subscriptions/{q(cfg['subscription'])}/resourceGroups/{q(resource_group)}"
        f"/providers/Microsoft.Web/sites/{q(app)}"
    )
    if slot:
        url += f"/slots/{q(slot)}"
    return url


def restart_app(cfg, app, resource_group=None, slot=None, soft=False, synchronous=False, token=None):
    """重啟 App Service（指定 slot 時只重啟該 deployment slot）。

    soft=True：只重新套用設定、必要時重啟 app，不重啟整個 worker process。
    synchronous=True：等 ARM 確認重啟完成才回應（較慢）。
    """
    resource_group = resource_group or cfg.get("resource_group")
    if not resource_group:
        raise AdoError("[錯誤] 未指定 Resource Group：請加 --resource-group，或在 .env 設定 AZURE_RESOURCE_GROUP")
    token = token or get_arm_token(cfg)
    params = urllib.parse.urlencode({
        "softRestart": str(bool(soft)).lower(),
        "synchronous": str(bool(synchronous)).lower(),
        "api-version": ARM_API_VERSION,
    })
    url = f"{_site_url(cfg, resource_group, app, slot)}/restart?{params}"
    try:
        http_request(url, {"Authorization": f"Bearer {token}"}, b"", method="POST")
    except AdoError as e:
        if "HTTP 403" in str(e):
            raise AdoError(f"{e}\n目前的身分沒有重啟權限：需要該 App Service 的 Website Contributor（或 Contributor）角色。") from None
        raise
    return {"app": app, "resourceGroup": resource_group, "slot": slot, "soft": bool(soft)}
