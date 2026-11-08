import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { category, CHECKPOINT_JOURNALS, CHECKPOINT_SIZED, credentialKey, DATA_CATALOG, declared, REQUIRED_MATERIAL } from '../server/recovery/data-catalog.mjs';
import { MODULES } from '../server/recovery/inventory.mjs';
import { moduleIds } from '../server/modules/catalog.mjs';

const UUID = '0f1e2d3c-4b5a-4968-8776-655443322110';

test('manifest schema 1 categories stay pinned', () => {
  // Restore compares every entry's category with category(entry.path). Changing
  // this set breaks every older backup that contains the path, in either
  // direction; it needs a new manifest schema instead (docs/backup-recovery.md).
  assert.deepEqual(DATA_CATALOG.filter(entry => entry.category === 'data').map(entry => entry.path ?? entry.pattern.source), [
    'execution-control.sqlite',
    'execution-control.sqlite.required',
    'hub.sqlite',
    'modules/monitor/market.sqlite',
    'modules/monitor/perpetual/market.sqlite',
    'modules/asset/ledger.sqlite',
    '^modules\\/asset\\/backups\\/before-import-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.sqlite$',
    'modules/crossex/crossex.sqlite',
    'modules/aster/trading.sqlite3',
  ]);
  for (const entry of DATA_CATALOG) if (entry.pattern) assert.equal(entry.pattern.flags, '');
  // An exact declaration wins over a pattern, so none may shadow a data pattern.
  const patterns = DATA_CATALOG.filter(entry => entry.pattern);
  for (const entry of DATA_CATALOG) if (entry.path) assert.ok(!patterns.some(other => other.pattern.test(entry.path)), entry.path);
  assert.deepEqual(REQUIRED_MATERIAL, ['execution-control.sqlite', 'execution-control.sqlite.required', 'hub.sqlite', 'credentials.key']);
  // restore compares required material with lower-cased manifest paths.
  for (const required of REQUIRED_MATERIAL) assert.equal(required, required.toLowerCase());
});

test('checkpoint evidence bounds the declared journals', () => {
  assert.deepEqual(Object.fromEntries(CHECKPOINT_JOURNALS.map(entry => [entry.path, [entry.checkpoint.tables, Boolean(entry.checkpoint.optional)]])), {
    'execution-control.sqlite': [['aw_operations', 'aw_isolations'], false],
    'hub.sqlite': [['execution_jobs', 'execution_orders', 'execution_locks', 'execution_stop_requests', 'projects', 'trading_accounts', 'execution_accounts'], false],
    'modules/asset/ledger.sqlite': [['connections'], true],
    'modules/crossex/crossex.sqlite': [['live_executions', 'live_orders', 'live_cache', 'live_connection', 'settings'], false],
    'modules/aster/trading.sqlite3': [['accounts', 'deleted_accounts', 'pairs', 'intents', 'kv'], false],
  });
  assert.deepEqual(CHECKPOINT_SIZED.map(entry => [entry.path, Boolean(entry.checkpoint.optional)]), [['modules/greeks/.env', true], ['modules/greeks/engine_state.json', true]]);
});

test('every path has one deterministic category', () => {
  const cases = {
    'hub.sqlite': 'data',
    'credentials.key': 'secrets',
    'modules/crossex/credentials.key': 'secrets',
    'modules/asset/config.json': 'secrets',
    [`modules/asset/backups/before-import-${UUID}.sqlite`]: 'data',
    // Undeclared: new files, renamed databases, case variants, lookalikes.
    'modules/monitor/notifications.json': 'secrets',
    'modules/monitor/market-v2.sqlite': 'secrets',
    'Hub.sqlite': 'secrets',
    'modules/monitor/market.sqlite-wal': 'secrets',
    'old/hub.sqlite': 'secrets',
    'modules/monitor/perpetual/nested/market.sqlite': 'secrets',
    [`modules/asset/backups/before-import-${UUID.toUpperCase()}.sqlite`]: 'secrets',
    [`modules/asset/backups/before-import-${UUID}.sqlite.bak`]: 'secrets',
    [`modules/asset/backups/x/before-import-${UUID}.sqlite`]: 'secrets',
    'modules/asset/backups/before-import-1.sqlite': 'secrets',
  };
  for (const [relative, expected] of Object.entries(cases)) assert.equal(category(relative), expected, relative);
  assert.equal(declared('modules/monitor/market-v2.sqlite'), null);
});

test('declarations are consistent with modules, keys and the recovery code', () => {
  assert.deepEqual(MODULES, [...moduleIds]);
  for (const entry of DATA_CATALOG) {
    assert.ok(['hub', 'shared', ...moduleIds].includes(entry.owner), entry.owner);
    if (moduleIds.includes(entry.owner)) assert.ok((entry.path ?? entry.pattern.source.slice(1).replaceAll('\\/', '/')).startsWith(`modules/${entry.owner}/`), entry.owner);
    assert.ok(['data', 'secrets'].includes(entry.category));
    assert.ok(Boolean(entry.path) !== Boolean(entry.pattern));
    if (entry.key) {
      assert.equal(declared(entry.key)?.category, 'secrets', entry.key);
      assert.equal(credentialKey(entry.path), entry.key);
    }
  }
  assert.throws(() => credentialKey('modules/monitor/market.sqlite'), /no credential key/);
  // A path the recovery code reads by name must be declared, so a rename cannot
  // silently leave a check pointing at a file inventory treats as unknown.
  const directory = new URL('../server/recovery/', import.meta.url);
  const files = fs.readdirSync(directory).filter(name => /\.(?:mjs|py)$/.test(name) && name !== 'data-catalog.mjs');
  assert.ok(files.includes('restore.mjs') && files.includes('startup-guard.py'));
  const backupKeys = ['data.key', 'secrets.key']; // held outside the data root (operations.py KEYS)
  for (const file of files) {
    const source = fs.readFileSync(new URL(file, directory), 'utf8');
    for (const [, , relative] of source.matchAll(/(['"`])((?:modules\/[\w.-]+\/[\w./-]+)|[\w-]+\.(?:sqlite3?|key))\1/g)) assert.ok(backupKeys.includes(relative) || declared(relative), `${file}: ${relative}`);
  }
});
