"""Updater boundary and recovery tests. Linux CI: sudo python3 deploy/test-updater.py."""
import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import socket
import stat
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server/update-service'))
import registry
import releases
import updater


OLD = 'b' * 40
NEW = 'a' * 40
OLD_KEY = '1' * 64
NEW_KEY = '2' * 64
GITHUB_TOKEN = 'github_pat_' + 'A1b2c3d4' * 8
REPLACEMENT_TOKEN = 'ghp_' + 'X9y8z7w6' * 5
INSTALLER = b'#!/usr/bin/env bash\n# CI RELEASE HELPERS\n: "${PROJECT_DEPLOY_MANIFEST_FILE}"\n'
OLD_INSTALLER = INSTALLER + b'# earlier installer\n'
LINUX_ROOT = sys.platform == 'linux' and hasattr(os, 'geteuid') and os.geteuid() == 0


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


class FakeNetwork:
    """Only fixture URLs may be read; any accidental real/flexible endpoint fails."""
    def __init__(self, modules=registry.MODULES):
        self.calls = []
        self.values = {}
        for number, module in enumerate(modules, 1):
            filename = module.repository + '-linux-x64.tar.gz'
            manifest = {'schema': 1, 'repository': 'hxx344/' + module.repository, 'commit': NEW,
                        'tag': 'deploy-' + NEW, 'artifacts': {'linux-x64': {
                            'file': filename, 'sha256': '3' * 64, 'application_key': NEW_KEY}}}
            metadata = {'id': number, 'draft': False, 'prerelease': False,
                        'published_at': '2026-10-09T12:00:00Z', 'tag_name': 'deploy-' + NEW,
                        'assets': [{'name': 'release-manifest.json', 'state': 'uploaded', 'size': len(encoded(manifest))},
                                   {'name': filename, 'state': 'uploaded', 'size': 12345, 'digest': 'sha256:' + '3' * 64}]}
            self.values[module.id] = {'module': module, 'metadata': metadata, 'manifest': manifest,
                                     'installer': INSTALLER, 'oldInstaller': OLD_INSTALLER, 'comparison': {'status': 'ahead'}}

    def request(self, url, maximum=releases.MAX_JSON, method='GET'):
        self.calls.append((url, method))
        for entry in self.values.values():
            module = entry['module']
            base = 'https://api.github.com/repos/hxx344/' + module.repository + '/'
            if url in (base + 'releases/latest', base + 'releases/' + str(entry['metadata']['id'])):
                return encoded(entry['metadata'])
            if url.startswith(base + 'compare/'):
                return encoded(entry['comparison'])
            download = 'https://github.com/hxx344/' + module.repository + '/releases/download/deploy-' + NEW + '/'
            if url == download + 'release-manifest.json':
                return encoded(entry['manifest'])
            if url == download + module.repository + '-linux-x64.tar.gz' and method == 'HEAD':
                return b''
            raw = 'https://raw.githubusercontent.com/hxx344/' + module.repository + '/'
            if url == raw + NEW + '/' + module.installer:
                return entry['installer']
            if url == raw + OLD + '/' + module.installer:
                return entry['oldInstaller']
            if url == 'https://github.com/hxx344/' + module.repository + '/releases/download/deploy-' + OLD + '/release-manifest.json':
                old = copy.deepcopy(entry['manifest']); old.update(commit=OLD, tag='deploy-' + OLD)
                old['artifacts']['linux-x64']['application_key'] = OLD_KEY
                return encoded(old)
        raise AssertionError('Unexpected network request: ' + method + ' ' + url)


