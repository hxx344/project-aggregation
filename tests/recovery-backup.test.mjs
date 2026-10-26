import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createAccountWriter } from '../server/execution/account-writer.mjs';
import { createStore } from '../modules/crossex/server/store.mjs';
import { createLiveRuntime } from '../modules/crossex/server/live-runtime.mjs';
import { acquireRecoveryLocks, acquireRuntimeLock } from '../server/recovery/lifecycle-lock.mjs';
import { createBackup } from '../server/recovery/backup.mjs';
import { restoreBackup, admitHandoff } from '../server/recovery/restore.mjs';
import { authenticate, decryptFile } from '../server/recovery/crypto.mjs';
import { MODULES, openSourceDatabase, readLockedRegistry, readRegistry } from '../server/recovery/inventory.mjs';
import { openNotificationStore } from '../modules/monitor/server/notification-store.mjs';
import { openStore as openHynixAlertStore } from '../modules/monitor/server/alert-store.mjs';
import { FileStore, emptyStore } from '../modules/monitor/server/oil/store.mjs';
import { openPerpetualAlertStore } from '../modules/monitor/server/perpetual-alert-store.mjs';
import { openCrossExSettingsStore } from '../modules/monitor/server/perpetual-crossex-store.mjs';

async function setup(t, { pending = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-backup-'));
  if (process.platform === 'win32') { const result = spawnSync(process.env.PYTHON || 'python', ['-I', fileURLToPath(new URL('./test_lifecycle_lock.py', import.meta.url)), '--secure-dir', root]); assert.equal(result.status, 0, result.stderr?.toString()); }
  const source = path.join(root, 'source'); fs.mkdirSync(source, { mode: 0o700 });
  const locks = [], databases = [], writers = []; t.after(async () => { for (const writer of writers) writer.close(); for (const db of databases) db.close(); for (const lock of locks.reverse()) await lock.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const module of MODULES) fs.mkdirSync(path.join(source, 'modules', module), { recursive: true });
  const writer = createAccountWriter({ databasePath: path.join(source, 'execution-control.sqlite'), moduleId: 'hub', runtimeId: crypto.randomUUID() }); writer.close();
  const key = randomBytes(32); fs.writeFileSync(path.join(source, 'credentials.key'), key);
  const hub = new DatabaseSync(path.join(source, 'hub.sqlite'));
  hub.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE projects(id TEXT PRIMARY KEY,json TEXT,credentials TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,csrf TEXT,expires INTEGER); INSERT INTO sessions VALUES('old-session','old-csrf',9999999999999);
    CREATE TABLE login_account_guard(account TEXT PRIMARY KEY,failed INTEGER,first_failure_at INTEGER,until INTEGER); INSERT INTO login_account_guard VALUES('global',5,1,9999999999999);
    CREATE TABLE login_ip_attempts(ip TEXT PRIMARY KEY,count INTEGER,until INTEGER); INSERT INTO login_ip_attempts VALUES('127.0.0.1',10,9999999999999);
    CREATE TABLE execution_accounts(exchange TEXT PRIMARY KEY,revision INTEGER,credentials TEXT,account_mode TEXT,identity TEXT,key_label TEXT,verified_at TEXT,snapshot TEXT);
    CREATE TABLE execution_jobs(id TEXT PRIMARY KEY,json TEXT); CREATE TABLE execution_orders(id TEXT PRIMARY KEY,job_id TEXT,json TEXT);
    CREATE TABLE execution_locks(resource TEXT PRIMARY KEY,job_id TEXT); CREATE TABLE execution_stop_requests(job_id TEXT PRIMARY KEY,requested_at INTEGER);
    CREATE TABLE execution_previews(id TEXT PRIMARY KEY,session TEXT,expires INTEGER,json TEXT,consumed TEXT); INSERT INTO execution_previews VALUES('preview','old-session',9999999999999,'{}',NULL);
    CREATE TABLE execution_entries(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL); INSERT INTO execution_entries VALUES('entry',0,9999999999999);
    CREATE TABLE execution_lease(id INTEGER PRIMARY KEY,owner TEXT,expires INTEGER); INSERT INTO execution_lease VALUES(1,'old-owner',9999999999999);`);
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), ciphertext = Buffer.concat([cipher.update(JSON.stringify({ password: 'sensitive-password-fixture' })), cipher.final()]);
  hub.prepare('INSERT INTO projects VALUES(?,?,?)').run('one', '{}', Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64'));
  hub.prepare('INSERT INTO settings VALUES(?,?)').run('wal-only', 'must-survive');
  databases.push(hub);
  const crossStore = createStore(path.join(source, 'modules/crossex')); const runtime = createLiveRuntime(crossStore, { market: {} }); await runtime.stop(); crossStore.set('monitorPassword',crossStore.encrypt('crossex-fixture-password')); crossStore.close();
  const aster = new DatabaseSync(path.join(source, 'modules/aster/trading.sqlite3'));
  aster.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE deleted_accounts(id TEXT PRIMARY KEY,data TEXT,deleted_at REAL);
    CREATE TABLE pairs(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE pair_members(account_id TEXT PRIMARY KEY,pair_id TEXT,direction TEXT);
    CREATE TABLE intents(id TEXT PRIMARY KEY,account_id TEXT,status TEXT,data TEXT); CREATE TABLE kv(key TEXT PRIMARY KEY,data TEXT); INSERT INTO kv VALUES('runtime_mode','"authenticated"');`); aster.close();
  fs.writeFileSync(path.join(source, 'modules/greeks/engine_state.json'), JSON.stringify({ schema_version: 1, exchange_network: 'mainnet', active_strategy_symbols: [], active_strategy_sizes: {}, order_journal: {}, rfq_state: {}, execution_groups: {}, execution_group_links: {} }));
  fs.writeFileSync(path.join(source, 'modules/greeks/.env'), 'AUTO_OPEN=false\nAPI_SECRET=private-fixture\n');
  fs.mkdirSync(path.join(source, 'modules/monitor/nested/deeper'), { recursive: true }); fs.writeFileSync(path.join(source, 'modules/monitor/nested/deeper/state.json'), '{"nested":true}');
  for (const folder of ['modules/monitor', 'modules/monitor/nested']) { const db = new DatabaseSync(path.join(source, folder, 'market.sqlite')); db.exec('CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES(\'market\')'); db.close(); }
  fs.writeFileSync(path.join(source, 'modules/aster/.env'), 'ASTER_ALLOW_LIVE=1\n');
  fs.writeFileSync(path.join(source, 'modules/aster/cert.pem'), 'fixture-certificate'); fs.writeFileSync(path.join(source, 'modules/monitor/empty.bin'), '');
  const assetKey = randomBytes(32), config = { credentialKey: assetKey.toString('hex'), sessionSecret: randomBytes(32).toString('hex'), passwordHash: 'a'.repeat(32) + ':' + 'b'.repeat(64) };
  fs.writeFileSync(path.join(source, 'modules/asset/config.json'), JSON.stringify(config));
  const asset = new DatabaseSync(path.join(source, 'modules/asset/ledger.sqlite')); asset.exec('CREATE TABLE connections(owner TEXT,exchange TEXT,encrypted TEXT,updated_at TEXT); CREATE TABLE _schema_migrations(name TEXT PRIMARY KEY,hash TEXT);');
  const aiv = randomBytes(12), ac = createCipheriv('aes-256-gcm', assetKey, aiv); ac.setAAD(Buffer.from('owner:gate')); const encrypted = Buffer.concat([ac.update('{"apiKey":"asset-fixture"}'),ac.final(),ac.getAuthTag()]);
  asset.prepare('INSERT INTO connections VALUES(?,?,?,?)').run('owner','gate',JSON.stringify({iv:[...aiv],cipher:[...encrypted]}),'2026-10-19'); asset.close();
  if (pending) { const db = new DatabaseSync(path.join(source, 'execution-control.sqlite')); db.exec("INSERT INTO aw_operations VALUES('pending','hub','hash','[]','old','{}','unknown',1,1,'group',NULL,NULL)"); db.close(); }
  const takeLock = async directory => { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); if (process.platform === 'win32') { const result = spawnSync(process.env.PYTHON || 'python', ['-I', fileURLToPath(new URL('./test_lifecycle_lock.py', import.meta.url)), '--secure-dir', directory]); assert.equal(result.status, 0, result.stderr?.toString()); } const lock = await acquireRecoveryLocks({ dataDir: directory }); locks.push(lock); return lock; };
  const sourceLock = await takeLock(source); const dataKey = randomBytes(32), secretsKey = randomBytes(32);
  const backupOptions = { dataDir: source, destination: path.join(root, 'backup'), dataKey, secretsKey, lock: sourceLock, commit: 'a'.repeat(40) };
  const restore = async (name = 'target', options = {}) => { const targetDir = path.join(root, name), lock = await takeLock(targetDir); return { result: await restoreBackup({ backupDir: backupOptions.destination, targetDir, lock, dataKey, secretsKey, ...options }), targetDir, lock }; };
  return { root, source, sourceLock, backupOptions, dataKey, secretsKey, hub, config, restore, takeLock, writers, closeHub() { hub.close(); databases.splice(databases.indexOf(hub),1); } };
}

