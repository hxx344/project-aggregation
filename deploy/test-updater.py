"""Updater boundary and recovery tests. Linux CI: sudo python3 deploy/test-updater.py."""
import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
import http.client
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

    def test_all_seven_installer_identities_and_local_only_discovery(self):
        self.assertEqual(registry.inventory(self.root), [])
        for module in registry.MODULES:
            self.install(module)
        (self.root / 'opt/unknown-remote-project').mkdir()
        values = registry.inventory(self.root)
        self.assertEqual([row['id'] for row in values], [module.id for module in registry.MODULES])
        self.assertEqual(len(values), 7)
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
        self.assertIn((f'https://raw.githubusercontent.com/hxx344/project-aggregation/{NEW}/install.sh', 'GET'), self.network.calls)
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
        self.launches = []; self.executed = []; self.syntaxes = []
        self.installer_hook = None
        self.alive = False
        self.coordinator = self.make_coordinator()

    def make_coordinator(self):
        return updater.Coordinator(directory=self.root / 'state', releases=self.reader,
                                   inspect=lambda: copy.deepcopy(self.installed), launch=lambda: self.launches.append('launch'),
                                   alive=lambda: self.alive, installer=self.install, syntax=lambda p: self.syntaxes.append(p.stem),
                                   clock=lambda: self.clock, stack_lock=self.root / 'stack.lock')

    def install(self, script, manifest, log):
        key = script.name.removesuffix('.install.sh')
        self.executed.append(key)
        log.write_text('api_secret=PRIVATE_DEPLOYMENT_CREDENTIAL\n', encoding='utf8')
        if self.installer_hook:
            code = self.installer_hook(key)
            if code:
                return code
        value = next(item for item in self.installed if item['id'] == key)
        value.update(currentCommit=NEW, currentVersion=NEW[:12], applicationKey=NEW_KEY,
                     identity=hashlib.sha256((key + NEW).encode()).hexdigest())
        return 0

    def check(self):
        self.coordinator.check()
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

    def test_doc_only_changes_are_current_and_installer_changes_apply_once(self):
        self.installed = [self.installed[-1]]
        self.installed[0]['applicationKey'] = NEW_KEY
        self.network.values['hub']['oldInstaller'] = INSTALLER
        result = self.check()
        self.assertEqual(result['modules'][0]['state'], 'current')
        self.assertIsNone(result['planId'])

        self.clock += 61
        self.network.values['hub']['oldInstaller'] = OLD_INSTALLER
        plan = self.prepare(); self.coordinator.apply(plan); self.coordinator.run()
        self.assertEqual(self.executed, ['hub'])
        self.assertEqual(self.coordinator.status()['job']['status'], 'succeeded')
        # An incremental installer may retain the app-identical previous source.
        self.installed[0]['currentCommit'] = OLD
        self.installed[0]['currentVersion'] = OLD[:12]
        self.clock += 61
        result = self.check()
        self.assertEqual(result['modules'][0]['state'], 'current')
        self.assertIsNone(result['planId'])
        self.installed[0]['identity'] = 'f' * 64
        self.clock += 61
        result = self.check()
        self.assertEqual(result['modules'][0]['state'], 'available', 'a receipt must not authorize a changed installation')

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
        self.assertTrue(any(item['state'] == 'available' for item in result['modules']))
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
            if key == 'aster':
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
        self.installer_hook = lambda key: 17 if key == 'asset' else 0
        plan = self.prepare(); self.coordinator.apply(plan); self.coordinator.run()
        state = self.coordinator.status()
        self.assertEqual(self.executed, ['aster', 'monitor', 'asset'])
        self.assertEqual([step['status'] for step in state['job']['steps']], ['succeeded', 'succeeded', 'failed', 'skipped', 'skipped', 'skipped', 'skipped'])
        self.assertEqual(state['job']['status'], 'failed')
        self.assertNotIn('PRIVATE_DEPLOYMENT_CREDENTIAL', json.dumps(state))
        self.assertEqual(state['modules'][0]['currentCommit'], NEW)

    def test_daemon_restart_marks_abandoned_queued_and_running_jobs_interrupted(self):
        for status in ['queued', 'running']:
            with self.subTest(status=status):
                self.clock += 61; plan = self.prepare(); self.coordinator.apply(plan)
                with self.coordinator.lock():
                    value = self.coordinator.load(); value['job']['status'] = status
                    if status == 'running':
                        value['job']['steps'][0]['status'] = 'succeeded'; value['job']['steps'][1]['status'] = 'running'
                    self.coordinator.save(value)
                self.clock += 31
                restarted = self.make_coordinator(); restarted.recover(starting=True)
                result = restarted.status()
                self.assertEqual(result['job']['status'], 'interrupted')
                self.assertIsNone(result['planId'])
                if status == 'running':
                    self.assertEqual(result['job']['steps'][0]['status'], 'succeeded')
                    self.assertEqual(result['job']['steps'][1]['status'], 'failed')

    def test_control_restart_keeps_active_worker_and_does_not_launch_another(self):
        plan = self.prepare(); self.coordinator.apply(plan); self.alive = True; self.clock += 31
        restarted = self.make_coordinator(); restarted.recover(starting=True)
        self.assertEqual(restarted.status()['job']['status'], 'queued')
        restarted.apply(plan)
        self.assertEqual(len(self.launches), 1)
        restarted.alive = lambda: (_ for _ in ()).throw(OSError('sensitive-systemctl-output'))
        self.assertEqual(restarted.status()['job']['status'], 'queued')

    def test_control_and_worker_use_separate_process_services_and_fixed_arguments(self):
        with patch.object(updater.subprocess, 'run') as run:
            updater.start_worker()
        arguments = run.call_args.args[0]
        self.assertEqual(arguments, ['/usr/bin/systemctl', 'start', '--no-block', updater.WORKER])
        self.assertNotIn('shell', run.call_args.kwargs)
        self.assertEqual(run.call_args.kwargs['env'], updater.ENVIRONMENT)

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
                patch.object(updater.Server, 'serve_forever', side_effect=inspect_socket):
            updater.main()

    @unittest.skipUnless(LINUX_ROOT, 'Unix socket and root permission checks run in Linux CI')
    def test_unix_http_rejects_extra_inputs_and_worker_survives_control_shutdown(self):
        plan = self.prepare(); endpoint = self.root / 'control.sock'
        entered = threading.Event(); resume = threading.Event(); workers = []
        def installer(key):
            if key == 'aster':
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
            self.assertEqual(len(self.executed), 7)
        finally:
            resume.set()
            if thread.is_alive():
                server.shutdown(); server.server_close(); thread.join(5)
            for worker in workers:
                worker.join(5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
