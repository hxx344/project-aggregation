"""Smoke-only wrapper: run the real helper with an offline urllib opener."""
import importlib.util
import io
import json
from pathlib import Path
import socket
import ssl
import sys
import urllib.error
from email.message import Message


def main():
    if len(sys.argv) != 3:
        return 2
    helper_path, fixture_path = (Path(value).resolve() for value in sys.argv[1:])
    assert helper_path.name == "variational-diagnostic.py" and helper_path.is_file()
    assert fixture_path.name == "variational-fixture.json"
    assert ssl.OPENSSL_VERSION

    def block_network(*_args, **_kwargs):
        raise AssertionError("Smoke helper must not open a network connection")

    socket.socket.connect = block_network
    socket.socket.connect_ex = block_network
    spec = importlib.util.spec_from_file_location("production_variational_diagnostic", helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)

    raw = sys.stdin.buffer.read(8193)
    assert len(raw) <= 8192
    supplied = json.loads(raw)
    assert isinstance(supplied, dict) and set(supplied) == {"vrToken", "operation"}
    operation = supplied["operation"]
    assert operation in ("diagnose-session", "diagnose-portfolio", "sync-portfolio")
    sys.stdin = io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8")
    session = operation == "diagnose-session"
    path = "/api/me" if session else "/api/portfolio?compute_margin=true"
    requests = 0

    class Response(io.BytesIO):
        def __init__(self, status, headers, body):
            super().__init__(body)
            self.status, self.headers = status, headers

        def getcode(self):
            return self.status

    class Opener:
        def open(self, request, timeout):
            nonlocal requests
            requests += 1
            assert requests == 1, "Each Python operation makes exactly one fixed GET"
            assert request.full_url == "https://omni.variational.io" + path
            assert request.get_method() == "GET" and request.data is None and timeout == 20
            headers = {key.lower(): value for key, value in request.header_items()}
            cookie = headers.get("cookie")
            assert cookie in ("vr-token=synthetic-var-token", "vr-token=synthetic-var-token-replacement")
            assert headers == {
                "cookie": cookie,
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
                "accept": "application/json",
            }
            fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
            diagnostic = operation.startswith("diagnose-")
            assert diagnostic == (fixture.get("diagnosticOnly") is True)
            # Separate writers: Windows append streams do not serialize independent processes.
            filename = "variational-" + operation + "-requests.jsonl" if diagnostic else "variational-sync-requests.jsonl"
            record = {"client": "grid-python", "path": path}
            if not diagnostic:
                record["operation"] = operation
            with fixture_path.with_name(filename).open("a", encoding="utf-8") as log:
                log.write(json.dumps(record) + "\n")
            value = fixture.get("pythonSession", fixture.get("session", {})) if session else fixture.get("pythonPortfolio", fixture)
            status = value.get("status", 503 if value.get("failure") is True else value.get("failure") or 200)
            response_headers = Message()
            response_headers["Set-Cookie"] = "vr-token=synthetic-var-returned-token"
            if value.get("challenge") or value.get("html"):
                response_headers["Content-Type"] = "text/html; charset=utf-8"
                if value.get("challenge"):
                    response_headers["cf-mitigated"] = "challenge"
                body = b"<p>PRIVATE_DIAGNOSTIC_ACCOUNT</p>"
            else:
                response_headers["Content-Type"] = "application/json"
                if session:
                    payload = value.get("payload", {"token": "synthetic-var-returned-token", "account": "PRIVATE_DIAGNOSTIC_ACCOUNT"})
                else:
                    payload = value.get("portfolio", {"balance": value.get("balance", "125"), "upnl": "9000", "margin": "8000",
                        "sub_accounts": [{"balance": "7000"}], "token": "synthetic-var-returned-token", "account": "PRIVATE_DIAGNOSTIC_ACCOUNT"})
                body = json.dumps(payload).encode()
            response = Response(status, response_headers, body)
            if status >= 400 or 300 <= status < 400:
                raise urllib.error.HTTPError(request.full_url, status, "synthetic", response_headers, response)
            return response

    def build_opener(*handlers):
        assert len(handlers) == 1 and isinstance(handlers[0], helper.NoRedirect)
        return Opener()

    helper.urllib.request.build_opener = build_opener
    return helper.main()


if __name__ == "__main__":
    sys.exit(main())