test('cold encrypted backup covers nested modules and WAL; restoration revokes sessions, preserves UNKNOWN and quarantines new authority', async t => {
  const f = await setup(t, { pending: true }); const before = readRegistry(f.source); assert.ok(fs.statSync(path.join(f.source,'hub.sqlite-wal')).size > 0);
  await createBackup({ ...f.backupOptions, rootEnvironment: { content: Buffer.from('ROOT_SECRET=external-fixture\n'), relativeName: 'root.env' } });
  const manifest = JSON.parse(fs.readFileSync(path.join(f.backupOptions.destination,'manifest.json')));
  assert.equal(manifest.body.entries.filter(e => e.path.endsWith('market.sqlite')).length, 2);
  assert.ok(manifest.body.entries.find(e => e.path === 'modules/monitor/nested/deeper/state.json'));
  assert.equal(manifest.body.entries.find(e => e.path === 'modules/greeks/.env').category, 'secrets');
  for (const dir of ['data','secrets']) for (const file of fs.readdirSync(path.join(f.backupOptions.destination,dir))) assert.equal(fs.readFileSync(path.join(f.backupOptions.destination,dir,file)).includes(Buffer.from('sensitive-password-fixture')), false);
  const restored = await f.restore(); const after = readRegistry(restored.targetDir); assert.equal(after.state.state,'quarantine'); assert.notEqual(after.state.authorityId,before.state.authorityId); assert.equal(after.registryId,before.registryId);
  const db = new DatabaseSync(path.join(restored.targetDir,'hub.sqlite')); assert.equal(db.prepare("SELECT value FROM settings WHERE key='wal-only'").get().value,'must-survive');
  for (const table of ['sessions','execution_previews','execution_lease','execution_entries','login_account_guard','login_ip_attempts']) assert.equal(db.prepare('SELECT count(*) n FROM '+table).get().n,0); db.close();
  const registry = new DatabaseSync(path.join(restored.targetDir,'execution-control.sqlite')); assert.equal(registry.prepare("SELECT state FROM aw_operations WHERE operation_id='pending'").get().state,'unknown'); assert.ok(registry.prepare("SELECT count(*) n FROM aw_owners WHERE status='closed'").get().n > 0); registry.close();
  const config = JSON.parse(fs.readFileSync(path.join(restored.targetDir,'modules/asset/config.json'))); assert.equal(config.credentialKey,f.config.credentialKey); assert.notEqual(config.sessionSecret,f.config.sessionSecret);
  await assert.rejects(admitHandoff({ sourceDir:f.source,targetDir:restored.targetDir,sourceLock:f.sourceLock,targetLock:restored.lock,dataKey:f.dataKey,secretsKey:f.secretsKey }),/HANDOFF_REQUIRED/);
});