class RootFixture(unittest.TestCase):
    def setUp(self):
        if os.name != 'nt' and not LINUX_ROOT:
            self.skipTest('Protected metadata requires root; run sudo python3 deploy/test-updater.py')
        self.temporary = tempfile.TemporaryDirectory(prefix='hub-updater-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)

    def link(self, target, destination, directory=False):
        try:
            destination.symlink_to(target, target_is_directory=directory)
        except OSError as error:
            if os.name == 'nt' and getattr(error, 'winerror', None) == 1314:
                self.skipTest('Windows symlink privilege unavailable; covered by Linux root CI')
            raise


class RegistryTests(RootFixture):
    def install(self, module):
        names = {'aster': 'release-20261009T120000Z-ABC123', 'monitor': 'b' * 12 + '-AbCd1234',
                 'asset': 'b' * 12 + '.AbCd12', 'crossex': 'b' * 12 + '-' + 'c' * 16,
                 'variational': OLD, 'greeks': 'b' * 12 + '-' + 'c' * 16, 'hub': 'b' * 12 + '-' + 'c' * 16}
        root = self.root / 'opt' / module.directory
        release = root / 'releases' / names[module.id]
        release.mkdir(parents=True)
        for marker in module.markers:
            (release / marker).write_text('variational-grid' if module.id == 'variational' and marker == '.install-owned' else OLD, encoding='utf8')
        if module.root_marker:
            (root / '.managed-install').write_text(module.service, encoding='utf8')
        if module.checked:
            destination = root / module.checked[1:] if module.checked.startswith('@') else release / module.checked
            destination.write_text(OLD + ' fixture-state', encoding='utf8')
        (release / '.release-commit').write_text(OLD, encoding='utf8')
        (release / '.release-application-key').write_text(OLD_KEY, encoding='utf8')
        current = root / 'current'
        self.link(release, current, directory=True)
        unit = self.root / 'etc/systemd/system' / (module.service + '.service')
        unit.parent.mkdir(parents=True, exist_ok=True)
        current_path = str(current).replace('\\', '/')
        command = '/usr/bin/python3 -m variational_grid run --config /etc/variational-grid/config.toml' if module.id == 'variational' else '/usr/bin/node ' + current_path + '/server/index.mjs'
        unit.write_text(f'# Managed by {module.service} installer\n[Service]\nUser={module.user}\nWorkingDirectory={current_path}{module.working_suffix}\nExecStart={command}\n', encoding='utf8')
        return root, release, unit

    def test_only_unified_installer_identity_and_local_only_discovery(self):
        self.assertEqual(registry.inventory(self.root), [])
        for module in registry.MODULES:
            self.install(module)
        (self.root / 'opt/unknown-remote-project').mkdir()
        values = registry.inventory(self.root)
        self.assertEqual([row['id'] for row in values], [module.id for module in registry.MODULES])
        self.assertEqual(len(values), 1)
        for row in values:
            with self.subTest(module=row['id']):
                self.assertEqual(row['state'], 'unavailable')
                self.assertEqual(row['currentCommit'], OLD)
                self.assertEqual(row['applicationKey'], OLD_KEY)
                self.assertRegex(row['identity'], '^[a-f0-9]{64}$')

    def test_current_outside_release_tree_and_unknown_release_names_are_unmanaged(self):
        module = registry.BY_ID['hub']; root, release, _ = self.install(module)
        current = root / 'current'; current.unlink()
        outside = self.root / release.name; release.rename(outside)
        self.link(outside, current, directory=True)
        self.assertEqual(registry.installed(module, self.root)['state'], 'unmanaged')
        current.unlink(); renamed = root / 'releases/arbitrary-checkout'; outside.rename(renamed)
        self.link(renamed, current, directory=True)
        self.assertEqual(registry.installed(module, self.root)['state'], 'unmanaged')

    def test_links_in_protected_metadata_and_mismatched_service_are_rejected(self):
        module = registry.BY_ID['hub']; root, release, unit = self.install(module)
        marker = release / '.install-ready'; marker.unlink()
        outside = self.root / 'forged-marker'; outside.write_text(OLD, encoding='utf8')
        self.link(outside, marker)
        self.assertEqual(registry.installed(module, self.root)['state'], 'unmanaged')
        marker.unlink(); marker.write_text(OLD, encoding='utf8')
        source = unit.read_text(encoding='utf8')
        for changed in [source.replace('User=project-aggregation', 'User=root'), source + 'WorkingDirectory=/tmp\n',
                        source.replace(str(root / 'current').replace('\\', '/'), '/tmp/unknown')]:
            with self.subTest(unit=changed):
                unit.write_text(changed, encoding='utf8')
                self.assertEqual(registry.installed(module, self.root)['state'], 'unmanaged')
        unit.write_text(source, encoding='utf8')
        dropins = unit.parent / (module.service + '.service.d'); dropins.mkdir()
        (dropins / 'custom.conf').write_text('[Service]\nUser=root\n', encoding='utf8')
        self.assertEqual(registry.installed(module, self.root)['state'], 'unmanaged')

    @unittest.skipUnless(LINUX_ROOT, 'Linux ownership/mode protection requires root')
    def test_writable_parent_nonroot_metadata_and_private_state_permissions(self):
        module = registry.BY_ID['hub']; root, release, unit = self.install(module)
        root.parent.chmod(0o777)
        self.assertEqual(registry.installed(module, self.root)['state'], 'unmanaged')
        root.parent.chmod(0o755)
        os.chown(unit, 65534, 65534)
        self.assertEqual(registry.installed(module, self.root)['state'], 'unmanaged')
        os.chown(unit, 0, 0)
        release.chmod(0o775)
        self.assertEqual(registry.installed(module, self.root)['state'], 'unmanaged')
        state = self.root / 'private'; state.mkdir(mode=0o755)
        with self.assertRaises(ValueError):
            updater.private_directory(state)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.module = registry.BY_ID['hub']
        self.network = FakeNetwork([self.module])
        self.release = releases.Releases(self.network, arch='linux-x64')
        self.value = self.network.values['hub']

    def test_fixed_commit_and_repository_downloads_ignore_server_supplied_urls(self):
        self.value['metadata']['url'] = 'https://attacker.example/release'
        for asset in self.value['metadata']['assets']:
            asset['browser_download_url'] = 'https://attacker.example/install.sh'
        result = self.release.read(self.module)
        self.assertEqual(result['commit'], NEW)
        self.assertEqual(result['installerHash'], hashlib.sha256(INSTALLER).hexdigest())
        self.assertIn((f'https://raw.githubusercontent.com/hxx344/project-aggregation/{NEW}/deploy/install.sh', 'GET'), self.network.calls)
        self.assertFalse(any('attacker.example' in url or '/main/' in url for url, _ in self.network.calls))

    def test_only_published_stable_metadata_is_eligible(self):
        original = copy.deepcopy(self.value['metadata'])
        for change in [{'draft': True}, {'prerelease': True}, {'id': True}, {'id': -1}, {'published_at': None},
                       {'tag_name': 'main'}, {'tag_name': 'deploy-' + 'z' * 40}, {'tag_name': []}]:
            with self.subTest(change=change):
                self.value['metadata'] = {**original, **change}
                with self.assertRaises(releases.ReleaseError):
                    self.release.read(self.module)

    def test_manifest_repository_commit_tag_schema_architecture_and_asset_integrity(self):
        original = copy.deepcopy(self.value['manifest'])
        mutations = [lambda m: m.update(schema=True), lambda m: m.update(repository='hxx344/other'),
                     lambda m: m.update(commit=OLD), lambda m: m.update(tag='deploy-' + OLD),
                     lambda m: m.update(artifacts={}), lambda m: m['artifacts']['linux-x64'].update(file='../escape.tar.gz'),
                     lambda m: m['artifacts']['linux-x64'].update(sha256='broken'),
                     lambda m: m['artifacts']['linux-x64'].update(application_key='broken')]
        for mutate in mutations:
            self.value['manifest'] = copy.deepcopy(original); mutate(self.value['manifest'])
            with self.subTest(manifest=self.value['manifest']):
                with self.assertRaises(releases.ReleaseError):
                    self.release.read(self.module)
        self.value['manifest'] = original
        asset = self.value['metadata']['assets'][1]; saved = copy.deepcopy(asset)
        for change in [{'state': 'new'}, {'size': 0}, {'size': True}, {'size': 3 * 1024 ** 3}, {'digest': 'sha256:' + '4' * 64}]:
            with self.subTest(change=change):
                asset.clear(); asset.update({**saved, **change})
                with self.assertRaises(releases.ReleaseError):
                    self.release.read(self.module)

    def test_unpinned_installer_and_non_public_transport_are_rejected(self):
        for source in [b'echo arbitrary', b'#!/bin/bash\necho missing-manifest-support\n']:
            self.value['installer'] = source
            with self.assertRaises(releases.ReleaseError):
                self.release.read(self.module)
        for url in ['http://github.com/x', 'https://127.0.0.1/x', 'https://github.com.attacker.example/x',
                    'https://user:password@github.com/x', 'https://github.com:444/x', 'file:///etc/passwd']:
            with self.subTest(url=url), self.assertRaises(releases.ReleaseError):
                releases.allowed_url(url)
        with patch.object(releases.platform, 'machine', return_value='unknown-cpu'), self.assertRaises(releases.ReleaseError):
            releases.architecture()


class CoordinatorTests(RootFixture):
    def setUp(self):
        super().setUp()
        self.clock = 1800000000.0
        self.network = FakeNetwork()
        self.reader = releases.Releases(self.network, arch='linux-x64')
        self.installed = [{'id': module.id, 'name': module.name, 'state': 'unavailable', 'currentVersion': OLD[:12],
                           'latestVersion': None, 'currentCommit': OLD, 'latestCommit': None, 'applicationKey': OLD_KEY,
                           'artifactCommit': OLD, 'identity': hashlib.sha256(module.id.encode()).hexdigest()}
                          for module in registry.MODULES]
        self.launches = []; self.executed = []; self.executed_modes = []; self.syntaxes = []
        self.installer_hook = None
        self.alive = False
        self.coordinator = self.make_coordinator()

    def make_coordinator(self):
        return updater.Coordinator(directory=self.root / 'state', releases=self.reader,
                                   inspect=lambda: copy.deepcopy(self.installed), launch=lambda: self.launches.append('launch'),
                                   alive=lambda: self.alive, installer=self.install, syntax=lambda p: self.syntaxes.append(p.stem),
                                   clock=lambda: self.clock, stack_lock=self.root / 'stack.lock')

    def install(self, script, manifest, log, deploy_mode='source'):
        key = script.name.removesuffix('.install.sh')
        self.executed.append(key)
        self.executed_modes.append(deploy_mode)
        log.write_text('api_secret=PRIVATE_DEPLOYMENT_CREDENTIAL\n', encoding='utf8')
        if self.installer_hook:
            code = self.installer_hook(key)
            if code:
                return code
        value = next(item for item in self.installed if item['id'] == key)
        value.update(currentCommit=NEW, currentVersion=NEW[:12], applicationKey=NEW_KEY,
                     identity=hashlib.sha256((key + NEW).encode()).hexdigest())
        return 0

    def check(self, minimum_interval=updater.CHECK_MIN_INTERVAL, automatic=False):
        self.coordinator.check(minimum_interval=minimum_interval, automatic=automatic)
        if self.coordinator.check_thread:
            self.coordinator.check_thread.join(5)
            self.assertFalse(self.coordinator.check_thread.is_alive(), 'version check did not finish')
        result = self.coordinator.status()
        self.assertFalse(result['checking'])
        return result

    def prepare(self):
        result = self.check()
        self.assertIsNotNone(result['planId'], result)
        return result['planId']

    def test_token_save_replace_remove_and_restart_expose_only_configured(self):
        self.assertEqual(self.coordinator.status()['githubToken'], {'configured': False})
        initial_state = self.coordinator.load()
        for token in (GITHUB_TOKEN, REPLACEMENT_TOKEN, ''):
            with self.subTest(configured=bool(token)):
                public = self.coordinator.set_token(token)
                self.assertEqual(public['githubToken'], {'configured': bool(token)})
                self.assertEqual(self.coordinator.read_token(), token)
                self.assertEqual(self.make_coordinator().status(), public)
                self.assertEqual(self.coordinator.load(), initial_state)
                for secret in (GITHUB_TOKEN, REPLACEMENT_TOKEN, hashlib.sha256(GITHUB_TOKEN.encode()).hexdigest()):
                    self.assertNotIn(secret, json.dumps(public))
                    self.assertNotIn(secret, (self.coordinator.directory / 'state.json').read_text())
                self.assertFalse(self.network.calls)
        self.assertFalse((self.coordinator.directory / 'credentials.json').exists())

    def test_token_changes_preserve_reviewed_plan_and_retry_deadline(self):
        plan = self.prepare()
        before = self.coordinator.load()
        plan_bytes = (self.coordinator.plans / plan / 'plan.json').read_bytes()
        calls = list(self.network.calls)
        self.coordinator.set_token(GITHUB_TOKEN)
        self.assertEqual(self.coordinator.load(), before)
        self.assertEqual((self.coordinator.plans / plan / 'plan.json').read_bytes(), plan_bytes)
        with self.coordinator.lock():
            before.update(checkError='GitHub API匿名请求额度已用尽', failureCount=2,
                          nextCheckNotBefore=self.clock + 1200)
            self.coordinator.save(before)
        for token in (REPLACEMENT_TOKEN, ''):
            self.coordinator.set_token(token)
            self.assertEqual(self.coordinator.load(), before)
            self.coordinator.check()
            self.assertEqual(self.coordinator.load(), before)
            self.assertEqual(self.network.calls, calls)

    def test_token_busy_conflicts_cannot_replace_existing_configuration(self):
        self.coordinator.set_token(GITHUB_TOKEN)
        for checking, status in ((True, None), (False, 'queued'), (False, 'running')):
            with self.subTest(checking=checking, status=status):
                with self.coordinator.lock():
                    state = self.coordinator.load()
                    state.update(checking=checking, job={'status': status} if status else None)
                    self.coordinator.save(state)
                for token in (REPLACEMENT_TOKEN, ''):
                    with self.assertRaises(updater.UpdateError) as caught:
                        self.coordinator.set_token(token)
                    self.assertEqual(caught.exception.status, 409)
                    self.assertEqual(self.coordinator.read_token(), GITHUB_TOKEN)
                    self.assertEqual(self.coordinator.load(), state)

    def test_token_validation_rejects_injection_types_and_unbounded_input(self):
        for token in (None, True, 123, {}, [], 'short', 'a' * 256, 'a' * 19, ' ' + GITHUB_TOKEN,
                      GITHUB_TOKEN + '\n', GITHUB_TOKEN + '\r\nX-Evil: value', 'é' * 20, 'a-' * 20):
            with self.subTest(token_type=type(token).__name__):
                with self.assertRaises(updater.UpdateError) as caught:
                    self.coordinator.set_token(token)
                self.assertEqual(caught.exception.status, 400)
                self.assertNotIn(GITHUB_TOKEN, str(caught.exception))
                self.assertEqual(self.coordinator.read_token(), '')
        for token in ('a' * 20, 'Z9_' * 85):
            self.coordinator.set_token(token)
            self.assertEqual(self.coordinator.read_token(), token)

    def test_invalid_credentials_fail_closed_without_anonymous_requests_or_secret_errors(self):
        worker = updater.Coordinator(directory=self.coordinator.directory)
        worker.releases.network.opener = unittest.mock.Mock()
        path = self.coordinator.directory / 'credentials.json'
        for data in (b'{', encoded([]), encoded({'schema': 1, 'token': GITHUB_TOKEN, 'extra': True}),
                     encoded({'schema': True, 'token': GITHUB_TOKEN}), encoded({'schema': 1, 'token': None}),
                     encoded({'schema': 1, 'token': GITHUB_TOKEN + '\n'}), b'x' * 1025,
                     b'{"schema":1,"token":"","token":"' + GITHUB_TOKEN.encode() + b'"}'):
            with self.subTest(size=len(data)):
                updater.write_bytes(path, data)
                with self.assertRaises(releases.ReleaseError) as caught:
                    worker.releases.network.request('https://api.github.com/repos/hxx344/project-aggregation/releases/latest')
                self.assertNotIn(GITHUB_TOKEN, str(caught.exception))
                with self.assertRaises(releases.ReleaseError):
                    worker.status()
        worker.releases.network.opener.open.assert_not_called()
        with patch.object(updater.os, 'open', side_effect=PermissionError(GITHUB_TOKEN)):
            with self.assertRaises(releases.ReleaseError) as caught:
                self.coordinator.read_token()
            self.assertNotIn(GITHUB_TOKEN, str(caught.exception))

    def test_atomic_token_write_failure_keeps_previous_value_and_removes_temporary_file(self):
        self.coordinator.set_token(GITHUB_TOKEN)
        with patch.object(updater.os, 'replace', side_effect=OSError(REPLACEMENT_TOKEN)):
            with self.assertRaises(updater.UpdateError) as caught:
                self.coordinator.set_token(REPLACEMENT_TOKEN)
        self.assertEqual(caught.exception.status, 503)
        self.assertNotIn(REPLACEMENT_TOKEN, str(caught.exception))
        self.assertEqual(self.coordinator.read_token(), GITHUB_TOKEN)
        self.assertEqual(list(self.coordinator.directory.glob('.write-*')), [])

    def test_credentials_reject_links_and_nonregular_objects(self):
        path = self.coordinator.directory / 'credentials.json'
        outside = self.root / 'outside.json'
        updater.write_json(outside, {'schema': 1, 'token': GITHUB_TOKEN})
        original = outside.read_bytes()
        self.link(outside, path)
        for action in (self.coordinator.read_token, lambda: self.coordinator.set_token(REPLACEMENT_TOKEN),
                       lambda: self.coordinator.set_token('')):
            with self.assertRaises((releases.ReleaseError, updater.UpdateError)):
                action()
        self.assertEqual(outside.read_bytes(), original)
        path.unlink()
        path.mkdir(mode=0o700)
        with self.assertRaises(releases.ReleaseError):
            self.coordinator.read_token()
        with self.assertRaises(updater.UpdateError):
            self.coordinator.set_token(GITHUB_TOKEN)

    @unittest.skipUnless(LINUX_ROOT, 'Root ownership and private file modes run in Linux CI')
    def test_credentials_require_root_private_file_and_directory_permissions(self):
        self.coordinator.set_token(GITHUB_TOKEN)
        path = self.coordinator.directory / 'credentials.json'
        self.assertEqual(path.stat().st_uid, 0)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        for mode in (0o640, 0o604, 0o660, 0o601):
            path.chmod(mode)
            with self.assertRaises(releases.ReleaseError):
                self.coordinator.read_token()
            with self.assertRaises(updater.UpdateError):
                self.coordinator.set_token('')
        path.chmod(0o600)
        os.chown(path, 65534, 65534)
        try:
            with self.assertRaises(releases.ReleaseError):
                self.coordinator.read_token()
            with self.assertRaises(updater.UpdateError):
                self.coordinator.set_token(REPLACEMENT_TOKEN)
        finally:
            os.chown(path, 0, 0)
        self.coordinator.directory.chmod(0o750)
        try:
            with self.assertRaises(releases.ReleaseError):
                self.coordinator.read_token()
        finally:
            self.coordinator.directory.chmod(0o700)

    def test_default_control_and_worker_read_current_token_for_each_api_request(self):
        control = updater.Coordinator(directory=self.coordinator.directory)
        worker = updater.Coordinator(directory=self.coordinator.directory)
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.url = 'https://api.github.com/repos/hxx344/project-aggregation/releases/latest'
        response.headers = {}
        response.read.return_value = b'{}'
        for coordinator in (control, worker):
            coordinator.releases.network.opener = unittest.mock.Mock()
            coordinator.releases.network.opener.open.return_value = response
        for token in (GITHUB_TOKEN, REPLACEMENT_TOKEN, ''):
            control.set_token(token)
            for coordinator in (control, worker):
                network = coordinator.releases.network
                self.assertEqual(network.request(response.url), b'{}')
                request = network.opener.open.call_args.args[0]
                self.assertEqual(request.get_header('Authorization'), 'Bearer ' + token if token else None)
        self.assertNotIn('GITHUB_TOKEN', updater.ENVIRONMENT)
        self.assertNotIn('GH_TOKEN', updater.ENVIRONMENT)

    def test_token_http_contract_is_bounded_and_never_echoes_credentials(self):
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), updater.Handler)
        server.coordinator = self.coordinator
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.05})
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(lambda: thread.join(5))
        self.addCleanup(server.shutdown)
        def request(body, route='/token', headers=None):
            connection = http.client.HTTPConnection(*server.server_address, timeout=5)
            try:
                connection.request('POST', route, body=body, headers=headers or {'Content-Type': 'application/json'})
                response = connection.getresponse()
                data = response.read()
                self.assertNotIn(GITHUB_TOKEN.encode(), data)
                self.assertEqual(response.getheader('Cache-Control'), 'no-store')
                return response.status, json.loads(data)
            finally:
                connection.close()
        status, public = request(encoded({'token': GITHUB_TOKEN}))
        self.assertEqual(status, 200)
        self.assertEqual(public, self.coordinator.status())
        self.assertEqual(public['githubToken'], {'configured': True})
        for body in (encoded({}), encoded({'token': GITHUB_TOKEN, 'url': 'https://attacker.example'}),
                     encoded({'token': 123}), encoded({'token': GITHUB_TOKEN + '\n'}), encoded([]),
                     b'{"token":"","token":"' + GITHUB_TOKEN.encode() + b'"}', b'x' * 1025, b'{'):
            self.assertEqual(request(body)[0], 400)
            self.assertEqual(self.coordinator.read_token(), GITHUB_TOKEN)
        self.assertEqual(request(encoded({'token': GITHUB_TOKEN}), headers={'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(request(encoded({'token': GITHUB_TOKEN}), '/token?extra=1')[0], 404)
        with self.coordinator.lock():
            state = self.coordinator.load()
            state['checking'] = True
            self.coordinator.save(state)
        self.assertEqual(request(encoded({'token': ''}))[0], 409)
        with self.coordinator.lock():
            state['checking'] = False
            self.coordinator.save(state)
        self.assertEqual(request(encoded({'token': ''}))[1]['githubToken'], {'configured': False})

    def test_release_notes_are_public_but_never_change_the_reviewed_plan(self):
        self.network.values['hub']['metadata']['body'] = '修复检查\r\n<script>仅作文本</script> 🚀'
        first = self.check()
        self.assertEqual(first['modules'][-1]['releaseNotes'], '修复检查\n<script>仅作文本</script> 🚀')
        self.assertEqual(first['modules'][-1]['state'], 'available')
        plan_id = first['planId']
        plan = self.coordinator.read_plan(plan_id)
        self.assertNotIn('releaseNotes', json.dumps(plan))
        self.assertNotIn('修复检查', json.dumps(plan, ensure_ascii=False))
        self.clock += 180
        self.network.values['hub']['metadata']['body'] = '更正说明内容'
        second = self.check()
        self.assertEqual(second['modules'][-1]['releaseNotes'], '更正说明内容')
        self.assertEqual(second['planId'], plan_id)
        self.assertEqual(self.coordinator.read_plan(plan_id), plan)
        self.network.values['hub']['metadata']['body'] = '执行时再次修改说明'
        self.coordinator.apply(plan_id)
        self.coordinator.run()
        self.assertEqual(self.coordinator.status()['job']['status'], 'succeeded')

    def test_legacy_release_and_saved_module_without_notes_remain_compatible(self):
        original = self.reader.read
        def legacy_read(*args, **kwargs):
            result = original(*args, **kwargs)
            result.pop('releaseNotes')
            return result
        with patch.object(self.reader, 'read', side_effect=legacy_read):
            result = self.check()
        self.assertIsNotNone(result['planId'])
        self.assertTrue(all(item['releaseNotes'] == '' for item in result['modules']))
        with self.coordinator.lock():
            state = self.coordinator.load()
            for item in state['modules']:
                item.pop('releaseNotes')
            self.coordinator.save(state)
        public = self.coordinator.status()
        self.assertEqual(public['planId'], result['planId'])
        self.assertTrue(all('releaseNotes' not in item for item in public['modules']))

    def test_same_content_release_is_available_and_successful_receipt_prevents_repeated_updates(self):
        self.installed = [self.installed[-1]]
        self.installed[0]['applicationKey'] = NEW_KEY
        self.network.values['hub']['oldInstaller'] = INSTALLER
        result = self.check()
        self.assertEqual(result['modules'][0]['state'], 'available')
        self.assertEqual(result['modules'][0]['currentCommit'], OLD)
        self.assertEqual(result['modules'][0]['latestCommit'], NEW)
        self.assertIsNotNone(result['planId'])

        # An incremental installer may retain the app-identical previous source.
        with patch.object(self.coordinator, 'installer', return_value=0) as install:
            self.coordinator.apply(result['planId']); self.coordinator.run()
            install.assert_called_once()
        self.assertEqual(self.coordinator.status()['job']['status'], 'succeeded')
        self.assertEqual(self.installed[0]['currentCommit'], OLD)
        receipt = updater.read_json(self.coordinator.directory / 'hub.receipt.json')
        self.assertEqual(receipt['identity'], self.installed[0]['identity'])
        self.assertEqual(receipt['commit'], NEW)
        self.clock += 61
        result = self.check()
        self.assertEqual(result['modules'][0]['state'], 'current')
        self.assertEqual(result['modules'][0]['currentCommit'], NEW)
        self.assertEqual(result['modules'][0]['latestCommit'], NEW)
        self.assertIsNone(result['planId'])
        self.installed[0]['identity'] = 'f' * 64
        self.clock += 61
        result = self.check()
        self.assertEqual(result['modules'][0]['state'], 'available', 'a receipt must not authorize a changed installation')
        self.assertEqual(result['modules'][0]['currentCommit'], OLD)
        self.assertIsNotNone(result['planId'])

    def test_matching_release_commit_is_current_without_ancestry_comparison(self):
        self.installed[0].update(currentCommit=NEW, currentVersion=NEW[:12])
        with patch.object(self.reader, 'is_newer', wraps=self.reader.is_newer) as compare:
            result = self.check()
            compare.assert_not_called()
        self.assertEqual(result['modules'][0]['state'], 'current')
        self.assertEqual(result['modules'][0]['reason'], '已是最新正式版本')
        self.assertIsNone(result['planId'])
        self.assertIsNone(result['checkError'])

    def test_equivalent_content_cannot_bypass_release_ancestry(self):
        self.installed[0]['applicationKey'] = NEW_KEY
        self.network.values['hub']['oldInstaller'] = INSTALLER
        cases = [('ahead', 'available', '正式版本可用'),
                 ('behind', 'current', '本机版本领先于当前正式版本，不自动降级'),
                 ('diverged', 'unavailable', '本机与正式版本的来源不同，请通过命令检查后更新'),
                 ('unknown', 'unavailable', '无法确认正式版本的更新顺序')]
        for comparison, expected_state, reason in cases:
            with self.subTest(comparison=comparison):
                self.clock += 301
                self.network.values['hub']['comparison'] = {'status': comparison}
                with patch.object(self.reader, 'is_newer', wraps=self.reader.is_newer) as compare:
                    result = self.check()
                    compare.assert_called_once_with(registry.BY_ID['hub'], OLD, NEW)
                self.assertEqual(result['modules'][0]['state'], expected_state)
                self.assertEqual(result['modules'][0]['reason'], reason)
                self.assertEqual(result['modules'][0]['currentCommit'], OLD)
                self.assertEqual(result['modules'][0]['latestCommit'], NEW)
                self.assertEqual(result['planId'] is not None, expected_state == 'available')
                self.assertEqual(result['checkError'] is not None, expected_state == 'unavailable')

    def test_comparison_failure_with_equivalent_content_invalidates_previous_plan(self):
        self.installed[0]['applicationKey'] = NEW_KEY
        self.network.values['hub']['oldInstaller'] = INSTALLER
        self.prepare()
        self.clock += 61
        original = self.network.request
        def fail_comparison(url, *args, **kwargs):
            if '/compare/' in url:
                raise releases.ReleaseError('版本比较暂时不可用', transient=True)
            return original(url, *args, **kwargs)
        with patch.object(self.network, 'request', side_effect=fail_comparison) as request:
            result = self.check()
            request.assert_any_call(self.reader.api(registry.BY_ID['hub'], f'compare/{OLD}...{NEW}'))
        self.assertEqual(result['modules'][0]['state'], 'unavailable')
        self.assertEqual(result['modules'][0]['reason'], '版本比较暂时不可用')
        self.assertIsNone(result['planId'])
        self.assertIsNotNone(result['checkError'])
        self.assertEqual(self.launches, [])

    def test_legacy_missing_application_key_requires_one_proven_ci_migration(self):
        self.installed = [self.installed[-1]]
        self.installed[0]['applicationKey'] = None
        self.network.values['hub']['manifest']['artifacts']['linux-x64']['application_key'] = OLD_KEY
        self.network.values['hub']['oldInstaller'] = INSTALLER
        result = self.check()
        self.assertEqual(result['modules'][0]['state'], 'available')
        self.assertIsNotNone(result['planId'])

    def test_changed_release_eligibility_stops_every_installer_before_any_deployment(self):
        plan = self.prepare(); self.coordinator.apply(plan)
        self.network.values['hub']['metadata']['prerelease'] = True
        self.coordinator.run()
        state = self.coordinator.status()
        self.assertEqual(state['job']['status'], 'failed')
        self.assertEqual(self.executed, [])
        self.assertTrue(all(step['status'] == 'skipped' for step in state['job']['steps']))

    def test_manifest_or_installer_change_after_check_blocks_all_modules(self):
        for mutate in [lambda: self.network.values['hub']['manifest'].update(node_version='24.15.0'),
                       lambda: self.network.values['hub'].update(installer=INSTALLER + b'# changed after review\n')]:
            with self.subTest(mutation=mutate):
                self.clock += 61; plan = self.prepare(); self.coordinator.apply(plan); mutate(); self.coordinator.run()
                self.assertEqual(self.coordinator.status()['job']['status'], 'failed')
                self.assertEqual(self.executed, [])

    def test_expired_plan_and_changed_local_identity_cannot_launch_worker(self):
        plan = self.prepare(); self.clock += updater.PLAN_TTL + 1
        with self.assertRaises(updater.UpdateError) as expired:
            self.coordinator.apply(plan)
        self.assertEqual(expired.exception.status, 409)
        self.assertEqual(self.launches, [])
        plan = self.prepare(); self.installed[0]['identity'] = 'f' * 64
        with self.assertRaises(updater.UpdateError) as changed:
            self.coordinator.apply(plan)
        self.assertEqual(changed.exception.status, 409)
        self.assertEqual(self.launches, [])

    def test_local_change_after_acceptance_and_tampered_plan_prevent_execution(self):
        plan = self.prepare(); self.coordinator.apply(plan)
        self.installed[-1]['identity'] = 'f' * 64
        self.coordinator.run()
        self.assertEqual(self.coordinator.status()['job']['status'], 'failed')
        self.assertEqual(self.executed, [])
        self.clock += 61; plan = self.prepare()
        script = self.coordinator.plans / plan / 'hub.install.sh'
        script.write_bytes(INSTALLER + b'\necho injected\n')
        with self.assertRaises(updater.UpdateError) as tampered:
            self.coordinator.apply(plan)
        self.assertEqual(tampered.exception.status, 409)
        self.assertEqual(len(self.launches), 1)

    def test_partial_check_never_silently_omits_an_unavailable_installed_module(self):
        self.network.values['hub']['metadata']['prerelease'] = True
        result = self.check()
        self.assertFalse(any(item['state'] == 'available' for item in result['modules']))
        self.assertEqual(result['modules'][-1]['state'], 'unavailable')
        self.assertIsNone(result['planId'])
        self.assertIsNotNone(result['checkError'])
        self.assertEqual(self.launches, [])

    def test_check_is_coalesced_and_rate_limited_and_restart_clears_abandoned_check(self):
        entered = threading.Event(); release = threading.Event()
        original = self.coordinator.inspect
        self.coordinator.inspect = lambda: (entered.set(), release.wait(5), original())[-1]
        first = self.coordinator.check(); self.assertTrue(first['checking']); self.assertTrue(entered.wait(5))
        thread = self.coordinator.check_thread
        self.assertTrue(self.coordinator.check()['checking']); self.assertIs(self.coordinator.check_thread, thread)
        release.set(); thread.join(5); self.assertFalse(thread.is_alive())
        requests = len(self.network.calls)
        self.coordinator.check(); self.assertEqual(len(self.network.calls), requests)
        with self.coordinator.lock():
            value = self.coordinator.load(); value['checking'] = True; self.coordinator.save(value)
        restarted = self.make_coordinator(); restarted.recover(starting=True)
        self.assertFalse(restarted.status()['checking']); self.assertIsNone(restarted.status()['planId'])

    def test_automatic_check_is_due_every_minute_and_survives_restart(self):
        self.assertEqual(updater.AUTO_CHECK_INTERVAL, 60)
        self.assertEqual(self.coordinator.next_check_delay(), 0)
        self.check()
        self.assertEqual(self.coordinator.next_check_delay(), updater.AUTO_CHECK_INTERVAL)
        calls = len(self.network.calls)
        self.clock += updater.AUTO_CHECK_INTERVAL - 1
        restarted = self.make_coordinator(); restarted.recover(starting=True)
        self.assertEqual(restarted.next_check_delay(), 1)
        self.assertFalse(restarted.check(minimum_interval=updater.AUTO_CHECK_INTERVAL)['checking'])
        self.assertEqual(len(self.network.calls), calls)
        self.clock += 1
        self.assertTrue(restarted.check(minimum_interval=updater.AUTO_CHECK_INTERVAL)['checking'])
        restarted.check_thread.join(5)
        self.assertGreater(len(self.network.calls), calls)
        self.assertEqual(restarted.next_check_delay(), updater.AUTO_CHECK_INTERVAL)

    def test_scheduler_starts_without_http_and_does_not_duplicate_or_reenter(self):
        entered = threading.Event(); release = threading.Event()
        original = self.coordinator.inspect
        self.coordinator.inspect = lambda: (entered.set(), release.wait(5), original())[-1]
        try:
            self.coordinator.start_scheduler()
            thread = self.coordinator.scheduler_thread
            self.coordinator.start_scheduler()
            self.assertIs(self.coordinator.scheduler_thread, thread)
            self.assertTrue(entered.wait(5))
            check_thread = self.coordinator.check_thread
            self.assertEqual(self.coordinator.next_check_delay(), 5)
            self.coordinator.check(minimum_interval=updater.AUTO_CHECK_INTERVAL)
            self.assertIs(self.coordinator.check_thread, check_thread)
        finally:
            self.coordinator.stop_scheduler(); release.set()
            if self.coordinator.check_thread:
                self.coordinator.check_thread.join(5)
        self.assertFalse(thread.is_alive())
        plan = self.coordinator.status()['planId']
        self.coordinator.apply(plan)
        self.clock += 31
        self.assertEqual(self.coordinator.next_check_delay(), 5)
        self.assertFalse(self.coordinator.check(minimum_interval=updater.AUTO_CHECK_INTERVAL)['checking'])

    def test_auto_retry_after_failure_preserves_no_failed_plan(self):
        plan = self.prepare(); self.clock += updater.AUTO_CHECK_INTERVAL
        self.network.values['hub']['metadata']['prerelease'] = True
        state = self.check(minimum_interval=updater.AUTO_CHECK_INTERVAL)
        self.assertIsNone(state['planId']); self.assertIsNotNone(state['checkError'])
        with self.assertRaises(updater.UpdateError):
            self.coordinator.apply(plan)
        self.assertEqual(self.coordinator.next_check_delay(), updater.AUTO_CHECK_INTERVAL)
        self.network.values['hub']['metadata']['prerelease'] = False
        self.clock += updater.AUTO_CHECK_INTERVAL
        self.assertIsNotNone(self.check(minimum_interval=updater.AUTO_CHECK_INTERVAL)['planId'])

    def test_server_retry_deadline_blocks_manual_auto_and_restarted_checks(self):
        deadline = self.clock + 3600
        failure = releases.ReleaseError('GitHub 查询受限', retry_at=deadline, transient=True)
        original = self.coordinator.inspect
        with patch.object(self.reader, 'read', side_effect=failure) as read, \
                patch.object(self.coordinator, 'inspect', side_effect=original) as inspect:
            state = self.check()
            self.assertIsNone(state['planId'])
            self.assertEqual(state['modules'][0]['state'], 'unavailable')
            self.assertIn('已暂停重试，约 60 分钟', state['checkError'])
            saved = self.coordinator.load()
            self.assertEqual(saved['failureCount'], 1)
            self.assertEqual(saved['nextCheckNotBefore'], deadline)
            self.assertNotIn('retryAt', json.dumps(saved['modules']))
            self.assertNotIn('retryAt', json.dumps(state))
            self.assertNotIn('nextCheckNotBefore', state)
            for offset in [1, 60, 300, 1800, 3599]:
                self.clock = deadline - 3600 + offset
                for minimum in [0, updater.CHECK_MIN_INTERVAL, updater.AUTO_CHECK_INTERVAL]:
                    self.assertFalse(self.coordinator.check(minimum_interval=minimum)['checking'])
                self.assertGreater(self.coordinator.next_check_delay(), 0)
            self.assertEqual(self.coordinator.next_check_delay(), 1)
            restarted = self.make_coordinator()
            restarted.inspect = inspect
            restarted.recover(starting=True)
            self.assertFalse(restarted.check(minimum_interval=0)['checking'])
            self.assertEqual(restarted.load()['nextCheckNotBefore'], deadline)
            inspect.assert_called_once()
            read.assert_called_once()
        self.coordinator = restarted
        self.clock = deadline
        self.assertEqual(self.coordinator.next_check_delay(), 0)
        recovered = self.check(minimum_interval=0)
        self.assertIsNotNone(recovered['planId'])
        self.assertIsNone(recovered['checkError'])
        self.assertEqual(self.coordinator.load()['failureCount'], 0)
        self.assertEqual(self.coordinator.load()['nextCheckNotBefore'], 0)
        self.assertNotIn('retryAt', json.dumps(self.coordinator.read_plan(recovered['planId'])))

    def test_failure_backoff_grows_to_cap_and_success_resets_it(self):
        failures = [releases.ReleaseError('网络暂时不可用', transient=True),
                    releases.ReleaseError('发布校验失败'),
                    OSError('https://example.invalid/?secret=PRIVATE_BODY')]
        interval, cap = updater.AUTO_CHECK_INTERVAL, updater.CHECK_RETRY_MAX_INTERVAL
        for index, delay in enumerate([interval, 2 * interval, 4 * interval, 8 * interval, cap, cap]):
            with self.subTest(attempt=index + 1), \
                    patch.object(self.reader, 'read', side_effect=failures[index % len(failures)]) as read:
                state = self.check(minimum_interval=0)
                saved = self.coordinator.load()
                self.assertEqual(saved['failureCount'], index + 1)
                self.assertEqual(saved['nextCheckNotBefore'], self.clock + delay)
                self.assertEqual(state['modules'][0]['state'], 'unavailable')
                self.assertIsNone(state['planId'])
                self.assertNotIn('PRIVATE_BODY', json.dumps(state))
                self.clock += delay - 1
                self.assertEqual(self.coordinator.next_check_delay(), 1)
                self.assertFalse(self.coordinator.check(minimum_interval=0, automatic=True)['checking'])
                read.assert_called_once()
                self.clock += 1
        self.assertIsNotNone(self.check(minimum_interval=0)['planId'])
        self.assertEqual(self.coordinator.load()['failureCount'], 0)
        self.assertEqual(self.coordinator.load()['nextCheckNotBefore'], 0)
        self.clock += interval
        with patch.object(self.reader, 'read', side_effect=failures[0]):
            self.check(minimum_interval=0)
        self.assertEqual(self.coordinator.load()['failureCount'], 1)
        self.assertEqual(self.coordinator.load()['nextCheckNotBefore'], self.clock + interval)

    def test_inventory_failure_and_interrupted_check_also_back_off(self):
        with patch.object(self.coordinator, 'inspect', side_effect=OSError('PRIVATE_INSPECT_ERROR')) as inspect:
            state = self.check(minimum_interval=0)
            self.assertIn('约 1 分钟后自动重试，也可以手动重新检查', state['checkError'])
            self.assertNotIn('PRIVATE_INSPECT_ERROR', json.dumps(state))
            self.assertEqual(self.coordinator.load()['failureCount'], 1)
            self.assertFalse(self.coordinator.check(minimum_interval=0, automatic=True)['checking'])
            inspect.assert_called_once()
        with self.coordinator.lock():
            state = self.coordinator.load()
            state['checking'] = True
            self.coordinator.save(state)
        restarted = self.make_coordinator()
        restarted.recover(starting=True)
        self.assertEqual(restarted.load()['failureCount'], 2)
        self.assertEqual(restarted.load()['nextCheckNotBefore'], self.clock + 2 * updater.AUTO_CHECK_INTERVAL)
        self.assertFalse(restarted.check(minimum_interval=0, automatic=True)['checking'])
        restarted.recover(starting=True)
        self.assertEqual(restarted.load()['failureCount'], 2)

    def test_clock_rollback_rebases_retry_deadline_once_and_eventually_allows_check(self):
        failure = releases.ReleaseError('GitHub 查询受限', retry_at=self.clock + 3600, transient=True)
        with patch.object(self.reader, 'read', side_effect=failure) as read:
            self.check()
            self.clock -= 86400
            self.assertGreater(self.coordinator.next_check_delay(), 0)
            deadline = self.coordinator.load()['nextCheckNotBefore']
            self.assertEqual(deadline, self.clock + 3600)
            self.assertFalse(self.coordinator.check(minimum_interval=0)['checking'])
            self.clock += 3599
            self.assertEqual(self.coordinator.next_check_delay(), 1)
            self.assertEqual(self.coordinator.load()['nextCheckNotBefore'], deadline)
            self.assertFalse(self.coordinator.check(minimum_interval=0)['checking'])
            read.assert_called_once()
        self.clock += 1
        self.assertEqual(self.coordinator.next_check_delay(), 0)
        self.assertIsNotNone(self.check(minimum_interval=0)['planId'])
        self.clock -= 86400
        self.assertEqual(self.coordinator.next_check_delay(), updater.AUTO_CHECK_INTERVAL)
        self.clock += updater.AUTO_CHECK_INTERVAL
        self.assertEqual(self.coordinator.next_check_delay(), 0)
        self.assertIsNotNone(self.check(minimum_interval=updater.AUTO_CHECK_INTERVAL)['planId'])

    def test_legacy_state_without_retry_fields_keeps_automatic_interval(self):
        self.check()
        with self.coordinator.lock():
            state = self.coordinator.load()
            for key in ['failureCount', 'nextCheckNotBefore', 'lastCheckStarted']:
                state.pop(key, None)
            self.coordinator.save(state)
        self.clock += updater.AUTO_CHECK_INTERVAL - 1
        restarted = self.make_coordinator()
        self.assertEqual(restarted.next_check_delay(), 1)
        self.assertEqual(restarted.load()['failureCount'], 0)
        self.assertEqual(restarted.load()['nextCheckNotBefore'], 0)
        self.assertFalse(restarted.check(minimum_interval=updater.AUTO_CHECK_INTERVAL)['checking'])

    def test_clock_rollback_during_failure_keeps_the_new_retry_deadline(self):
        def fail_after_rollback(_module):
            self.clock -= 86400
            raise releases.ReleaseError('网络暂时不可用', transient=True)
        with patch.object(self.reader, 'read', side_effect=fail_after_rollback) as read:
            self.check()
            self.assertEqual(self.coordinator.next_check_delay(), updater.AUTO_CHECK_INTERVAL)
            self.assertEqual(self.coordinator.load()['nextCheckNotBefore'], self.clock + updater.AUTO_CHECK_INTERVAL)
            self.assertFalse(self.coordinator.check(minimum_interval=0, automatic=True)['checking'])
            read.assert_called_once()
        self.clock += updater.AUTO_CHECK_INTERVAL
        self.assertIsNotNone(self.check(minimum_interval=0)['planId'])

    def test_manual_check_skips_local_backoff_but_keeps_server_deadline(self):
        with patch.object(self.reader, 'read', side_effect=releases.ReleaseError('网络暂时不可用', transient=True)) as read:
            self.check()
            self.check(minimum_interval=0)
            self.assertEqual(read.call_count, 2)
            self.assertEqual(self.coordinator.load()['nextCheckNotBefore'], self.clock + 2 * updater.AUTO_CHECK_INTERVAL)
            self.assertEqual(self.coordinator.load()['retryNotBefore'], 0)
        self.clock += updater.CHECK_MIN_INTERVAL - 1
        self.assertFalse(self.coordinator.check()['checking'])
        self.clock += 1
        self.assertGreater(self.coordinator.next_check_delay(), 0)
        recovered = self.check()
        self.assertIsNotNone(recovered['planId'])
        self.assertIsNone(recovered['checkError'])
        saved = self.coordinator.load()
        self.assertEqual((saved['failureCount'], saved['nextCheckNotBefore'], saved['retryNotBefore']), (0, 0, 0))
        self.clock += 300
        deadline = self.clock + 1200
        with patch.object(self.reader, 'read', side_effect=releases.ReleaseError('受限', retry_at=deadline, transient=True)):
            self.check(minimum_interval=0)
        self.assertEqual(self.coordinator.load()['retryNotBefore'], deadline)
        self.clock = deadline - 1
        restarted = self.make_coordinator(); restarted.recover(starting=True)
        self.assertFalse(restarted.check(minimum_interval=0)['checking'])
        self.clock = deadline
        self.coordinator = restarted
        self.assertIsNotNone(self.check(minimum_interval=0)['planId'])

    def test_legacy_backoff_is_honoured_as_a_server_deadline_once(self):
        with self.coordinator.lock():
            state = self.coordinator.load()
            state.pop('retryNotBefore')
            state.update(failureCount=2, nextCheckNotBefore=self.clock + 600, checkedAt=updater.iso(self.clock))
            self.coordinator.save(state)
        restarted = self.make_coordinator()
        self.assertEqual(restarted.load()['retryNotBefore'], self.clock + 600)
        self.assertFalse(restarted.check(minimum_interval=0)['checking'])
        self.clock += 600
        self.coordinator = restarted
        self.assertIsNotNone(self.check(minimum_interval=0)['planId'])
        self.assertEqual(self.coordinator.load()['retryNotBefore'], 0)

    def test_hung_check_times_out_and_its_late_result_is_discarded(self):
        entered = threading.Event(); release = threading.Event()
        original = self.coordinator.inspect
        calls = []
        def inspect():
            calls.append(1)
            if len(calls) == 1:
                entered.set(); release.wait(5)
                self.network.values['hub']['metadata']['prerelease'] = True
            return original()
        self.coordinator.inspect = inspect
        try:
            self.assertTrue(self.coordinator.check()['checking'])
            hung = self.coordinator.check_thread
            self.assertTrue(entered.wait(5))
            self.clock += updater.CHECK_DEADLINE
            self.assertTrue(self.coordinator.status()['checking'])
            self.clock += 1
            state = self.coordinator.status()
            self.assertFalse(state['checking'])
            self.assertIn('版本检查超时', state['checkError'])
            self.assertIsNone(self.coordinator.load()['checkId'])
            self.assertFalse(self.coordinator.check(minimum_interval=0, automatic=True)['checking'])
            recovered = self.check(minimum_interval=0)
            self.assertIsNotNone(recovered['planId'])
        finally:
            release.set()
            hung.join(5)
        self.assertFalse(hung.is_alive())
        final = self.coordinator.status()
        self.assertEqual(final['planId'], recovered['planId'])
        self.assertIsNone(final['checkError'])
        self.assertEqual(final['modules'], recovered['modules'])
        self.assertEqual(self.coordinator.load()['failureCount'], 0)

    def test_unchanged_plan_survives_check_without_extending_expiry(self):
        plan = self.prepare(); expires = self.coordinator.status()['expiresAt']
        self.clock += 180
        release = threading.Event(); original = self.coordinator.inspect
        self.coordinator.inspect = lambda: (release.wait(5), original())[-1]
        try:
            started = self.coordinator.check()
            self.assertEqual(started['planId'], plan)
            with self.assertRaises(updater.UpdateError):
                self.coordinator.apply(plan)
        finally:
            release.set(); self.coordinator.check_thread.join(5)
            self.coordinator.inspect = original
        state = self.coordinator.status()
        self.assertEqual(state['planId'], plan); self.assertEqual(state['expiresAt'], expires)
        self.assertEqual(len(list(self.coordinator.plans.iterdir())), 1)
        self.clock += updater.PLAN_TTL
        self.assertNotEqual(self.prepare(), plan)

    def test_changed_candidate_identity_or_content_replaces_reviewed_plan(self):
        plan = self.prepare(); self.clock += 180
        self.installed[0]['identity'] = 'f' * 64
        changed = self.prepare(); self.assertNotEqual(changed, plan)
        self.clock += 180
        self.network.values['hub']['manifest']['node_version'] = '24.15.0'
        self.assertNotEqual(self.prepare(), changed)

    def test_concurrent_double_click_launches_one_worker_and_other_plan_is_rejected(self):
        plan = self.prepare()
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(self.coordinator.apply, [plan] * 8))
        self.assertEqual(len(self.launches), 1)
        self.assertEqual(len({result['job']['id'] for result in results}), 1)
        with self.assertRaises(updater.UpdateError) as error:
            self.coordinator.apply('f' * 32)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.executed, [])

    def test_shared_stack_lock_conflict_prevents_installation(self):
        plan = self.prepare(); self.coordinator.apply(plan)
        with updater.file_lock(self.root / 'stack.lock', blocking=False):
            self.coordinator.run()
        result = self.coordinator.status()
        self.assertEqual(result['job']['status'], 'failed')
        self.assertEqual(self.executed, [])
        self.assertIn('另一个部署', result['job']['message'])

    def test_duplicate_workers_cannot_corrupt_the_winning_workers_progress(self):
        plan = self.prepare(); self.coordinator.apply(plan)
        second = self.make_coordinator()
        ready = threading.Barrier(2); entered = threading.Event(); release = threading.Event(); finished = threading.Event()
        real_lock = updater.file_lock
        @contextmanager
        def synchronized_lock(path, blocking=True):
            if path.name == 'worker.lock':
                ready.wait(timeout=5)
            with real_lock(path, blocking=blocking):
                yield
        def install(key):
            if key == 'hub':
                entered.set(); self.assertTrue(release.wait(5))
            return 0
        self.installer_hook = install
        def run(coordinator):
            try:
                coordinator.run()
            finally:
                finished.set()
        with patch.object(updater, 'file_lock', synchronized_lock), ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(run, coordinator) for coordinator in [self.coordinator, second]]
            try:
                self.assertTrue(entered.wait(5)); self.assertTrue(finished.wait(5))
                self.assertEqual(self.coordinator.status()['job']['status'], 'running')
            finally:
                release.set()
                for future in futures:
                    future.result(timeout=5)
        self.assertEqual(self.coordinator.status()['job']['status'], 'succeeded')
        self.assertEqual(self.executed, [module.id for module in registry.MODULES])

    def test_installs_serially_in_fixed_order_with_hub_last(self):
        plan = self.prepare(); self.coordinator.apply(plan); self.coordinator.run()
        self.assertEqual(self.executed, [module.id for module in registry.MODULES])
        self.assertEqual(self.executed[-1], 'hub')
        state = self.coordinator.status()
        self.assertEqual(state['job']['status'], 'succeeded')
        self.assertTrue(all(step['status'] == 'succeeded' for step in state['job']['steps']))
        self.assertIsNone(state['planId'])
        self.assertNotIn('PRIVATE_DEPLOYMENT_CREDENTIAL', json.dumps(state))
        self.assertNotIn('installerHash', json.dumps(state))
        self.assertNotIn('installedIdentity', json.dumps(state))

    def test_partial_failure_preserves_success_and_never_leaks_raw_logs(self):
        self.installer_hook = lambda key: 17 if key == 'hub' else 0
        plan = self.prepare(); self.coordinator.apply(plan); self.coordinator.run()
        state = self.coordinator.status()
        self.assertEqual(self.executed, ['hub'])
        self.assertEqual([step['status'] for step in state['job']['steps']], ['failed'])
        self.assertEqual(state['job']['status'], 'failed')
        self.assertNotIn('PRIVATE_DEPLOYMENT_CREDENTIAL', json.dumps(state))
        self.assertEqual(state['modules'][0]['currentCommit'], OLD)

    def fail_after_deployment(self):
        def fail(_key):
            self.installed[0].update(currentCommit=NEW, currentVersion=NEW[:12], applicationKey=NEW_KEY,
                                     identity='e' * 64)
            return 17  # Application activation succeeded; updater bootstrap did not.
        self.installer_hook = fail
        plan = self.prepare(); self.coordinator.apply(plan); self.coordinator.run()
        self.assertEqual(self.coordinator.status()['job']['status'], 'failed')
        self.assertEqual(self.installed[0]['currentCommit'], NEW)
        self.installer_hook = None
        return plan

    def test_post_activation_failure_requires_fresh_pinned_recovery_plan_even_after_expiry(self):
        failed_plan = self.fail_after_deployment()
        old = self.coordinator.read_plan(failed_plan)
        self.clock += updater.PLAN_TTL + 1
        self.network.values['hub']['manifest']['node_version'] = '24.15.0'
        state = self.check()
        self.assertIsNotNone(state['planId'])
        self.assertNotEqual(state['planId'], failed_plan)
        self.assertEqual(state['modules'][0]['state'], 'available')
        self.assertTrue(state['modules'][0]['recovery'])
        self.assertEqual(state['modules'][0]['currentCommit'], NEW)
        fresh = self.coordinator.read_plan(state['planId'])
        self.assertEqual(fresh['entries'][0]['installedIdentity'], 'e' * 64)
        self.assertNotEqual(fresh['entries'][0]['manifestHash'], old['entries'][0]['manifestHash'])
        with self.assertRaises(updater.UpdateError):
            self.coordinator.apply(failed_plan)
        with self.assertRaises(updater.UpdateError):
            self.coordinator.read_plan(failed_plan)
        self.coordinator.apply(state['planId']); self.coordinator.run()
        result = self.coordinator.status()
        self.assertEqual(result['job']['status'], 'succeeded')
        self.assertNotIn('recovery', result['modules'][0])
        self.clock += 61
        self.assertIsNone(self.check()['planId'])

    def test_interrupted_post_activation_attempt_also_offers_recovery(self):
        plan = self.prepare(); self.coordinator.apply(plan)
        with self.coordinator.lock():
            state = self.coordinator.load()
            state['job']['status'] = 'running'; state['job']['steps'][0]['status'] = 'running'
            self.coordinator.save(state)
        self.installed[0].update(currentCommit=NEW, identity='e' * 64)
        self.clock += 61
        self.coordinator.recover(starting=True)
        state = self.check()
        self.assertEqual(state['job']['status'], 'interrupted')
        self.assertTrue(state['modules'][0]['recovery'])
        self.assertNotEqual(state['planId'], plan)

    def test_matching_success_receipt_suppresses_recovery_when_final_job_write_was_interrupted(self):
        plan = self.prepare(); self.coordinator.apply(plan); self.coordinator.run()
        with self.coordinator.lock():
            state = self.coordinator.load()
            state['job']['status'] = 'interrupted'; state['job']['steps'][0]['status'] = 'failed'
            self.coordinator.save(state)
        self.clock += 61
        result = self.check()
        self.assertEqual(result['modules'][0]['state'], 'current')
        self.assertNotIn('recovery', result['modules'][0])
        self.assertIsNone(result['planId'])

    def test_older_success_receipt_cannot_hide_new_failed_attempt(self):
        self.fail_after_deployment()
        release = self.reader.read(registry.BY_ID['hub'])
        receipt = {key: release[key] for key in ('commit', 'releaseId', 'applicationKey', 'installerHash')}
        receipt.update(identity=self.installed[0]['identity'], jobId='f' * 32, completedAt=updater.iso(self.clock - 1))
        updater.write_json(self.coordinator.directory / 'hub.receipt.json', receipt)
        self.clock += 61
        self.assertTrue(self.check()['modules'][0]['recovery'])

    def test_newer_installed_release_does_not_recover_old_failed_target(self):
        self.fail_after_deployment()
        future = 'c' * 40
        release = self.reader.read(registry.BY_ID['hub'])
        release.update(commit=future, tag='deploy-' + future)
        self.installed[0].update(currentCommit=future, identity='d' * 64)
        self.clock += 61
        with patch.object(self.reader, 'read', return_value=release):
            state = self.check()
        self.assertEqual(state['modules'][0]['state'], 'current')
        self.assertNotIn('recovery', state['modules'][0])
        self.assertIsNone(state['planId'])
        self.assertEqual(state['job']['status'], 'failed', 'version checks must preserve historical task results')

    def test_changed_protected_old_plan_cannot_authorize_recovery(self):
        plan = self.fail_after_deployment()
        updater.write_bytes(self.coordinator.plans / plan / 'hub.install.sh', b'changed')
        self.clock += 61
        result = self.check()
        self.assertIsNone(result['planId'])
        self.assertNotIn('recovery', result['modules'][0])

    def test_worker_launch_failure_invalidates_accepted_plan_for_explicit_retry(self):
        plan = self.prepare()
        with patch.object(self.coordinator, 'launch', side_effect=OSError('private output')):
            with self.assertRaises(updater.UpdateError) as error:
                self.coordinator.apply(plan)
        self.assertEqual(error.exception.status, 503)
        failed = self.coordinator.status()
        self.assertEqual(failed['job']['status'], 'failed')
        self.assertEqual(failed['job']['steps'][0]['status'], 'skipped')
        self.assertIsNone(failed['planId'])
        self.assertIsNone(failed['expiresAt'])
        self.clock += 61
        fresh = self.check()['planId']
        self.assertNotEqual(fresh, plan)
        self.coordinator.apply(fresh)
        self.assertEqual(len(self.launches), 1)

    def test_daemon_restart_marks_abandoned_queued_and_running_jobs_interrupted(self):
        for status in ['queued', 'running']:
            with self.subTest(status=status):
                self.clock += 61; plan = self.prepare(); self.coordinator.apply(plan)
                with self.coordinator.lock():
                    value = self.coordinator.load(); value['job']['status'] = status
                    if status == 'running':
                        value['job']['steps'][0]['status'] = 'running'
                    self.coordinator.save(value)
                self.clock += 31
                restarted = self.make_coordinator(); restarted.recover(starting=True)
                result = restarted.status()
                self.assertEqual(result['job']['status'], 'interrupted')
                self.assertIsNone(result['planId'])
                if status == 'running':
                    self.assertEqual(result['job']['steps'][0]['status'], 'failed')

    def test_control_restart_keeps_active_worker_and_does_not_launch_another(self):
        plan = self.prepare(); self.coordinator.apply(plan); self.alive = True; self.clock += 31
        restarted = self.make_coordinator(); restarted.recover(starting=True)
        self.assertEqual(restarted.status()['job']['status'], 'queued')
        restarted.apply(plan)
        self.assertEqual(len(self.launches), 1)
        restarted.alive = lambda: (_ for _ in ()).throw(OSError('sensitive-systemctl-output'))
        self.assertEqual(restarted.status()['job']['status'], 'queued')

    def test_ci_selection_is_durable_and_only_identical_mode_reenters_the_job(self):
        plan = self.prepare()
        accepted = self.coordinator.apply(plan, 'ci')
        self.assertEqual(accepted['deploymentModes'], ['source', 'ci'])
        self.assertEqual(accepted['job']['deployMode'], 'ci')
        restarted = self.make_coordinator()
        self.assertEqual(restarted.load()['job']['deployMode'], 'ci')
        self.assertEqual(restarted.apply(plan, 'ci')['job']['id'], accepted['job']['id'])
        with self.assertRaises(updater.UpdateError) as caught:
            restarted.apply(plan)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(len(self.launches), 1)
        restarted.run()
        self.assertEqual(self.executed_modes, ['ci'])
        self.assertEqual(restarted.status()['job']['status'], 'succeeded')
        self.assertEqual(restarted.status()['job']['deployMode'], 'ci')

    def test_default_and_legacy_jobs_use_source_and_reject_ci_reentry(self):
        plan = self.prepare()
        accepted = self.coordinator.apply(plan)
        self.assertEqual(accepted['job']['deployMode'], 'source')
        with self.coordinator.lock():
            state = self.coordinator.load()
            del state['job']['deployMode']
            self.coordinator.save(state)
        restarted = self.make_coordinator()
        self.assertEqual(restarted.status()['job']['deployMode'], 'source')
        self.assertEqual(restarted.apply(plan, 'source')['job']['id'], accepted['job']['id'])
        with self.assertRaises(updater.UpdateError) as caught:
            restarted.apply(plan, 'ci')
        self.assertEqual(caught.exception.status, 409)
        restarted.run()
        self.assertEqual(self.executed_modes, ['source'])
        self.assertEqual(restarted.status()['job']['status'], 'succeeded')

    def test_invalid_modes_never_launch_and_corrupt_saved_mode_never_executes(self):
        plan = self.prepare()
        for mode in (None, True, 123, {}, [], '', 'SOURCE', 'ci ', 'source;id', 'auto'):
            with self.subTest(mode=mode), self.assertRaises(updater.UpdateError) as caught:
                self.coordinator.apply(plan, mode)
            self.assertEqual(caught.exception.status, 400)
        self.assertEqual(self.launches, [])
        self.assertIsNone(self.coordinator.status()['job'])
        self.coordinator.apply(plan)
        with self.coordinator.lock():
            state = self.coordinator.load()
            state['job']['deployMode'] = 'source;id'
            self.coordinator.save(state)
        self.coordinator.run()
        self.assertEqual(self.executed, [])
        self.assertEqual(self.coordinator.status()['job']['status'], 'failed')

    def test_apply_http_contract_accepts_only_optional_enumerated_deploy_mode(self):
        plan = self.prepare()
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), updater.Handler)
        server.coordinator = self.coordinator
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.05})
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(lambda: thread.join(5))
        self.addCleanup(server.shutdown)
        def request(body):
            connection = http.client.HTTPConnection(*server.server_address, timeout=5)
            try:
                connection.request('POST', '/apply', body=body, headers={'Content-Type': 'application/json'})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()
        for mode in (None, True, 123, {}, [], '', 'SOURCE', 'ci ', 'source;id', 'auto'):
            self.assertEqual(request(encoded({'planId': plan, 'deployMode': mode}))[0], 400)
        for body in ({'deployMode': 'ci'}, {'planId': plan, 'deployMode': 'ci', 'command': 'id'}):
            self.assertEqual(request(encoded(body))[0], 400)
        self.assertEqual(request(b'{"planId":"' + plan.encode() + b'","deployMode":"source","deployMode":"ci"}')[0], 400)
        self.assertEqual(self.launches, [])
        status, accepted = request(encoded({'planId': plan, 'deployMode': 'ci'}))
        self.assertEqual(status, 202)
        self.assertEqual(accepted['job']['deployMode'], 'ci')
        self.assertEqual(request(encoded({'planId': plan}))[0], 409)
        self.assertEqual(request(encoded({'planId': plan, 'deployMode': 'ci'}))[1]['job']['id'], accepted['job']['id'])
        self.assertEqual(len(self.launches), 1)

    def test_control_and_worker_use_separate_process_services_and_fixed_arguments(self):
        with patch.object(updater.subprocess, 'run') as run:
            updater.start_worker()
        arguments = run.call_args.args[0]
        self.assertEqual(arguments, ['/usr/bin/systemctl', 'start', '--no-block', updater.WORKER])
        self.assertNotIn('shell', run.call_args.kwargs)
        self.assertEqual(run.call_args.kwargs['env'], updater.ENVIRONMENT)

    def test_installer_uses_source_mode_pinned_manifest_and_clean_environment(self):
        script = self.root / 'hub.install.sh'
        manifest = self.root / 'hub.release-manifest.json'
        log = self.root / 'hub.install.log'
        script.write_bytes(INSTALLER)
        manifest.write_bytes(encoded(self.network.values['hub']['manifest']))
        inherited = {'PROJECT_DEPLOY_MODE': 'ci', 'PROJECT_DEPLOY_TESTS': '1',
                     'PROJECT_DEPLOY_MANIFEST_FILE': '/untrusted/manifest.json',
                     'PROJECT_UPDATE_PROGRESS_FILE': '/untrusted/progress.json',
                     'GITHUB_TOKEN': GITHUB_TOKEN, 'VITE_UNTRUSTED': 'inherited', 'BASH_ENV': '/untrusted/shell'}
        with patch.dict(os.environ, inherited), patch.object(updater.subprocess, 'run', return_value=SimpleNamespace(returncode=23)) as run:
            self.assertEqual(updater.run_installer(script, manifest, log), 23)
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0], ['/bin/bash', str(script)])
        self.assertEqual(run.call_args.kwargs['env'], {
            **updater.ENVIRONMENT, 'PROJECT_DEPLOY_MODE': 'source', 'PROJECT_DEPLOY_TESTS': '0',
            'PROJECT_DEPLOY_MANIFEST_FILE': str(manifest),
            'PROJECT_UPDATE_PROGRESS_FILE': str(log.parent / 'progress.json')})
        self.assertEqual(run.call_args.kwargs['cwd'], '/')
        self.assertEqual(run.call_args.kwargs['stdin'], updater.subprocess.DEVNULL)
        self.assertEqual(run.call_args.kwargs['stderr'], updater.subprocess.STDOUT)
        self.assertEqual(Path(run.call_args.kwargs['stdout'].name), log)
        self.assertNotIn('shell', run.call_args.kwargs)
        self.assertFalse(run.call_args.kwargs['check'])
        self.assertEqual(json.loads(manifest.read_text())['commit'], NEW)

    def test_installer_uses_selected_ci_mode_and_rejects_arbitrary_environment_values(self):
        script = self.root / 'hub.install.sh'
        manifest = self.root / 'hub.release-manifest.json'
        log = self.root / 'hub.install.log'
        with patch.dict(os.environ, {'PROJECT_DEPLOY_MODE': 'source', 'BASH_ENV': '/untrusted/shell'}), \
                patch.object(updater.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
            self.assertEqual(updater.run_installer(script, manifest, log, 'ci'), 0)
        self.assertEqual(run.call_args.args[0], ['/bin/bash', str(script)])
        self.assertEqual(run.call_args.kwargs['env'], {
            **updater.ENVIRONMENT, 'PROJECT_DEPLOY_MODE': 'ci', 'PROJECT_DEPLOY_TESTS': '0',
            'PROJECT_DEPLOY_MANIFEST_FILE': str(manifest),
            'PROJECT_UPDATE_PROGRESS_FILE': str(log.parent / 'progress.json')})
        for mode in (None, {}, [], True, 'auto', 'ci;id'):
            with patch.object(updater.subprocess, 'run') as run, self.assertRaises(updater.UpdateError):
                updater.run_installer(script, manifest, self.root / 'invalid.log', mode)
            run.assert_not_called()
            self.assertFalse((self.root / 'invalid.log').exists())

    def test_progress_is_bound_to_running_job_and_never_changes_its_result(self):
        plan = self.prepare(); accepted = self.coordinator.apply(plan)
        job_id = accepted['job']['id']
        sample_path = self.coordinator.jobs / job_id / 'progress.json'
        sample = {'stage': 'build', 'timestamp': self.clock * 1000}
        updater.write_json(sample_path, sample)
        self.assertNotIn('progress', self.coordinator.status()['job'], 'queued is not an executing installer')
        def inspect_progress(_key):
            self.assertEqual(self.coordinator.status()['job']['progress'], sample)
            self.assertEqual(self.make_coordinator().status()['job']['progress'], sample,
                             'control and worker read the same private job directory after restart')
            self.assertNotIn('progress', self.coordinator.load()['job'], 'samples are not persisted in authoritative job state')
            for malformed in ('{invalid', '[' * 1500 + '0' + ']' * 1500):
                sample_path.write_text(malformed, encoding='utf8')
                self.assertNotIn('progress', self.coordinator.status()['job'])
            updater.write_json(sample_path, sample)
        self.installer_hook = inspect_progress
        self.coordinator.run()
        finished = self.coordinator.status()['job']
        self.assertEqual(finished['status'], 'succeeded')
        self.assertNotIn('progress', finished)
        with self.coordinator.lock():
            state = self.coordinator.load()
            state['job'].update(id='f' * 32, status='running')
            self.coordinator.save(state)
        self.assertNotIn('progress', self.coordinator.status()['job'], 'a different job cannot reuse the old path')

    def test_terminal_timings_survive_old_worker_state_and_control_restart(self):
        plan = self.prepare(); accepted = self.coordinator.apply(plan)
        job_id = accepted['job']['id']
        path = self.coordinator.jobs / job_id / 'stage-timings.json'
        sample = {'schema': 1, 'jobId': job_id, 'createdAt': self.clock * 1000, 'closed': True, 'active': None,
                  'entries': [{'stage': 'build', 'detail': 'build-workbench', 'durationMs': 1200},
                              {'stage': 'finalize', 'detail': 'updater', 'durationMs': 20}]}
        updater.write_json(path, sample)
        self.assertNotIn('stageTimings', self.coordinator.status()['job'])
        def inspect_timings(_key):
            self.assertNotIn('stageTimings', self.coordinator.status()['job'])
        self.installer_hook = inspect_timings
        self.coordinator.run()
        self.assertNotIn('stageTimings', self.coordinator.load()['job'])
        expected = {'entries': sample['entries']}
        self.assertEqual(self.coordinator.status()['job']['stageTimings'], expected)
        self.clock -= 300
        self.assertEqual(self.make_coordinator().status()['job']['stageTimings'], expected)
        updater.write_json(path, {**sample, 'createdAt': self.clock * 1000})
        self.assertEqual(self.make_coordinator().status()['job']['stageTimings'], expected)
        self.clock += 86400
        restarted = self.make_coordinator()
        self.assertEqual(restarted.status()['job']['stageTimings'], expected)
        for status in ('failed', 'interrupted'):
            with self.coordinator.lock():
                state = self.coordinator.load(); state['job']['status'] = status
                # Untrusted/stale in-state display fields must not override the private projection.
                state['job']['stageTimings'] = {'entries': [{'stage': 'secret', 'durationMs': 1}]}
                self.coordinator.save(state)
            self.assertEqual(restarted.status()['job']['stageTimings'], expected)
            self.assertEqual(restarted.status()['job']['status'], status)
        updater.write_json(path, {**sample, 'closed': False, 'active': {'index': 1}})
        self.assertIsNone(restarted.status()['job']['stageTimings']['entries'][1]['durationMs'])
        for invalid in ('{', '[' * 1500 + '0' + ']' * 1500):
            path.write_text(invalid, encoding='utf8')
            self.assertNotIn('stageTimings', restarted.status()['job'])
            self.assertEqual(restarted.status()['job']['status'], 'interrupted')
        updater.write_json(path, {**sample, 'jobId': 'f' * 32})
        self.assertNotIn('stageTimings', restarted.status()['job'])
        updater.write_json(path, sample)
        with self.coordinator.lock():
            state = self.coordinator.load(); state['job']['id'] = 'f' * 32
            self.coordinator.save(state)
        self.assertNotIn('stageTimings', restarted.status()['job'], 'a new task never reads an old task directory')

    @unittest.skipUnless(LINUX_ROOT, 'Unix socket and root permission checks run in Linux CI')
    def test_removed_progress_route_does_not_hold_control_connection_slots(self):
        endpoint = self.root / 'progress-control.sock'
        server = updater.Server(endpoint, self.coordinator)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.05}); thread.start()
        try:
            for route, expected in [('/progress', 404)] * 20 + [('/status', 200)]:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(2); connection.connect(str(endpoint))
                    connection.sendall(f'GET {route} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'.encode())
                    response = http.client.HTTPResponse(connection); response.begin()
                    self.assertEqual(response.status, expected)
                    json.loads(response.read())
        finally:
            server.shutdown(); server.server_close(); thread.join(5)

    @unittest.skipUnless(LINUX_ROOT, 'Unix socket and root permission checks run in Linux CI')
    def test_main_creates_root_owned_group_only_control_socket(self):
        endpoint_dir = self.root / 'run'; endpoint_dir.mkdir(mode=0o700)
        endpoint = endpoint_dir / 'control.sock'
        def inspect_socket(*_args, **_kwargs):
            info = endpoint.stat()
            self.assertTrue(stat.S_ISSOCK(info.st_mode))
            self.assertEqual(info.st_uid, 0)
            self.assertEqual(info.st_gid, 0)
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o660)
            self.assertEqual(stat.S_IMODE(endpoint_dir.stat().st_mode), 0o750)
        with patch.object(updater, 'SOCKET_DIR', endpoint_dir), patch.object(updater, 'Coordinator', return_value=self.coordinator), \
                patch.object(sys, 'argv', ['updater.py', 'serve']), patch('grp.getgrnam', return_value=SimpleNamespace(gr_gid=0)), \
                patch.object(updater.Server, 'serve_forever', side_effect=inspect_socket), \
                patch.object(self.coordinator, 'start_scheduler') as start, patch.object(self.coordinator, 'stop_scheduler') as stop:
            updater.main()
        start.assert_called_once(); stop.assert_called_once()

    @unittest.skipUnless(LINUX_ROOT, 'Unix socket and root permission checks run in Linux CI')
    def test_unix_http_rejects_extra_inputs_and_worker_survives_control_shutdown(self):
        plan = self.prepare(); endpoint = self.root / 'control.sock'
        entered = threading.Event(); resume = threading.Event(); workers = []
        def installer(key):
            if key == 'hub':
                entered.set(); self.assertTrue(resume.wait(5))
            return 0
        self.installer_hook = installer
        def launch():
            self.launches.append('launch'); worker = threading.Thread(target=self.coordinator.run)
            worker.start(); workers.append(worker)
        self.coordinator.launch = launch
        server = updater.Server(endpoint, self.coordinator)
        os.chmod(endpoint, 0o660)
        self.assertEqual(stat.S_IMODE(endpoint.stat().st_mode), 0o660)
        self.assertEqual(endpoint.stat().st_uid, 0)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.05}); thread.start()
        def request(route, body):
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); connection.settimeout(5); connection.connect(str(endpoint))
            content = encoded(body)
            connection.sendall((f'POST {route} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {len(content)}\r\nConnection: close\r\n\r\n').encode() + content)
            response = http.client.HTTPResponse(connection); response.begin(); payload = json.loads(response.read()); status = response.status
            connection.close(); return status, payload
        try:
            self.assertEqual(request('/apply', {'planId': plan, 'command': 'id'})[0], 400)
            self.assertEqual(request('/check', {'url': 'https://attacker.example'})[0], 400)
            status, accepted = request('/apply', {'planId': plan})
            self.assertEqual(status, 202); self.assertEqual(accepted['job']['status'], 'queued')
            self.assertTrue(entered.wait(5))
            server.shutdown(); server.server_close(); thread.join(5)
            resume.set()
            for worker in workers:
                worker.join(5); self.assertFalse(worker.is_alive())
            self.assertEqual(self.coordinator.status()['job']['status'], 'succeeded')
            self.assertEqual(len(self.executed), 1)
        finally:
            resume.set()
            if thread.is_alive():
                server.shutdown(); server.server_close(); thread.join(5)
            for worker in workers:
                worker.join(5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
