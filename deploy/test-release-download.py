#!/usr/bin/env python3
"""Exercise the exact embedded downloader with local HTTP transport, never a TLS bypass."""
import contextlib
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import re
import signal
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock
import urllib.error
import urllib.parse
import urllib.request


SOURCE = Path(__file__).with_name('release-common.sh').read_text(encoding='utf-8')
PYTHON = SOURCE.split("<<'CI_DOWNLOAD_PY'\n", 1)[1].split('\nCI_DOWNLOAD_PY', 1)[0]
core = types.ModuleType('release_downloader')
exec(compile(PYTHON, 'release-common.sh:CI_DOWNLOAD_PY', 'exec'), core.__dict__)
URL = 'https://download.test/archive'


class FixtureTransport(urllib.request.HTTPSHandler):
    """Map HTTPS only at the transport boundary; keep production redirect validation."""
    def __init__(self, port):
        super().__init__()
        self.port = port

    def https_open(self, request):
        parsed = urllib.parse.urlsplit(request.full_url)
        local = urllib.request.Request('http://127.0.0.1:%d%s' % (self.port, parsed.path),
                                       headers=dict(request.header_items()), method=request.get_method())
        local.timeout = request.timeout
        response = self.do_open(http.client.HTTPConnection, local)
        response.url = request.full_url
        return response


class TestDownloader(core.Downloader):
    def __init__(self, cache, url, expected, port):
        super().__init__(cache, url, expected)
        self.test_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                                     core.HTTPSRedirect(), FixtureTransport(port))
        self.worker_lock = threading.Lock()
        self.worker_count = 0
        self.single_worker_counts = []

    def _open_request(self, request):
        return self.test_opener.open(request, timeout=core.SOCKET_TIMEOUT)

    def pause_retry(self, attempt):
        self.check_cancel()
        return attempt + 1 < core.ATTEMPTS

    def part(self, index, start, size):
        with self.worker_lock:
            self.worker_count += 1
        try:
            super().part(index, start, size)
            if index == 0 and hasattr(self, 'first_complete'):
                self.first_complete.set()
        finally:
            with self.worker_lock:
                self.worker_count -= 1

    def single(self):
        with self.worker_lock:
            self.single_worker_counts.append(self.worker_count)
        return super().single()


