import importlib.util
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import subprocess
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get('RECOVERY_TEST_NODE') or shutil.which('node')


def load(name):
    spec = importlib.util.spec_from_file_location('m2_' + name.replace('-', '_'), ROOT / 'server/recovery' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


operations = load('operations')
startup = load('startup-guard')


class StartupGuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='recovery-guard-')
        self.addCleanup(self.temporary.cleanup)
        self.data = Path(self.temporary.name)
        self.database = self.data / 'execution-control.sqlite'
        self.core = self.data / 'core.mjs'
        self.core.write_text('export const RECOVERY_SCHEMA_VERSION=1;\n', encoding='utf-8')
        self.node = NODE
        self.registry = str(uuid.uuid4())
        self.state('normal')

    def state(self, value):
        with closing(sqlite3.connect(self.database)) as db:
            db.execute('CREATE TABLE IF NOT EXISTS aw_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
            for key, data in [('recovery_schema', '1'), ('registry_id', self.registry),
                              ('recovery_state', json.dumps({'schemaVersion': 1, 'authorityId': str(uuid.uuid4()), 'state': value}))]:
                db.execute('INSERT OR REPLACE INTO aw_meta VALUES (?,?)', (key, data))
            db.commit()
        info = self.database.stat()
        Path(str(self.database) + '.required').write_text(json.dumps({'schema': 1, 'registryId': self.registry, 'dev': str(info.st_dev), 'ino': str(info.st_ino)}))

    def test_only_supported_core_may_start_normal_or_quarantined_m2_data(self):
        for state in ('normal', 'quarantine'):
            self.state(state)
            startup.guard(str(self.data), self.core, self.node)
            self.core.write_text('export const OLD_CORE=1;\n')
            with self.assertRaisesRegex(ValueError, 'cannot enforce'):
                startup.guard(str(self.data), self.core, self.node)
            self.core.write_text('export const RECOVERY_SCHEMA_VERSION=1;\n')

    def test_retired_source_missing_marker_and_incomplete_restore_stay_closed(self):
        self.state('retired')
        with self.assertRaisesRegex(ValueError, 'retired'):
            startup.guard(str(self.data), self.core, self.node)
        self.state('quarantine')
        Path(str(self.database) + '.required').unlink()
        with self.assertRaises(FileNotFoundError):
            startup.guard(str(self.data), self.core, self.node)
        self.state('quarantine')
        (self.data / 'recovery-control.json').write_text(json.dumps({'body': {'status': 'restoring'}}))
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            startup.guard(str(self.data), self.core, self.node)

    def test_sticky_schema_cannot_silently_become_legacy(self):
        with closing(sqlite3.connect(self.database)) as db:
            db.execute("DELETE FROM aw_meta WHERE key='recovery_state'")
            db.commit()
        with self.assertRaisesRegex(ValueError, 'missing'):
            startup.guard(str(self.data), self.core, self.node)

    def test_missing_database_and_orphan_stage_do_not_authorize_legacy_bootstrap(self):
        self.database.unlink()
        with self.assertRaisesRegex(ValueError, 'missing'):
            startup.guard(str(self.data), self.core, self.node)
        Path(str(self.database) + '.required').unlink()
        with self.assertRaisesRegex(ValueError, 'missing'):
            startup.guard(str(self.data), self.core, self.node)
        (self.data / '.recovery-stage-interrupted').mkdir()
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            startup.guard(str(self.data), self.core, self.node)


class OperatorTests(unittest.TestCase):
    def test_disaster_restore_does_not_require_the_missing_source_or_restart_it(self):
        import argparse
        for active in ('failed', 'active'):
            with self.subTest(active=active), tempfile.TemporaryDirectory(prefix='recovery-missing-source-') as directory:
                root = Path(directory); keys = root / 'keys'; keys.mkdir()
                for name in ('data.key', 'secrets.key'):
                    (keys / name).write_bytes(os.urandom(32))
                target = root / 'targets/restored'
                config = {'source': root / 'missing-source', 'uid': 123, 'gid': 123}
                actions = []
                def cli(_config, action, *arguments, **kwargs):
                    actions.append(action)
                    if action == 'check-source':
                        raise ValueError('RECOVERY_REQUIRED_MATERIAL_MISSING')
                    target.mkdir(mode=0o700)
                    return {'state': 'quarantine'}
                args = argparse.Namespace(action='restore', target_dir=target, backup_dir=root / 'backup', destination=None)
                with patch.object(operations, 'KEYS', keys), patch.object(operations, 'deployment', return_value=config), \
                        patch.object(operations, 'run_cli', side_effect=cli), patch.object(operations, 'install_guard'), \
                        patch.object(operations, 'safe_directory', side_effect=lambda path, **_: path.mkdir(parents=True, exist_ok=True)), \
                        patch.object(operations, 'require_service_parent'), patch.object(operations, 'chown_restored'), \
                        patch.object(operations, 'service_state', return_value={'ActiveState': active}), \
                        patch.object(operations, 'require_stopped'), patch.object(operations, 'systemctl') as controller:
                    self.assertEqual(operations._main_locked(args)['state'], 'quarantine')
                    self.assertEqual(actions[0], 'restore')
                    self.assertTrue(target.is_dir())
                    self.assertFalse(any(call.args[:1] == ('start',) for call in controller.call_args_list))

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'installer environment permissions run in Linux CI')
    def test_root_environment_accepts_installer_group_read_but_rejects_other_or_writable_access(self):
        with tempfile.TemporaryDirectory(prefix='recovery-env-mode-') as directory:
            filename = Path(directory) / 'root.env'; filename.write_text('DATA_DIR=/var/lib/project-aggregation\n')
            with patch.object(operations, 'ENVIRONMENT', filename):
                filename.chmod(0o640); operations.trusted_environment()
                for mode in (0o644, 0o660, 0o650):
                    filename.chmod(mode)
                    with self.assertRaisesRegex(ValueError, 'UNTRUSTED_INPUT'):
                        operations.trusted_environment()

    def test_configuration_is_resolved_only_inside_both_global_operation_locks(self):
        from contextlib import contextmanager
        events = []
        @contextmanager
        def held(path):
            events.append(str(path))
            yield
        with patch.object(operations.sys, 'platform', 'linux'), patch.object(operations.os, 'geteuid', return_value=0, create=True), \
                patch.object(operations, 'exclusive', side_effect=held), patch.object(operations, '_main_locked', side_effect=lambda _: events.append('configuration-read')):
            operations.main(['inspect'])
        self.assertEqual(events, [str(operations.STACK_LOCK), str(operations.INSTALL_LOCK), 'configuration-read'])
    def test_root_environment_is_literal_and_never_executes_shell(self):
        values = operations.environment_values('DATA_DIR=/var/lib/project-aggregation\nAUTO_OPEN=false\nVALUE="$(never-run)"\n')
        self.assertEqual(values['DATA_DIR'], '/var/lib/project-aggregation')
        self.assertEqual(values['VALUE'], '$(never-run)')
        with self.assertRaises(ValueError):
            operations.environment_values('DATA_DIR=/var/lib/project aggregation\n')

    def test_service_inactive_and_pid_zero_do_not_override_populated_cgroup(self):
        state = {'ActiveState': 'inactive', 'MainPID': '0', 'ControlGroup': '/system.slice/project-aggregation.service'}
        with patch.object(operations, 'service_state', return_value=state), patch.object(Path, 'exists', return_value=True), \
                patch.object(Path, 'is_file', return_value=True), patch.object(Path, 'read_text', return_value='populated 1\n'):
            with self.assertRaisesRegex(ValueError, 'WRITERS_STILL_RUNNING'):
                operations.require_stopped()

    def test_any_running_or_populated_unit_blocks_the_cold_checkpoint(self):
        stopped = {'ActiveState': 'inactive', 'MainPID': '0', 'ControlGroup': ''}
        for unit in operations.SERVICES:
            with self.subTest(unit=unit):
                states = {name: dict(stopped) for name in operations.SERVICES}
                states[unit] = {'ActiveState': 'activating', 'MainPID': '0', 'ControlGroup': ''}
                with patch.object(operations, 'service_state', side_effect=states.__getitem__):
                    with self.assertRaisesRegex(ValueError, 'WRITERS_STILL_RUNNING'):
                        operations.require_stopped()
                # A unit that stopped but left a process in the cgroup it had before.
                states[unit] = dict(stopped)
                group = '/system.slice/' + unit
                with patch.object(operations, 'service_state', side_effect=states.__getitem__), \
                        patch.object(Path, 'exists', lambda path: str(path) == '/sys/fs/cgroup' + group), \
                        patch.object(Path, 'is_file', return_value=True), patch.object(Path, 'read_text', return_value='populated 1\n'):
                    with self.assertRaisesRegex(ValueError, 'WRITERS_STILL_RUNNING'):
                        operations.require_stopped({unit: group})
        with patch.object(operations, 'service_state', return_value=stopped):
            self.assertEqual(set(operations.require_stopped()), set(operations.SERVICES))

    def test_operation_stops_both_units_and_starts_the_runtime_unit(self):
        import argparse
        for running in operations.SERVICES:
            with self.subTest(running=running), tempfile.TemporaryDirectory(prefix='recovery-units-') as directory:
                keys = Path(directory)
                states = {unit: {'ActiveState': 'active' if unit == running else 'inactive', 'ControlGroup': '/system.slice/' + unit}
                          for unit in operations.SERVICES}
                args = argparse.Namespace(action='backup', destination=keys / 'backup', target_dir=None, backup_dir=None)
                with patch.object(operations, 'KEYS', keys), patch.object(operations, 'deployment', return_value={'source': keys / 'data', 'uid': 1}), \
                        patch.object(operations, 'run_cli', return_value={'state': 'normal'}), patch.object(operations, 'install_guard'), \
                        patch.object(operations, 'safe_directory'), patch.object(operations, 'service_state', side_effect=states.__getitem__), \
                        patch.object(operations, 'require_stopped') as stopped, patch.object(operations, 'systemctl') as controller:
                    operations._main_locked(args)
                self.assertEqual([call.args for call in controller.call_args_list], [('stop', *operations.SERVICES), ('start', operations.SERVICE)])
                self.assertEqual(stopped.call_args_list[0].args, ({unit: '/system.slice/' + unit for unit in operations.SERVICES},))

    def test_deployment_requires_both_installer_units_with_one_identity(self):
        with tempfile.TemporaryDirectory(prefix='recovery-units-') as directory:
            root = Path(directory); runtime = root / 'runtime.service'; api = root / 'api.service'
            def unit(entry, user='nobody', node='/usr/bin/node', marker='# Managed by project-aggregation installer\n'):
                return f'{marker}[Service]\nUser={user}\nExecStart={node} {operations.APP}/current/server/{entry}\n'
            cases = [(unit('index.mjs'), unit('api/main.mjs'), 'SERVICE_CONFIG_INVALID'),
                     (unit('runtime/main.mjs'), None, 'MISSING'),
                     (unit('runtime/main.mjs'), unit('runtime/main.mjs'), 'SERVICE_CONFIG_INVALID'),
                     (unit('runtime/main.mjs'), unit('api/main.mjs', user='root'), 'SERVICE_CONFIG_INVALID'),
                     (unit('runtime/main.mjs'), unit('api/main.mjs', node='/opt/node/bin/node'), 'SERVICE_CONFIG_INVALID'),
                     (unit('runtime/main.mjs'), unit('api/main.mjs', marker=''), 'UNMANAGED_SERVICE')]
            def trusted(filename, private=False):
                if not Path(filename).exists():
                    raise ValueError('MISSING')
                return Path(filename)
            for runtime_text, api_text, error in cases:
                with self.subTest(error=error, api=api_text):
                    runtime.write_text(runtime_text); api.unlink(missing_ok=True)
                    if api_text is not None:
                        api.write_text(api_text)
                    with patch.object(operations, 'UNIT_FILE', runtime), patch.object(operations, 'API_UNIT_FILE', api), \
                            patch.object(operations, 'trusted_environment'), patch.object(operations, 'trusted', side_effect=trusted):
                        with self.assertRaisesRegex(ValueError, error):
                            operations.deployment()
            api.write_text(unit('api/main.mjs'))
            with patch.object(operations, 'UNIT_FILE', runtime), patch.object(operations, 'API_UNIT_FILE', api), patch.object(operations, 'trusted', side_effect=trusted):
                self.assertEqual(operations.managed_unit(runtime, 'runtime/main.mjs'), operations.managed_unit(api, 'api/main.mjs'))

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'root ownership fixture runs in Linux CI')
    def test_guard_install_is_incremental_and_does_not_restart_or_remove_other_overrides(self):
        # The production drop-in requires a root-owned non-writable ancestor
        # chain. /tmp intentionally does not satisfy that installation contract.
        with tempfile.TemporaryDirectory(prefix='recovery-install-', dir='/run') as directory:
            root = Path(directory)
            release = root / 'release'
            (release / 'server/recovery').mkdir(parents=True)
            shutil.copyfile(ROOT / 'server/recovery/startup-guard.py', release / 'server/recovery/startup-guard.py')
            config = {'release': release, 'source': root / 'data', 'node': Path(NODE)}
            library, units, launcher = root / 'lib', root / 'units', root / 'launcher'
            units.mkdir()
            guards = [units / f'{unit}.d/20-recovery-guard.conf' for unit in operations.SERVICES]
            loaded = {}  # unit -> DropInPaths systemd reports

            def controller(*arguments, **_):
                calls.append(arguments)
                return loaded.get(arguments[1], '') if arguments[0] == 'show' else ''

            def install():
                operations.install_guard(config, library=library, units=units, launcher=launcher)

            reloads = lambda: sum(call == ('daemon-reload',) for call in calls)
            calls = []
            with patch.object(operations, 'systemctl', side_effect=controller):
                install()
                self.assertEqual(guards[0].read_bytes(), guards[1].read_bytes())
                self.assertEqual(guards[0].read_bytes(), operations.guard_dropin(library / 'startup-guard.py', Path(NODE)))
                self.assertEqual(reloads(), 1)
                # Every later run sees its own loaded guards: nothing is written or reloaded.
                loaded = {unit: str(guard) for unit, guard in zip(operations.SERVICES, guards)}
                first = [guard.stat().st_mtime_ns for guard in guards]
                install()
                self.assertEqual([guard.stat().st_mtime_ns for guard in guards], first)
                self.assertEqual(reloads(), 1)
                self.assertFalse(any('restart' in call for call in calls))
                # A missing API guard is added with one more reload.
                guards[1].unlink(); loaded[operations.API_SERVICE] = ''
                install()
                self.assertTrue(guards[1].is_file())
                self.assertEqual(reloads(), 2)
                # A guard on disk that systemd has not loaded (an earlier reload failed) is reloaded.
                install()
                self.assertEqual(reloads(), 3)
                loaded[operations.API_SERVICE] = str(guards[1])
                # Overrides stop the install before anything is written: another unit's guard,
                # a loaded custom drop-in, a custom drop-in not loaded yet, or an unmanaged guard.
                for guard in guards: guard.unlink()
                custom = guards[1].with_name('custom.conf')
                for name, reported, on_disk in [('API reports the runtime guard', {operations.API_SERVICE: str(guards[0])}, None),
                                                ('loaded runtime override', {operations.SERVICE: '/etc/systemd/system/custom.conf'}, None),
                                                ('loaded API override', {operations.API_SERVICE: '/etc/systemd/system/custom.conf'}, None),
                                                ('unloaded API override', {}, (custom, b'[Service]\n')),
                                                ('unmanaged API guard', {}, (guards[1], b'[Service]\n'))]:
                    with self.subTest(name):
                        loaded = reported
                        if on_disk: on_disk[0].write_bytes(on_disk[1])
                        with self.assertRaisesRegex(ValueError, 'UNSUPPORTED_SERVICE_OVERRIDE|UNMANAGED_GUARD'):
                            install()
                        self.assertFalse(guards[0].exists())
                        if on_disk: on_disk[0].unlink()
                        self.assertFalse(guards[1].exists())

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'root/service permissions run in Linux CI')
    def test_restored_target_parent_remains_traversable_by_the_service_account(self):
        import argparse
        import pwd
        account = pwd.getpwnam('nobody')
        with tempfile.TemporaryDirectory(prefix='recovery-service-target-') as directory:
            root = Path(directory); root.chmod(0o755)
            keys = root / 'keys'; keys.mkdir(mode=0o700)
            for name in ('data.key', 'secrets.key'):
                (keys / name).write_bytes(os.urandom(32))
            target = root / 'targets/restored'
            config = {'source': root / 'source', 'uid': account.pw_uid, 'gid': account.pw_gid}
            def cli(_config, action, *arguments, **kwargs):
                if action == 'restore':
                    selected = Path(arguments[arguments.index('--target-dir') + 1]); selected.mkdir(mode=0o700)
                    (selected / 'readable').write_text('restored state', encoding='utf-8')
                return {'state': 'quarantine'}
            args = argparse.Namespace(action='restore', target_dir=target, backup_dir=root / 'backup', destination=None)
            with patch.object(operations, 'KEYS', keys), patch.object(operations, 'deployment', return_value=config), \
                    patch.object(operations, 'run_cli', side_effect=cli), patch.object(operations, 'install_guard'), \
                    patch.object(operations, 'service_state', return_value={'ActiveState': 'inactive'}), patch.object(operations, 'require_stopped'):
                operations._main_locked(args)
            result = subprocess.run(['/usr/sbin/runuser', '-u', 'nobody', '--', '/usr/bin/python3', '-I', '-c',
                                     'from pathlib import Path; import sys; assert Path(sys.argv[1]).read_text()=="restored state"', str(target / 'readable')], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
            for private in (root / 'targets', root / 'private-ancestor'):
                private.mkdir(mode=0o700, exist_ok=True); private.chmod(0o700)
                nested = private / 'nested'; nested.mkdir(mode=0o755)
                with self.assertRaisesRegex(ValueError, 'TARGET_PARENT_INACCESSIBLE'):
                    operations.require_service_parent(nested, config)

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'root/service SQLite readers run in Linux CI')
    def test_root_cold_registry_reads_do_not_break_later_service_ownership(self):
        import pwd
        account = pwd.getpwnam('nobody')
        node = NODE
        with tempfile.TemporaryDirectory(prefix='recovery-service-sqlite-') as directory:
            root = Path(directory); root.chmod(0o755)
            code = root / 'code'
            (code / 'server/execution').mkdir(parents=True)
            shutil.copyfile(ROOT / 'server/execution/account-writer.mjs', code / 'server/execution/account-writer.mjs')
            shutil.copytree(ROOT / 'server/recovery', code / 'server/recovery', ignore=shutil.ignore_patterns('__pycache__'))
            data = root / 'data'; data.mkdir(mode=0o700); os.chown(data, account.pw_uid, account.pw_gid)
            create = "import {pathToFileURL} from 'node:url'; const {createAccountWriter}=await import(pathToFileURL(process.argv[1])); const w=createAccountWriter({databasePath:process.argv[2]+'/execution-control.sqlite',moduleId:'hub',runtimeId:'permissions-probe'}); w.close();"
            def service_open():
                result = subprocess.run(['/usr/sbin/runuser', '-u', 'nobody', '--', node, '--input-type=module', '-e', create, str(code / 'server/execution/account-writer.mjs'), str(data)], capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
            service_open()
            probe = "import {pathToFileURL} from 'node:url'; const base=process.argv[1],dataDir=process.argv[2]; const {acquireRecoveryLocks}=await import(pathToFileURL(base+'/server/recovery/lifecycle-lock.mjs')); const {readLockedRegistry,openLockedSourceDatabase}=await import(pathToFileURL(base+'/server/recovery/inventory.mjs')); const lock=await acquireRecoveryLocks({dataDir,expectedOwnerUid:Number(process.argv[3])}); try { const db=openLockedSourceDatabase(dataDir+'/execution-control.sqlite',{lock,dataDir}); db.prepare('SELECT COUNT(*) FROM aw_meta').get(); db.close(); readLockedRegistry(dataDir,lock); } finally {await lock.close()}"
            result = subprocess.run([node, '--input-type=module', '-e', probe, str(code), str(data), str(account.pw_uid)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
            for suffix in ('-wal', '-shm'):
                filename = Path(str(data / 'execution-control.sqlite') + suffix)
                if filename.exists():
                    self.assertEqual(filename.stat().st_uid, account.pw_uid)
            service_open()


if __name__ == '__main__':
    unittest.main()
