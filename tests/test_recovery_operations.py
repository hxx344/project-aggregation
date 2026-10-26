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

    def test_rejected_guard_runs_no_operation_and_restarts_only_a_live_source(self):
        import argparse
        for error, state, started in [(ValueError('RECOVERY_UNSUPPORTED_SERVICE_OVERRIDE'), 'normal', True),
                                      (subprocess.CalledProcessError(1, 'daemon-reload'), 'normal', True),
                                      (ValueError('RECOVERY_UNSUPPORTED_SERVICE_OVERRIDE'), 'retired', False)]:
            with self.subTest(error=error, state=state), tempfile.TemporaryDirectory(prefix='recovery-units-') as directory:
                keys = Path(directory)
                states = {unit: {'ActiveState': 'active', 'ControlGroup': '/system.slice/' + unit} for unit in operations.SERVICES}
                args = argparse.Namespace(action='backup', destination=keys / 'backup', target_dir=None, backup_dir=None)
                actions = []
                def cli(_config, action, *_arguments):
                    actions.append(action)
                    return {'state': state}
                with patch.object(operations, 'KEYS', keys), patch.object(operations, 'deployment', return_value={'source': keys / 'data', 'uid': 1}), \
                        patch.object(operations, 'run_cli', side_effect=cli), patch.object(operations, 'install_guard', side_effect=error), \
                        patch.object(operations, 'safe_directory'), patch.object(operations, 'service_state', side_effect=states.__getitem__), \
                        patch.object(operations, 'require_stopped'), patch.object(operations, 'systemctl') as controller:
                    with self.assertRaises(type(error)):
                        operations._main_locked(args)
                self.assertEqual(actions, ['keys', 'check-source', 'check-source'])
                self.assertEqual([call.args for call in controller.call_args_list],
                                 [('stop', *operations.SERVICES)] + ([('start', operations.SERVICE)] if started else []))

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

    def test_dual_slot_deployment_checks_the_entry_and_the_template(self):
        with tempfile.TemporaryDirectory(prefix='recovery-units-') as directory:
            root = Path(directory)
            runtime, entry, template = root / 'runtime.service', root / 'entry.service', root / 'template.service'
            def unit(entry_file, user='nobody', link='current', wants=''):
                return f'# Managed by project-aggregation installer\n{wants}[Service]\nUser={user}\nExecStart=/bin/sh {operations.APP}/{link}/server/{entry_file}\n'
            dual = unit('runtime/main.mjs', wants='[Unit]\nWants=network-online.target project-aggregation-entry.service\n')
            def trusted(filename, private=False):
                if not Path(filename).exists():
                    raise ValueError('MISSING')
                return Path(filename)
            good = (unit('entry/main.mjs'), unit('api/main.mjs', link='slots/%i'))
            # The release check after the units fails here: nothing is installed under /opt.
            cases = [(good, 'RELEASE_INVALID', dual),
                     ((unit('entry/main.mjs'), unit('api/main.mjs')), 'SERVICE_CONFIG_INVALID', dual),
                     ((unit('entry/main.mjs', user='root'), good[1]), 'SERVICE_CONFIG_INVALID', dual),
                     ((unit('api/main.mjs'), good[1]), 'SERVICE_CONFIG_INVALID', dual),
                     ((good[0], None), 'MISSING', dual),
                     # A leftover entry the runtime does not pull in leaves the single layout and its API unit.
                     (good, 'MISSING', unit('runtime/main.mjs')),
                     (good, 'MISSING', unit('runtime/main.mjs', wants='[Unit]\n# Wants=project-aggregation-entry.service\n'))]
            for (entry_text, template_text), error, runtime_text in cases:
                with self.subTest(error=error, entry=entry_text, template=template_text, runtime=runtime_text):
                    runtime.write_text(runtime_text); entry.write_text(entry_text); template.unlink(missing_ok=True)
                    if template_text is not None:
                        template.write_text(template_text)
                    with patch.object(operations, 'UNIT_FILE', runtime), patch.object(operations, 'ENTRY_UNIT_FILE', entry), \
                            patch.object(operations, 'SLOT_UNIT_FILE', template), patch.object(operations, 'API_UNIT_FILE', root / 'absent.service'), \
                            patch.object(operations, 'trusted_environment'), patch.object(operations, 'trusted', side_effect=trusted):
                        with self.assertRaisesRegex(ValueError, error):
                            operations.deployment()

    def test_single_layout_also_stops_dual_slot_units_left_installed(self):
        with tempfile.TemporaryDirectory(prefix='recovery-units-') as directory:
            entry, template = Path(directory) / 'entry.service', Path(directory) / 'template.service'
            with patch.object(operations, 'dual_slots', return_value=False), patch.object(operations, 'ENTRY_UNIT_FILE', entry), \
                    patch.object(operations, 'SLOT_UNIT_FILE', template):
                self.assertEqual(operations.services(), operations.SERVICES)
                entry.write_text('')
                self.assertEqual(operations.services(), (*operations.SERVICES, operations.ENTRY_SERVICE))
                template.write_text('')
                self.assertEqual(operations.services(), (*operations.SERVICES, operations.ENTRY_SERVICE, *operations.SLOT_SERVICES))
            with patch.object(operations, 'dual_slots', return_value=True):
                self.assertEqual(operations.services(), operations.DUAL_SERVICES)

    def test_dual_slot_operation_stops_the_entry_and_both_slots(self):
        import argparse
        with tempfile.TemporaryDirectory(prefix='recovery-units-') as directory:
            keys = Path(directory)
            states = {unit: {'ActiveState': 'active' if unit == operations.SLOT_SERVICES[1] else 'inactive', 'ControlGroup': '/system.slice/' + unit}
                      for unit in operations.DUAL_SERVICES}
            args = argparse.Namespace(action='backup', destination=keys / 'backup', target_dir=None, backup_dir=None)
            with patch.object(operations, 'dual_slots', return_value=True), patch.object(operations, 'KEYS', keys), \
                    patch.object(operations, 'deployment', return_value={'source': keys / 'data', 'uid': 1}), \
                    patch.object(operations, 'run_cli', return_value={'state': 'normal'}), patch.object(operations, 'install_guard'), \
                    patch.object(operations, 'safe_directory'), patch.object(operations, 'service_state', side_effect=states.__getitem__), \
                    patch.object(operations, 'require_stopped') as stopped, patch.object(operations, 'systemctl') as controller:
                operations._main_locked(args)
            self.assertEqual([call.args for call in controller.call_args_list], [('stop', *operations.DUAL_SERVICES), ('start', operations.SERVICE)])
            self.assertEqual(stopped.call_args_list[0].args, ({unit: '/system.slice/' + unit for unit in operations.DUAL_SERVICES},))
            # Every unit of the layout must be stopped, the slots included.
            running = {**states, operations.SLOT_SERVICES[0]: {'ActiveState': 'active', 'MainPID': '7', 'ControlGroup': ''}}
            stopped = {unit: {'ActiveState': 'inactive', 'MainPID': '0', 'ControlGroup': ''} for unit in operations.DUAL_SERVICES}
            with patch.object(operations, 'dual_slots', return_value=True):
                with patch.object(operations, 'service_state', side_effect=lambda unit: running[unit] if unit == operations.SLOT_SERVICES[0] else stopped[unit]):
                    with self.assertRaisesRegex(ValueError, 'WRITERS_STILL_RUNNING'):
                        operations.require_stopped()
                with patch.object(operations, 'service_state', side_effect=stopped.__getitem__):
                    self.assertEqual(set(operations.require_stopped()), set(operations.DUAL_SERVICES))

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'root ownership fixture runs in Linux CI')
    def test_dual_slot_guard_goes_to_the_runtime_and_the_template_only(self):
        with tempfile.TemporaryDirectory(prefix='recovery-install-', dir='/run') as directory:
            root = Path(directory)
            release = root / 'release'
            (release / 'server/recovery').mkdir(parents=True)
            shutil.copyfile(ROOT / 'server/recovery/startup-guard.py', release / 'server/recovery/startup-guard.py')
            config = {'release': release, 'source': root / 'data', 'node': Path(NODE)}
            library, units, launcher = root / 'lib', root / 'units', root / 'launcher'
            units.mkdir()
            directories = {operations.SERVICE: units / (operations.SERVICE + '.d'), operations.ENTRY_SERVICE: units / (operations.ENTRY_SERVICE + '.d'),
                           **{unit: units / (operations.SLOT_UNIT_FILE.name + '.d') for unit in operations.SLOT_SERVICES}}
            extra = {unit: [] for unit in directories}

            def controller(*arguments, **_):
                if arguments[0] == 'daemon-reload':
                    return ''
                unit = arguments[1]
                return ' '.join([*map(str, sorted(directories[unit].glob('*.conf'))), *extra[unit]])

            with patch.object(operations, 'dual_slots', return_value=True), patch.object(operations, 'systemctl', side_effect=controller):
                operations.install_guard(config, library=library, units=units, launcher=launcher)
                runtime_guard = directories[operations.SERVICE] / '20-recovery-guard.conf'
                template_guard = directories[operations.SLOT_SERVICES[0]] / '20-recovery-guard.conf'
                self.assertEqual(runtime_guard.read_bytes(), template_guard.read_bytes())
                self.assertFalse(directories[operations.ENTRY_SERVICE].exists())
                # The entry carries no drop-in, on disk or loaded from elsewhere.
                extra[operations.ENTRY_SERVICE] = ['/etc/systemd/system/service.d/zz.conf']
                with self.assertRaisesRegex(ValueError, 'UNSUPPORTED_SERVICE_OVERRIDE'):
                    operations.install_guard(config, library=library, units=units, launcher=launcher)
                extra[operations.ENTRY_SERVICE] = []
                directories[operations.ENTRY_SERVICE].mkdir()
                (directories[operations.ENTRY_SERVICE] / '20-recovery-guard.conf').write_bytes(runtime_guard.read_bytes())
                with self.assertRaisesRegex(ValueError, 'UNSUPPORTED_SERVICE_OVERRIDE'):
                    operations.install_guard(config, library=library, units=units, launcher=launcher)
                (directories[operations.ENTRY_SERVICE] / '20-recovery-guard.conf').unlink()
                # One instance loading its own drop-in besides the template's is an override.
                extra[operations.SLOT_SERVICES[1]] = [str(units / 'project-aggregation-api@b.service.d/zz.conf')]
                with self.assertRaisesRegex(ValueError, 'UNSUPPORTED_SERVICE_OVERRIDE'):
                    operations.install_guard(config, library=library, units=units, launcher=launcher)
                extra[operations.SLOT_SERVICES[1]] = []
                operations.install_guard(config, library=library, units=units, launcher=launcher)

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'root ownership fixture runs in Linux CI')
    def test_guard_install_is_incremental_and_rejects_other_overrides(self):
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
            # A small systemd: a reload loads each unit's drop-in files plus the
            # drop-ins of shared directories (`shared`); `show` reports them.
            loaded = {unit: {} for unit in operations.SERVICES}
            shared = {unit: [] for unit in operations.SERVICES}
            failing_reloads = []

            def on_disk(unit):
                return {str(path): path.read_bytes() for path in units.glob(f'{unit}.d/*.conf')}

            def controller(*arguments, **_):
                calls.append(arguments)
                if arguments[0] == 'daemon-reload':
                    if failing_reloads:
                        failing_reloads.pop()
                        raise subprocess.CalledProcessError(1, arguments)
                    for unit in operations.SERVICES:
                        loaded[unit] = {**on_disk(unit), **{path: b'' for path in shared[unit]}}
                    return ''
                self.assertEqual(arguments, ('show', arguments[1], '--property=DropInPaths', '--value'))
                return ' '.join(loaded[arguments[1]])

            def install(node=Path(NODE)):
                operations.install_guard({**config, 'node': node}, library=library, units=units, launcher=launcher)

            reloads = lambda: sum(call == ('daemon-reload',) for call in calls)
            calls = []
            with patch.object(operations, 'systemctl', side_effect=controller):
                install()
                self.assertEqual(guards[0].read_bytes(), guards[1].read_bytes())
                self.assertEqual(guards[0].read_bytes(), operations.guard_dropin(library / 'startup-guard.py', Path(NODE)))
                self.assertEqual(reloads(), 1)
                # A later run rewrites nothing; it still reloads and checks what systemd loaded.
                first = [guard.stat().st_mtime_ns for guard in guards]
                install()
                self.assertEqual([guard.stat().st_mtime_ns for guard in guards], first)
                self.assertEqual(reloads(), 2)
                self.assertFalse(any('restart' in call for call in calls))
                # A missing API guard is added.
                guards[1].unlink()
                install()
                self.assertTrue(guards[1].is_file())
                self.assertEqual(reloads(), 3)
                # A changed guard whose reload failed is loaded by the next run, which writes nothing.
                failing_reloads.append(True)
                with self.assertRaises(subprocess.CalledProcessError):
                    install(Path('/opt/node/bin/node'))
                changed = [guard.read_bytes() for guard in guards]
                install(Path('/opt/node/bin/node'))
                self.assertEqual([guard.read_bytes() for guard in guards], changed)
                self.assertEqual(reloads(), 5)
                self.assertEqual(loaded[operations.API_SERVICE], {str(guards[1]): changed[1]})
                # A drop-in added to a shared directory, guards unchanged, is loaded by the
                # reload and then stops the install.
                shared[operations.API_SERVICE] = ['/etc/systemd/system/service.d/zz.conf']
                with self.assertRaisesRegex(ValueError, 'UNSUPPORTED_SERVICE_OVERRIDE'):
                    install(Path('/opt/node/bin/node'))
                self.assertEqual([guard.read_bytes() for guard in guards], changed)
                self.assertEqual(reloads(), 6)
                # Once the operator removes it and reloads, the guards are accepted as they are.
                shared[operations.API_SERVICE] = []
                controller('daemon-reload')
                install(Path('/opt/node/bin/node'))
                self.assertEqual(reloads(), 8)
                # Overrides stop the install before anything is written or reloaded: another unit's guard,
                # a loaded custom drop-in alone or next to the guard, a custom drop-in not
                # loaded yet alone or next to the guard, or an unmanaged guard.
                custom = guards[1].with_name('custom.conf')
                api_override = {operations.API_SERVICE: {str(guards[1]): b'', '/etc/systemd/system/custom.conf': b''}}
                for name, reported, files, keep in [
                        ('API reports the runtime guard', {operations.API_SERVICE: {str(guards[0]): b''}}, [], False),
                        ('loaded runtime override', {operations.SERVICE: {'/etc/systemd/system/custom.conf': b''}}, [], False),
                        ('loaded API override', {operations.API_SERVICE: {'/etc/systemd/system/custom.conf': b''}}, [], False),
                        ('loaded API override next to the guard', api_override, [], True),
                        ('unloaded API override', {}, [(custom, b'[Service]\n')], False),
                        ('unloaded API override next to the guard', {}, [(custom, b'[Service]\n')], True),
                        ('unmanaged API guard', {}, [(guards[1], b'[Service]\n')], False)]:
                    with self.subTest(name):
                        guard_files = [guard.read_bytes() for guard in guards]
                        if not keep:
                            for guard in guards: guard.unlink()
                        for unit in operations.SERVICES:
                            loaded[unit] = reported.get(unit, on_disk(unit))
                        for path, content in files: path.write_bytes(content)
                        before = [guard.read_bytes() if guard.exists() else None for guard in guards]
                        count = reloads()
                        with self.assertRaisesRegex(ValueError, 'UNSUPPORTED_SERVICE_OVERRIDE|UNMANAGED_GUARD'):
                            install()
                        self.assertEqual([guard.read_bytes() if guard.exists() else None for guard in guards], before)
                        self.assertEqual(reloads(), count)
                        self.assertFalse(any('restart' in call for call in calls))
                        for path, _ in files: path.unlink()
                        for guard, content in zip(guards, guard_files): guard.write_bytes(content)
                        for unit in operations.SERVICES:
                            loaded[unit] = on_disk(unit)

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