class Fixture:
    def __init__(self, payload, mode='range'):
        self.payload, self.mode = payload, mode
        self.requests = []
        self.active = self.maximum = 0
        self.lock = threading.Lock()
        self.started = threading.Event()
        self.release = threading.Event()
        self.first_complete = threading.Event()
        self.full_during_range = False
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_):
                pass

            def do_GET(self):
                requested = self.headers.get('Range')
                with fixture.lock:
                    fixture.requests.append((self.path, requested))
                    sequence = len(fixture.requests)
                mode, data = fixture.mode, fixture.payload
                if mode.startswith('redirect') and self.path == '/archive':
                    self.send_response(302)
                    target = 'https://download.test/final' if mode == 'redirect_https' else 'http://127.0.0.1:%d/final' % fixture.port
                    if mode == 'redirect_loop':
                        target = URL
                    self.send_header('Location', target)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                if mode == 'transient' and sequence == 1:
                    self.send_response(503)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                probe = requested == 'bytes=0-0'
                ranged = requested is not None and mode != 'ignored' and not (mode == 'late_ignored' and not probe)
                if mode == 'bad_sha' or (mode == 'bad_range_sha' and ranged and not probe):
                    data = bytes([data[0] ^ 1]) + data[1:]
                if mode == 'range_416' and ranged and not probe:
                    self.send_response(416)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                start, end = (0, len(data) - 1)
                if ranged:
                    match = re.fullmatch(r'bytes=(\d+)-(\d+)', requested)
                    start, end = map(int, match.groups())
                body = data[start:end + 1]
                length = len(body)
                self.send_response(206 if ranged else 200)
                if ranged:
                    response_start = start + 1 if mode == 'wrong_range' and not probe else start
                    response_total = len(data) + 1 if mode == 'wrong_total' and not probe else len(data)
                    self.send_header('Content-Range', 'bytes %d-%d/%d' % (response_start, end, response_total))
                if mode == 'oversize':
                    length = core.MAX_SIZE + 1
                if mode == 'wrong_length' and ranged and not probe:
                    length += 1
                self.send_header('Content-Length', str(length))
                if mode == 'encoded' and ranged and not probe:
                    self.send_header('Content-Encoding', 'gzip')
                self.send_header('Connection', 'close')
                self.end_headers()
                tracked = ranged and not probe
                if tracked:
                    with fixture.lock:
                        fixture.active += 1
                        fixture.maximum = max(fixture.maximum, fixture.active)
                    fixture.started.set()
                elif not requested:
                    with fixture.lock:
                        fixture.full_during_range |= fixture.active > 0
                try:
                    if mode == 'overlap' and tracked:
                        time.sleep(0.08)
                    if mode == 'stall' and tracked:
                        self.wfile.write(body[:65536])
                        self.wfile.flush()
                        fixture.release.wait(8)
                        return
                    if mode == 'drop_tail' and tracked and start >= core.BLOCK:
                        fixture.first_complete.wait(5)
                    if ((mode == 'truncate_once' and tracked and sequence == 2) or
                            (mode == 'drop_tail' and tracked and start >= core.BLOCK)):
                        body = body[:min(65536, len(body) // 2)]
                    self.wfile.write(body)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass
                finally:
                    if tracked:
                        with fixture.lock:
                            fixture.active -= 1
                    self.close_connection = True

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


def data_bytes(size):
    seed = bytes(range(251))
    return (seed * (size // len(seed) + 1))[:size]


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='release-download-')
        self.root = Path(self.temporary.name)
        self.cache = self.root / 'cache'
        self.output = io.StringIO()
        self.redirect = contextlib.redirect_stderr(self.output)
        self.redirect.__enter__()

    def tearDown(self):
        self.redirect.__exit__(None, None, None)
        self.temporary.cleanup()

    def downloader(self, fixture, expected=None):
        downloader = TestDownloader(self.cache, URL, expected or hashlib.sha256(fixture.payload).hexdigest(), fixture.port)
        downloader.first_complete = fixture.first_complete
        return downloader

    def test_four_workers_overlap_and_cache_hit(self):
        with Fixture(data_bytes(core.BLOCK * 4 + 1234), 'overlap') as fixture:
            downloader = self.downloader(fixture)
            result = downloader.run()
            self.assertEqual(hashlib.sha256(result.read_bytes()).hexdigest(), downloader.expected)
            self.assertEqual(fixture.maximum, 4)
            count = len(fixture.requests)
            self.assertEqual(self.downloader(fixture).run(), result)
            self.assertEqual(len(fixture.requests), count)
            self.assertIn('缓存', self.output.getvalue())
            self.assertIn('4 路', self.output.getvalue())
            self.assertIn('MiB/s', self.output.getvalue())

    def test_range_failures_use_clean_single_stream(self):
        for mode in ('ignored', 'late_ignored', 'wrong_range', 'wrong_length', 'wrong_total', 'encoded', 'range_416'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(dir=self.root) as directory:
                self.cache = Path(directory) / 'cache'
                with Fixture(data_bytes(180000), mode) as fixture:
                    result = self.downloader(fixture).run()
                    self.assertEqual(result.read_bytes(), fixture.payload)
                    self.assertEqual(sum(request is None for _, request in fixture.requests), 1)

    def test_short_body_resumes_strict_range(self):
        with Fixture(data_bytes(900000), 'truncate_once') as fixture:
            result = self.downloader(fixture).run()
            self.assertEqual(result.read_bytes(), fixture.payload)
            self.assertIn(('/archive', 'bytes=65536-899999'), fixture.requests)
            self.assertFalse(any(request is None for _, request in fixture.requests))

    def test_fallback_joins_all_range_workers_before_single(self):
        with Fixture(data_bytes(core.BLOCK * 4 + 123), 'wrong_range') as fixture:
            downloader = self.downloader(fixture)
            self.assertEqual(downloader.run().read_bytes(), fixture.payload)
            self.assertEqual(downloader.single_worker_counts, [0])
            self.assertEqual(downloader.active, set())

    def test_restart_reuses_complete_parts_and_prefix(self):
        with Fixture(data_bytes(core.BLOCK + 900000), 'drop_tail') as fixture:
            downloader = self.downloader(fixture)
            with self.assertRaises(core.Retryable):
                downloader.run()
            self.assertFalse(downloader.archive.exists())
            saved = json.loads((downloader.parts / 'metadata.json').read_text())
            self.assertIn('0', saved['completed'])
            prefix = (downloader.parts / 'part-001').stat().st_size
            self.assertGreater(prefix, 0)
            fixture.mode = 'range'
            fixture.requests.clear()
            result = self.downloader(fixture).run()
            self.assertEqual(result.read_bytes(), fixture.payload)
            self.assertEqual(fixture.requests, [('/archive', 'bytes=0-0'),
                                               ('/archive', 'bytes=%d-%d' % (core.BLOCK + prefix, len(fixture.payload) - 1))])

    def test_saved_completed_part_hash_is_rechecked(self):
        with Fixture(data_bytes(core.BLOCK + 900000), 'drop_tail') as fixture:
            downloader = self.downloader(fixture)
            with self.assertRaises(core.Retryable):
                downloader.run()
            path = downloader.parts / 'part-000'
            with path.open('r+b') as target:
                target.write(b'bad')
            fixture.mode = 'range'
            fixture.requests.clear()
            self.assertEqual(self.downloader(fixture).run().read_bytes(), fixture.payload)
            self.assertIn(('/archive', 'bytes=0-%d' % (core.BLOCK - 1)), fixture.requests)

    def test_metadata_identity_change_discards_old_prefix(self):
        with Fixture(data_bytes(core.BLOCK + 900000), 'drop_tail') as fixture:
            downloader = self.downloader(fixture)
            with self.assertRaises(core.Retryable):
                downloader.run()
            metadata = downloader.parts / 'metadata.json'
            state = json.loads(metadata.read_text())
            state['url'] = 'https://other.test/archive'
            metadata.write_text(json.dumps(state))
            fixture.mode = 'range'
            fixture.requests.clear()
            self.assertEqual(self.downloader(fixture).run().read_bytes(), fixture.payload)
            self.assertIn(('/archive', 'bytes=%d-%d' % (core.BLOCK, len(fixture.payload) - 1)), fixture.requests)

    def test_hash_mismatch_gets_one_clean_retry_and_never_promotes(self):
        with Fixture(data_bytes(100000), 'bad_sha') as fixture:
            downloader = self.downloader(fixture)
            with self.assertRaisesRegex(core.DownloadError, 'SHA256 mismatch'):
                downloader.run()
            self.assertFalse(downloader.archive.exists())
            self.assertEqual(sum(request is None for _, request in fixture.requests), 1)
            self.assertEqual(list(downloader.parts.iterdir()), [])

    def test_bad_range_hash_recovers_with_single(self):
        with Fixture(data_bytes(100000), 'bad_range_sha') as fixture:
            self.assertEqual(self.downloader(fixture).run().read_bytes(), fixture.payload)
            self.assertEqual(sum(request is None for _, request in fixture.requests), 1)

    def test_corrupt_cached_archive_is_replaced_unknown_temp_preserved(self):
        with Fixture(data_bytes(100000)) as fixture:
            downloader = self.downloader(fixture)
            downloader.archive.write_bytes(b'corrupt')
            old = self.cache / '.download.unknown'
            old.write_bytes(b'keep')
            self.assertEqual(downloader.run().read_bytes(), fixture.payload)
            self.assertEqual(old.read_bytes(), b'keep')

    def test_https_redirect_works_and_downgrade_or_loop_fails(self):
        for mode in ('redirect_https', 'redirect_http', 'redirect_loop'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(dir=self.root) as directory:
                self.cache = Path(directory) / 'cache'
                with Fixture(data_bytes(100000), mode) as fixture:
                    downloader = self.downloader(fixture)
                    if mode == 'redirect_https':
                        self.assertEqual(downloader.run().read_bytes(), fixture.payload)
                    else:
                        with self.assertRaises(core.DownloadError):
                            downloader.run()
                        self.assertFalse(downloader.archive.exists())
                        self.assertFalse(any(path == '/final' for path, _ in fixture.requests))
                        self.assertLessEqual(len(fixture.requests), 4)

    def test_http_initial_url_is_rejected(self):
        with self.assertRaisesRegex(core.DownloadError, 'HTTPS'):
            TestDownloader(self.cache, 'http://download.test/archive', 'a' * 64, 1)

    def test_transient_http_is_retried(self):
        with Fixture(data_bytes(100000), 'transient') as fixture:
            self.assertEqual(self.downloader(fixture).run().read_bytes(), fixture.payload)
            self.assertEqual(fixture.requests[:2], [('/archive', 'bytes=0-0')] * 2)

    def test_tls_certificate_failure_is_terminal_but_eof_retries_are_bounded(self):
        for reason, expected_count in ((ssl.SSLCertVerificationError('invalid certificate'), 1),
                                       (ssl.SSLEOFError('unexpected EOF'), core.ATTEMPTS)):
            with self.subTest(reason=type(reason).__name__):
                downloader = TestDownloader(self.cache, URL, 'a' * 64, 1)
                with mock.patch.object(downloader, '_open_request', side_effect=urllib.error.URLError(reason)) as request:
                    with self.assertRaises(core.DownloadError):
                        downloader.run()
                    self.assertEqual(request.call_count, expected_count)

    def test_body_timeout_keeps_partial_bytes_and_has_bounded_retries(self):
        with mock.patch.object(core, 'SOCKET_TIMEOUT', 0.1), Fixture(data_bytes(1000000), 'stall') as fixture:
            downloader = self.downloader(fixture)
            with self.assertRaises(core.Retryable):
                downloader.run()
            requests = [request for _, request in fixture.requests if request != 'bytes=0-0']
            self.assertEqual(len(requests), core.ATTEMPTS)
            self.assertEqual(requests[1], 'bytes=65536-999999')
            self.assertGreater((downloader.parts / 'part-000').stat().st_size, 0)
            self.assertFalse(downloader.archive.exists())

    def test_oversized_response_is_rejected(self):
        with Fixture(data_bytes(100000), 'oversize') as fixture:
            downloader = self.downloader(fixture)
            with self.assertRaises(core.DownloadError):
                downloader.run()
            self.assertFalse(downloader.archive.exists())

    def test_cancellation_joins_writers_and_preserves_prefix(self):
        # Windows socket shutdown need not wake a pending timed recv immediately.
        # A shorter fixture timeout exercises the same bounded shutdown without a 20s test wait.
        with mock.patch.object(core, 'SOCKET_TIMEOUT', 0.5), Fixture(data_bytes(core.BLOCK * 4), 'stall') as fixture:
            downloader = self.downloader(fixture)
            errors = []

            def run():
                try:
                    downloader.run()
                except Exception as error:
                    errors.append(error)

            worker = threading.Thread(target=run)
            worker.start()
            self.assertTrue(fixture.started.wait(5))
            time.sleep(0.1)
            started = time.monotonic()
            downloader.cancelled.set()
            worker.join(5)
            self.assertFalse(worker.is_alive(), 'cancel must close blocked sockets before joining')
            self.assertLess(time.monotonic() - started, 5)
            self.assertTrue(errors)
            self.assertFalse(downloader.archive.exists())
            self.assertEqual(downloader.active, set())
            sizes = {path.name: path.stat().st_size for path in downloader.parts.iterdir()}
            self.assertTrue(any(name.startswith('part-') and size > 0 for name, size in sizes.items()))
            time.sleep(0.1)
            self.assertEqual(sizes, {path.name: path.stat().st_size for path in downloader.parts.iterdir()})

    @unittest.skipUnless(os.name == 'posix', 'Linux cache ownership/permission semantics')
    def test_cache_ancestor_permissions_and_links(self):
        unsafe = self.root / 'unsafe'
        unsafe.mkdir(mode=0o777)
        unsafe.chmod(0o777)
        with self.assertRaises(core.DownloadError):
            core.Downloader(unsafe / 'cache', URL, 'a' * 64)
        linked = self.root / 'linked'
        linked.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(core.DownloadError):
            core.Downloader(linked / 'cache', URL, 'a' * 64)
        if os.geteuid() == 0:
            foreign = self.root / 'foreign'
            foreign.mkdir()
            os.chown(foreign, 65534, 65534)
            with self.assertRaises(core.DownloadError):
                core.Downloader(foreign / 'cache', URL, 'a' * 64)

    @unittest.skipUnless(os.name == 'posix', 'Linux symlink/hardlink cache protection')
    def test_cache_files_reject_symlinks_hardlinks_and_special_files(self):
        for kind in ('symlink', 'hardlink', 'fifo'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.root) as directory:
                cache = Path(directory) / 'cache'
                downloader = core.Downloader(cache, URL, 'a' * 64)
                victim = Path(directory) / 'victim'
                victim.write_bytes(b'untouched')
                if kind == 'symlink':
                    downloader.archive.symlink_to(victim)
                elif kind == 'hardlink':
                    os.link(victim, downloader.archive)
                else:
                    os.mkfifo(downloader.archive)
                with self.assertRaises(core.DownloadError):
                    downloader.run()
                self.assertEqual(victim.read_bytes(), b'untouched')

    @unittest.skipUnless(os.name == 'posix', 'Linux flock and signal delivery')
    def test_process_signal_releases_lock_and_restart_resumes(self):
        with Fixture(data_bytes(core.BLOCK * 4), 'stall') as fixture:
            expected = hashlib.sha256(fixture.payload).hexdigest()
            command = [sys.executable, '-I', str(Path(__file__).resolve()), '--child', str(fixture.port), str(self.cache), expected]
            child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.assertTrue(fixture.started.wait(10))
                time.sleep(0.1)
                import fcntl
                with (self.cache / ('.' + expected + '.lock')).open('rb') as lock:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                child.send_signal(signal.SIGTERM)
                child.communicate(timeout=10)
                self.assertNotEqual(child.returncode, 0)
                with (self.cache / ('.' + expected + '.lock')).open('rb') as lock:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
                fixture.release.set()
                fixture.mode = 'range'
                fixture.requests.clear()
                restarted = subprocess.run(command, capture_output=True, timeout=30)
                self.assertEqual(restarted.returncode, 0, restarted.stderr.decode())
                self.assertEqual((self.cache / (expected + '.tar.gz')).read_bytes(), fixture.payload)
                self.assertTrue(any(request and int(request.split('=')[1].split('-')[0]) % core.BLOCK > 0
                                    for _, request in fixture.requests))
            finally:
                if child.poll() is None:
                    child.kill()
                    child.communicate()


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--child':
        TestDownloader(sys.argv[3], URL, sys.argv[4], int(sys.argv[2])).run()
    else:
        unittest.main()
