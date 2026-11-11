import unittest

import httpx

from app.bybit import BybitClient, BybitError


def response(status, content=b"", headers=None):
    return httpx.Response(status, content=content, headers=headers, request=httpx.Request("GET", "https://api.bybit.com/v5/account/wallet-balance?api_key=SECRETKEY"))


class BybitHttpFailureTests(unittest.TestCase):
    def failure(self, status, content=b"", path="/v5/account/wallet-balance"):
        with self.assertRaises(httpx.HTTPStatusError) as raised:
            BybitClient._response_result(response(status, content), path)
        self.assertNotIsInstance(raised.exception, BybitError)
        self.assertEqual(raised.exception.response.status_code, status)
        return str(raised.exception)

    def test_403_without_a_usable_code_lists_the_possible_causes_and_hides_the_url(self):
        bodies = (b"", b"<html>403 Forbidden</html>", b"{", b"[1]", b'{"retCode":"10010"}', b'{"retCode":true}',
                  b'{"retCode":10010.0}', b'{"retCode":0}', b'{"retCode":-5}', b'{"retCode":' + b"9" * 400 + b"}")
        for body in bodies:
            with self.subTest(body=body[:40]):
                message = self.failure(403, body)
                self.assertIn("HTTP 403，响应不含错误码", message)
                self.assertIn("可能原因", message)
                self.assertIn("请求过于频繁", message)
                self.assertIn("地区受限", message)
                self.assertNotIn("SECRETKEY", message)
                self.assertNotIn("api.bybit.com", message)
                self.assertLess(len(message), 200)

    def test_error_body_with_a_documented_code_gives_that_cause_without_echoing_the_body(self):
        expected = {10002: "时间戳", 10003: "API 密钥无效", 10004: "签名校验失败", 10005: "权限不足", 10006: "限频",
                    10009: "所在地区当前不可访问", 10010: "不在该 API 密钥的白名单内", 10024: "合规限制"}
        for code, words in expected.items():
            for status in (401, 403):
                with self.subTest(code=code, status=status):
                    message = self.failure(status, ('{"retCode":%d,"retMsg":"leak apiKey=SECRETKEY"}' % code).encode())
                    self.assertIn(f"HTTP {status}（错误码 {code}）", message)
                    self.assertIn(words, message)
                    self.assertNotIn("SECRETKEY", message)

    def test_unlisted_code_is_reported_as_unlisted_not_as_missing(self):
        message = self.failure(403, b'{"retCode":170001,"retMsg":"x"}')
        self.assertIn("错误码 170001，未收录的错误码", message)
        self.assertNotIn("不含错误码", message)

    def test_oversized_error_body_is_not_parsed(self):
        body = b'{"retCode":10010,"pad":"' + b"x" * 70_000 + b'"}'
        self.assertIn("响应不含错误码", self.failure(403, body))

    def test_other_statuses_keep_the_status_and_never_show_the_url(self):
        self.assertIn("HTTP 429（响应不含错误码）：请求过于频繁", self.failure(429))
        self.assertEqual(self.failure(502, b"bad gateway"), "Bybit 返回 HTTP 502（响应不含错误码）")
        self.assertEqual(self.failure(301), "Bybit 返回 HTTP 301（响应不含错误码）")

    def test_success_status_is_unchanged(self):
        self.assertEqual(BybitClient._response_result(response(200, b'{"retCode":0,"result":{"ok":true}}'), "/v5/account/info"), {"ok": True})


class RecordingWriter:
    enabled = True

    def __init__(self):
        self.finished = []
        self.registry = self

    def assert_owned(self, operation):
        pass

    def prepare(self, method, path, body):
        return "operation"

    def validate_response(self, path, body, result):
        pass

    def finish(self, operation, state):
        self.finished.append((operation, state))


class BybitHttpFailureWriteTests(unittest.IsolatedAsyncioTestCase):
    async def test_http_error_on_a_write_is_recorded_unknown_even_with_a_refusal_code(self):
        # 10010 inside a 200 envelope proves a refusal; under an HTTP error nothing proves the order was not accepted.
        client = BybitClient("key", "secret")
        client.account_writer = RecordingWriter()
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(
            lambda request: httpx.Response(403, json={"retCode": 10010, "retMsg": "x"})))
        self.addAsyncCleanup(client.close)
        with self.assertRaises(httpx.HTTPStatusError) as raised:
            await client._request("POST", "/v5/order/create", body={"symbol": "BTC-OPTION"}, private=True)
        self.assertNotIsInstance(raised.exception, BybitError)
        self.assertIn("错误码 10010", str(raised.exception))
        self.assertEqual(client.account_writer.finished, [("operation", "unknown")])


if __name__ == "__main__":
    unittest.main()