test('manifest/key corruption never publishes a usable target and latest valid backup is never overwritten', async t => {
  const f=await setup(t); await createBackup(f.backupOptions);
  await assert.rejects(createBackup(f.backupOptions),/TARGET_EXISTS/);
  await assert.rejects(f.restore('wrong-key',{dataKey:randomBytes(32)}),/AUTHENTICATION_FAILED/);
  const payload=path.join(f.backupOptions.destination,'data','0.gcm'); const actual = fs.existsSync(payload) ? payload : path.join(f.backupOptions.destination,'secrets','0.gcm'); const bytes=fs.readFileSync(actual); bytes[13]^=1; fs.writeFileSync(actual,bytes);
  await assert.rejects(f.restore('corrupt'));
  assert.equal(fs.existsSync(path.join(f.root,'corrupt','execution-control.sqlite')),false);
});

test('archive traversal, same encryption keys, hardlinks, limits and forged lock evidence fail closed', async t => {
  const f=await setup(t);
  await assert.rejects(createBackup({...f.backupOptions,secretsKey:f.dataKey}),/KEYS_INVALID/);
  await assert.rejects(createBackup({...f.backupOptions,lock:{assertHeld(){}}}),/RUNTIME_LOCK_LOST/);
  // The runtime lock alone does not prove that no API process is alive.
  const empty = fs.mkdtempSync(path.join(f.root, 'runtime-only-')); fs.chmodSync(empty, 0o700); const runtimeOnly = await acquireRuntimeLock({ dataDir: empty });
  try { await assert.rejects(createBackup({...f.backupOptions,dataDir:empty,lock:runtimeOnly}),/RUNTIME_LOCK_LOST/); } finally { await runtimeOnly.close(); }
  await assert.rejects(createBackup({...f.backupOptions,maxBytes:32}),/LIMIT_EXCEEDED/);
  await assert.rejects(createBackup({...f.backupOptions,destination:path.join(f.source,'nested')}),/OVERLAP/);
  fs.linkSync(path.join(f.source,'credentials.key'),path.join(f.source,'hard-link')); await assert.rejects(createBackup(f.backupOptions),/UNSAFE_FILE/); fs.unlinkSync(path.join(f.source,'hard-link'));
  await createBackup(f.backupOptions); const manifestFile=path.join(f.backupOptions.destination,'manifest.json'); const doc=JSON.parse(fs.readFileSync(manifestFile)); doc.body.entries[0].path='../outside'; fs.writeFileSync(manifestFile,JSON.stringify(authenticate(doc.body,f.dataKey,f.secretsKey)));
  await assert.rejects(f.restore(),/UNSAFE_PATH/);
});

