"""Offline checks for the shipped Python helper; no real credentials or hosts."""
import contextlib
from email.message import Message
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import socket
import ssl
import sys
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

HELPER = Path(__file__).resolve().parents[1] / "scripts" / "variational-diagnostic.py"
SPEC = importlib.util.spec_from_file_location("variational_diagnostic", HELPER)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)
TOKEN = "synthetic.python.input"
RETURNED = "synthetic.python.returned"
PRIVATE = "PRIVATE_RESPONSE " + TOKEN
RESULT_KEYS = {"endpoint", "path", "status", "contentType", "challenge", "elapsedMs", "structureOk", "outcome"}
SESSION_URL = "https://omni.variational.io/api/me"
PORTFOLIO_PATH = "/api/portfolio?compute_margin=true"
OPERATIONS = ("diagnose-session", "diagnose-portfolio", "sync-portfolio")


def headers(values=None):
    result = Message()
    for key, value in ({"Content-Type": "application/json"} if values is None else values).items():
        result[key] = str(value)
    return result


class Response(io.BytesIO):
    def __init__(self, body=None, status=200, fields=None, reject_read=False):
        raw = json.dumps({"token": RETURNED, "account": PRIVATE}).encode() if body is None else body
        super().__init__(raw)
        self.status, self.headers = status, headers(fields)
        self.read_sizes, self.reject_read, self.was_closed = [], reject_read, False

    def getcode(self):
        return self.status

    def read(self, size=-1):
        self.read_sizes.append(size)
        if self.reject_read:
            raise AssertionError("Rejected response body was read")
        return super().read(size)

    def close(self):
        self.was_closed = True
        super().close()


class Opener:
    def __init__(self, response=None, error=None):
        self.response, self.error, self.calls = response, error, []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        if self.error is not None:
            raise self.error
        return self.response


