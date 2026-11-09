"""Exercise mirror selection in the actual embedded, integrity-checked downloader."""
import contextlib
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.request
from email.message import Message


SPEC = importlib.util.spec_from_file_location('download_fixtures', Path(__file__).with_name('test-release-download.py'))
fixtures = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixtures)
core = fixtures.core
Downloader = core.Downloader
COMMIT = 'a' * 40
SUFFIX = '/hxx344/project-aggregation/releases/download/deploy-' + COMMIT + '/fixture.tar.gz'
ORIGIN = 'https://github.com' + SUFFIX
TAG = 'deploy-' + COMMIT
API_ASSET = 'https://api.github.com/repos/hxx344/project-aggregation/releases/assets/4242'
TAG_PATH = '/repos/hxx344/project-aggregation/releases/tags/' + TAG


class StatusFixture:
    """Serve one fixed status/body and keep each request's headers for assertions."""
    def __init__(self, status, body=b''):
        self.status, self.body, self.requests = status, body, []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_):
                pass

            def do_GET(self):
                fixture.requests.append((self.path, self.headers))
                self.send_response(fixture.status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(fixture.body)))
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(fixture.body)
                self.close_connection = True

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class RecordingTransport(fixtures.FixtureTransport):
    def __init__(self, port, seen):
        super().__init__(port)
        self.seen = seen

    def https_open(self, request):
        self.seen.append((request.full_url, request.get_header('Accept')))
        return super().https_open(request)


