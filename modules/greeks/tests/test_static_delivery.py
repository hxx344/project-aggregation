import gzip
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from pydantic import SecretStr

from app.main import app


class StaticDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def read(self, path, *, encoding="identity", method="GET", headers=None, password=""):
        with patch("app.main.settings.dashboard_password", SecretStr(password)):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 40000)),
                base_url="http://localhost",
            ) as client:
                async with client.stream(method, path, headers={"Accept-Encoding": encoding, **(headers or {})}) as response:
                    return response.status_code, response.headers, b"".join([part async for part in response.aiter_raw()])

    async def test_all_dashboard_code_files_negotiate_compression_without_changing_cache_or_body(self):
        directory = Path(__file__).resolve().parents[1] / "app" / "static"
        total_plain = total_gzip = 0
        for filename in ("index.html", "app.js", "style.css", "hub.js", "performance.js", "position-payoff.js"):
            path = "/" if filename == "index.html" else "/static/" + filename
            status, plain_headers, plain = await self.read(path)
            self.assertEqual(status, 200, path)
            self.assertEqual(plain, (directory / filename).read_bytes())
            status, headers, compressed = await self.read(path, encoding="gzip")
            self.assertEqual(status, 200, path)
            self.assertEqual(headers.get("content-encoding"), "gzip", path)
            self.assertEqual(gzip.decompress(compressed), plain)
            self.assertEqual(headers["cache-control"], plain_headers["cache-control"])
            self.assertIn("no-store", headers["cache-control"])
            self.assertIn("accept-encoding", headers["vary"].lower())
            self.assertEqual(headers["x-content-type-options"], "nosniff")
            self.assertTrue(headers["etag"].startswith('W/"'))
            if "content-length" in headers:
                self.assertEqual(int(headers["content-length"]), len(compressed))
            total_plain += len(plain)
            total_gzip += len(compressed)
        self.assertLess(total_gzip, total_plain / 2)

    async def test_encoding_refusal_ranges_and_head_keep_the_original_representation(self):
        status, headers, plain = await self.read("/static/app.js")
        self.assertEqual(status, 200)
        for encoding in ("gzip;q=0, *;q=1", "gzip;q=0.000", "br"):
            status, received, body = await self.read("/static/app.js", encoding=encoding)
            self.assertEqual(status, 200)
            self.assertNotIn("content-encoding", received)
            self.assertEqual(body, plain)
        status, received, body = await self.read("/static/app.js", encoding="gzip", headers={"Range": "bytes=0-15"})
        self.assertEqual(status, 206)
        self.assertNotIn("content-encoding", received)
        self.assertEqual(body, plain[:16])
        status, received, body = await self.read("/static/app.js", encoding="gzip", method="HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertEqual(int(received["content-length"]), len(plain))

    async def test_api_authentication_errors_and_conditional_responses_are_not_compressed(self):
        for path, password, expected in (("/api/config", "", 200), ("/static/missing.js", "", 404), ("/static/app.js", "delivery-test-password", 401)):
            status, headers, _ = await self.read(path, encoding="gzip", password=password)
            self.assertEqual(status, expected, path)
            self.assertNotIn("content-encoding", headers)
        _, headers, _ = await self.read("/static/app.js")
        status, received, body = await self.read("/static/app.js", encoding="gzip", headers={"If-None-Match": headers["etag"]})
        self.assertEqual(status, 304)
        self.assertNotIn("content-encoding", received)
        self.assertEqual(body, b"")


if __name__ == "__main__":
    unittest.main()
