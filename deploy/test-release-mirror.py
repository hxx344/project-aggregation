"""Exercise mirror selection in the actual embedded, integrity-checked downloader."""
import contextlib
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
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
        with fixtures.Fixture(self.payload, 'stall') as mirror, fixtures.Fixture(self.payload) as origin:
            self.configure(f'http://127.0.0.1:{mirror.port}', timeout=1)
            start = time.monotonic()
            self.assertEqual(self.download(origin).read_bytes(), self.payload)
            self.assertLess(time.monotonic() - start, 4)
            self.assertTrue(mirror.started.is_set())
            self.assertTrue(origin.requests)

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


if __name__ == '__main__':
    unittest.main()
