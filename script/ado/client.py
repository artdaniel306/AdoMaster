"""REST API 呼叫（Azure DevOps，以及共用的 http_request）。"""

import base64
import json
import urllib.error
import urllib.parse
import urllib.request

from .errors import AdoError


def _project_base(cfg):
    org = urllib.parse.quote(cfg["org"], safe="")
    project = urllib.parse.quote(cfg["project"], safe="")
    return f"{cfg['base_url']}/{org}/{project}"


def api_url(cfg, path, **params):
    params["api-version"] = cfg["api_version"]
    query = urllib.parse.urlencode(params)
    return f"{_project_base(cfg)}/_apis/{path}?{query}"


def web_url(cfg, item_id):
    """Work Item 在瀏覽器中的網址。"""
    return f"{_project_base(cfg)}/_workitems/edit/{item_id}"


def http_request(url, headers=None, data=None, method=None, not_json_hint=""):
    """送出 HTTP 請求並解析 JSON 回應；空 body（如 App Service restart 回 200 無內容）回傳 None。

    data 為已編碼的 bytes（Content-Type 由呼叫端放在 headers）；為 None 時送 GET，否則預設 POST。
    回應有內容但不是 JSON 時視為錯誤，not_json_hint 會附在錯誤訊息後面。
    """
    headers = {"Accept": "application/json", **(headers or {})}
    req = urllib.request.Request(
        url, data=data, method=method or ("GET" if data is None else "POST"), headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            if not body.strip():
                return None
            ctype = resp.headers.get("Content-Type", "")
            if "application/json" not in ctype:
                raise AdoError(f"[錯誤] 回應不是 JSON（HTTP {resp.status}, {ctype}）{not_json_hint}")
            return json.loads(body)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail)
            # ADO: {"message"}；ARM: {"error": {"code", "message"}}；Entra ID: {"error_description"}
            err = parsed.get("error")
            detail = (
                parsed.get("message")
                or (err.get("message") if isinstance(err, dict) else None)
                or parsed.get("error_description")
                or detail
            )
        except (ValueError, AttributeError):
            pass
        raise AdoError(f"[錯誤] HTTP {e.code} {e.reason}\nURL: {url}\n{detail}") from None
    except urllib.error.URLError as e:
        raise AdoError(f"[錯誤] 無法連線：{e.reason}\nURL: {url}") from None


def api_request(url, pat, payload=None, content_type="application/json", method=None):
    """Azure DevOps API：payload 為 None 時送 GET，否則以 JSON body 送 POST（可用 method 指定，如更新 Work Item 用 PATCH）。

    建立 / 更新 Work Item 時 content_type 需為 application/json-patch+json。
    """
    token = base64.b64encode(f":{pat}".encode("utf-8")).decode("ascii")
    headers = {"Authorization": f"Basic {token}"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = content_type
    # PAT 無效時 Azure DevOps 常回 203 + HTML 登入頁
    return http_request(
        url, headers, data, method,
        not_json_hint="，請確認 PAT 是否正確、是否過期，以及是否有 Work Items (Read) 權限。",
    )