test('the runtime directory left by a killed runtime is not backed up, but a link in its place still fails', { skip: process.platform === 'win32' ? 'POSIX special files' : false }, async t => {
  const f = await setup(t);
  const run = path.join(f.source, 'run'), sockets = path.join(run, 'modules-AbC123');
  fs.mkdirSync(sockets, { recursive: true, mode: 0o700 }); fs.chmodSync(run, 0o700);
  fs.writeFileSync(path.join(run, 'runtime.json'), '{}', { mode: 0o600 });
  // FIFOs stand in for the sockets: both are special files the walk refuses.
  for (const file of [path.join(run, 'runtime-00000000-0000-4000-8000-000000000001.sock'), path.join(sockets, 'crossex-1.sock')]) assert.equal(spawnSync('mkfifo', ['-m', '600', file]).status, 0);
  await createBackup(f.backupOptions);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.backupOptions.destination, 'manifest.json')));
  assert.deepEqual(manifest.body.entries.filter(entry => entry.path === 'run' || entry.path.startsWith('run/')), []);
  fs.rmSync(run, { recursive: true }); fs.symlinkSync(os.tmpdir(), run);
  await assert.rejects(createBackup({ ...f.backupOptions, destination: f.backupOptions.destination + '-link' }), /UNSAFE_FILE/);
  // Only the directory is the runtime's: a file of that name is backed up like any other.
  fs.rmSync(run); fs.writeFileSync(run, 'kept', { mode: 0o600 });
  await createBackup({ ...f.backupOptions, destination: f.backupOptions.destination + '-file' });
  const files = JSON.parse(fs.readFileSync(path.join(f.backupOptions.destination + '-file', 'manifest.json'))).body.entries;
  assert.deepEqual(files.filter(entry => entry.path === 'run').map(entry => entry.size), [4]);
});

test('missing or incorrect application credentials and unsupported registry schema keep recovery failed', async t => {
  const f=await setup(t); fs.writeFileSync(path.join(f.source,'credentials.key'),randomBytes(32)); await createBackup(f.backupOptions);
  await assert.rejects(f.restore(),/CREDENTIAL_VALIDATION_FAILED/);
  assert.equal(fs.existsSync(path.join(f.root,'target','execution-control.sqlite')),false);
  const registry=new DatabaseSync(path.join(f.source,'execution-control.sqlite')); registry.prepare("UPDATE aw_meta SET value='999' WHERE key='schema'").run(); registry.close();
  await assert.rejects(createBackup({...f.backupOptions,destination:path.join(f.root,'new-backup')}),/SCHEMA_UNSUPPORTED/);
});

test('sealed handoff permanently retires source, admits once, and rejects a different restored clone', async t => {
  const f=await setup(t);
  fs.writeFileSync(path.join(f.source,'modules/greeks/.env'),'API_SECRET=fixture-secret\n');
  await createBackup({...f.backupOptions,kind:'handoff',environment:{AUTO_OPEN:'false'},rootEnvironment:{content:Buffer.from('AUTO_OPEN=false\n'),relativeName:'root.env'}}); assert.equal(readRegistry(f.source).state.state,'retired');
  const first=await f.restore('first'), second=await f.restore('second');
  const options={sourceDir:f.source,sourceLock:f.sourceLock,dataKey:f.dataKey,secretsKey:f.secretsKey};
  await assert.rejects(admitHandoff({...options,targetDir:first.targetDir,targetLock:first.lock,environment:{AUTO_OPEN:'true'}}),/HANDOFF_UNSAFE/);
  await admitHandoff({...options,targetDir:first.targetDir,targetLock:first.lock}); assert.equal(readRegistry(first.targetDir).state.state,'normal');
  await admitHandoff({...options,targetDir:first.targetDir,targetLock:first.lock});
  await assert.rejects(admitHandoff({...options,targetDir:second.targetDir,targetLock:second.lock}),/ALREADY_CONSUMED/);
  assert.equal(readRegistry(second.targetDir).state.state,'quarantine');
  await assert.rejects(createBackup({...f.backupOptions,destination:path.join(f.root,'another'),kind:'handoff'}),/SOURCE_NOT_NORMAL/);
});

test('unresolved original operations can be saved but cannot seal a handoff', async t => {
  const f=await setup(t,{pending:true}); await assert.rejects(createBackup({...f.backupOptions,kind:'handoff'}),/HANDOFF_UNSAFE/); assert.equal(readRegistry(f.source).state.state,'normal');
  await createBackup(f.backupOptions); assert.equal((await f.restore()).result.state,'quarantine');
});

test('handoff publication interruption resumes the same sealed checkpoint without reactivating source', async t => {
  const f = await setup(t); const late = createAccountWriter({ databasePath:path.join(f.source,'execution-control.sqlite'), moduleId:'late-fixture', runtimeId:crypto.randomUUID() });
  f.writers.push(late);
  const originalRename = fs.renameSync;
  fs.renameSync = (source,target) => { if (target === f.backupOptions.destination) throw Object.assign(new Error('simulated full disk on publication'), { code:'ENOSPC' }); return originalRename(source,target); };
  try { await assert.rejects(createBackup({...f.backupOptions,kind:'handoff'}),/simulated full disk/); }
  finally { fs.renameSync = originalRename; }
  const retired = readRegistry(f.source); assert.equal(retired.state.state,'retired'); assert.equal(retired.handoff.sealed,true);
  assert.throws(() => late.bind('late',{authority:'binance',environment:'mainnet',accountId:'123'},'1'),/AUTHORITY_RETIRED|RECOVERY_RETIRED/);
  const resumed = await createBackup({...f.backupOptions,kind:'handoff'}); assert.equal(resumed.resumed,true); assert.equal(resumed.checkpointId,retired.handoff.checkpointId);
  assert.equal(readRegistry(f.source).state.state,'retired');
  const restored=await f.restore(); await admitHandoff({sourceDir:f.source,targetDir:restored.targetDir,sourceLock:f.sourceLock,targetLock:restored.lock,dataKey:f.dataKey,secretsKey:f.secretsKey});
  assert.equal(readRegistry(restored.targetDir).state.state,'normal');
});