class HelperTests(unittest.TestCase):
    def safe(self, result, outcome, operation="diagnose-session"):
        self.assertEqual(set(result), RESULT_KEYS | ({"balance"} if operation == "sync-portfolio" else set()))
        self.assertEqual((result["endpoint"], result["path"]),
                         ("session", "/api/me") if operation == "diagnose-session" else ("portfolio", PORTFOLIO_PATH))
        if operation == "sync-portfolio" and outcome != "ok":
            self.assertIsNone(result["balance"])
        self.assertEqual(result["outcome"], outcome)
        self.assertIs(type(result["elapsedMs"]), int)
        self.assertGreaterEqual(result["elapsedMs"], 0)
        encoded = json.dumps(result)
        for secret in (TOKEN, RETURNED, PRIVATE, "PRIVATE_HEADER", "PRIVATE_EXCEPTION"):
            self.assertNotIn(secret, encoded)
        return result

    def main_result(self, raw, opener):
        stream = io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8")
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(sys, "stdin", stream), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors), \
                patch.object(helper.urllib.request, "build_opener", return_value=opener):
            code = helper.main()
        self.assertEqual(errors.getvalue(), "")
        return code, output.getvalue()

    def test_fixed_destination_headers_timeout_and_no_body(self):
        for operation in OPERATIONS:
            response = Response(json.dumps({"token": RETURNED, "balance": "125.5", "account": PRIVATE}).encode())
            opener = Opener(response)
            result = self.safe(helper.probe(TOKEN, opener, operation), "ok", operation)
            self.assertEqual(result.get("balance"), "125.5" if operation == "sync-portfolio" else None)
            self.assertTrue(response.was_closed)
            self.assertEqual(response.read_sizes, [2 * 1024 * 1024 + 1])
            self.assertEqual(len(opener.calls), 1)
            request, timeout = opener.calls[0]
            url = SESSION_URL if operation == "diagnose-session" else "https://omni.variational.io" + PORTFOLIO_PATH
            self.assertEqual((request.full_url, request.get_method(), request.data, timeout), (url, "GET", None, 20))
            self.assertEqual({key.lower(): value for key, value in request.header_items()}, {
                "cookie": "vr-token=" + TOKEN, "accept": "application/json",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
            })

    def test_default_opener_installs_no_redirect_handler(self):
        opener = Opener(Response())
        with patch.object(helper.urllib.request, "build_opener", return_value=opener) as build:
            self.safe(helper.probe(TOKEN), "ok")
        self.assertEqual(len(build.call_args.args), 1)
        self.assertIsInstance(build.call_args.args[0], helper.NoRedirect)
        self.assertIsNone(helper.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://untrusted.example"))

    def test_challenge_precedes_status_and_never_reads_error_body(self):
        for status in (200, 302, 401, 403, 429, 503):
            with self.subTest(status=status):
                response = Response(status=status, fields={"Content-Type": "text/html", "cf-mitigated": " Challenge ",
                                    "Set-Cookie": "vr-token=" + RETURNED, "X-Private": "PRIVATE_HEADER"}, reject_read=True)
                error = urllib.error.HTTPError(SESSION_URL, status, PRIVATE, response.headers, response) if status >= 300 else None
                result = self.safe(helper.probe(TOKEN, Opener(response, error)), "challenge")
                self.assertEqual((result["status"], result["contentType"], result["challenge"], result["structureOk"]),
                                 (status, "html", True, None))
                self.assertEqual(response.read_sizes, [])
                self.assertTrue(response.was_closed)

    def test_access_errors_redirects_and_non_json_do_not_read_bodies(self):
        for status, mime, outcome in (
            (401, "application/json", "unauthorized"), (403, "text/html", "forbidden"),
            (429, "application/problem+json", "rate_limited"), (302, "text/html", "redirect"),
            (503, "application/json", "network_error"), (200, "text/html; charset=utf-8", "html"),
            (200, "application/xhtml+xml", "html"), (200, "text/plain", "invalid_data"),
        ):
            with self.subTest(status=status, mime=mime):
                response = Response(status=status, fields={"Content-Type": mime, "Server": "cloudflare"}, reject_read=True)
                error = urllib.error.HTTPError(SESSION_URL, status, PRIVATE, response.headers, response) if status >= 300 else None
                result = self.safe(helper.probe(TOKEN, Opener(response, error)), outcome)
                self.assertFalse(result["challenge"])
                self.assertEqual(response.read_sizes, [])
                self.assertTrue(response.was_closed)

    def test_structure_is_not_a_token_lifetime_or_account_value_verdict(self):
        for token in ("x", "x" * 32768, "eyJhbGciOiJub25lIn0.eyJleHAiOjF9.signature"):
            result = helper.probe(TOKEN, Opener(Response(json.dumps({"token": token, "balance": PRIVATE}).encode())))
            self.safe(result, "ok")
            self.assertTrue(result["structureOk"])
        for value in (None, [], {}, {"token": ""}, {"token": 1}, {"token": "x" * 32769}, {"data": {"token": RETURNED}}):
            self.safe(helper.probe(TOKEN, Opener(Response(json.dumps(value).encode()))), "invalid_data")

    def test_malformed_oversized_and_non_utf8_bodies_are_bounded_and_redacted(self):
        for response in (
            Response(PRIVATE.encode()), Response(b"\xff"),
            Response(b" " * (2 * 1024 * 1024 + 1)),
            Response(b"", fields={"Content-Type": "application/json", "Content-Length": 2 * 1024 * 1024 + 1}, reject_read=True),
        ):
            result = self.safe(helper.probe(TOKEN, Opener(response)), "invalid_data")
            self.assertFalse(result["structureOk"]); self.assertTrue(response.was_closed)
            self.assertTrue(all(size == 2 * 1024 * 1024 + 1 for size in response.read_sizes))
        self.safe(helper.probe(TOKEN, Opener(Response(fields={"Content-Type": "application/vnd.omni+json"}))), "ok")
        result = self.safe(helper.probe(TOKEN, Opener(Response(fields={}))), "invalid_data")
        self.assertEqual(result["contentType"], "missing")

    def test_timeout_and_network_errors_never_echo_exception_text(self):
        for error, outcome in (
            (socket.timeout("PRIVATE_EXCEPTION " + TOKEN), "timeout"),
            (urllib.error.URLError(socket.timeout(PRIVATE)), "timeout"),
            (urllib.error.URLError(PRIVATE), "network_error"), (RuntimeError(PRIVATE), "network_error"),
        ):
            self.safe(helper.probe(TOKEN, Opener(error=error)), outcome)

    def test_invalid_token_is_rejected_before_network(self):
        opener = Opener(Response())
        for token in ("", "abc", "vr-token=abcdef", "a; other=secret", "a\r\nb", "Bearer abcdef", "令牌token", "a" * 4097, None):
            with self.assertRaises(ValueError):
                helper.probe(token, opener)
        self.assertEqual(opener.calls, [])

    def test_stdin_is_strict_bounded_and_does_not_print_invalid_input(self):
        for raw in (b"", b"{", b"null", b"[]", b'{"vrToken":123}', b'{"vrToken":"abc"}',
                    json.dumps({"vrToken": TOKEN, "url": "https://untrusted.example"}).encode(),
                    json.dumps({"vrToken": TOKEN}).encode(),
                    *(json.dumps({"vrToken": TOKEN, "operation": operation}).encode() for operation in (None, {}, [], "GET", "sync", "https://untrusted.example")),
                    json.dumps({"vrToken": TOKEN, "operation": "sync-portfolio", "balance": "125"}).encode(),
                    json.dumps({"vrToken": TOKEN}).encode() + b"{}", b"x" * 8193):
            opener = Opener(Response())
            code, output = self.main_result(raw, opener)
            self.assertNotEqual(code, 0); self.assertEqual(output, "")
            self.assertEqual(opener.calls, [])
        for raw in (json.dumps({"vrToken": TOKEN, "operation": "diagnose-session"}).encode(),
                    json.dumps({"vrToken": "a" * 4096, "operation": "diagnose-session"}).encode().ljust(8192, b" ")):
            opener = Opener(Response())
            code, output = self.main_result(raw, opener)
            self.assertEqual(code, 0); self.assertEqual(len(output.splitlines()), 1)
            self.safe(json.loads(output), "ok"); self.assertEqual(len(opener.calls), 1)

    def test_portfolio_amounts_allow_zero_and_negative_equity_without_exposing_other_fields(self):
        for operation in ("diagnose-portfolio", "sync-portfolio"):
            for balance in ("0", "-0.000", "-125.50", "0.000000000001", 0, -12.5, 1e-300, 1e300):
                body = json.dumps({"balance": balance, "token": RETURNED, "upnl": "9999", "account": PRIVATE,
                                   "sub_accounts": {"cross": {"balance": "8888"}}}).encode()
                result = self.safe(helper.probe(TOKEN, Opener(Response(body)), operation), "ok", operation)
                self.assertTrue(result["structureOk"])
                if operation == "sync-portfolio":
                    self.assertEqual(result["balance"], balance)
                else:
                    self.assertNotIn("balance", result)

    def test_portfolio_rejects_invalid_amounts_instead_of_substituting_zero(self):
        values = (None, True, False, "", " ", "NaN", "Infinity", "1e9", "1junk", "+1", ".5", "１２３", "١٢٣",
                  "9" * 309, "0." + "0" * 400 + "1", "1" * 129, [], {}, float("nan"), float("inf"), 10 ** 400)
        for operation in ("diagnose-portfolio", "sync-portfolio"):
            for value in values:
                with self.subTest(operation=operation, value=str(value)[:30]):
                    response = Response(json.dumps({"balance": value, "token": RETURNED}).encode())
                    result = self.safe(helper.probe(TOKEN, Opener(response), operation), "invalid_data", operation)
                    self.assertFalse(result["structureOk"])
            for value in (None, [], {}, {"data": {"balance": "125"}}, {"token": RETURNED}, {"upnl": "5"}):
                self.safe(helper.probe(TOKEN, Opener(Response(json.dumps(value).encode())), operation), "invalid_data", operation)

    def test_portfolio_failure_outputs_never_contain_a_balance_or_raw_response(self):
        for operation in ("diagnose-portfolio", "sync-portfolio"):
            for status, fields, outcome in (
                (200, {"Content-Type": "text/html", "cf-mitigated": "challenge"}, "challenge"),
                (403, {"Content-Type": "text/html", "cf-mitigated": "challenge"}, "challenge"),
                (401, {"Content-Type": "application/json"}, "unauthorized"),
                (403, {"Content-Type": "text/html"}, "forbidden"),
                (429, {"Content-Type": "application/json"}, "rate_limited"),
                (302, {"Content-Type": "text/html"}, "redirect"),
                (200, {"Content-Type": "text/html"}, "html"),
            ):
                response = Response(status=status, fields=fields, reject_read=True)
                error = urllib.error.HTTPError("https://omni.variational.io" + PORTFOLIO_PATH, status, PRIVATE, response.headers, response) if status >= 300 else None
                self.safe(helper.probe(TOKEN, Opener(response, error), operation), outcome, operation)
                self.assertEqual(response.read_sizes, [])
                self.assertTrue(response.was_closed)
            for response in (Response(PRIVATE.encode()), Response(b" " * (2 * 1024 * 1024 + 1))):
                self.safe(helper.probe(TOKEN, Opener(response), operation), "invalid_data", operation)
            for error, outcome in ((socket.timeout(PRIVATE), "timeout"), (urllib.error.URLError(PRIVATE), "network_error")):
                self.safe(helper.probe(TOKEN, Opener(error=error), operation), outcome, operation)

    def test_main_has_separate_diagnostic_and_sync_output_permissions(self):
        for operation in OPERATIONS:
            opener = Opener(Response(json.dumps({"token": RETURNED, "balance": "321.125", "account": PRIVATE}).encode()))
            code, output = self.main_result(json.dumps({"vrToken": TOKEN, "operation": operation}).encode(), opener)
            self.assertEqual(code, 0)
            result = self.safe(json.loads(output), "ok", operation)
            self.assertEqual(len(opener.calls), 1)
            self.assertEqual("balance" in result, operation == "sync-portfolio")
        opener = Opener(Response())
        for operation in ("unexpected", None, {}, []):
            with self.assertRaises(ValueError):
                helper.probe(TOKEN, opener, operation)
        self.assertEqual(opener.calls, [])

    def test_real_urllib_handles_http_errors_and_redirects_without_following_them(self):
        state = {"status": 200, "paths": []}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                state["paths"].append(self.path)
                self.send_response(state["status"])
                self.send_header("Content-Type", "application/json")
                self.send_header("Location", "https://untrusted.example/never")
                body = json.dumps({"token": RETURNED, "balance": "125"}).encode()
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        class LoopbackHTTPS(urllib.request.HTTPSHandler):
            def https_open(self, request):
                if request.full_url not in (SESSION_URL, "https://omni.variational.io" + PORTFOLIO_PATH):
                    raise AssertionError("Redirect must not be followed")
                return self.do_open(lambda _host, **kwargs: http.client.HTTPConnection(
                    "127.0.0.1", server.server_port, **kwargs), request)

        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), helper.NoRedirect(), LoopbackHTTPS())
            for operation in OPERATIONS:
                for status, outcome in ((200, "ok"), (401, "unauthorized"), (403, "forbidden"), (302, "redirect"), (307, "redirect")):
                    state["status"] = status
                    self.safe(helper.probe(TOKEN, opener, operation), outcome, operation)
            self.assertEqual(state["paths"], ["/api/me"] * 5 + [PORTFOLIO_PATH] * 10)
            self.assertTrue(ssl.OPENSSL_VERSION)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
