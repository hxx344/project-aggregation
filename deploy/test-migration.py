"""Exercise copy consistency, credentials, rollback and retry without systemd."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

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
