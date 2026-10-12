import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/sqlite.ts';
import { createPositionsService } from '../lib/hub-positions.ts';
import { position } from '../lib/positions-values.ts';
import type { HubPositions, Position } from '../lib/positions-types.ts';
import type { Credentials } from '../lib/validation.ts';

const credential: Credentials = { exchange: 'binance', apiKey: 'synthetic-key', apiSecret: 'synthetic-secret' };
const at = Date.parse('2026-10-01T00:00:00.000Z');
const sample = [position('BTCUSDT', 'long', '1.000000000000000001', 'BTC')];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const scope = (report: HubPositions, exchange = 'binance', account = 'default', id = 'um') => report.exchanges.find(item => item.id === exchange)!.accounts.find(item => item.id === account)!.scopes.find(item => item.id === id)!;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const database = openDatabase(':memory:'); const credentials = new Map<string, unknown>(); let revision = 0;
  const save = async (owner = 'owner', key = 'binance', value: unknown = credential) => {
    const encrypted = 'synthetic-encrypted-' + ++revision; credentials.set(encrypted, value);
    await database.prepare('INSERT INTO connections(owner,exchange,encrypted,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner,exchange) DO UPDATE SET encrypted=excluded.encrypted')
      .bind(owner, key, encrypted, new Date(at).toISOString()).run();
  };
  const unseal = async (value: string) => credentials.get(value);
  return { database, save, unseal };
}

test('Asset catalog includes all five exchanges before setup and never exposes credentials', async t => {
  const f = fixture(); t.after(() => f.database.close());
  const service = createPositionsService({ read: async () => assert.fail('unconfigured must not read') });
  const report = await service.read(f.database, 'owner', async () => assert.fail('unconfigured must not decrypt'));
  assert.deepEqual(report.exchanges.map(item => item.id), ['binance', 'bybit', 'okx', 'aster', 'variational']);
  for (const exchange of report.exchanges) for (const account of exchange.accounts) {
    assert.equal(account.configured, false); assert.equal(account.revision, null);
    for (const item of account.scopes) { assert.equal(item.status, 'unconfigured'); assert.equal(item.fetchedAt, null); assert.deepEqual(item.positions, []); }
  }
});

test('GET returns loading promptly, single-flights within TTL and marks only successful empty results live', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  const pending = deferred<Position[]>(); let reads = 0; let clock = at;
  const service = createPositionsService({ now: () => clock, read: async () => { reads++; return pending.promise; } });
  const initial = await service.read(f.database, 'owner', f.unseal);
  assert.equal(scope(initial).status, 'loading'); assert.equal(scope(initial).refreshing, true); assert.equal(scope(initial).fetchedAt, null);
  assert.equal(scope(initial, 'binance', 'default', 'options').status, 'unsupported');
  await flush(); await service.read(f.database, 'owner', f.unseal); assert.equal(reads, 3, 'global cap includes queued fourth Binance scope');
  pending.resolve([]); await service.idle(); assert.equal(reads, 4);
  const result = await service.read(f.database, 'owner', f.unseal);
  assert.equal(scope(result).status, 'live'); assert.deepEqual(scope(result).positions, []); assert.equal(scope(result).fetchedAt, new Date(at).toISOString());
  clock += 29_999; await service.read(f.database, 'owner', f.unseal); assert.equal(reads, 4);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});

test('TTL refresh keeps a full snapshot, 90s aging marks stale, and failed refresh preserves data and original fetch time', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save(); let clock = at; let fail = false;
  const wait = deferred<Position[]>(); let mode = 'success';
  const service = createPositionsService({ now: () => clock, read: async () => {
    if (fail) throw new Error('PRIVATE provider signature and synthetic-secret');
    if (mode === 'wait') return wait.promise;
    return sample;
  } });
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  clock += 30_000; mode = 'wait';
  const refreshing = await service.read(f.database, 'owner', f.unseal);
  assert.equal(scope(refreshing).status, 'live'); assert.equal(scope(refreshing).refreshing, true); assert.deepEqual(scope(refreshing).positions, sample);
  clock += 60_000; const stale = await service.read(f.database, 'owner', f.unseal); assert.equal(scope(stale).status, 'stale');
  wait.resolve(sample); await service.idle();
  const fetchedAt = scope(await service.read(f.database, 'owner', f.unseal)).fetchedAt;
  fail = true; clock += 30_000; await service.read(f.database, 'owner', f.unseal); await service.idle();
  const failure = await service.read(f.database, 'owner', f.unseal);
  assert.equal(scope(failure).status, 'error'); assert.equal(scope(failure).fetchedAt, fetchedAt); assert.deepEqual(scope(failure).positions, sample);
  assert.equal(JSON.stringify(failure).includes('PRIVATE'), false); assert.equal(JSON.stringify(failure).includes('synthetic-secret'), false);
});