test('bounded backup failure before sealing leaves authority normal and missing secret material is rejected', async t => {
  const f=await setup(t);
  await assert.rejects(createBackup({...f.backupOptions,kind:'handoff',timeoutMs:1}));
  assert.equal(readRegistry(f.source).state.state,'normal'); assert.equal(fs.existsSync(f.backupOptions.destination),false);
  fs.unlinkSync(path.join(f.source,'credentials.key'));
  await assert.rejects(createBackup(f.backupOptions),/REQUIRED_MATERIAL_MISSING/);
});

test('CrossEx and Asset application key mismatches are detected by real ciphertext, independent of archive keys', async t => {
  const f=await setup(t);
  fs.writeFileSync(path.join(f.source,'modules/crossex/credentials.key'),randomBytes(32));
  await createBackup(f.backupOptions); await assert.rejects(f.restore('cross-bad-key'),/CREDENTIAL_VALIDATION_FAILED/);
  const store=createStore(path.join(f.source,'modules/crossex')); store.set('monitorPassword',null); store.close();
  const configPath=path.join(f.source,'modules/asset/config.json'), config=JSON.parse(fs.readFileSync(configPath)); config.credentialKey=randomBytes(32).toString('hex'); fs.writeFileSync(configPath,JSON.stringify(config));
  await createBackup({...f.backupOptions,destination:path.join(f.root,'asset-backup')});
  await assert.rejects(f.restore('asset-bad-key',{backupDir:path.join(f.root,'asset-backup')}),/CREDENTIAL_VALIDATION_FAILED/);
});

test('source consumption committed before target activation can resume only the recorded target inode', async t => {
  const f=await setup(t); await createBackup({...f.backupOptions,kind:'handoff'}); const first=await f.restore('first'), clone=await f.restore('clone');
  const registry=readRegistry(first.targetDir), sourceDb=new DatabaseSync(path.join(f.source,'execution-control.sqlite'));
  const record=JSON.parse(sourceDb.prepare("SELECT value FROM aw_meta WHERE key='recovery_handoff'").get().value);
  record.admittedTarget={recoveryId:first.result.recoveryId,authorityId:first.result.authorityId,...registry.identity};
  sourceDb.prepare("UPDATE aw_meta SET value=? WHERE key='recovery_handoff'").run(JSON.stringify(record)); sourceDb.exec('PRAGMA wal_checkpoint(TRUNCATE)'); sourceDb.close();
  const options={sourceDir:f.source,sourceLock:f.sourceLock,dataKey:f.dataKey,secretsKey:f.secretsKey};
  await assert.rejects(admitHandoff({...options,targetDir:clone.targetDir,targetLock:clone.lock}),/ALREADY_CONSUMED/);
  assert.equal(readRegistry(first.targetDir).state.state,'quarantine'); await admitHandoff({...options,targetDir:first.targetDir,targetLock:first.lock});
  assert.equal(readRegistry(first.targetDir).state.state,'normal'); assert.equal(readRegistry(clone.targetDir).state.state,'quarantine');
});

test('real Monitor notification migration and all ordinary configurations require the separate secrets key', async t => {
  const f = await setup(t), monitor = path.join(f.source, 'modules/monitor');
  const channels = [
    { id: 'hynix', webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/hynix-fixture', signingSecret: 'hynix-signing-fixture' },
    { id: 'oil', webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/oil-fixture', signingSecret: 'oil-signing-fixture' },
  ];
  const notifications = await openNotificationStore(monitor, () => channels);
  assert.equal(notifications.get().candidates.length, 2);
  const hynix = await openHynixAlertStore(path.join(monitor, 'hynix')), hs = hynix.get();
  hs.config = { ...hs.config, ...channels[0] }; delete hs.config.id; await hynix.save(hs);
  await openHynixAlertStore(path.join(monitor, 'hynix'));
  for (const folder of ['oil', 'cl-xau/bybit/bz']) {
    const store = new FileStore(path.join(monitor, folder), true); await store.acquire();
    // Historical fields may remain on disk after the current reader strips them.
    const state = emptyStore(); state.config = { ...state.config, webhookUrl: channels[1].webhookUrl, signingSecret: channels[1].signingSecret };
    await store.write(state); assert.equal((await store.read()).config.signingSecret, undefined);
  }
  const opportunities = await openPerpetualAlertStore(path.join(monitor, 'perpetual')); await opportunities.save(opportunities.get());
  const crossex = await openCrossExSettingsStore(path.join(monitor, 'perpetual')); await crossex.save(crossex.get());
  fs.writeFileSync(path.join(monitor, 'nested/deeper/renamed-settings.json'), JSON.stringify({ migration: { channels: [{ signingSecret: 'future-nested-fixture' }] } }));
  await createBackup(f.backupOptions);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.backupOptions.destination, 'manifest.json'))).body;
  const protectedPaths = ['modules/monitor/notifications.json', 'modules/monitor/hynix/alerts.json', 'modules/monitor/oil/monitor.json',
    'modules/monitor/cl-xau/bybit/bz/monitor.json', 'modules/monitor/perpetual/opportunity-alerts.json', 'modules/monitor/perpetual/crossex-settings.json',
    'modules/monitor/nested/deeper/renamed-settings.json'];
  for (const relative of protectedPaths) {
    const i = manifest.entries.findIndex(entry => entry.path === relative), entry = manifest.entries[i]; assert.ok(entry, relative); assert.equal(entry.category, 'secrets', relative);
    const payload = path.join(f.backupOptions.destination, 'secrets', i + '.gcm'), wrongOut = path.join(f.root, 'data-key-' + i), correctOut = path.join(f.root, 'secrets-key-' + i);
    await assert.rejects(decryptFile(payload, wrongOut, f.dataKey, manifest.checkpointId, entry, () => {}));
    await decryptFile(payload, correctOut, f.secretsKey, manifest.checkpointId, entry, () => {});
    assert.deepEqual(fs.readFileSync(correctOut), fs.readFileSync(path.join(f.source, relative)));
  }
  assert.equal(manifest.entries.find(entry => entry.path === 'hub.sqlite').category, 'data');
  assert.equal(manifest.entries.find(entry => entry.path === 'modules/monitor/market.sqlite').category, 'data');
  assert.equal(manifest.entries.find(entry => entry.path === 'modules/monitor/nested/market.sqlite').category, 'secrets');
  const restored = await f.restore();
  assert.deepEqual((await openNotificationStore(path.join(restored.targetDir, 'modules/monitor'))).get().candidates, channels);
});

