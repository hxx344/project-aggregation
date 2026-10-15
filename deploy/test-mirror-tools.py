"""Local transport and orchestration regressions; no service install or external downloads."""
import contextlib
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import ssl
import subprocess
import tarfile
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
BASH = os.environ.get('TEST_BASH') or ('D:/Git/bin/bash.exe' if os.name == 'nt' else shutil.which('bash'))

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

mirror = load('mirror_tools', ROOT / 'deploy/mirror-tools.py')
oss = load('oss_sync', ROOT / 'deploy/sync-release-to-oss.py')
PAYLOAD = b'verified release fixture\n' * 100
DIGEST = hashlib.sha256(PAYLOAD).hexdigest()
COMMIT = 'a' * 40
MANIFEST = {'schema': 1, 'repository': mirror.REPOSITORY, 'commit': COMMIT, 'tag': 'deploy-' + COMMIT,
            'artifacts': {'linux-x64': {'file': 'fixture-linux-x64.tar.gz', 'sha256': DIGEST}}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == '/timeout':
            time.sleep(0.3)
        if self.path in ('/redirect', '/bad-redirect', '/loop'):
            self.send_response(302)
            self.send_header('Location', {'/redirect': '/ok', '/bad-redirect': 'http://example.com/data', '/loop': '/loop'}[self.path])
            self.end_headers()
            return
        if self.path == '/404':
            self.send_error(404)
            return
        body = b'' if self.path == '/empty' else b'incorrect' if self.path == '/hashbad' else PAYLOAD
        self.send_response(206 if self.path == '/partial' else 200)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Cache-Status', 'HIT')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


class MirrorTools(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.work = Path(self.temp.name)
        self.machine = patch.object(mirror.platform, 'machine', return_value='x86_64')
        self.machine.start()

    def tearDown(self):
        self.machine.stop()
        self.temp.cleanup()

    def test_success_redirect_hash_and_cache_header(self):
        for path in ('/ok', '/redirect'):
            result = mirror.download(self.base + path, self.work / 'artifact', DIGEST, progress=False)
            self.assertEqual((self.work / 'artifact').read_bytes(), PAYLOAD)
            self.assertEqual(result['status'], 'passed')
            self.assertEqual(result['cache_status'], 'HIT')
            self.assertEqual(result['url'], self.base + '/ok')
            self.assertGreater(result['seconds'], 0)

    def test_http_failures_never_leave_partial_or_report_success(self):
        for path in ('/404', '/empty', '/hashbad', '/partial', '/bad-redirect', '/loop', '/timeout'):
            with self.subTest(path=path), self.assertRaises((OSError, ValueError)):
                mirror.download(self.base + path, self.work / 'artifact', DIGEST, timeout=0.1, progress=False)
            self.assertFalse((self.work / 'artifact').exists())
            self.assertFalse((self.work / 'artifact.part').exists())

    def test_production_protocol_and_base_url_policy(self):
        for value in ('http://localhost:8090', 'http://example.com', 'https://user:pass@example.com',
                      'https://example.com/releases', 'https://example.com?x=1', 'https://example.com/#x',
                      'https://example.com\n', 'https://example.com:99999', 'http://127.0.0.2',
                      'https://exa_mple.com', 'https://example..com', 'https://example.com\\x',
                      'https://example.com/', 'https://example%2ecom'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                mirror.validate_url(value, base=True)
        self.assertEqual(mirror.validate_url('http://[::1]:8090', base=True), 'http://[::1]:8090')
        with self.assertRaises(ValueError):
            mirror.download(self.base + '/ok', self.work / 'artifact', official=True)
        redirect = mirror.RestrictedRedirect(official=True)
        with self.assertRaises(ValueError):
            redirect.redirect_request(urllib.request.Request('https://github.com/file'), None, 302, '', {}, self.base + '/ok')

    def test_redirect_cannot_downgrade_or_change_local_origin(self):
        request = urllib.request.Request(self.base + '/file')
        redirect = mirror.RestrictedRedirect(initial_http_origin=mirror.origin(self.base))
        accepted = redirect.redirect_request(request, None, 302, '', {}, self.base + '/ok')
        self.assertEqual(accepted.full_url, self.base + '/ok')
        for target in ('http://127.0.0.1:1/file', 'http://[::1]:8090/file'):
            with self.assertRaises(ValueError):
                redirect.redirect_request(request, None, 302, '', {}, target)
        redirect.redirect_request(request, None, 302, '', {}, 'https://github.com/file')
        with self.assertRaises(ValueError):
            redirect.redirect_request(request, None, 302, '', {}, self.base + '/file')
        with self.assertRaises(ValueError):
            mirror.RestrictedRedirect().redirect_request(urllib.request.Request('https://mirror.example/file'),
                                                         None, 302, '', {}, self.base + '/file')

    def test_https_with_fixture_ca_and_default_certificate_rejection(self):
        openssl = shutil.which('openssl') or ('D:/Git/usr/bin/openssl.exe' if os.name == 'nt' else None)
        if not openssl or not Path(openssl).exists():
            self.skipTest('OpenSSL unavailable for local TLS fixture')
        key, cert = self.work / 'key.pem', self.work / 'cert.pem'
        subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key),
                        '-out', str(cert), '-days', '1', '-subj', '/CN=127.0.0.1',
                        '-addext', 'subjectAltName=IP:127.0.0.1'], check=True, capture_output=True)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f'https://127.0.0.1:{server.server_port}/redirect'
        try:
            with self.assertRaises(OSError):
                mirror.download(url, self.work / 'artifact', DIGEST, progress=False)
            client = urllib.request.build_opener(mirror.RestrictedRedirect(official=True),
                                                 urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=cert)))
            result = mirror.download(url, self.work / 'artifact', DIGEST, official=True, opener=client, progress=False)
            self.assertEqual(result['sha256'], DIGEST)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_manifest_identity_and_hash_fields(self):
        self.assertEqual(mirror.validate_manifest(copy.deepcopy(MANIFEST)), MANIFEST)
        for key, value in [('schema', True), ('schema', 2), ('repository', 'attacker/repo'),
                           ('commit', 'main'), ('tag', 'v1'), ('artifacts', {})]:
            bad = copy.deepcopy(MANIFEST)
            bad[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                mirror.validate_manifest(bad)
        for key, value in [('file', '../archive.tar.gz'), ('file', 'file;touch.tar.gz'), ('sha256', 'bad')]:
            bad = copy.deepcopy(MANIFEST)
            bad['artifacts']['linux-x64'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                mirror.validate_manifest(bad)

    def test_github_and_oss_url_paths(self):
        item = MANIFEST['artifacts']['linux-x64']
        self.assertEqual(mirror.artifact_url(MANIFEST, item, self.base),
                         f'{self.base}/hxx344/project-aggregation/releases/download/deploy-{COMMIT}/fixture-linux-x64.tar.gz')
        self.assertEqual(mirror.artifact_url(MANIFEST, item, 'https://oss.example', 'oss'),
                         f'https://oss.example/releases/hxx344/project-aggregation/deploy-{COMMIT}/fixture-linux-x64.tar.gz')

    def test_config_is_strict_data_and_disabled_is_distinct(self):
        path = self.work / 'mirror.conf'
        value = 'RELEASE_MIRROR_URL=http://127.0.0.1:8090\nRELEASE_MIRROR_KIND=github\nRELEASE_MIRROR_PRIORITY=disabled\nRELEASE_MIRROR_TIMEOUT=60\n'
        path.write_text(value, encoding='utf-8')
        config = mirror.read_config(path)
        self.assertEqual(config['RELEASE_MIRROR_PRIORITY'], 'disabled')
        for suffix in ('RELEASE_MIRROR_TIMEOUT=2\n', 'UNKNOWN=1\n', '$(touch /tmp/unwanted)\n'):
            path.write_text(value + suffix, encoding='utf-8')
            with self.assertRaises(ValueError):
                mirror.read_config(path)
        with patch.object(mirror, 'measure', return_value={'name': 'GitHub', 'status': 'passed'}) as measured, patch.dict(os.environ, {}, clear=True):
            results = mirror.run_performance(MANIFEST, self.work, 60, 1, config)
        self.assertEqual(measured.call_count, 1)
        self.assertEqual(results[1]['status'], 'disabled')
        self.assertIsNone(mirror.read_config(self.work / 'absent'))
        path.write_text('RELEASE_MIRROR_DOMAIN="mirror.example"\nRELEASE_MIRROR_HEALTH_CHECK="https://mirror.example/health"\n', encoding='utf-8')
        with contextlib.redirect_stderr(io.StringIO()) as warning:
            self.assertIsNone(mirror.read_config(path))
        self.assertIn('旧版镜像', warning.getvalue())
        path.write_text('RELEASE_MIRROR_PRIORITY="disabled"\n', encoding='utf-8')
        self.assertEqual(mirror.read_config(path)['RELEASE_MIRROR_PRIORITY'], 'disabled')
        path.write_text('RELEASE_MIRROR_URL="https://mirror.example"\n', encoding='utf-8')
        self.assertEqual(mirror.read_config(path)['RELEASE_MIRROR_TIMEOUT'], 60)

    def test_failed_baseline_never_claims_speedup(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            mirror.report([{'name': 'GitHub', 'status': 'failed'},
                           {'name': '镜像', 'status': 'passed', 'seconds': .01},
                           {'name': 'OSS', 'status': 'unconfigured'}])
        report = output.getvalue()
        self.assertIn('基线失败，无法比较', report)
        self.assertNotIn('%', report)
        self.assertIn('未配置', report)
        self.assertIn('git fetch', report)

    def test_test_only_never_requires_root_and_explicit_deploy_skips_redundant_speed_tests(self):
        manifest_path = self.work / 'manifest.json'
        manifest_path.write_text(json.dumps(MANIFEST), encoding='utf-8')
        with patch.object(mirror, 'resolve_manifest', return_value=(MANIFEST, manifest_path)), \
             patch.object(mirror, 'read_config', return_value=None), \
             patch.object(mirror, 'run_performance', side_effect=lambda *_a: [{'name': 'GitHub', 'status': 'failed'}]) as measured, \
             patch.object(mirror, 'deploy_local') as deploy, \
             patch.dict(os.environ, {}, clear=True), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(mirror.main(['optimize']), 1)
            deploy.assert_not_called()
            self.assertEqual(mirror.main(['optimize', '--deploy-local', '--verify']), 0)
            self.assertEqual(deploy.call_count, 1)
            self.assertEqual(measured.call_count, 1)
            self.assertTrue(deploy.call_args.kwargs['verify'])
            with patch.dict(os.environ, {'AUTO_DEPLOY': 'true'}):
                mirror.main(['optimize', '--test-only'])
            self.assertEqual(deploy.call_count, 1)

    def test_local_deployment_delegates_single_artifact_verification_to_configure(self):
        with patch.object(mirror.os, 'geteuid', return_value=0, create=True), \
             patch.object(mirror, 'prepare_deploy_scripts', return_value=self.work), \
             patch.object(mirror.subprocess, 'run') as runner, \
             patch.object(mirror, 'measure', return_value={'status': 'passed'}) as measured:
            mirror.deploy_local(MANIFEST, self.work / 'manifest.json', self.work, 60, self.work, verify=True)
        self.assertEqual(runner.call_count, 2)
        config_args = runner.call_args.args[0]
        self.assertIn('--manifest', config_args)
        self.assertIn('--priority', config_args)
        self.assertIn('--verify', config_args)
        measured.assert_not_called()

    def test_verify_cli_downloads_exact_artifact_and_digest_once(self):
        result = {'status': 'passed', 'cache_status': 'MISS'}
        with patch.object(mirror, 'resolve_manifest', return_value=(MANIFEST, self.work / 'manifest.json')), \
             patch.object(mirror, 'download', return_value=result) as downloaded, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(mirror.main(['verify', '--url', self.base]), 0)
        self.assertEqual(downloaded.call_count, 1)
        arguments = downloaded.call_args.args
        self.assertIn('/hxx344/project-aggregation/releases/download/deploy-' + COMMIT, arguments[0])
        self.assertEqual(arguments[2], DIGEST)
        self.assertEqual(json.loads(output.getvalue())['cache_status'], 'MISS')

    def test_script_downloads_are_pinned_to_manifest_commit(self):
        urls = []
        with patch.object(mirror, 'local_release_scripts', return_value=None), \
             patch.object(mirror, 'download', side_effect=lambda url, *_a, **_kw: urls.append(url)):
            mirror.prepare_deploy_scripts(MANIFEST, self.work, self.work / 'missing')
        self.assertEqual(len(urls), 3)
        self.assertTrue(all('/' + COMMIT + '/deploy/' in url for url in urls))
        self.assertTrue(all('/main/' not in url for url in urls))

    def test_local_scripts_reuse_only_selected_git_content(self):
        scripts = self.work / 'deploy'
        scripts.mkdir()
        for name in ('setup-release-mirror.sh', 'configure-release-mirror.sh', 'mirror-tools.py'):
            (scripts / name).write_text('selected version\n', encoding='utf-8')
        def git(*arguments):
            return subprocess.run(['git', '-C', str(self.work), *arguments], check=True,
                                  text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()
        git('init', '-q')
        git('add', 'deploy')
        git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
        commit = git('rev-parse', 'HEAD')
        self.assertEqual(mirror.local_release_scripts(scripts, commit), scripts)
        (scripts / 'setup-release-mirror.sh').write_text('unpublished version\n', encoding='utf-8')
        self.assertIsNone(mirror.local_release_scripts(scripts, commit))

    def test_speed_flow_extracts_verified_bundle_and_fails_missing_runtime_files(self):
        def download_bundle(_url, destination, *_args, **_kwargs):
            with tarfile.open(destination, 'w:gz') as archive:
                for name in mirror.REQUIRED_FILES:
                    content = b'fixture'
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))
            return {'bytes': Path(destination).stat().st_size, 'seconds': 1, 'speed_mib': 1}
        with patch.object(mirror, 'download', side_effect=download_bundle), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(mirror.run_download_speed(MANIFEST, self.work, 60), 0)
        with patch.object(mirror, 'download', side_effect=download_bundle), \
             patch.object(mirror, 'REQUIRED_FILES', ('missing-file',)), contextlib.redirect_stdout(io.StringIO()):
            other = self.work / 'other'
            other.mkdir()
            # A genuinely missing file is tested with an empty, valid archive.
            def empty_bundle(_url, destination, *_args, **_kwargs):
                with tarfile.open(destination, 'w:gz'):
                    pass
                return {'bytes': 10, 'seconds': 1, 'speed_mib': 1}
            with patch.object(mirror, 'download', side_effect=empty_bundle), self.assertRaisesRegex(ValueError, '运行文件缺失'):
                mirror.run_download_speed(MANIFEST, other, 60)

    def test_cancel_download_cleans_partial(self):
        class Interrupted:
            def open(self, *_args, **_kwargs):
                raise KeyboardInterrupt
        with self.assertRaises(KeyboardInterrupt):
            mirror.download(self.base + '/ok', self.work / 'artifact', DIGEST, opener=Interrupted())
        self.assertEqual(list(self.work.iterdir()), [])

    def test_shell_terminal_and_pipe_exit_codes_and_cleanup(self):
        # A fake python3 handles only launcher invocations; it never contacts the network.
        bin_dir = self.work / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'python3').write_text('#!/usr/bin/env bash\ncase "$2" in\n  -) cat >/dev/null; printf "%s\\n" "' + COMMIT + '";;\n  *) printf "%s\\n" "$@" >> "$FIXTURE_LOG"; exit "${FIXTURE_STATUS:-0}";;\nesac\n', encoding='utf-8', newline='\n')
        (bin_dir / 'curl').write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$@" >> "$FIXTURE_CURL"\nwhile (( $# )); do if [[ "$1" == -o ]]; then printf "fixture\\n" > "$2"; break; fi; shift; done\nprintf "%s" "${FIXTURE_HTTP:-200}"\n', encoding='utf-8', newline='\n')
        for file in bin_dir.iterdir():
            file.chmod(0o755)
        bash_env = self.work / 'bash-env'
        bash_env.write_text('export PATH="' + ('$(cygpath -u "$FIXTURE_BIN")' if os.name == 'nt' else '$FIXTURE_BIN') + ':$PATH"\n',
                            encoding='utf-8', newline='\n')
        env = {**os.environ, 'PATH': bin_dir.as_posix() + os.pathsep + os.environ['PATH'],
               'BASH_ENV': bash_env.as_posix(), 'FIXTURE_BIN': bin_dir.as_posix(),
               'FIXTURE_LOG': (self.work / 'log').as_posix(), 'FIXTURE_CURL': (self.work / 'curl-log').as_posix(),
               'TMPDIR': self.work.as_posix(), 'FIXTURE_STATUS': '7'}
        for relative in ('deploy/test-mirror-performance.sh', 'deploy/one-click-optimize.sh', 'test-download-speed.sh'):
            path = ROOT / relative
            result = subprocess.run([BASH, str(path)], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 7, result.stdout + result.stderr)
            result = subprocess.run([BASH], input=path.read_text(encoding='utf-8'), env=env, cwd=self.work,
                                    text=True, encoding='utf-8', capture_output=True)
            self.assertEqual(result.returncode, 7, result.stdout + result.stderr)
        log = (self.work / 'curl-log').read_text(encoding='utf-8')
        self.assertIn('/' + COMMIT + '/deploy/mirror-tools.py', log)
        self.assertNotIn('/main/', log)
        self.assertIn('--proto-redir', log)
        self.assertFalse(list(self.work.glob('tmp.*')))
        result = subprocess.run([BASH], input=(ROOT / 'deploy/one-click-optimize.sh').read_text(encoding='utf-8'),
                                env={**env, 'FIXTURE_HTTP': '206'}, cwd=self.work, text=True, encoding='utf-8', capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('206', result.stderr)
        self.assertFalse(list(self.work.glob('tmp.*')))

    @unittest.skipIf(os.name == 'nt', 'POSIX signal delivery and process cleanup are checked in Linux CI')
    def test_shell_cancellation_stops_child_and_cleans_bootstrap_directory(self):
        bin_dir = self.work / 'bin'
        bin_dir.mkdir()
        python_stub = bin_dir / 'python3'
        python_stub.write_text('#!/usr/bin/env bash\nif [[ "$2" == - ]]; then cat >/dev/null; printf "%s\\n" "' + COMMIT + '"; exit; fi\ntrap \'rm -f -- "$FIXTURE_MARKER"; exit 143\' TERM INT\nprintf ready > "$FIXTURE_MARKER"\nwhile :; do sleep 0.1; done\n', encoding='utf-8')
        curl_stub = bin_dir / 'curl'
        curl_stub.write_text('#!/usr/bin/env bash\nwhile (( $# )); do if [[ "$1" == -o ]]; then printf fixture > "$2"; break; fi; shift; done\nprintf 200\n', encoding='utf-8')
        for file in (python_stub, curl_stub):
            file.chmod(0o755)
        marker = self.work / 'running'
        env = {**os.environ, 'PATH': str(bin_dir) + os.pathsep + os.environ['PATH'],
               'FIXTURE_MARKER': str(marker), 'TMPDIR': str(self.work)}
        process = subprocess.Popen([BASH], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, env=env, cwd=self.work, start_new_session=True)
        try:
            process.stdin.write((ROOT / 'deploy/one-click-optimize.sh').read_bytes())
            process.stdin.close()
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(.05)
            self.assertTrue(marker.exists())
            process.send_signal(signal.SIGTERM)
            self.assertEqual(process.wait(timeout=5), 143)
            self.assertFalse(marker.exists())
            self.assertFalse(list(self.work.glob('tmp.*')))
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
    def test_oss_missing_credentials_is_failure(self):
        with self.assertRaises(ValueError):
            oss.oss_configuration(self.work, {})

    def test_oss_hash_before_upload_and_reuse_verified_remote(self):
        manifest_path = self.work / 'manifest.json'
        manifest_path.write_text(json.dumps(MANIFEST), encoding='utf-8')
        with patch.object(oss, 'remote_matches', return_value=True), \
             patch.object(oss.mirror, 'download') as downloaded, patch.object(oss, 'oss_copy') as copied:
            oss.synchronize(MANIFEST, manifest_path, 'bucket', self.work / 'conf', self.work)
            downloaded.assert_not_called()
            copied.assert_not_called()
        def corrupt(_url, destination, *_args, **_kwargs):
            Path(destination).write_bytes(b'old release with same name')
        with patch.object(oss, 'remote_matches', return_value=False), \
             patch.object(oss.mirror, 'download', side_effect=corrupt), patch.object(oss, 'oss_copy') as copied:
            with self.assertRaisesRegex(ValueError, '上传前 SHA256'):
                oss.synchronize(MANIFEST, manifest_path, 'bucket', self.work / 'conf', self.work)
            copied.assert_not_called()

    def test_oss_upload_uses_versioned_path_and_verifies_after_upload(self):
        manifest_path = self.work / 'manifest.json'
        manifest_path.write_text(json.dumps(MANIFEST), encoding='utf-8')
        def downloaded(_url, destination, *_args, **_kwargs):
            Path(destination).write_bytes(PAYLOAD)
        with patch.object(oss, 'remote_matches', side_effect=[False, True, False, True]) as verify, \
             patch.object(oss.mirror, 'download', side_effect=downloaded), \
             patch.object(oss, 'oss_copy', return_value=True) as copied:
            oss.synchronize(MANIFEST, manifest_path, 'bucket', self.work / 'conf', self.work)
        self.assertEqual(copied.call_count, 2)
        self.assertEqual(verify.call_count, 4)
        for call in copied.call_args_list:
            self.assertIn(f'/releases/{mirror.REPOSITORY}/deploy-{COMMIT}/', call.args[1])
        self.assertTrue(copied.call_args.args[1].endswith('/release-manifest.json'))


if __name__ == '__main__':
    unittest.main()
