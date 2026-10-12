"""One fixed read-only request using Var Grid's standard-library HTTP client.

The only credential input is stdin. Never print upstream bodies or exception text.
"""
import json
import hashlib
from datetime import datetime, timezone
import math
import re
import socket
import sys
import time
import urllib.error
import urllib.request

TARGETS = {
    "diagnose-session": ("session", "/api/me"),
    "diagnose-portfolio": ("portfolio", "/api/portfolio?compute_margin=true"),
    "sync-portfolio": ("portfolio", "/api/portfolio?compute_margin=true"),
    "sync-positions": ("portfolio", "/api/positions"),
}
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36"
MAX_BYTES = 2 * 1024 * 1024
MAX_INPUT_BYTES = 8192


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def content_kind(value):
    mime = (value or "").split(";", 1)[0].strip().lower()
    if not mime:
        return "missing"
    if mime == "application/json" or re.fullmatch(r"application/[a-z0-9.+-]+\+json", mime):
        return "json"
    if mime in ("text/html", "application/xhtml+xml"):
        return "html"
    return "other"


def valid_token(value):
    return isinstance(value, str) and 5 <= len(value) <= 4096 and re.fullmatch(r"[A-Za-z0-9._~-]+", value) is not None


def valid_balance(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return False
    if isinstance(value, str) and (len(value) > 128 or re.fullmatch(r"-?[0-9]+(?:\.[0-9]+)?", value) is None):
        return False
    try:
        number = float(value)
        return math.isfinite(number) and not (isinstance(value, str) and number == 0 and re.search(r"[1-9]", value))
    except (ValueError, OverflowError):
        return False


def position_decimal(value, optional=False):
    if optional and value in (None, ""):
        return None
    if not isinstance(value, str) or len(value) > 128 or re.fullmatch(r"-?[0-9]+(?:\.[0-9]+)?", value) is None:
        raise ValueError("Invalid position")
    return value


def position_text(value):
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9_.:/ -]{1,128}", value) is None:
        raise ValueError("Invalid position")
    return value