test('restore rejects incompatible enum, malformed journal and invalid embedded JSON before publishing quarantine', async t => {
  const f = await setup(t), stateFile = path.join(f.source, 'modules/greeks/engine_state.json'), valid = JSON.parse(fs.readFileSync(stateFile));
  for (const name of ['network', 'journal', 'json']) {
    const state = structuredClone(valid);
    if (name === 'network') state.exchange_network = 'unsupported-network';
    if (name === 'journal') state.order_journal.bad = { symbol: 'fixture', side: 'Sideways', qty: 1, filledQty: 0, terminal: false, status: 'working' };
    fs.writeFileSync(stateFile, JSON.stringify(state));
    if (name === 'json') f.hub.prepare('INSERT INTO execution_jobs VALUES (?,?)').run('bad', 'invalid-fixture-json');
    const backupDir = path.join(f.root, name + '-backup'); await createBackup({ ...f.backupOptions, destination: backupDir });
    await assert.rejects(f.restore(name + '-target', { backupDir }), /RECOVERY_SCHEMA_UNSUPPORTED/);
    assert.equal(fs.existsSync(path.join(f.root, name + '-target', 'execution-control.sqlite')), false);
  }
});

test('offline classifiers reject excessive journal rows and records within the operation budget', async t => {
  const f = await setup(t);
  f.hub.prepare('INSERT INTO execution_jobs VALUES (?,?)').run('one',JSON.stringify({id:'one',status:'completed'}));
  f.hub.prepare('INSERT INTO execution_jobs VALUES (?,?)').run('two',JSON.stringify({id:'two',status:'completed'}));
  await assert.rejects(createBackup({...f.backupOptions,kind:'handoff',maxCheckpointRows:1}),/RECOVERY_CHECKPOINT_LIMIT_OR_INVALID/);
  assert.equal(readRegistry(f.source).state.state,'normal');
  await createBackup(f.backupOptions);
  await assert.rejects(f.restore('rows-limited',{maxCheckpointRows:1}),/RECOVERY_CHECKPOINT_LIMIT_OR_INVALID/);
  await assert.rejects(f.restore('record-limited',{maxRecordBytes:8}),/RECOVERY_CHECKPOINT_LIMIT_OR_INVALID/);
  assert.equal(fs.existsSync(path.join(f.root,'rows-limited','execution-control.sqlite')),false);
});

test('checkpoint record budgets count UTF-8 bytes rather than Unicode characters', async t => {
  const f = await setup(t), payload = JSON.stringify({ id: 'unicode', status: 'completed', note: '中'.repeat(500) });
  assert.ok(payload.length < 1024 && Buffer.byteLength(payload) > 1024);
  f.hub.prepare('INSERT INTO execution_jobs VALUES (?,?)').run('unicode', payload);
  await assert.rejects(createBackup({ ...f.backupOptions, kind: 'handoff', maxRecordBytes: 1024 }), /RECOVERY_CHECKPOINT_LIMIT_OR_INVALID/);
  assert.equal(readRegistry(f.source).state.state, 'normal');
});

