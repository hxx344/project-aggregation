"""Fixed read-only Variational HTTP bridge. Credentials are read only from stdin."""
import base64
import json
import re
import sys
import urllib.error
import urllib.request

ORIGIN = "https://omni.variational.io"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36"
PATHS = {
    "/api/me": "GET",
    "/api/quotes/indicative": "POST",
    "/api/funding/v2?underlying=BZ&instrument_type=perpetual_rwa_future": "GET",
    "/api/funding/v2?underlying=CL&instrument_type=perpetual_rwa_future": "GET",
}
MAX_INPUT_BYTES = 32_768
MAX_BODY_BYTES = 2_000_000
RESPONSE_HEADERS = ("content-type", "x-omni-auth", "cf-mitigated")
COOKIE = re.compile(r"vr-token=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\Z")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_definition(value):
    if not isinstance(value, dict) or set(value) != {"url", "method", "headers", "body"}:
        raise ValueError()
    urls = {ORIGIN + path: method for path, method in PATHS.items()}
    if not isinstance(value["url"], str) or value["url"] not in urls:
        raise ValueError()
    method = urls[value["url"]]
    if value["method"] != method or not isinstance(value["headers"], dict):
        raise ValueError()
    headers = value["headers"]
    expected = {"Accept": "application/json", "User-Agent": USER_AGENT,
                "Cache-Control": "no-cache", "Referer": ORIGIN + "/"}
    if method == "POST":
        expected["Content-Type"] = "application/json"
    authenticated = value["url"] in {ORIGIN + "/api/me", ORIGIN + "/api/quotes/indicative"}
    if "Cookie" in headers:
        cookie = headers["Cookie"]
        if not authenticated or not isinstance(cookie, str) or len(cookie) > 8201 or COOKIE.fullmatch(cookie) is None:
            raise ValueError()
        expected["Cookie"] = cookie
    elif authenticated:
        raise ValueError()
    if headers != expected:
        raise ValueError()
    body = None
    if method == "POST":
        submitted = value["body"]
        if not isinstance(submitted, dict) or set(submitted) != {"instrument", "qty"} or submitted["qty"] != "1":
            raise ValueError()
        instrument = submitted["instrument"]
        if not isinstance(instrument, dict) or instrument.get("underlying") not in ("BZ", "CL"):
            raise ValueError()
        fixed = {"underlying": instrument["underlying"], "instrument_type": "perpetual_rwa_future",
                 "settlement_asset": "USDC", "kind": "commodity"}
        if instrument != fixed:
            raise ValueError()
        body = json.dumps({"instrument": fixed, "qty": "1"}, separators=(",", ":")).encode("utf-8")
    elif value["body"] is not None:
        raise ValueError()
    return urllib.request.Request(value["url"], data=body, headers=expected, method=method)


def fetch_response(value):
    request = request_definition(value)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        response = opener.open(request, timeout=8)
    except urllib.error.HTTPError as error:
        # Preserve status and selected headers for auth/challenge classification.
        # NoRedirect turns redirects into HTTPError; nothing follows Location.
        response = error
    with response:
        status = response.status
        if type(status) is not int or not 200 <= status <= 599:
            raise ValueError()
        body = response.read(MAX_BODY_BYTES + 1)
        if len(body) > MAX_BODY_BYTES:
            raise ValueError()
        headers = {}
        for name in RESPONSE_HEADERS:
            item = response.headers.get(name)
            if item is not None:
                if not isinstance(item, str) or len(item) > 1024 or any(ord(char) < 32 or ord(char) > 126 for char in item):
                    raise ValueError()
                headers[name] = item
        return {"status": status, "headers": headers, "body": base64.b64encode(body).decode("ascii")}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError()
        value = json.loads(raw, object_pairs_hook=unique_object)
        result = fetch_response(value)
        sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
        return 0
    except Exception:
        # Never print input, URLs, request headers, response bodies, or tracebacks.
        return 2


if __name__ == "__main__":
    sys.exit(main())