def normalize_positions(data):
    # The current Omni frontend reads GET /api/positions as an array. It uses
    # position_info, price_info.price, value, upnl and estimated_liquidation_price.
    # Unknown shapes (including paginated objects) fail, never imply flat holdings.
    source = data
    if not isinstance(source, list) or len(source) > 1000:
        raise ValueError("Invalid position")
    result, ids = [], set()
    for row in source:
        if not isinstance(row, dict) or not isinstance(row.get("position_info"), dict):
            raise ValueError("Invalid position")
        info = row["position_info"]
        quantity = position_decimal(info.get("qty"))
        if not re.search(r"[1-9]", quantity):
            continue
        instrument = info.get("instrument")
        if not isinstance(instrument, dict) or instrument.get("instrument_type") not in ("perpetual_future", "perpetual_rwa_future", "perpetual_cfd", "swap"):
            raise ValueError("Invalid position")
        underlying = position_text(instrument.get("underlying"))
        currency = position_text(instrument.get("settlement_asset"))
        instrument_id = hashlib.sha256(json.dumps(instrument, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        identity = [instrument, info.get("pool_location"), info.get("counterparty"), info.get("company")]
        position_id = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        if position_id in ids:
            raise ValueError("Invalid position")
        ids.add(position_id)
        price_info = row.get("price_info")
        if price_info is not None and not isinstance(price_info, dict):
            raise ValueError("Invalid position")
        updated = info.get("updated_at")
        if updated is not None:
            if not isinstance(updated, str):
                raise ValueError("Invalid position")
            parsed = datetime.fromisoformat(updated.replace("Z", "+00:00"))
            if parsed.tzinfo is None or parsed.timestamp() <= 0 or parsed.timestamp() > time.time() + 60:
                raise ValueError("Invalid position")
            updated = parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        result.append({"id": position_id, "symbol": underlying, "instrumentId": instrument_id,
                       "side": "short" if quantity.startswith("-") else "long", "quantity": quantity.lstrip("-"),
                       "quantityUnit": underlying, "contractSize": "1",
                       "entryPrice": position_decimal(info.get("avg_entry_price"), True),
                       "markPrice": position_decimal((price_info or {}).get("price"), True),
                       "notional": position_decimal(row.get("value"), True).lstrip("-") if row.get("value") not in (None, "") else None,
                       "unrealizedPnl": position_decimal(row.get("upnl"), True),
                       "leverage": None, "liquidationPrice": position_decimal(row.get("estimated_liquidation_price"), True),
                       "priceCurrency": currency, "notionalCurrency": currency, "pnlCurrency": currency,
                       "marginMode": None, "sourceUpdatedAt": updated})
    return result


def probe(token, opener=None, operation="diagnose-session"):
    if not valid_token(token) or not isinstance(operation, str) or operation not in TARGETS:
        raise ValueError("Invalid diagnostic input")
    endpoint, path = TARGETS[operation]
    started = time.monotonic()
    result = {"endpoint": endpoint, "path": path, "status": None,
              "contentType": None, "challenge": False, "elapsedMs": 0,
              "structureOk": None, "outcome": "network_error"}
    if operation == "sync-portfolio":
        result["balance"] = None
    if operation == "sync-positions":
        result["positions"] = None
    response = None
    try:
        # Match Grid's Client.request login path, including its three headers.
        request = urllib.request.Request("https://omni.variational.io" + path, headers={
            "Cookie": "vr-token=" + token, "User-Agent": USER_AGENT, "Accept": "application/json",
        }, method="GET")
        client = opener if opener is not None else urllib.request.build_opener(NoRedirect())
        try:
            response = client.open(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        status = response.getcode()
        result["status"] = status if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599 else None
        result["contentType"] = content_kind(response.headers.get("Content-Type"))
        result["challenge"] = response.headers.get("cf-mitigated", "").strip().lower() == "challenge"
        if result["challenge"]:
            result["outcome"] = "challenge"
        elif isinstance(status, int) and 300 <= status < 400:
            result["outcome"] = "redirect"
        elif status in (401, 403, 429):
            result["outcome"] = {401: "unauthorized", 403: "forbidden", 429: "rate_limited"}[status]
        elif not isinstance(status, int) or not 200 <= status < 300:
            result["outcome"] = "network_error"
        elif result["contentType"] == "html":
            result["outcome"] = "html"
        elif result["contentType"] != "json":
            result["outcome"] = "invalid_data"
        else:
            length = response.headers.get("Content-Length")
            if length and length.isdecimal() and int(length) > MAX_BYTES:
                raise ValueError("Invalid diagnostic response")
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise ValueError("Invalid diagnostic response")
            data = json.loads(body)
            if endpoint == "session":
                returned_token = data.get("token") if isinstance(data, dict) else None
                # Attest only to structure, never to authentication or token validity.
                result["structureOk"] = isinstance(returned_token, str) and 0 < len(returned_token) <= 32768
            elif operation == "sync-positions":
                result["positions"] = normalize_positions(data)
                result["structureOk"] = True
            else:
                balance = data.get("balance") if isinstance(data, dict) else None
                result["structureOk"] = bool(valid_balance(balance))
                if operation == "sync-portfolio" and result["structureOk"]:
                    result["balance"] = balance
            result["outcome"] = "ok" if result["structureOk"] else "invalid_data"
    except (socket.timeout, TimeoutError):
        result["outcome"] = "timeout"
    except urllib.error.URLError as error:
        result["outcome"] = "timeout" if isinstance(error.reason, (socket.timeout, TimeoutError)) else "network_error"
    except (ValueError, UnicodeError, RecursionError):
        result["structureOk"] = False
        result["outcome"] = "invalid_data"
    except Exception:
        result["outcome"] = "network_error"
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass
        result["elapsedMs"] = max(0, round((time.monotonic() - started) * 1000))
    return result


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            return 2
        value = json.loads(raw)
        if (not isinstance(value, dict) or set(value) != {"vrToken", "operation"}
                or not valid_token(value["vrToken"]) or not isinstance(value["operation"], str)
                or value["operation"] not in TARGETS):
            return 2
        result = probe(value["vrToken"], operation=value["operation"])
        sys.stdout.write(json.dumps(result, separators=(",", ":"), allow_nan=False) + "\n")
        return 0
    except Exception:
        return 2


if __name__ == "__main__":
    sys.exit(main())