test('credential replacement clears cached holdings immediately and rejects earlier in-flight completion', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  const old = deferred<Position[]>(); const replacement = deferred<Position[]>(); const started: string[] = [];
  const service = createPositionsService({ read: async credentials => {
    assert.ok('apiKey' in credentials); started.push(credentials.apiKey);
    return credentials.apiKey === 'synthetic-key' ? old.promise : replacement.promise;
  } });
  const initial = await service.read(f.database, 'owner', f.unseal); await flush();
  await f.save('owner', 'binance', { ...credential, apiKey: 'replacement-key' });
  const changed = await service.read(f.database, 'owner', f.unseal);
  assert.notEqual(changed.exchanges[0].accounts[0].revision, initial.exchanges[0].accounts[0].revision);
  assert.equal(scope(changed).status, 'loading'); assert.deepEqual(scope(changed).positions, []);
  old.resolve(sample); await flush(); assert.ok(started.includes('replacement-key'));
  const stillLoading = await service.read(f.database, 'owner', f.unseal); assert.deepEqual(scope(stillLoading).positions, []);
  replacement.resolve([]); await service.idle(); assert.equal(scope(await service.read(f.database, 'owner', f.unseal)).status, 'live');
  assert.deepEqual(scope(await service.read(f.database, 'owner', f.unseal)).positions, []);
});

test('disconnect and cross-owner reads cannot expose old holdings, including late refresh results', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save(); const pending = deferred<Position[]>();
  const service = createPositionsService({ read: async () => pending.promise });
  await service.read(f.database, 'owner', f.unseal); await flush();
  await f.database.prepare('DELETE FROM connections WHERE owner = ?').bind('owner').run();
  const disconnected = await service.read(f.database, 'owner', f.unseal);
  for (const item of disconnected.exchanges[0].accounts[0].scopes) { assert.equal(item.status, 'unconfigured'); assert.deepEqual(item.positions, []); }
  pending.resolve(sample); await flush();
  const other = await service.read(f.database, 'other-owner', f.unseal);
  assert.equal(other.exchanges[0].accounts[0].configured, false); assert.deepEqual(scope(other).positions, []);
  assert.deepEqual(scope(await service.read(f.database, 'owner', f.unseal)).positions, []);
});

test('Aster account directory comes from Asset saved accounts, including disconnected names and legacy default', async t => {
  const f = fixture(); t.after(() => f.database.close());
  const aster: Credentials = { exchange: 'aster', privateKey: '0'.repeat(63) + '1', walletAddress: '0x' + '1'.repeat(40), includeSpot: false };
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const disconnected = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await f.save('owner', 'aster', aster); await f.save('owner', 'aster:' + id, aster);
  await f.database.prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?)').bind('owner', 'aster-accounts', JSON.stringify([{ id, name: '策略二' }, { id: disconnected, name: '已断开策略' }])).run();
  const service = createPositionsService({ read: async () => sample });
  const result = await service.read(f.database, 'owner', f.unseal);
  const accounts = result.exchanges.find(item => item.id === 'aster')!.accounts;
  assert.deepEqual(accounts.map(item => item.name), ['策略二', '已断开策略', '默认账号']);
  assert.equal(accounts[1].configured, false); assert.equal(accounts[0].configured, true); assert.equal(accounts[2].configured, true);
  await service.idle();
});

test('global refresh concurrency is bounded and a timed-out provider cannot overwrite a later snapshot', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  let active = 0, maximum = 0, clock = at; const pending = deferred<Position[]>(); let phase = 0;
  const service = createPositionsService({ now: () => clock, deadline: 15, concurrency: 2, read: async (_c, _scope, signal) => {
    active++; maximum = Math.max(maximum, active); signal.addEventListener('abort', () => { active--; }, { once: true });
    if (phase === 0) return pending.promise;
    active--; return [];
  } });
  await service.read(f.database, 'owner', f.unseal); await service.idle(); assert.equal(maximum, 2);
  const failed = await service.read(f.database, 'owner', f.unseal); assert.equal(scope(failed).status, 'error'); assert.equal(scope(failed).fetchedAt, null);
  phase = 1; clock += 30_000; await service.read(f.database, 'owner', f.unseal); await service.idle();
  pending.resolve(sample); await flush();
  assert.deepEqual(scope(await service.read(f.database, 'owner', f.unseal)).positions, []);
});

test('vault decryption failures are sanitized and never become successful empty positions', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  const service = createPositionsService({ read: async () => assert.fail('cannot read after failed decrypt') });
  await service.read(f.database, 'owner', async () => { throw new Error('PRIVATE encrypted content'); }); await service.idle();
  const result = await service.read(f.database, 'owner', f.unseal);
  assert.equal(scope(result).status, 'error'); assert.equal(scope(result).fetchedAt, null); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
