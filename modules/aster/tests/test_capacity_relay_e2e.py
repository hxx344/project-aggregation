"""Real localhost TLS transport; Aster upstream is always an offline mock."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest

import httpx
import uvicorn
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect

from trading.capacity_relay_client import PublicCapacityRelayClient
from trading.capacity_relay_server import RelayCollector, RelayConfig, Sample, create_app
from trading.models import TradingError


SYMBOL = "XAUUSD1"
TOKEN = "local-test-token-" + "a" * 32


class RelayTLSEndToEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        openssl = shutil.which("openssl")
        if openssl is None and Path("D:/Git/usr/bin/openssl.exe").is_file():
            openssl = "D:/Git/usr/bin/openssl.exe"
        if openssl is None:
            raise unittest.SkipTest("openssl is required for the local TLS transport test")
        cls.directory = tempfile.TemporaryDirectory(prefix="aster-relay-tls-")
        cls.addClassCleanup(cls.directory.cleanup)
        cls.cert = str(Path(cls.directory.name) / "localhost-ca.pem")
        cls.key = str(Path(cls.directory.name) / "localhost-key.pem")
        subprocess.run([
            openssl, "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
            "-keyout", cls.key, "-out", cls.cert, "-days", "1",
            "-subj", "/CN=capacity-relay-test",
            "-addext", "subjectAltName=IP:127.0.0.1",
            "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
            "-addext", "extendedKeyUsage=serverAuth",
        ], check=True, capture_output=True, timeout=10)

    def setUp(self):
        self.upstream_requests = []
        self.snapshots = []
        self.thread_errors = []
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.addCleanup(self.listener.close)
        self.port = self.listener.getsockname()[1]
        self.url = f"https://127.0.0.1:{self.port}"

        def upstream(request):
            self.upstream_requests.append(request)
            raise AssertionError("A relay consumer must never trigger an upstream request")

        self.upstream = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        self.addCleanup(lambda: asyncio.run(self.upstream.aclose()))
        config = RelayConfig(TOKEN, host="127.0.0.1", port=self.port,
                             cert_file=self.cert, key_file=self.key)
        self.collector = RelayCollector(config, http=self.upstream)
        app = create_app(config, collector=self.collector, start_collector=False)

        @app.middleware("http")
        async def count_snapshots(request, call_next):
            response = await call_next(request)
            if request.url.path == "/v1/snapshot":
                self.snapshots.append(response.status_code)
            return response

        self.server = uvicorn.Server(uvicorn.Config(
            app, host="127.0.0.1", port=self.port, ssl_certfile=self.cert,
            ssl_keyfile=self.key, log_level="critical", access_log=False,
            lifespan="on", ws="websockets", timeout_graceful_shutdown=1))

        def serve():
            try:
                self.server.run(sockets=[self.listener])
            except BaseException as error:
                self.thread_errors.append(error)

        self.server_thread = threading.Thread(target=serve, name="test-relay-tls", daemon=True)
        self.addCleanup(self.stop_server)
        self.server_thread.start()
        deadline = time.monotonic() + 5
        pause = threading.Event()
        while not self.server.started and self.server_thread.is_alive() and time.monotonic() < deadline:
            pause.wait(0.01)
        self.assertTrue(self.server.started, "Local TLS relay did not start")
        self.assertEqual(self.thread_errors, [])
        self.oi = {"success": True, "code": "000000", "data": {
            "symbol": SYMBOL, "leverageOiRemainingMap": {"5": "12000", "10": "5000"}}}
        self.brackets = {"success": True, "code": "000000", "data": {"brackets": [{
            "symbol": SYMBOL, "riskBrackets": [{"minOpenPosLeverage": 1,
                "maxOpenPosLeverage": 20, "bracketNotionalCap": "5000"}]}]}}
        self.seed()

    def stop_server(self):
        self.server.should_exit = True
        self.server_thread.join(3)
        if self.server_thread.is_alive():
            self.server.force_exit = True
            self.server_thread.join(2)
        self.assertFalse(self.server_thread.is_alive(), "TLS server thread was not stopped")
        self.assertEqual(self.thread_errors, [])

    def seed(self, age=0.05):
        wall, ticks = time.time() - age, time.monotonic() - age
        self.collector.samples[("oi", SYMBOL)] = Sample("oi", SYMBOL, wall, ticks, 1, self.oi)
        self.collector.samples[("brackets", SYMBOL)] = Sample("brackets", SYMBOL, wall, ticks, 2, self.brackets)

    def client(self, token=TOKEN, *, trust=True, url=None, connector=None):
        client = PublicCapacityRelayClient(url or self.url, token,
            ca_file=self.cert if trust else None, connect=connector)
        self.addCleanup(client.close)
        return client

    def start_stream(self, *, connector=connect, startup_timeout=None, sample_timeout=3):
        handshake_finished = threading.Event()
        handshake_errors = []
        handshake_attempts = 0
        connected_attempt = None
        received = threading.Event()

        @contextmanager
        def observed_connect(*args, **kwargs):
            nonlocal handshake_attempts, connected_attempt
            # Use the client's real backoff for one transient opening timeout.
            # A successful opening starts the push phase; later reconnects must
            # not turn a missing initial push into a passing assertion.
            if handshake_finished.is_set():
                raise RuntimeError("The test's connection-opening phase has ended")
            handshake_attempts += 1
            try:
                connection = connector(*args, **kwargs)
            except Exception as error:
                # Report transport phase and error class, never raw exception
                # text or handshake headers (which may contain the token).
                phase = "connector"
                trace = error.__traceback__
                while trace is not None:
                    module = trace.tb_frame.f_globals.get("__name__")
                    if module == "ssl":
                        phase = "tls"
                    elif module == "socket":
                        phase = "tcp"
                    elif module == "websockets.sync.client" and trace.tb_frame.f_code.co_name == "handshake":
                        phase = "websocket"
                    trace = trace.tb_next
                handshake_errors.append({"attempt": handshake_attempts,
                                         "phase": phase, "error": type(error).__name__})
                if not isinstance(error, TimeoutError) or handshake_attempts >= 2:
                    handshake_finished.set()
                raise
            connected_attempt = handshake_attempts
            handshake_finished.set()
            with connection:
                yield connection

        streamed = self.client(connector=observed_connect)
        streamed.set_update_listener(lambda symbol, kind: received.set() if kind == "brackets" else None)
        streamed.start()
        # Both production opening timeouts plus the first retry's backoff and
        # scheduling margin are bounded separately from the initial push.
        if startup_timeout is None:
            startup_timeout = 2 * streamed._OPEN_TIMEOUT + streamed._RETRY_INITIAL + 2
        self.assertTrue(handshake_finished.wait(startup_timeout),
                        f"TLS WebSocket handshake did not finish: {handshake_errors}; {streamed.status()}")
        self.assertIsNotNone(connected_attempt,
                             f"TLS WebSocket handshake failed: {handshake_errors}; {streamed.status()}")
        self.assertTrue(received.wait(sample_timeout),
                        f"TLS WebSocket connected but did not deliver initial cached samples: {streamed.status()}")
        self.assertTrue(streamed.status()["connected"])
        self.assertEqual(streamed.status()["ws"]["connection_attempts"], connected_attempt)
        return streamed

    def test_real_wss_push_and_https_fallback_share_cache_without_upstream_requests(self):
        streamed = self.start_stream()
        # Risk brackets have a 60-second refresh target, so this assertion does
        # not depend on the machine finishing its TLS handshake within 0.5s.
        started, checked, payload = streamed.sample("brackets", SYMBOL, 300)
        self.assertEqual(payload, self.brackets)
        self.assertGreater(time.monotonic() - started, 0)
        self.assertLess(checked, time.time())
        self.assertEqual(self.snapshots, [], "A valid WS cache must not issue HTTP")

        streamed.close()
        self.assertFalse(streamed._thread.is_alive())
        # A separate HTTP-only client models loss of the push connection and
        # consumes the same immutable bracket sample.
        fallback = self.client()
        _, fallback_checked, bracket_payload = fallback.sample("brackets", SYMBOL, 300)
        self.assertEqual(bracket_payload, self.brackets)
        self.assertLessEqual(fallback_checked, self.collector.samples[("brackets", SYMBOL)].sampled_at + 0.001)
        self.assertEqual(self.snapshots, [200])
        self.assertFalse(fallback.status()["running"])
        self.assertEqual(self.upstream_requests, [])

    def test_real_https_oi_fallback_keeps_cached_sample_time_without_upstream_requests(self):
        # OI expires at the server after 3s, independently of the WS handshake.
        # Give this HTTP-only assertion its own fresh fixture instead of making
        # it wait for the preceding TLS/WS startup and shutdown.
        fallback = self.client()
        _, oi_checked, oi_payload = fallback.sample("oi", SYMBOL, 8)
        self.assertEqual(oi_payload, self.oi)
        self.assertLessEqual(oi_checked, self.collector.samples[("oi", SYMBOL)].sampled_at + 0.001)
        self.assertEqual(self.snapshots, [200])
        self.assertFalse(fallback.status()["running"])
        self.assertEqual(self.upstream_requests, [])

    def test_delayed_connection_start_does_not_consume_initial_push_budget(self):
        # Simulate a receiver thread delayed before it enters the real TLS/WS
        # handshake, then one opening timeout. The old shared 3s wait fails.
        delay = 3.1
        timeouts = []

        def delayed_connect(*args, **kwargs):
            timeouts.append(kwargs["open_timeout"])
            if len(timeouts) == 1:
                time.sleep(delay)
                raise TimeoutError("injected first opening timeout after startup delay")
            return connect(*args, **kwargs)

        streamed = self.start_stream(connector=delayed_connect,
            startup_timeout=delay + 2 * PublicCapacityRelayClient._OPEN_TIMEOUT
                + PublicCapacityRelayClient._RETRY_INITIAL + 2)
        self.assertEqual(timeouts, [PublicCapacityRelayClient._OPEN_TIMEOUT] * 2)
        self.assertEqual(streamed.status()["ws"]["connection_attempts"], 2)
        self.assertEqual(streamed.status()["ws"]["failure_count"], 1)
        _, _, payload = streamed.sample("brackets", SYMBOL, 300)
        self.assertEqual(payload, self.brackets)
        self.assertEqual(self.snapshots, [])
        self.assertEqual(self.upstream_requests, [])

    def test_one_opening_timeout_retries_then_delivers_real_tls_cached_samples(self):
        timeouts = []

        def timeout_once(*args, **kwargs):
            timeouts.append(kwargs["open_timeout"])
            if len(timeouts) == 1:
                raise TimeoutError("injected first opening timeout")
            return connect(*args, **kwargs)

        streamed = self.start_stream(connector=timeout_once)
        self.assertEqual(timeouts, [PublicCapacityRelayClient._OPEN_TIMEOUT] * 2)
        self.assertEqual(streamed.status()["ws"]["connection_attempts"], 2)
        self.assertEqual(streamed.status()["ws"]["failure_count"], 1)
        self.assertEqual(streamed.sample("brackets", SYMBOL, 300)[2], self.brackets)
        self.assertEqual(self.snapshots, [])
        self.assertEqual(self.upstream_requests, [])

    def test_persistent_handshake_timeout_fails_after_two_attempts(self):
        attempts = []

        def failed_connect(*args, **kwargs):
            attempts.append(kwargs["open_timeout"])
            raise TimeoutError("injected handshake timeout")

        with self.assertRaisesRegex(AssertionError, "TLS WebSocket handshake failed"):
            self.start_stream(connector=failed_connect)
        self.assertEqual(attempts, [PublicCapacityRelayClient._OPEN_TIMEOUT] * 2)
        self.assertEqual(self.snapshots, [])
        self.assertEqual(self.upstream_requests, [])

    def test_non_timeout_handshake_failure_is_not_retried(self):
        attempts = []

        def failed_connect(*args, **kwargs):
            attempts.append(kwargs["open_timeout"])
            raise ssl.SSLCertVerificationError("injected invalid certificate")

        with self.assertRaisesRegex(AssertionError, "TLS WebSocket handshake failed"):
            self.start_stream(connector=failed_connect)
        self.assertEqual(attempts, [PublicCapacityRelayClient._OPEN_TIMEOUT])
        self.assertEqual(self.snapshots, [])
        self.assertEqual(self.upstream_requests, [])

    def test_connected_stream_without_initial_cache_still_fails_push_phase(self):
        self.collector.samples.clear()
        with self.assertRaisesRegex(AssertionError, "connected but did not deliver initial cached samples"):
            self.start_stream(sample_timeout=0.1)
        self.assertEqual(self.snapshots, [])
        self.assertEqual(self.upstream_requests, [])

    def test_real_tls_rejects_wrong_token_untrusted_ca_hostname_and_expired_cache(self):
        wrong = self.client(token="wrong-token-" + "b" * 32)
        with self.assertRaises(TradingError):
            wrong.sample("oi", SYMBOL, 8)
        self.assertEqual(self.snapshots, [401])

        tls = ssl.create_default_context(cafile=self.cert)
        with self.assertRaises(InvalidStatus) as denied:
            with connect(f"wss://127.0.0.1:{self.port}/v1/stream", ssl=tls, proxy=None,
                         additional_headers={"Authorization": "Bearer incorrect"}, open_timeout=1,
                         close_timeout=1, logger=wrong._ws_logger):
                self.fail("Unauthenticated WS was accepted")
        self.assertEqual(denied.exception.response.status_code, 403)

        untrusted = self.client(trust=False)
        with self.assertRaises(TradingError):
            untrusted.sample("oi", SYMBOL, 8)
        wrong_hostname = self.client(url=f"https://localhost:{self.port}")
        with self.assertRaises(TradingError):
            wrong_hostname.sample("oi", SYMBOL, 8)
        self.assertEqual(self.snapshots, [401], "Certificate failures must occur before HTTP")

        self.seed(age=9)
        expired = self.client()
        with self.assertRaises(TradingError):
            expired.sample("oi", SYMBOL, 8)
        self.assertEqual(self.snapshots, [401, 503])
        self.assertEqual(expired.status()["cached_samples"], 0)
        self.assertEqual(self.upstream_requests, [])


if __name__ == "__main__":
    unittest.main()