test('absent Greeks journal restores only in quarantine and never replaces a missing archived payload', async t => {
  const f = await setup(t), filename = path.join(f.source, 'modules/greeks/engine_state.json'), original = fs.readFileSync(filename);
  fs.unlinkSync(filename);
  await assert.rejects(createBackup({ ...f.backupOptions, kind: 'handoff' }), /RECOVERY_HANDOFF_UNSAFE/);
  assert.equal(readRegistry(f.source).state.state, 'normal');
  await createBackup(f.backupOptions); const restored = await f.restore();
  assert.equal(restored.result.state, 'quarantine');
  assert.equal(fs.existsSync(path.join(restored.targetDir, 'modules/greeks/engine_state.json')), false);
  const writer = createAccountWriter({ databasePath: path.join(restored.targetDir, 'execution-control.sqlite'), moduleId: 'hub', runtimeId: crypto.randomUUID() }); f.writers.push(writer);
  const subject = { authority: 'bybit', environment: 'mainnet', accountId: '123456789' };
  writer.bind('missing-state', subject, 1); const ticket = writer.claim([subject]);
  assert.throws(() => writer.prepare(ticket, 'missing-state-blocked', { action: 'create' }), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(admitHandoff({ sourceDir: f.source, targetDir: restored.targetDir, sourceLock: f.sourceLock, targetLock: restored.lock, dataKey: f.dataKey, secretsKey: f.secretsKey }), /RECOVERY_HANDOFF_REQUIRED/);
  fs.writeFileSync(filename, original); const backupDir = path.join(f.root, 'with-state');
  await createBackup({ ...f.backupOptions, destination: backupDir });
  const body = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'))).body;
  const index = body.entries.findIndex(entry => entry.path === 'modules/greeks/engine_state.json'); assert.ok(index >= 0);
  fs.unlinkSync(path.join(backupDir, body.entries[index].category, index + '.gcm'));
  await assert.rejects(f.restore('lost-payload', { backupDir }), { code: 'ENOENT' });
  assert.equal(fs.existsSync(path.join(f.root, 'lost-payload', 'execution-control.sqlite')), false);
});

test('restoring a migrated ASTER CA rebinds only the fixed key to the new DATA_DIR and handoff verifies the included certificate', async t => {
  const f = await setup(t), envFile = path.join(f.source,'modules/aster/.env');
  const relative = 'modules/aster/migration-files/aster_capacity_relay_ca_file.pem', certificate = path.join(f.source, relative);
  fs.mkdirSync(path.dirname(certificate),{recursive:true}); fs.writeFileSync(certificate,'fixture-relay-ca-pem');
  const untouched = 'ASTER_ALLOW_LIVE=1\nASTER_CAPACITY_RELAY_TOKEN="token-with apostrophe\' preserved"\n';
  fs.writeFileSync(envFile,untouched + "ASTER_CAPACITY_RELAY_CA_FILE='" + certificate + "'\n");
  const result=await createBackup({...f.backupOptions,kind:'handoff',rootEnvironment:{content:Buffer.from('ROOT_ONLY=preserved-material\n'),relativeName:'root.env'}});
  assert.equal(result.restorable,null); assert.equal(result.unresolvedDependencyCount,0);
  const manifest=JSON.parse(fs.readFileSync(path.join(f.backupOptions.destination,'manifest.json'))).body;
  assert.equal(manifest.pathBindings.length,1); assert.equal(manifest.pathBindings[0].relativeEntry,relative);
  assert.equal(manifest.pathBindings[0].envEntry,'modules/aster/.env'); assert.equal(manifest.pathBindings[0].key,'ASTER_CAPACITY_RELAY_CA_FILE');
  const restored=await f.restore('new-target'); const restoredEnv=fs.readFileSync(path.join(restored.targetDir,'modules/aster/.env'),'utf8');
  assert.ok(restoredEnv.startsWith(untouched)); assert.equal(parseEnv(restoredEnv).ASTER_CAPACITY_RELAY_CA_FILE,path.join(restored.targetDir,relative));
  assert.equal(fs.readFileSync(parseEnv(restoredEnv).ASTER_CAPACITY_RELAY_CA_FILE,'utf8'),'fixture-relay-ca-pem');
  assert.equal(fs.readFileSync(path.join(restored.targetDir,'_recovery/root.env'),'utf8'),'ROOT_ONLY=preserved-material\n');
  await admitHandoff({sourceDir:f.source,targetDir:restored.targetDir,sourceLock:f.sourceLock,targetLock:restored.lock,dataKey:f.dataKey,secretsKey:f.secretsKey});
  assert.equal(readRegistry(restored.targetDir).state.state,'normal');
});

test('untrusted ASTER CA external paths are never read and cannot retire or claim a complete restore', async t => {
  const f=await setup(t), privateFile=path.join(f.root,'external-private.pem'), envFile=path.join(f.source,'modules/aster/.env');
  fs.writeFileSync(privateFile,'synthetic-private-material-must-not-be-read'); fs.writeFileSync(envFile,"ASTER_CAPACITY_RELAY_CA_FILE='"+privateFile+"'\n");
  const read=fs.readFileSync, open=fs.openSync, copy=fs.copyFileSync; let externalReads=0;
  const isPrivate = value => typeof value === 'string' && path.resolve(value) === privateFile;
  fs.readFileSync=(file,...args)=>{if(isPrivate(file)){externalReads++;throw new Error('external private read');}return read(file,...args);};
  fs.openSync=(file,...args)=>{if(isPrivate(file)){externalReads++;throw new Error('external private open');}return open(file,...args);};
  fs.copyFileSync=(file,...args)=>{if(isPrivate(file)){externalReads++;throw new Error('external private copy');}return copy(file,...args);};
  try {
    await assert.rejects(createBackup({...f.backupOptions,kind:'handoff'}),/RECOVERY_DEPENDENCY_NOT_INCLUDED/); assert.equal(readRegistry(f.source).state.state,'normal');
    const result=await createBackup(f.backupOptions); assert.equal(result.restorable,false); assert.equal(result.unresolvedDependencyCount,1);
    assert.equal(result.unresolvedDependencies[0].code,'EXTERNAL_MATERIAL_NOT_INCLUDED'); assert.equal(JSON.stringify(result).includes(privateFile),false);
    const manifest=JSON.parse(read(path.join(f.backupOptions.destination,'manifest.json'))).body;
    assert.equal(manifest.entries.some(entry=>entry.path.endsWith('external-private.pem')),false);
    await assert.rejects(f.restore(),/RECOVERY_DEPENDENCY_NOT_INCLUDED/); assert.equal(externalReads,0);
    fs.writeFileSync(envFile,"ASTER_CAPACITY_RELAY_CA_FILE='"+path.join(f.source,'modules/aster/missing.pem')+"'\n");
    const missingBackup=path.join(f.root,'missing-backup');
    await assert.rejects(createBackup({...f.backupOptions,destination:missingBackup,kind:'handoff'}),/RECOVERY_DEPENDENCY_NOT_INCLUDED/);
    const missing=await createBackup({...f.backupOptions,destination:missingBackup});
    assert.equal(missing.restorable,false); assert.equal(missing.unresolvedDependencies[0].code,'REFERENCED_MATERIAL_MISSING');
    await assert.rejects(f.restore('missing-target',{backupDir:missingBackup}),/RECOVERY_DEPENDENCY_NOT_INCLUDED/);
    assert.equal(readRegistry(f.source).state.state,'normal');
  } finally { fs.readFileSync=read;fs.openSync=open;fs.copyFileSync=copy; }
});

test('a trusted inherited internal CA is made portable without restoring root.env into the live environment', async t => {
  const f=await setup(t), envFile=path.join(f.source,'modules/aster/.env'), relative='modules/aster/cert.pem'; fs.unlinkSync(envFile);
  await createBackup({...f.backupOptions,environment:{ASTER_CAPACITY_RELAY_CA_FILE:path.join(f.source,relative)}});
  fs.unlinkSync(path.join(f.source,relative));
  const restored=await f.restore(); const env=parseEnv(fs.readFileSync(path.join(restored.targetDir,'modules/aster/.env'),'utf8'));
  assert.equal(env.ASTER_CAPACITY_RELAY_CA_FILE,path.join(restored.targetDir,relative));
  assert.equal(fs.readFileSync(env.ASTER_CAPACITY_RELAY_CA_FILE,'utf8'),'fixture-certificate');
  assert.equal(fs.existsSync(path.join(restored.targetDir,'_recovery/root.env')),false);
});

test('cold registry reads and SQLite backup sources do not create WAL/SHM files', async t => {
  const f=await setup(t); f.closeHub();
  const sourceFiles = ['execution-control.sqlite','hub.sqlite','modules/crossex/crossex.sqlite','modules/asset/ledger.sqlite','modules/aster/trading.sqlite3'];
  const assertNoSidecars = () => { for (const name of sourceFiles) for (const suffix of ['-wal','-shm']) assert.equal(fs.existsSync(path.join(f.source,name+suffix)),false,name+suffix); };
  assertNoSidecars(); readRegistry(f.source); const db=openSourceDatabase(path.join(f.source,'hub.sqlite')); db.prepare('SELECT count(*) FROM settings').get(); db.close(); assertNoSidecars();
  await createBackup(f.backupOptions); assertNoSidecars();
});

test('a committed retirement WAL is authoritative and missing SHM recovery requires the real cold lock', async t => {
  const f=await setup(t), filename=path.join(f.source,'execution-control.sqlite');
  spawnSync(process.execPath,['--input-type=module','-e',`
    import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA synchronous=FULL');
    const state=JSON.parse(db.prepare("SELECT value FROM aw_meta WHERE key='recovery_state'").get().value);state.state='retired';
    db.prepare("UPDATE aw_meta SET value=? WHERE key='recovery_state'").run(JSON.stringify(state));process.kill(process.pid,'SIGKILL');
  `,filename],{windowsHide:true,timeout:5000,encoding:'utf8'});
  assert.ok(fs.statSync(filename+'-wal').size>0);assert.equal(readRegistry(f.source).state.state,'retired');
  fs.unlinkSync(filename+'-shm');
  assert.throws(()=>readRegistry(f.source),/RECOVERY_DATABASE_CHECKPOINT_REQUIRED/);
  assert.throws(()=>readLockedRegistry(f.source,{assertHeld(){}}),/RUNTIME_LOCK_LOST/);
  assert.equal(readLockedRegistry(f.source,f.sourceLock).state.state,'retired');
  for(const suffix of ['-wal','-shm'])assert.equal(fs.existsSync(filename+suffix),false);
});
