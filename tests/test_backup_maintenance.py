"""Isolated schedule fixtures; never touch production services, keys or webhooks."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

REPO = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load('maintenance_fixture', REPO / 'server/recovery/maintenance.py')
operations = load('operations_fixture', REPO / 'server/recovery/operations.py')
CONFIG = {'schemaVersion': 1, 'enabled': True, 'start': '23:00', 'end': '01:00', 'timezone': 'Asia/Shanghai', 'keep': 2, 'minFreeMb': 64}
NOW = datetime(2026, 11, 10, 16, 0, tzinfo=timezone.utc)


class FixtureOps:
    def __init__(self, root):
        self.KEYS = root / 'keys'
        self.KEYS.mkdir()
        for name in ('data.key', 'secrets.key'):
            (self.KEYS / name).write_bytes(os.urandom(32))
        self.APP = root / 'app'
        self.ENVIRONMENT = root / 'root.env'
        self.STACK_LOCK = root / 'stack.lock'
        self.INSTALL_LOCK = root / 'install.lock'
        self.calls = []
        self.states = {'runtime.service': 'active', 'api.service': 'inactive'}
        self.source_state = 'normal'
        self.fail_backup = False
        self.fail_stop = False
        self.fail_start = False
        self.locks = []

    def safe_directory(self, directory, private=True):
        directory.mkdir(parents=True, exist_ok=True)

    def trusted(self, filename, private=False):
        return filename

    def deployment(self):
        return {'source': self.KEYS.parent / 'source', 'uid': 123}

    @contextmanager
    def exclusive(self, filename):
        self.locks.append(filename)
        yield

    def services(self):
        return tuple(self.states)

    def service_state(self, unit):
        return {'ActiveState': self.states[unit], 'MainPID': '0', 'ControlGroup': ''}

    def install_guard(self, _):
        self.calls.append('guard')

    def require_stopped(self, groups=None):
        if any(state not in ('inactive', 'failed') for state in self.states.values()):
            raise ValueError('RECOVERY_WRITERS_STILL_RUNNING')

    def systemctl(self, *args, **kwargs):
        self.calls.append(args)
        if args[0] == 'stop':
            if self.fail_stop:
                raise ValueError('RECOVERY_STOP_FAILED')
            for unit in args[1:]:
                self.states[unit] = 'inactive'
        if args[0] == 'start':
            if self.fail_start:
                raise ValueError('RECOVERY_START_FAILED')
            for unit in args[1:]:
                self.states[unit] = 'active'
            if 'runtime.service' in args:
                self.states['api.service'] = 'active'  # systemd Wants dependency
        if args[0] == 'show':
            return 'ActiveState=active\nUnitFileState=enabled\nNeedDaemonReload=no'

    def run_cli(self, config, action, *args, **kwargs):
        self.calls.append(action)
        if action == 'check-source':
            return {'state': self.source_state}
        if action == 'backup':
            if self.fail_backup:
                raise ValueError('RECOVERY_SPACE_INSUFFICIENT')
            directory = args[args.index('--destination') + 1]
            directory.mkdir()
            (directory / 'manifest.json').write_text('{}')
            return {'checkpointId': '12345678-1234-1234-1234-123456789012'}
        if action == 'verify-archive':
            directory = args[args.index('--backup-dir') + 1]
            if not (directory / 'manifest.json').is_file():
                raise ValueError('RECOVERY_MANIFEST_INVALID')
            import hashlib
            return {'checkpointId': '12345678-1234-1234-1234-123456789012', 'digest': hashlib.sha256(directory.name.encode()).hexdigest(), 'commit': 'a' * 40,
                    'completedAt': NOW.isoformat(), 'verifiedAt': NOW.isoformat(), 'archiveVerification': 'authenticated-ciphertext', 'unresolvedDependencyCount': 0}
        return {}


class ScheduleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='backup-schedule-fixture-')
        self.root = Path(self.temporary.name).resolve()
        self.ops = FixtureOps(self.root)
        self.patches = [patch.object(m.os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True), patch.object(m, 'ROOT', self.root / 'backups'), patch.object(m, 'CONFIG', self.root / 'config.json'),
                        patch.object(m, 'PUBLIC', self.root / 'public/readiness.json'), patch.object(m, 'UNITS', self.root / 'units')]
        for item in self.patches:
            item.start()
        # Main behavioral tests run natively on Windows too. Linux-only tests
        # below exercise the actual atomic writer, permissions and nofollow.
        self.real_atomic = m.atomic
        self.atomic_patch = patch.object(m, 'atomic', side_effect=self.write)
        self.atomic_patch.start()
        self.write(self.ops, m.CONFIG, CONFIG)

    def tearDown(self):
        self.atomic_patch.stop()
        for item in reversed(self.patches):
            item.stop()
        self.temporary.cleanup()

    def write(self, ops, filename, value, private=True):
        filename.parent.mkdir(parents=True, exist_ok=True)
        filename.write_text(json.dumps(value), encoding='utf-8')

    def tick(self, now=NOW):
        return m.run_locked(self.ops, lambda: now)

    def state(self):
        return json.loads((m.ROOT / 'state.json').read_text())

    def test_cross_midnight_window_uses_start_day_and_excludes_end(self):
        self.assertEqual(m.window(CONFIG, NOW), 'Asia/Shanghai:2026-11-10:23:00')
        self.assertEqual(m.window(CONFIG, NOW.replace(hour=15, minute=59)), m.window(CONFIG, NOW))
        self.assertIsNone(m.window(CONFIG, NOW.replace(hour=17)))
        self.assertIsNone(m.window(CONFIG, NOW.replace(hour=14)))
        utc = {**CONFIG, 'timezone': 'UTC', 'start': '10:00', 'end': '11:00'}
        self.assertIsNotNone(m.window(utc, NOW.replace(hour=10)))
        self.assertIsNone(m.window(utc, NOW.replace(hour=11)))

    def test_success_restores_exact_active_set_and_same_window_is_idempotent(self):
        first = self.tick()
        self.assertEqual(first['status'], 'complete')
        self.assertEqual(self.ops.states, {'runtime.service': 'active', 'api.service': 'inactive'})
        self.assertEqual(self.tick()['status'], 'already-claimed')
        self.assertEqual(self.ops.calls.count('backup'), 1)
        row = self.state()['runs'][0]
        self.assertEqual(row['archive']['archiveVerification'], 'authenticated-ciphertext')
        self.assertNotIn('restorable', row['archive'])

    def test_outside_window_and_disabled_never_stop_or_make_up_missed_window(self):
        self.assertEqual(self.tick(NOW.replace(hour=17))['status'], 'outside-window')
        self.assertNotIn('backup', self.ops.calls)
        m.CONFIG.unlink()
        self.assertEqual(self.tick()['status'], 'disabled')
        self.assertFalse(any(isinstance(call, tuple) and call[0] == 'stop' for call in self.ops.calls))

    def test_window_rechecked_after_guard_and_persistent_claim_immediately_before_stop(self):
        times = iter([NOW, NOW, NOW, NOW.replace(hour=17), NOW.replace(hour=17)])
        result = m.run_locked(self.ops, lambda: next(times))
        self.assertEqual(result['error'], 'RECOVERY_SCHEDULE_WINDOW_CLOSED')
        self.assertFalse(any(isinstance(call, tuple) and call[0] == 'stop' for call in self.ops.calls))
        self.assertEqual(self.tick()['status'], 'already-claimed')

    def test_space_failure_and_missing_keys_never_stop(self):
        with patch.object(m.shutil, 'disk_usage', return_value=Mock(free=0)):
            self.assertEqual(self.tick()['error'], 'RECOVERY_SPACE_INSUFFICIENT')
        self.assertFalse(any(isinstance(call, tuple) and call[0] == 'stop' for call in self.ops.calls))
        (self.ops.KEYS / 'data.key').unlink()
        result = self.tick(NOW.replace(day=11))
        self.assertEqual(result['error'], 'RECOVERY_KEYS_MISSING')

    def test_backup_failure_restores_original_services_and_preserves_prior_archive(self):
        self.tick()
        first = self.state()['runs'][0]['id']
        self.ops.fail_backup = True
        result = self.tick(NOW.replace(day=11))
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(self.ops.states, {'runtime.service': 'active', 'api.service': 'inactive'})
        self.assertTrue((m.ROOT / first / 'manifest.json').exists())

    def test_service_restore_failure_is_unknown_and_future_windows_do_not_stop(self):
        self.ops.fail_start = True
        self.assertEqual(self.tick()['status'], 'unknown')
        stops = sum(isinstance(call, tuple) and call[0] == 'stop' for call in self.ops.calls)
        self.assertEqual(self.tick(NOW.replace(day=11))['status'], 'unknown-requires-review')
        self.assertEqual(stops, sum(isinstance(call, tuple) and call[0] == 'stop' for call in self.ops.calls))

    def test_crash_claim_becomes_unknown_and_only_recovers_services_without_new_backup(self):
        with patch.object(m, 'cold_backup', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.tick()
        self.assertEqual(self.state()['runs'][0]['status'], 'running')
        self.assertEqual(self.tick(NOW.replace(day=11))['status'], 'unknown-requires-review')
        self.assertEqual(self.state()['runs'][0]['status'], 'unknown')
        self.assertNotIn('backup', self.ops.calls)

    def test_retired_source_never_restarts_and_quarantine_is_not_changed(self):
        self.ops.source_state = 'retired'
        self.assertEqual(self.tick()['status'], 'unknown')
        self.assertFalse(any(isinstance(call, tuple) and call[0] == 'start' for call in self.ops.calls))
        self.assertNotIn('backup', self.ops.calls)
        self.ops.source_state = 'quarantine'
        before = {'runtime.service': 'active', 'api.service': 'inactive'}
        m.restore_services(self.ops, self.ops.deployment(), before)
        self.assertEqual(self.ops.source_state, 'quarantine')
        self.assertEqual(self.ops.states, before)

    def test_retention_only_removes_old_verified_plan_packages_and_keeps_two(self):
        m.ROOT.mkdir()
        manual = m.ROOT / 'manual-copy'
        manual.mkdir()
        (manual / 'manifest.json').write_text('manual')
        incomplete = m.ROOT / '.scheduled-incomplete'
        incomplete.mkdir()
        for day in (10, 11, 12):
            self.tick(NOW.replace(day=day))
        state = self.state()
        self.assertEqual(state['runs'][0]['retention'], 'removed')
        self.assertFalse((m.ROOT / state['runs'][0]['id']).exists())
        for run in state['runs'][1:]:
            self.assertTrue((m.ROOT / run['id'] / 'manifest.json').is_file())
        self.assertTrue(manual.exists())
        self.assertTrue(incomplete.exists())

    def test_retention_identity_or_delete_failure_preserves_evidence(self):
        for day in (10, 11):
            self.tick(NOW.replace(day=day))
        original = self.state()['runs'][0]
        with patch.object(m.shutil, 'rmtree', side_effect=OSError('secret-path-do-not-leak')):
            result = self.tick(NOW.replace(day=12))
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['error'], 'RECOVERY_RETENTION_DELETE_FAILED')
        self.assertEqual(self.state()['runs'][0]['retention'], 'delete-failed')
        self.assertTrue((m.ROOT / original['id']).exists())
        marker = m.ROOT / original['id'] / '.schedule.json'
        self.write(self.ops, marker, {'schemaVersion': 1, 'id': original['id'], 'digest': 'f' * 64})
        self.assertEqual(self.tick(NOW.replace(day=13))['error'], 'RECOVERY_RETENTION_IDENTITY_MISMATCH')
        self.assertTrue((m.ROOT / original['id']).exists())

    def test_retention_total_deadline_preserves_all_packages(self):
        self.tick()
        state = self.state()
        with patch.object(m.time, 'monotonic', side_effect=[0, 601]):
            with self.assertRaisesRegex(ValueError, 'RECOVERY_RETENTION_TIMEOUT'):
                m.retain(self.ops, self.ops.deployment(), CONFIG, state)
        self.assertTrue((m.ROOT / state['runs'][0]['id']).exists())

    def test_notification_claim_is_durable_before_send_and_timeout_is_not_resent(self):
        self.write(self.ops, m.CONFIG, {**CONFIG, 'webhook': 'https://example.invalid/PRIVATE'})
        self.ops.fail_backup = True
        def send(*args, **kwargs):
            self.assertEqual(self.state()['runs'][-1]['notification'], 'unknown')
            self.assertEqual(kwargs['timeout'], 8)
            raise TimeoutError('https://example.invalid/PRIVATE')
        opener = Mock()
        opener.open.side_effect = send
        with patch.object(m.urllib.request, 'build_opener', return_value=opener):
            self.tick()
            self.tick()
        self.assertEqual(opener.open.call_count, 1)
        public = m.PUBLIC.read_text()
        self.assertNotIn('PRIVATE', public)
        self.assertNotIn('data.key', public)
        self.assertNotIn(str(self.root), public)
        self.assertEqual(json.loads(public)['runs'][0]['notification'], 'unknown')

    def test_notification_claim_write_failure_prevents_any_external_send(self):
        state = {'schemaVersion': 1, 'runs': [{'id': 'scheduled-20261110T000000Z-123456789012', 'window': 'window', 'status': 'failed', 'phase': 'preflight', 'error': 'RECOVERY_SPACE_INSUFFICIENT'}]}
        with patch.object(m, 'save', side_effect=OSError('disk full')), patch.object(m.urllib.request, 'build_opener') as opener:
            with self.assertRaises(OSError):
                m.notify(self.ops, {**CONFIG, 'webhook': 'https://example.invalid/private'}, state, state['runs'][0])
        opener.assert_not_called()

    def test_metadata_publish_failure_does_not_reclassify_success(self):
        with patch.object(m, 'publish', side_effect=OSError('public unavailable')):
            result = self.tick()
        self.assertEqual(result['status'], 'complete')
        self.assertFalse(result['metadataPublished'])
        self.assertEqual(self.state()['runs'][0]['status'], 'complete')

    def test_public_permission_exception_cannot_target_an_unrelated_path(self):
        with patch.object(self.ops, 'safe_directory') as safe:
            with self.assertRaisesRegex(ValueError, 'RECOVERY_PUBLIC_PATH_INVALID'):
                self.real_atomic(self.ops, self.root / 'unrelated/state.json', {}, private=False)
        safe.assert_not_called()
        self.assertFalse((self.root / 'unrelated').exists())

    def test_unknown_schema_refuses_and_empty_old_state_is_disabled_by_default(self):
        self.write(self.ops, m.ROOT / 'state.json', {'schemaVersion': 9, 'runs': []})
        with self.assertRaisesRegex(ValueError, 'STATE_INVALID'):
            self.tick()
        self.assertNotIn('backup', self.ops.calls)
        m.CONFIG.unlink()
        self.assertEqual(self.tick()['status'], 'disabled')

    def test_configure_is_one_command_with_timer_no_backup_and_defaults_shanghai(self):
        result = m.main(self.ops, ['schedule-configure', '--window-start', '02:00', '--window-end', '03:00'])
        self.assertTrue(result['enabled'])
        value = json.loads(m.CONFIG.read_text())
        self.assertEqual(value['timezone'], 'Asia/Shanghai')
        self.assertIn(('enable', '--now', m.TIMER), self.ops.calls)
        self.assertEqual(self.ops.locks, [self.ops.STACK_LOCK, self.ops.INSTALL_LOCK])
        self.assertIn('Persistent=false', (m.UNITS / m.TIMER).read_text())
        self.assertIn('schedule-run', (m.UNITS / m.SERVICE).read_text())
        self.assertNotIn('backup', self.ops.calls)
        calls = len(self.ops.calls)
        result = m.main(self.ops, ['schedule-configure', '--window-start', '02:00', '--window-end', '03:00'])
        self.assertTrue(result['unchanged'])
        self.assertFalse(any(isinstance(call, tuple) and call[0] in ('disable', 'enable', 'daemon-reload') for call in self.ops.calls[calls:]))
        m.main(self.ops, ['schedule-configure', '--disable'])
        self.assertFalse(json.loads(m.CONFIG.read_text())['enabled'])
        self.assertIn(('disable', '--now', m.TIMER), self.ops.calls)

    def test_lock_conflict_or_timer_activation_failure_never_runs_backup(self):
        with patch.object(self.ops, 'exclusive', side_effect=BlockingIOError):
            with self.assertRaises(BlockingIOError):
                m.main(self.ops, ['schedule-run'])
        self.assertEqual(self.ops.calls, [])
        original = self.ops.systemctl
        def fail(*args, **kwargs):
            if args[0] == 'enable':
                raise subprocess.TimeoutExpired('systemctl', 30)
            return original(*args, **kwargs)
        with patch.object(self.ops, 'systemctl', side_effect=fail):
            with self.assertRaises(subprocess.TimeoutExpired):
                m.main(self.ops, ['schedule-configure', '--window-start', '02:00', '--window-end', '03:00'])
        self.assertFalse(json.loads(m.CONFIG.read_text())['enabled'])

    def test_explicit_resolve_never_starts_a_new_backup(self):
        with patch.object(m, 'cold_backup', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.tick()
        identity = self.state()['runs'][0]['id']
        result = m.main(self.ops, ['schedule-resolve', '--run-id', identity])
        self.assertEqual(result['status'], 'failed')
        self.assertNotIn('backup', self.ops.calls)

    def test_manual_registration_is_idempotent_read_only_and_never_a_retention_candidate(self):
        m.CONFIG.unlink()
        archive = self.root / 'manual'
        archive.mkdir()
        (archive / 'manifest.json').write_text('{}')
        first = m.main(self.ops, ['backup-register', '--backup-dir', str(archive)])
        second = m.main(self.ops, ['backup-register', '--backup-dir', str(archive)])
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(len(self.state()['runs']), 1)
        self.assertEqual(json.loads(m.PUBLIC.read_text())['runs'][0]['origin'], 'manual-registration')
        self.assertFalse(json.loads(m.PUBLIC.read_text())['schedule']['enabled'])
        m.retain(self.ops, self.ops.deployment(), CONFIG, self.state())
        self.assertTrue(archive.exists())
        self.assertNotIn('backup', self.ops.calls)
        self.assertNotIn('restore', self.ops.calls)
        self.assertFalse(any(isinstance(call, tuple) and call[0] in ('start', 'stop') for call in self.ops.calls))

    def test_manual_registration_capacity_keeps_unknown_claim_and_publicly_reports_it(self):
        unknown = {'id': 'scheduled-20261110T000000Z-123456789012', 'window': 'old-window', 'status': 'unknown', 'phase': 'interrupted', 'error': 'RECOVERY_SCHEDULE_INTERRUPTED'}
        state = {'schemaVersion': 1, 'runs': [unknown]}
        for number in range(m.MAX_RECORDS + 10):
            m.append_run(state, {'id': f'manual-{number:024x}', 'window': 'manual', 'status': 'complete', 'phase': 'complete'})
        self.assertIn(unknown, state['runs'])
        self.assertEqual(len(state['runs']), m.MAX_RECORDS)
        m.publish(self.ops, CONFIG, state)
        public = json.loads(m.PUBLIC.read_text())
        self.assertTrue(public['schedule']['blockedByUnknown'])
        self.assertEqual(len(public['runs']), m.PUBLIC_RECORDS)
        self.assertTrue(any(row['id'] == unknown['id'] for row in public['runs']))

    def test_interrupted_after_cold_stop_restores_original_services_only(self):
        unknown = {'id': 'scheduled-20261110T000000Z-123456789012', 'window': 'old-window', 'status': 'running', 'phase': 'cold-backup',
                   'before': dict(self.ops.states)}
        self.write(self.ops, m.ROOT / 'state.json', {'schemaVersion': 1, 'runs': [unknown]})
        self.ops.states = {key: 'inactive' for key in self.ops.states}
        self.assertEqual(self.tick()['status'], 'unknown-requires-review')
        self.assertEqual(self.ops.states, unknown['before'])
        self.assertTrue(self.state()['runs'][0]['servicesRecovered'])
        self.assertNotIn('backup', self.ops.calls)


@unittest.skipUnless(os.name == 'posix' and hasattr(os, 'geteuid') and os.geteuid() == 0, 'Linux root CI only; no WSL')
class RootBoundaryTests(unittest.TestCase):
    def test_private_umask_public_snapshot_is_actually_readable_by_nonroot_after_each_publish(self):
        import pwd
        account = pwd.getpwnam('nobody')
        with tempfile.TemporaryDirectory(prefix='backup-public-read-fixture-') as directory:
            root = Path(directory)
            # Only the fixture ancestor is traversable; production ancestors
            # already exist. The implementation must not chmod an ancestor.
            root.chmod(0o755)
            public = root / 'public/readiness.json'
            private = root / 'private/state.json'
            state = {'schemaVersion': 1, 'runs': []}
            program = ('import json,sys; from pathlib import Path; '
                       'value=json.loads(Path(sys.argv[1]).read_text()); '
                       'assert value["schemaVersion"] == 1; '
                       'assert len(value["runs"]) == int(sys.argv[2])')
            previous_umask = os.umask(0o077)
            try:
                with patch.object(m, 'PUBLIC', public):
                    m.atomic(operations, private, {'private': True})
                    for expected in (0, 1):
                        if expected:
                            state['runs'].append({'id': 'manual-' + 'a' * 24, 'window': 'manual', 'status': 'complete', 'phase': 'complete'})
                        m.publish(operations, {'schemaVersion': 1, 'enabled': False}, state)
                        result = subprocess.run([os.sys.executable, '-I', '-c', program, str(public), str(expected)],
                                                user=account.pw_uid, group=account.pw_gid, extra_groups=[], cwd='/',
                                                env=operations.CLEAN_ENV, capture_output=True, text=True, timeout=5)
                        self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(public.parent.stat().st_mode & 0o777, 0o755)
                    self.assertEqual(public.stat().st_mode & 0o777, 0o644)
                    self.assertEqual(public.stat().st_uid, 0)
                    self.assertEqual(root.stat().st_mode & 0o777, 0o755)
                    self.assertEqual(private.parent.stat().st_mode & 0o777, 0o700)
                    self.assertEqual(private.stat().st_mode & 0o777, 0o600)
                    denied = subprocess.run([os.sys.executable, '-I', '-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).read_text()', str(private)],
                                            user=account.pw_uid, group=account.pw_gid, extra_groups=[], cwd='/',
                                            env=operations.CLEAN_ENV, capture_output=True, text=True, timeout=5)
                    self.assertNotEqual(denied.returncode, 0)
                    self.assertIn('PermissionError', denied.stderr)
            finally:
                os.umask(previous_umask)

    def test_real_atomic_writer_rejects_links_writable_parents_and_private_file_permissions(self):
        with tempfile.TemporaryDirectory(prefix='backup-root-boundary-') as directory:
            root = Path(directory)
            target = root / 'state.json'
            m.atomic(operations, target, {'safe': True})
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            target.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'UNTRUSTED'):
                m.read_json(operations, target)
            target.chmod(0o600)
            link = root / 'link.json'
            link.symlink_to(target)
            with self.assertRaisesRegex(ValueError, 'UNTRUSTED'):
                m.atomic(operations, link, {})
            root.chmod(0o777)
            with self.assertRaises(ValueError):
                m.atomic(operations, target, {})
            root.chmod(0o700)

    def test_retention_refuses_link_hardlink_and_escape_without_deleting(self):
        with tempfile.TemporaryDirectory(prefix='backup-retention-root-') as directory:
            root = Path(directory)
            managed = root / 'scheduled-20261110T000000Z-123456789012'
            managed.mkdir(mode=0o700)
            target = root / 'outside'
            target.write_text('must survive')
            target.chmod(0o600)
            with patch.object(m, 'ROOT', root):
                with self.assertRaisesRegex(ValueError, 'UNSAFE_PATH'):
                    m.checked_tree(operations, root.parent)
                (managed / 'linked').symlink_to(target)
                with self.assertRaises(ValueError):
                    m.checked_tree(operations, managed)
                (managed / 'linked').unlink()
                os.link(target, managed / 'hardlink')
                with self.assertRaises(ValueError):
                    m.checked_tree(operations, managed)
                self.assertEqual(target.read_text(), 'must survive')

    def test_generated_units_pass_real_systemd_analyze_without_starting_services(self):
        if not shutil.which('systemd-analyze'):
            self.skipTest('systemd-analyze unavailable')
        with tempfile.TemporaryDirectory(prefix='backup-unit-fixture-') as directory:
            root = Path(directory)
            ops = FixtureOps(root)
            with patch.object(m, 'ROOT', root / 'backups'), patch.object(m, 'CONFIG', root / 'keys/schedule.json'), patch.object(m, 'PUBLIC', root / 'public/readiness.json'), patch.object(m, 'UNITS', root / 'units'):
                m.main(ops, ['schedule-configure', '--window-start', '02:00', '--window-end', '03:00'])
                result = subprocess.run(['systemd-analyze', 'verify', str(m.UNITS / m.SERVICE), str(m.UNITS / m.TIMER)], capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn('backup', ops.calls)


if __name__ == '__main__':
    unittest.main()
