"""Real Linux nginx test using the production templates and a local TLS upstream.

Only transport addresses/CA/listen are substituted; redirect allowlists, cache
keys, status checks, and response handling are the production configuration.
Run: python3 deploy/test-mirror-nginx.py (nginx and openssl must be installed).
"""
import hashlib
import http.server
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LINUX = sys.platform == 'linux' and 'microsoft' not in os.uname().release.lower()
AVAILABLE = LINUX and shutil.which('nginx') and shutil.which('openssl')
REVISION = 'a' * 40
RELEASE_PATH = '/hxx344/project-aggregation/releases/download/deploy-' + REVISION + '/'
PAYLOAD = (b'fixed-release-archive-body\x00\xff' * 16384)


def template(name):
    source = (ROOT / 'deploy/setup-release-mirror.sh').read_text(encoding='utf-8')
    return re.search(r"<<'" + name + r"'\n(.*?)\n" + name, source, re.S).group(1) + '\n'


@unittest.skipUnless(AVAILABLE, 'requires native Linux nginx and openssl; no WSL fallback')
class NginxMirrorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='mirror-nginx-')
        cls.base = Path(cls.temporary.name)
        cls.requests = []
        cls.sni = []
        cls.lock = threading.Lock()
        cls.certificate, cls.key = cls.base / 'ca.pem', cls.base / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=github.com', '-addext',
                        'subjectAltName=DNS:github.com,DNS:release-assets.githubusercontent.com',
                        '-addext', 'basicConstraints=critical,CA:TRUE',
                        '-keyout', str(cls.key), '-out', str(cls.certificate)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        class Upstream(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_):
                pass

            def do_GET(self):
                host = self.headers.get('Host')
                with cls.lock:
                    cls.requests.append((host, self.path, dict(self.headers)))
                name = self.path.split('/')[-1].split('?')[0]
                if host == 'github.com':
                    location = ('https://evil.example/forbidden' if name == 'badredirect.tar.gz'
                                else 'https://release-assets.githubusercontent.com/assets/' + name + '?token=fixed')
                    self.send_response(302)
                    self.send_header('Location', location)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                elif host == 'release-assets.githubusercontent.com':
                    if name == 'chained.tar.gz':
                        self.send_response(302)
                        self.send_header('Location', 'https://evil.example/forbidden')
                        self.send_header('Content-Length', '0')
                        self.end_headers()
                        return
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Cache-Control', 'private, max-age=0')
                    self.send_header('Set-Cookie', 'upstream=private')
                    self.send_header('Content-Length', str(len(PAYLOAD)))
                    self.end_headers()
                    self.wfile.write(PAYLOAD)
                else:
                    self.send_error(400)

        cls.upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.certificate, cls.key)
        context.set_servername_callback(lambda sock, name, ctx: cls.sni.append(name))
        cls.upstream.socket = context.wrap_socket(cls.upstream.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.upstream.shutdown()
        cls.upstream.server_close()
        cls.thread.join(timeout=5)
        cls.temporary.cleanup()

    def setUp(self):
        self.work = self.base / self._testMethodName
        self.work.mkdir()
        cache = self.work / 'cache'
        cache.mkdir()
        with socket.socket() as free:
            free.bind(('127.0.0.1', 0))
            self.port = free.getsockname()[1]
        upstream = 'https://127.0.0.1:' + str(self.upstream.server_port)
        global_conf = template('NGINX_GLOBAL').replace('CACHE_DIRECTORY', cache.as_posix())
        # Preserve the production whitelist, then map only its accepted URL to a
        # local transport. There is deliberately no production override variable.
        global_conf += '''map $release_asset_url $test_asset_transport {
    default "";
    ~^https://release-assets[.]githubusercontent[.]com(?<test_asset_path>/.*)$ TRANSPORT$test_asset_path;
}
'''.replace('TRANSPORT', upstream)
        site = template('NGINX_SITE').replace('MIRROR_LISTEN', '127.0.0.1:' + str(self.port))
        site = site.replace('MIRROR_RESOLVERS', '127.0.0.1')
        site = site.replace('/etc/ssl/certs/ca-certificates.crt', self.certificate.as_posix())
        site = site.replace('proxy_pass https://github.com;', 'proxy_pass ' + upstream + ';')
        site = site.replace('proxy_pass $release_asset_url;', 'proxy_pass $test_asset_transport;')
        if self._testMethodName == 'test_upstream_certificate_name_is_verified':
            site = site.replace('proxy_ssl_name $mirror_upstream_host;', 'proxy_ssl_name wrong.example;')
        self.config = self.work / 'nginx.conf'
        temporary_paths = ''.join(name + '_temp_path ' + (self.work / name).as_posix() + ';\n'
                                  for name in ('client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'))
        self.config.write_text('pid ' + (self.work / 'nginx.pid').as_posix() + ';\n'
                               'error_log ' + (self.work / 'error.log').as_posix() + ' info;\n'
                               'events {}\nhttp {\naccess_log off;\n' + temporary_paths + global_conf + site + '\n}\n', encoding='utf-8')
        command = [shutil.which('nginx'), '-p', str(self.work) + '/', '-c', str(self.config)]
        check = subprocess.run(command + ['-t'], capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stdout + check.stderr)
        self.log_handle = (self.work / 'stderr.log').open('wb')
        self.process = subprocess.Popen(command + ['-g', 'daemon off; master_process off;'],
                                        stdout=self.log_handle, stderr=self.log_handle)
        self.addCleanup(self.stop)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                status, _, body = self.get('/health')
                if status == 200 and body == b'OK\n':
                    return
            except (OSError, urllib.error.URLError):
                time.sleep(0.03)
        self.fail('nginx did not start: ' + self.error_log())

    def error_log(self):
        path = self.work / 'error.log'
        return path.read_text() if path.exists() else ''

    def stop(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.log_handle.close()

    def get(self, path, headers=None, method='GET'):
        request = urllib.request.Request('http://127.0.0.1:' + str(self.port) + path,
                                         headers=headers or {}, method=method)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            response = opener.open(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def test_redirect_body_cache_hit_and_range_are_real(self):
        path = RELEASE_PATH + 'body.tar.gz'
        before = len(self.requests)
        status, headers, body = self.get(path, {'Authorization': 'secret', 'Cookie': 'private=1'})
        self.assertEqual(status, 200, self.error_log())
        self.assertEqual(hashlib.sha256(body).digest(), hashlib.sha256(PAYLOAD).digest())
        self.assertEqual(headers.get('X-Cache-Status'), 'MISS')
        self.assertIsNone(headers.get('Location'))
        self.assertIsNone(headers.get('Set-Cookie'))
        status, headers, body = self.get(path)
        self.assertEqual((status, body), (200, PAYLOAD))
        self.assertEqual(headers.get('X-Cache-Status'), 'HIT', self.error_log())
        status, headers, body = self.get(path, {'Range': 'bytes=11-50'})
        self.assertEqual((status, body), (206, PAYLOAD[11:51]))
        self.assertEqual(headers.get('Content-Range'), 'bytes 11-50/' + str(len(PAYLOAD)))
        self.assertEqual(headers.get('X-Cache-Status'), 'HIT')
        status, headers, body = self.get(path, method='HEAD')
        self.assertEqual((status, body), (200, b''))
        requests = self.requests[before:]
        self.assertEqual(len(requests), 2)
        self.assertEqual([item[0] for item in requests], ['github.com', 'release-assets.githubusercontent.com'])
        for _, _, request_headers in requests:
            self.assertNotIn('Authorization', request_headers)
            self.assertNotIn('Cookie', request_headers)
        self.assertIn('github.com', self.sni)
        self.assertIn('release-assets.githubusercontent.com', self.sni)

    def test_rejects_unfixed_paths_and_external_or_chained_redirects(self):
        invalid = ['/anything', '/hxx344/other/releases/download/deploy-' + REVISION + '/a.tar.gz',
                   '/hxx344/project-aggregation/releases/latest/download/a.tar.gz',
                   RELEASE_PATH + 'a.zip', RELEASE_PATH + 'a.tarXgz', RELEASE_PATH + 'a.tar.gz?query=1']
        before = len(self.requests)
        for path in invalid:
            with self.subTest(path=path):
                self.assertIn(self.get(path)[0], (400, 404))
        self.assertEqual(before, len(self.requests))
        for name in ('badredirect.tar.gz', 'chained.tar.gz'):
            status, headers, _ = self.get(RELEASE_PATH + name)
            self.assertEqual(status, 502, self.error_log())
            self.assertIsNone(headers.get('Location'))
        self.assertTrue(all(host in ('github.com', 'release-assets.githubusercontent.com') for host, _, _ in self.requests))

    def test_upstream_certificate_name_is_verified(self):
        status, _, _ = self.get(RELEASE_PATH + 'certificate.tar.gz')
        self.assertEqual(status, 502)
        self.assertIn('certificate', self.error_log())


if __name__ == '__main__':
    unittest.main()
