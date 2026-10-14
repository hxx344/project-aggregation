"""Exercise copy consistency, credentials, rollback and retry without systemd."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('migration', Path(__file__).with_name('migrate-modules.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / 'new-data'
        self.data.mkdir()
        self.states = {name: {'active': 'active', 'enabled': 'enabled'} for name in module.SERVICES}
        self.calls = []
        self.migration = module.Migration(self.data, self.root / 'journal.json', filesystem=self.root,
                                          systemctl=self.systemctl)
        # Fixtures represent a root-owned Linux filesystem even when this suite
        # runs as an unprivileged CI user or on Windows. Only the privileged
        # configuration check sees these metadata; file reads/copies remain real.
        self.real_os = module.os
        self.metadata = {}
        fixture_os = patch.object(module, 'os', SimpleNamespace(name='posix', stat=self.fixture_stat))
        fixture_os.start()
        self.addCleanup(fixture_os.stop)

    def fixture_stat(self, path, **kwargs):
        actual = self.real_os.stat(path, **kwargs)
        metadata = {'st_uid': 0, 'st_mode': actual.st_mode & ~0o022}
        metadata.update(self.metadata.get(Path(path), {}))
        return SimpleNamespace(**metadata)

    def systemctl(self, action, service, *args, check=True):
        runtime = service == '--runtime'
        if runtime:
            service = args[-1]
        self.calls.append((action, service))
        state = self.states[service]
        if action == 'show': return 'loaded'
        if action == 'is-active': return state['active']
        if action == 'is-enabled': return state['enabled']
        if action == 'stop': state['active'] = 'inactive'
        if action == 'start': state['active'] = 'active'
        if action == 'disable': state['enabled'] = 'disabled'
        if action == 'enable': state['enabled'] = 'enabled-runtime' if runtime else 'enabled'
        return ''

    def put(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
        return path

    def test_copy_after_all_writers_stop_includes_wal_key_config_and_preserves_originals(self):
        key = self.put('var/lib/gate-crossex-arbitrage/credentials.key', 'secret-key')
        self.put('var/lib/gate-crossex-arbitrage/crossex.sqlite', 'db')
        self.put('var/lib/gate-crossex-arbitrage/crossex.sqlite-wal', 'wal')
        self.put('etc/gate-crossex-arbitrage.env', 'INITIAL_PASSWORD="a b"\nDATA_DIR=/var/lib/gate-crossex-arbitrage\n')
        self.put('var/lib/asset-ledger/config.json', '{"private":"credential"}')
        original_copytree = module.shutil.copytree
        def consistent_copy(*args, **kwargs):
            self.assertTrue(all(state['active'] == 'inactive' for state in self.states.values()))
            return original_copytree(*args, **kwargs)
        from unittest.mock import patch
        with patch.object(module.shutil, 'copytree', consistent_copy):
            self.assertTrue(self.migration.begin())
        destination = self.data / 'modules/crossex'
        self.assertEqual((destination / 'credentials.key').read_text(), key.read_text())
        self.assertEqual((destination / 'crossex.sqlite-wal').read_text(), 'wal')
        self.assertIn('INITIAL_PASSWORD', (destination / '.env').read_text())
        self.assertEqual(key.read_text(), 'secret-key')
        self.migration.commit()
        before = list(self.calls)
        self.assertFalse(self.migration.begin())
        self.assertEqual(self.calls, before)

    def test_failed_activation_quarantines_new_data_restores_status_and_retries_fresh_source(self):
        source = self.put('var/lib/asset-ledger/ledger.sqlite', 'before')
        self.states['aster-desk'] = {'active': 'inactive', 'enabled': 'disabled'}
        self.states['variational-grid']['enabled'] = 'enabled-runtime'
        original = json.loads(json.dumps(self.states))
        self.migration.begin()
        (self.data / 'modules/asset/ledger.sqlite').write_text('candidate-writes')
        self.migration.rollback()
        self.assertEqual(self.states, original)
        self.assertFalse((self.data / 'modules/asset').exists())
        state = json.loads(self.migration.journal.read_text())
        self.assertEqual((Path(state['quarantine']) / 'asset/ledger.sqlite').read_text(), 'candidate-writes')
        source.write_text('standalone-resumed')
        self.migration.begin()
        self.assertEqual((self.data / 'modules/asset/ledger.sqlite').read_text(), 'standalone-resumed')

    def test_existing_embedded_data_is_never_overwritten_or_quarantined(self):
        existing = self.data / 'modules/asset'
        existing.mkdir(parents=True)
        (existing / 'config.json').write_text('existing')
        self.put('var/lib/asset-ledger/config.json', 'old')
        self.migration.begin()
        self.migration.rollback()
        self.assertEqual((existing / 'config.json').read_text(), 'existing')

    def v1_committed(self):
        # The old journal had neither schema nor a completed-module list.
        for name in module.V1_MODULES:
            self.put('new-data/modules/' + name + '/keep', 'live-data')
            self.states[module.MODULE_SERVICES[name]] = {'active': 'inactive', 'enabled': 'disabled'}
        self.migration.save({'status': 'committed', 'data': str(self.data),
                             'services': {name: {'active': True, 'enabled': 'enabled'} for name in module.SERVICES},
                             'created': list(module.V1_MODULES)})

    def test_v1_receipt_extends_only_aster_and_rollback_never_revives_retired_services(self):
        self.v1_committed()
        source = self.put('var/lib/aster-desk/trading.sqlite', 'old-aster')
        self.assertTrue(self.migration.begin())
        state = self.migration.load()
        self.assertEqual(state['selected'], ['aster'])
        self.assertEqual(list(state['services']), ['aster-desk'])
        self.assertEqual(state['created'], ['aster'])
        (self.data / 'modules/aster/trading.sqlite').write_text('candidate')
        self.migration.rollback()
        self.assertEqual(self.states['aster-desk']['active'], 'active')
        for name in module.V1_MODULES:
            self.assertEqual((self.data / 'modules' / name / 'keep').read_text(), 'live-data')
            self.assertEqual(self.states[module.MODULE_SERVICES[name]]['active'], 'inactive')
        self.assertTrue(all(service == 'aster-desk' for _, service in self.calls))
        source.write_text('new-standalone-state')
        self.assertTrue(self.migration.begin())
        self.assertEqual((self.data / 'modules/aster/trading.sqlite').read_text(), 'new-standalone-state')
        self.migration.commit()
        before = list(self.calls)
        self.assertFalse(self.migration.begin())
        self.assertEqual(self.calls, before)
        self.assertEqual(self.migration.load()['completed'], list(module.LEGACY))

    def test_aster_custom_runtime_wal_keys_and_relay_ca_are_copied_and_rewritten(self):
        self.put('etc/aster-desk/environment', 'ASTER_TRADING_RUNTIME=/srv/aster/custom\nASTER_CAPACITY_RELAY_CA_FILE=/etc/aster-desk/relay-ca.pem\nASTER_CAPACITY_RELAY_TOKEN="token with spaces"\n')
        ca = self.put('etc/aster-desk/relay-ca.pem', 'certificate')
        self.put('srv/aster/custom/.env', 'ASTER_CAPACITY_RELAY_CA_FILE=/root/private-fixture\n')
        self.put('root/private-fixture', 'must-not-copy')
        for name in ('trading.sqlite', 'trading.sqlite-wal', 'trading.sqlite-shm', 'config.json', 'keys/history.json'):
            self.put('srv/aster/custom/' + name, name)
        self.migration.begin()
        target = self.data / 'modules/aster'
        for name in ('trading.sqlite', 'trading.sqlite-wal', 'trading.sqlite-shm', 'config.json', 'keys/history.json'):
            self.assertEqual((target / name).read_text(), name)
        settings = module.read_env(target / '.env')
        self.assertEqual(settings['ASTER_TRADING_RUNTIME'], str(target))
        copied_ca = Path(settings['ASTER_CAPACITY_RELAY_CA_FILE'])
        self.assertTrue(copied_ca.is_relative_to(target))
        self.assertEqual(copied_ca.read_text(), ca.read_text())
        self.assertEqual(settings['ASTER_CAPACITY_RELAY_TOKEN'], 'token with spaces')
        self.assertEqual(ca.read_text(), 'certificate')
        self.assertEqual((self.root / 'srv/aster/custom/trading.sqlite').read_text(), 'trading.sqlite')

    def test_incremental_existing_aster_data_wins_and_rollback_preserves_it(self):
        self.v1_committed()
        self.put('new-data/modules/aster/config.json', 'embedded')
        self.put('var/lib/aster-desk/config.json', 'standalone')
        self.migration.begin()
        self.migration.rollback()
        self.assertEqual((self.data / 'modules/aster/config.json').read_text(), 'embedded')
        self.assertEqual(self.migration.load()['created'], [])

    def test_aster_runtime_environment_is_preserved_without_external_environment(self):
        original = 'ASTER_CAPACITY_RELAY_TOKEN="existing\'token with spaces"\n'
        self.put('var/lib/aster-desk/.env', original)
        self.migration.begin()
        copied = self.data / 'modules/aster/.env'
        self.assertIn(original, copied.read_text())
        self.assertEqual(module.read_env(copied)['ASTER_CAPACITY_RELAY_TOKEN'], "existing'token with spaces")

    def test_aster_runtime_file_reference_cannot_authorize_privileged_copy(self):
        self.v1_committed()
        secret = self.put('root/private-fixture', 'synthetic-secret')
        for content in ('ASTER_CAPACITY_RELAY_CA_FILE=/root/private-fixture\n',
                        'export ASTER_CAPACITY_RELAY_CA_FILE="/root/private-fixture"\n',
                        'ASTER_CAPACITY_RELAY_CA_FILE=\nASTER_CAPACITY_RELAY_CA_FILE=/root/private-fixture\n'):
            with self.subTest(content=content):
                self.put('var/lib/aster-desk/.env', content)
                with patch.object(module.shutil, 'copy2', wraps=module.shutil.copy2) as copy:
                    with self.assertRaisesRegex(ValueError, 'require trusted /etc/aster-desk/environment'):
                        self.migration.begin()
                self.assertFalse(any(Path(call.args[0]) == secret for call in copy.call_args_list))
                self.assertFalse((self.data / 'modules/.migrating-aster/migration-files').exists())
                self.assertEqual(secret.read_text(), 'synthetic-secret')
                self.migration.rollback()

    def test_aster_external_environment_and_every_ancestor_must_be_root_controlled(self):
        self.v1_committed()
        environment = self.put('etc/aster-desk/environment', 'ASTER_CAPACITY_RELAY_CA_FILE=/root/private-fixture\n')
        self.put('root/private-fixture', 'synthetic-secret')
        for path in (environment, environment.parent, environment.parent.parent, self.root):
            for attributes in ({'st_uid': 4242}, {'st_mode': 0o620}, {'st_mode': 0o602}):
                with self.subTest(path=path.relative_to(self.root), attributes=attributes):
                    self.metadata[path] = attributes
                    try:
                        with self.assertRaisesRegex(ValueError, 'must be root-owned and not writable'):
                            self.migration.begin()
                        self.assertFalse((self.data / 'modules/.migrating-aster').exists())
                        self.migration.rollback()
                    finally:
                        self.metadata.clear()

    @unittest.skipUnless(hasattr(module.os, 'geteuid'), 'Actual POSIX ownership is covered on Linux CI')
    def test_aster_external_environment_checks_actual_posix_metadata(self):
        environment = self.put('etc/aster-desk/environment', 'ASTER_CAPACITY_RELAY_CA_FILE=\n')
        environment.chmod(0o600)
        with patch.object(module, 'os', self.real_os):
            if self.real_os.geteuid() != 0:
                with self.assertRaisesRegex(ValueError, 'must be root-owned'):
                    self.migration.require_root_environment(environment)
            else:
                self.migration.require_root_environment(environment)
                environment.chmod(0o602)
                with self.assertRaisesRegex(ValueError, 'not writable'):
                    self.migration.require_root_environment(environment)

    def test_aster_linked_external_environment_is_rejected(self):
        environment = self.put('private/root-environment', 'ASTER_CAPACITY_RELAY_CA_FILE=\n')
        target = self.root / 'etc/aster-desk/environment'
        target.parent.mkdir(parents=True)
        try:
            target.symlink_to(environment)
        except OSError:
            self.skipTest('Symbolic links require Windows privileges; Linux CI covers this boundary')
        with self.assertRaisesRegex(ValueError, 'links'):
            self.migration.begin()

    def test_aster_references_require_regular_absolute_existing_files(self):
        self.v1_committed()
        for value in ('relative.pem', '/etc/aster-desk/missing.pem', '/etc/aster-desk'):
            with self.subTest(value=value):
                self.put('etc/aster-desk/environment', 'ASTER_CAPACITY_RELAY_CA_FILE=' + value)
                with self.assertRaises(ValueError):
                    self.migration.begin()
                self.migration.rollback()
                self.assertEqual(self.states['greeks']['active'], 'inactive')

    def test_committed_journal_cannot_skip_another_data_directory(self):
        self.v1_committed()
        self.migration.data = self.root / 'other-data'
        self.migration.data.mkdir()
        with self.assertRaisesRegex(ValueError, 'does not match'):
            self.migration.begin()

    def test_status_reads_durable_receipt_without_service_changes(self):
        self.assertEqual(self.migration.status(), 'absent')
        self.migration.begin()
        before = list(self.calls)
        self.assertEqual(self.migration.status(), 'pending')
        self.migration.commit()
        self.assertEqual(self.migration.status(), 'committed')
        self.migration.rollback()
        self.assertEqual(self.migration.status(), 'committed')
        self.assertEqual(self.calls, before)

    def test_incomplete_encrypted_store_is_rejected_and_can_be_recovered(self):
        self.put('var/lib/gate-crossex-arbitrage/crossex.sqlite', 'encrypted-data')
        with self.assertRaisesRegex(ValueError, 'credentials.key'):
            self.migration.begin()
        self.migration.rollback()
        self.assertTrue(all(state['active'] == 'active' for state in self.states.values()))

    def test_custom_state_file_and_asset_unit_override_are_copied(self):
        self.put('etc/greeks/greeks.env', 'STATE_FILE=/srv/greeks/custom/state.json\nBYBIT_API_KEY=secret\n')
        self.put('srv/greeks/custom/state.json', 'state')
        self.put('etc/systemd/system/asset-ledger.service', '[Service]\nEnvironment=ASSET_DATA_DIR=/srv/asset/custom\n')
        self.put('srv/asset/custom/ledger.sqlite', 'custom-asset')
        self.migration.begin()
        self.assertEqual((self.data / 'modules/greeks/engine_state.json').read_text(), 'state')
        self.assertEqual((self.data / 'modules/asset/ledger.sqlite').read_text(), 'custom-asset')

    def test_refuses_broad_or_relative_legacy_data_paths(self):
        for value in ('/', '/var', '../data'):
            with self.subTest(value=value):
                self.put('etc/market-spread-monitor.env', 'ALERT_DATA_DIR=' + value)
                with self.assertRaises(ValueError): self.migration.begin()
                self.migration.rollback()

    def test_linked_source_is_rejected_before_copying_external_data(self):
        secret = self.put('private/secret', 'do-not-copy')
        target = self.root / 'var/lib/market-spread-monitor'
        target.mkdir(parents=True)
        try:
            (target / 'secret').symlink_to(secret)
        except OSError:
            self.skipTest('Symbolic links require Windows privileges; Linux CI covers this boundary')
        with self.assertRaisesRegex(ValueError, 'links'):
            self.migration.begin()
        self.migration.rollback()
        self.assertFalse((self.data / 'modules/monitor/secret').exists())


if __name__ == '__main__':
    unittest.main()