class MirrorDownloads(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mirror-download-')
        self.root = Path(self.temporary.name)
        self.config = self.root / 'release-mirror.conf'
        self.cache = self.root / 'cache'
        self.payload = fixtures.data_bytes(180000)
        self.expected = hashlib.sha256(self.payload).hexdigest()
        self.output = io.StringIO()
        self.redirect = contextlib.redirect_stderr(self.output)
        self.redirect.__enter__()
        self.attempts = []

    def tearDown(self):
        self.redirect.__exit__(None, None, None)
        self.temporary.cleanup()

    def configure(self, base, priority='fallback', kind='github', timeout=60):
        self.config.write_text(
            '# release-mirror-config-v1\n'
            f'RELEASE_MIRROR_URL={base}\nRELEASE_MIRROR_KIND={kind}\n'
            f'RELEASE_MIRROR_PRIORITY={priority}\nRELEASE_MIRROR_TIMEOUT={timeout}\n', encoding='utf-8')
        self.config.chmod(0o600)

    def download(self, origin, *, mirror_error=None):
        def factory(cache, url, expected, **options):
            self.attempts.append(url)
            downloader = Downloader(cache, url, expected, **options)
            if url == ORIGIN:
                downloader.opener = urllib.request.build_opener(
                    urllib.request.ProxyHandler({}), core.HTTPSRedirect(), fixtures.FixtureTransport(origin.port))
            elif mirror_error is not None:
                downloader.run = mock.Mock(side_effect=mirror_error)
            return downloader
        with mock.patch.object(core, 'Downloader', side_effect=factory):
            return core.release_download(self.cache, ORIGIN, self.expected, config_path=self.config)

    def test_mirror_serves_verified_bytes_and_repeat_reuses_cache(self):
        with fixtures.Fixture(self.payload) as mirror, fixtures.Fixture(self.payload) as origin:
            self.configure(f'http://127.0.0.1:{mirror.port}')
            result = self.download(origin)
            self.assertEqual(result.read_bytes(), self.payload)
            self.assertTrue(mirror.requests)
            self.assertEqual({path for path, _ in mirror.requests}, {SUFFIX})
            self.assertEqual(origin.requests, [])
            count = len(mirror.requests)
            self.assertEqual(self.download(origin), result)
            self.assertEqual(len(mirror.requests), count)
            self.assertEqual(origin.requests, [])

    def test_corrupt_mirror_falls_back_to_the_same_official_release(self):
        with fixtures.Fixture(self.payload, 'bad_sha') as mirror, fixtures.Fixture(self.payload) as origin:
            self.configure(f'http://127.0.0.1:{mirror.port}')
            self.assertEqual(self.download(origin).read_bytes(), self.payload)
            self.assertEqual(self.attempts[-1], ORIGIN)
            self.assertTrue(mirror.requests)
            self.assertTrue(origin.requests)
            self.assertEqual({path for path, _ in origin.requests}, {SUFFIX})
            self.assertIn('回退 GitHub 固定版本', self.output.getvalue())

    def test_always_never_falls_back_or_promotes_corrupt_bytes(self):
        with fixtures.Fixture(self.payload, 'bad_sha') as mirror, fixtures.Fixture(self.payload) as origin:
            self.configure(f'http://127.0.0.1:{mirror.port}', priority='always')
            with self.assertRaisesRegex(core.DownloadError, 'SHA256 mismatch'):
                self.download(origin)
            self.assertEqual(origin.requests, [])
            self.assertEqual(len(self.attempts), 1)
            self.assertFalse((self.cache / (self.expected + '.tar.gz')).exists())

    def test_missing_disabled_and_legacy_configs_preserve_official_download(self):
        for mode in ('missing', 'disabled', 'legacy'):
            with self.subTest(mode=mode), fixtures.Fixture(self.payload) as origin:
                self.cache = self.root / mode
                self.config.unlink(missing_ok=True)
                if mode == 'disabled':
                    self.configure('https://mirror.example.invalid', priority='disabled')
                elif mode == 'legacy':
                    self.config.write_text('RELEASE_MIRROR_DOMAIN="old.example.invalid"\n', encoding='utf-8')
                self.attempts.clear()
                self.assertEqual(self.download(origin).read_bytes(), self.payload)
                self.assertEqual(self.attempts, [ORIGIN])

    def test_oss_uses_the_synchronizer_object_key(self):
        with fixtures.Fixture(self.payload) as mirror, fixtures.Fixture(self.payload) as origin:
            self.configure(f'http://127.0.0.1:{mirror.port}', kind='oss')
            self.assertEqual(self.download(origin).read_bytes(), self.payload)
            self.assertEqual({path for path, _ in mirror.requests},
                             {'/releases/hxx344/project-aggregation/deploy-' + COMMIT + '/fixture.tar.gz'})
            self.assertEqual(origin.requests, [])

    def test_unavailable_mirror_falls_back_but_local_failures_and_cancellation_do_not(self):
        errors = [core.DownloadError('download failed: HTTP 404'), core.Cancelled('cancelled'),
                  core.LocalDownloadError('unsafe cache'), PermissionError('denied'), OSError(28, 'disk full')]
        for index, error in enumerate(errors):
            with self.subTest(error=type(error).__name__), fixtures.Fixture(self.payload) as origin:
                self.cache = self.root / f'failure-{index}'
                self.configure('http://127.0.0.1:8090')
                self.attempts.clear()
                if index == 0:
                    self.assertEqual(self.download(origin, mirror_error=error).read_bytes(), self.payload)
                    self.assertTrue(origin.requests)
                else:
                    with self.assertRaises(type(error)):
                        self.download(origin, mirror_error=error)
                    self.assertEqual(origin.requests, [])
                    self.assertEqual(len(self.attempts), 1)

    def test_mirror_deadline_closes_stalled_transfer_before_failover(self):
        opened = Downloader._open_request
        closed = Downloader.close_response
        foreign_closes = []

        def owned_request(downloader, request):
            response = opened(downloader, request)
            response.owner_thread = threading.get_ident()
            return response

        def owned_close(downloader, response):
            if response.owner_thread != threading.get_ident():
                foreign_closes.append(response.owner_thread)
            return closed(downloader, response)

        with fixtures.Fixture(self.payload, 'stall') as mirror, fixtures.Fixture(self.payload) as origin:
            self.configure(f'http://127.0.0.1:{mirror.port}', timeout=1)
            start = time.monotonic()
            with mock.patch.object(Downloader, '_open_request', owned_request), \
                    mock.patch.object(Downloader, 'close_response', owned_close):
                self.assertEqual(self.download(origin).read_bytes(), self.payload)
            self.assertLess(time.monotonic() - start, 4)
            self.assertTrue(mirror.started.is_set())
            self.assertTrue(origin.requests)
            self.assertEqual(foreign_closes, [], 'only the reader may close its HTTPResponse')

    def test_http_is_an_explicit_same_origin_exception_only(self):
        for value in ('http://mirror.example', 'http://localhost:8090', 'http://127.0.0.2:8090',
                      'https://name:secret@mirror.example', 'https://mirror.example/path',
                      'https://mirror.example?token=secret', 'https://mirror.example/#x',
                      'https://mirror.example:0', 'https://mirror.example:70000', 'https://bad..example',
                      'https://-bad.example', 'https://[fe80::1%eth0]'):
            with self.subTest(value=value), self.assertRaises(core.LocalDownloadError):
                core.mirror_base_url(value)
        for value in ('http://127.0.0.1:8090', 'http://[::1]:8090', 'https://mirror.example:443',
                      'https://[2001:db8::1]'):
            self.assertEqual(core.mirror_base_url(value), value)
        with self.assertRaises(core.DownloadError):
            Downloader(self.cache, 'http://127.0.0.1:8090/archive', self.expected)
        handler = core.HTTPSRedirect(core.mirror_origin('http://127.0.0.1:8090'))
        request = urllib.request.Request('http://127.0.0.1:8090/archive')
        for target in ('http://127.0.0.1:8091/archive', 'http://localhost:8090/archive', 'http://remote.test/archive'):
            with self.subTest(target=target), self.assertRaises(core.DownloadError):
                handler.redirect_request(request, None, 302, '', Message(), target)
        self.assertEqual(handler.redirect_request(request, None, 302, '', Message(),
                         'https://release-assets.githubusercontent.com/file').full_url,
                         'https://release-assets.githubusercontent.com/file')
        with self.assertRaises(core.DownloadError):
            handler.redirect_request(urllib.request.Request('https://mirror.test/archive'), None, 302, '',
                                     Message(), 'http://127.0.0.1:8090/archive')

    def test_configuration_is_data_and_invalid_new_settings_fail_closed(self):
        invalid = ['RELEASE_MIRROR_URL=$(touch bad)\n', 'RELEASE_MIRROR_URL=https://mirror.example\nUNKNOWN=x\n',
                   'RELEASE_MIRROR_URL=https://mirror.example\nRELEASE_MIRROR_TIMEOUT=0\n',
                   'RELEASE_MIRROR_URL=https://mirror.example\nRELEASE_MIRROR_PRIORITY=bogus\n',
                   'RELEASE_MIRROR_URL=https://mirror.example\nRELEASE_MIRROR_URL=https://other.example\n',
                   'x' * 4097]
        for content in invalid:
            with self.subTest(content=content[:80]):
                self.config.write_text(content, encoding='utf-8')
                with self.assertRaises(core.LocalDownloadError):
                    core.read_mirror_config(self.config)
        self.assertFalse((self.root / 'bad').exists())

    def test_other_repositories_and_unpinned_urls_do_not_consult_mirrors(self):
        for url in ('https://github.com/hxx344/other/releases/download/deploy-' + COMMIT + '/fixture.tar.gz',
                    'https://github.com/hxx344/project-aggregation/releases/latest/download/fixture.tar.gz'):
            with (self.subTest(url=url),
                  mock.patch.object(core, 'read_mirror_config', side_effect=AssertionError('not an archive')),
                  mock.patch.object(core, 'Downloader') as factory):
                factory.return_value.run.return_value = self.cache
                self.assertEqual(core.release_download(self.cache, url, self.expected), self.cache)
                factory.assert_called_once_with(self.cache, url, self.expected)

    @unittest.skipUnless(os.name == 'posix', 'Linux configuration ownership and modes')
    def test_configuration_links_and_untrusted_parents_are_rejected(self):
        self.configure('https://mirror.example')
        self.config.chmod(0o666)
        with self.assertRaises(core.LocalDownloadError):
            core.read_mirror_config(self.config)
        self.config.chmod(0o600)
        linked = self.root / 'linked.conf'
        linked.symlink_to(self.config)
        with self.assertRaises(core.LocalDownloadError):
            core.read_mirror_config(linked)
        unsafe = self.root / 'unsafe'
        unsafe.mkdir(mode=0o777)
        unsafe.chmod(0o777)
        other = unsafe / 'mirror.conf'
        other.write_bytes(self.config.read_bytes())
        with self.assertRaises(core.LocalDownloadError):
            core.read_mirror_config(other)


class GitHubApiFallback(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='api-fallback-')
        self.root = Path(self.temporary.name)
        self.config = self.root / 'release-mirror.conf'
        self.cache = self.root / 'cache'
        self.payload = fixtures.data_bytes(180000)
        self.expected = hashlib.sha256(self.payload).hexdigest()
        self.output = io.StringIO()
        self.redirect = contextlib.redirect_stderr(self.output)
        self.redirect.__enter__()
        self.attempts, self.seen = [], []

    def tearDown(self):
        self.redirect.__exit__(None, None, None)
        self.temporary.cleanup()

    def release(self):
        return {'tag_name': TAG, 'draft': False, 'prerelease': False, 'assets': [
            {'id': 7, 'name': 'release-manifest.json', 'state': 'uploaded', 'size': 512},
            {'id': 4242, 'name': 'fixture.tar.gz', 'state': 'uploaded', 'size': len(self.payload)}]}

    def metadata(self, release=None, status=200):
        return StatusFixture(status, json.dumps(self.release() if release is None else release).encode())

    def opener(self, port):
        return urllib.request.build_opener(urllib.request.ProxyHandler({}), core.HTTPSRedirect(),
                                           RecordingTransport(port, self.seen))

    def download(self, official, metadata, asset=None, *, url=ORIGIN, failures=None):
        failures = failures or {}

        def factory(cache, target, expected, **options):
            self.attempts.append(target)
            downloader = Downloader(cache, target, expected, **options)
            downloader.pause_retry = lambda attempt: attempt + 1 < core.ATTEMPTS
            if target in failures:
                downloader.run = mock.Mock(side_effect=failures[target])
            elif target == url:
                downloader.opener = self.opener(official.port)
            elif target == API_ASSET and asset is not None:
                downloader.opener = self.opener(asset.port)
            else:
                raise AssertionError('unexpected download URL ' + target)
            return downloader
        with mock.patch.object(core, 'Downloader', side_effect=factory), \
                mock.patch.object(core, 'api_opener', lambda: self.opener(metadata.port)):
            return core.release_download(self.cache, url, self.expected, config_path=self.config)

    def test_official_outage_downloads_the_pinned_asset_through_the_api(self):
        for status in (503, 504):
            with self.subTest(status=status), StatusFixture(status) as official, self.metadata() as metadata, \
                    fixtures.Fixture(self.payload) as asset:
                self.cache = self.root / f'outage-{status}'
                self.attempts.clear()
                self.seen.clear()
                result = self.download(official, metadata, asset)
                self.assertEqual(result.read_bytes(), self.payload)
                self.assertEqual(self.attempts, [ORIGIN, API_ASSET])
                self.assertEqual(len(official.requests), core.ATTEMPTS)
                self.assertEqual([path for path, _ in metadata.requests], [TAG_PATH])
                headers = metadata.requests[0][1]
                self.assertEqual(headers['Accept'], 'application/vnd.github+json')
                self.assertEqual(headers['User-Agent'], 'project-aggregation-installer')
                api = [accept for target, accept in self.seen if target == API_ASSET]
                self.assertTrue(asset.requests)
                self.assertEqual(len(api), len(asset.requests))
                self.assertEqual(set(api), {'application/octet-stream'})
                self.assertIn('改用 GitHub API 文件接口', self.output.getvalue())

    def test_mirror_fallback_then_official_outage_still_uses_the_api(self):
        mirror = 'http://127.0.0.1:8090' + SUFFIX
        self.config.write_text('RELEASE_MIRROR_URL=http://127.0.0.1:8090\nRELEASE_MIRROR_PRIORITY=fallback\n',
                               encoding='utf-8')
        self.config.chmod(0o600)
        with StatusFixture(503) as official, self.metadata() as metadata, fixtures.Fixture(self.payload) as asset:
            result = self.download(official, metadata, asset,
                                   failures={mirror: core.DownloadError('download failed: HTTP 404')})
            self.assertEqual(result.read_bytes(), self.payload)
            self.assertEqual(self.attempts, [mirror, ORIGIN, API_ASSET])

    def test_terminal_official_failures_never_query_the_api(self):
        with StatusFixture(404) as official, self.metadata() as metadata:
            with self.assertRaisesRegex(core.DownloadError, 'HTTP 404'):
                self.download(official, metadata)
            self.assertEqual(metadata.requests, [])
            self.assertEqual(self.attempts, [ORIGIN])
        with fixtures.Fixture(self.payload, 'bad_sha') as official, self.metadata() as metadata:
            self.cache = self.root / 'bad-sha'
            with self.assertRaisesRegex(core.DownloadError, 'SHA256 mismatch'):
                self.download(official, metadata)
            self.assertEqual(metadata.requests, [])
            self.assertFalse((self.cache / (self.expected + '.tar.gz')).exists())

    def test_unusable_release_metadata_keeps_the_original_error(self):
        def change(path, value):
            def apply(release):
                target = release
                for key in path[:-1]:
                    target = target[key]
                if value is KeyError:
                    del target[path[-1]]
                else:
                    target[path[-1]] = value
            return apply
        cases = {
            'tag': change(('tag_name',), 'deploy-' + 'b' * 40), 'draft': change(('draft',), True),
            'prerelease': change(('prerelease',), True), 'draft-missing': change(('draft',), KeyError),
            'asset-missing': change(('assets', 1, 'name'), 'other.tar.gz'),
            'asset-duplicate': lambda release: release['assets'].append(copy.deepcopy(release['assets'][1])),
            'assets-invalid': change(('assets',), {}), 'state': change(('assets', 1, 'state'), 'starter'),
            'id-zero': change(('assets', 1, 'id'), 0), 'id-text': change(('assets', 1, 'id'), '4242'),
            'id-bool': change(('assets', 1, 'id'), True), 'id-float': change(('assets', 1, 'id'), 4242.0),
            'size-zero': change(('assets', 1, 'size'), 0), 'size-large': change(('assets', 1, 'size'), core.MAX_SIZE + 1),
            'size-text': change(('assets', 1, 'size'), '180000'),
        }
        responses = []
        for name, mutate in cases.items():
            release = self.release()
            mutate(release)
            responses.append((name, json.dumps(release).encode(), 200, 1))
        responses += [('json', b'not json', 200, 1), ('oversized', b' ' * (1024 * 1024 + 1), 200, 1),
                      ('lookup-404', b'{}', 404, 1), ('lookup-503', b'{}', 503, 2)]
        with StatusFixture(503) as official, StatusFixture(200) as metadata, fixtures.Fixture(self.payload) as asset:
            for name, body, status, count in responses:
                with self.subTest(case=name):
                    metadata.status, metadata.body = status, body
                    metadata.requests.clear()
                    self.cache = self.root / name
                    self.attempts.clear()
                    self.output.seek(0)
                    self.output.truncate()
                    with self.assertRaisesRegex(core.Retryable, 'HTTP 503'):
                        self.download(official, metadata, asset)
                    self.assertEqual(self.attempts, [ORIGIN])
                    self.assertEqual(len(metadata.requests), count)
                    self.assertEqual(asset.requests, [])
                    self.assertIn('GitHub API 文件接口下载失败', self.output.getvalue())

    def test_api_asset_hash_mismatch_is_never_promoted(self):
        with StatusFixture(503) as official, self.metadata() as metadata, \
                fixtures.Fixture(self.payload, 'bad_sha') as asset:
            with self.assertRaisesRegex(core.Retryable, 'HTTP 503'):
                self.download(official, metadata, asset)
            self.assertEqual(self.attempts, [ORIGIN, API_ASSET])
            self.assertIn('SHA256 mismatch', self.output.getvalue())
            self.assertFalse((self.cache / (self.expected + '.tar.gz')).exists())

    def test_cancellation_local_and_os_errors_never_use_the_api(self):
        with StatusFixture(503) as official, self.metadata() as metadata:
            for error in (core.Cancelled('cancelled'), core.LocalDownloadError('unsafe cache'), OSError(28, 'disk full')):
                with self.subTest(phase='official', error=type(error).__name__):
                    self.attempts.clear()
                    with self.assertRaises(type(error)):
                        self.download(official, metadata, failures={ORIGIN: error})
                    self.assertEqual(metadata.requests, [])
                    self.assertEqual(self.attempts, [ORIGIN])
            for error in (core.Cancelled('cancelled'), core.LocalDownloadError('unsafe cache')):
                with self.subTest(phase='api', error=type(error).__name__):
                    self.attempts.clear()
                    with self.assertRaises(type(error)):
                        self.download(official, metadata, failures={API_ASSET: error})
                    self.assertEqual(self.attempts, [ORIGIN, API_ASSET])

    def test_other_repositories_and_unpinned_urls_never_use_the_api(self):
        for url in ('https://github.com/hxx344/other/releases/download/' + TAG + '/fixture.tar.gz',
                    'https://github.com/hxx344/project-aggregation/releases/latest/download/fixture.tar.gz',
                    'https://github.com/hxx344/project-aggregation/releases/download/v1.0.0/fixture.tar.gz'):
            with self.subTest(url=url), StatusFixture(503) as official, self.metadata() as metadata:
                self.attempts.clear()
                with self.assertRaisesRegex(core.Retryable, 'HTTP 503'):
                    self.download(official, metadata, url=url)
                self.assertEqual(self.attempts, [url])
                self.assertEqual(metadata.requests, [])

if __name__ == '__main__':
    unittest.main()
