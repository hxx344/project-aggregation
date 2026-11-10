import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApiServer } from '../server/api/server.mjs';
import { openHubDatabase, seedProjects } from '../server/control/schema.mjs';
import { createControlStore } from '../server/control/store.mjs';
import { createProjectCatalog } from '../server/control/projects.mjs';
import { ensurePassword } from '../server/control/password.mjs';
import { createRuntimeService } from '../server/runtime/service.mjs';
import { createInProcessClient } from '../server/runtime/supervisor-client.mjs';
import { startInternalServer } from '../server/runtime/internal-server.mjs';
import { createInProcessDataClient, createSocketDataClient } from '../server/runtime/data-client.mjs';
import { createDataPlane } from '../server/runtime/data-plane.mjs';
import { createAgentTokens, createRateLimit, MAX_TOKENS } from '../server/agent-feed/tokens.mjs';
import { createAgentFeed } from '../server/agent-feed/feed.mjs';
import { createRuntimeFeed } from '../server/agent-feed/runtime-feed.mjs';
import { DATASETS, cleanDataset, dataset, row } from '../server/agent-feed/catalog.mjs';
import { REQUESTS_PER_MINUTE } from '../server/agent-feed/http.mjs';

const PASSWORD = 'test-password-not-a-real-secret';
const T0 = Date.parse('2026-11-10T00:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const settings = () => { const map = new Map(); return { map, getSetting: key => map.get(key), setSetting: (key, value) => map.set(key, value) }; };
const quiet = { info() {}, debug() {}, error() {}, warn() {} };

test('a token is shown once, stored only as a hash, and stops working when revoked', () => {
  const store = settings(), tokens = createAgentTokens({ ...store, now: () => T0 });
  const { token, entry } = tokens.create({ label: '巡检', scopes: ['system', 'public'] });
  assert.match(token, /^paf_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(entry.scopes, ['public', 'system']);
  const saved = store.map.get('agent-feed-tokens');
  assert.ok(!saved.includes(token) && !saved.includes(token.slice(4)));
  assert.ok(!JSON.stringify(tokens.state()).includes('hash'));
  assert.deepEqual(tokens.verify(token), { id: entry.id, label: '巡检', scopes: ['public', 'system'] });
  assert.equal(tokens.state().tokens[0].lastUsedAt, iso(T0));
  // A second store on the same settings sees the token, and the revocation, without a restart.
  const other = createAgentTokens(store);
  assert.equal(other.verify(token).id, entry.id);
  tokens.revoke(entry.id);
  assert.equal(other.verify(token), null);
  assert.equal(tokens.verify(token), null);
  assert.throws(() => tokens.revoke(entry.id), { status: 404 });
});

test('malformed tokens, bad input and the token limit are refused', () => {
  const tokens = createAgentTokens(settings());
  for (const value of [undefined, null, '', 'paf_short', `paf_${'a'.repeat(44)}`, `xyz_${'a'.repeat(43)}`, `paf_${'a'.repeat(43)}`]) assert.equal(tokens.verify(value), null);
  for (const body of [null, {}, { label: '', scopes: ['public'] }, { label: ' x', scopes: ['public'] }, { label: 'x', scopes: [] }, { label: 'x', scopes: ['portfolio'] }, { label: 'x', scopes: ['public', 'public'] }, { label: 'a'.repeat(41), scopes: ['public'] }])
    assert.throws(() => tokens.create(body), { status: 400 });
  for (let index = 0; index < MAX_TOKENS; index += 1) tokens.create({ label: `agent-${index}`, scopes: ['public'] });
  assert.throws(() => tokens.create({ label: 'one-more', scopes: ['public'] }), { status: 409 });
  assert.throws(() => tokens.create({ label: 'agent-0', scopes: ['public'] }), { status: 409 });
});

test('an unreadable token record grants nothing and is replaced by the next token', () => {
  for (const text of ['{', '{"schemaVersion":2,"tokens":[]}', JSON.stringify({ schemaVersion: 1, tokens: [{ id: 'x', label: 'a', scopes: ['public'], hash: 'zz', createdAt: 'never' }] })]) {
    const store = settings(); store.map.set('agent-feed-tokens', text);
    const tokens = createAgentTokens(store);
    assert.deepEqual([tokens.state().corrupt, tokens.state().tokens], [true, []]);
    assert.equal(tokens.verify(`paf_${'a'.repeat(43)}`), null);
    const { token } = tokens.create({ label: 'new', scopes: ['system'] });
    assert.equal(tokens.state().corrupt, false);
    assert.ok(tokens.verify(token));
  }
});

test('the rate limit counts per key and opens again with the next window', () => {
  let at = T0; const limited = createRateLimit({ limit: 2, windowMs: 60_000, now: () => at });
  assert.deepEqual([limited('a'), limited('a'), limited('b')], [null, null, null]);
  assert.equal(limited('a'), 60);
  at += 59_500; assert.equal(limited('a'), 1);
  at += 500; assert.equal(limited('a'), null);
});

test('a dataset is copied field by field, and a malformed one is dropped whole', () => {
  const good = dataset('market.monitor', [{ ...row({ entity: 'monitor:monitor', metric: 'spread', label: '价差\u0007', value: 1.5, unit: 'USDT/桶', asOf: iso(T0) }), credentials: 'secret', position: 3 }]);
  const clean = cleanDataset({ ...good, apiKey: 'secret' }, 'market.monitor');
  assert.deepEqual(Object.keys(clean), ['id', 'status', 'message', 'asOf', 'rows']);
  assert.deepEqual(clean.rows, [{ entity: 'monitor:monitor', metric: 'spread', label: '价差', value: 1.5, unit: 'USDT/桶', asOf: iso(T0), expiresAt: null, stale: false, status: 'ok' }]);
  for (const bad of [null, { ...good, id: 'market.aero' }, { ...good, rows: [{ ...good.rows[0], metric: 'has space' }] }, { ...good, rows: [{ ...good.rows[0], value: { nested: 1 } }] },
    { ...good, rows: [{ ...good.rows[0], status: 'fine' }] }, { ...good, rows: Array.from({ length: 401 }, () => good.rows[0]) }])
    assert.deepEqual(cleanDataset(bad, 'market.monitor'), { id: 'market.monitor', status: 'unavailable', message: '数据格式无效，已丢弃', asOf: null, rows: [] });
  // A missing or non-finite value is null and unknown, never 0.
  assert.deepEqual([row({ entity: 'a', metric: 'b', value: NaN }).value, row({ entity: 'a', metric: 'b', value: NaN, status: 'ok' }).status, row({ entity: 'a', metric: 'b', value: 0 }).value], [null, 'unknown', 0]);
});

const project = (id, adapter, extra = {}) => ({ id, name: id, adapter, enabled: true, url: 'https://internal.example/path', apiUrl: 'https://internal.example/api', ...extra });
const overviewOf = at => ({ generatedAt: iso(at), projects: [
  { project: project('monitor', 'monitor'), state: 'online', message: '正常', checkedAt: iso(at - 5000), lastSuccessAt: iso(at - 5000), updatedAt: iso(at - 8000), latencyMs: 42, staleAfterSeconds: 120, diagnostics: [],
    metrics: [{ key: 'spread', label: '布伦特 − WTI 价差', value: 3.14159265, unit: 'USDT/桶' }, { key: 'modules', label: '监控模块', value: 4, unit: '个' }, { key: 'bad', label: 'x', value: { a: 1 } }] },
  { project: project('asset', 'asset'), state: 'partial', message: '账户 0xabc 余额读取失败', checkedAt: iso(at - 9000), lastSuccessAt: iso(at - 60_000), updatedAt: iso(at - 9000), latencyMs: 800, staleAfterSeconds: 900,
    diagnostics: [{ id: 'hub:connection', kind: 'fault', message: 'https://internal.example/api?key=abc 失败', firstSeenAt: iso(at) }], metrics: [{ key: 'ledger_total', label: '表内总额', value: 123456.78, unit: 'USD' }], sync: { account: 'private' } },
  { project: project('docs', 'link'), state: 'online', message: '链接入口', checkedAt: null, updatedAt: null, latencyMs: null, metrics: [] },
  { project: project('aster', 'aster', { enabled: false }), state: 'disabled', message: '项目已停用', checkedAt: null, updatedAt: null, latencyMs: null, metrics: [] },
] });
const lag = at => ({ schemaVersion: 1, generatedAt: iso(at), monitoring: true, since: iso(at - 1000), tickMs: 100, stallThresholdMs: 200, lastMinute: { maxMs: 12, stalls: 0 }, lastFiveMinutes: { maxMs: 450, stalls: 2 }, recentStalls: [] });
const aeroState = at => ({ schema: 1, revision: 7, serverNow: at, config: { enabled: true, intervalMin: 15, minTvlUsd: 50_000, chains: { base: { enabled: true, rpcUrl: 'https://rpc.example/v2/SECRET-KEY' } } }, favorites: ['base:0xfavourite'],
  aero: { usd: 0.71234567, at: at - 60_000 }, chains: [{ id: 'base', name: 'Base', enabled: true, rpcHost: 'rpc.example', status: 'ok', updatedAt: at - 60_000, error: null }],
  pools: [
    { chain: 'base', address: '0xsmall', gauge: '0xg', tickSpacing: 100, token0: { address: '0xa', symbol: 'WETH', decimals: 18, usd: 3000 }, token1: { address: '0xb', symbol: 'USDC', decimals: 6, usd: 1 }, fee: 500, tvlUsd: 1_000_000, emissionPerSec: 0.5, vol24h: { daily: 0.0312, samples: 20 }, vol7d: null },
    { chain: 'base', address: '0xbig', gauge: null, tickSpacing: 1, token0: { address: '0xb', symbol: 'USDC', decimals: 6, usd: 1 }, token1: { address: '0xc', symbol: 'USDT', decimals: 6, usd: 1 }, fee: 100, tvlUsd: 9_000_000, emissionPerSec: 0, vol24h: null, vol7d: null },
    { chain: 'base', address: '0xunpriced', gauge: null, tickSpacing: 200, token0: { address: '0xd', symbol: 'X', decimals: 18, usd: null }, token1: { address: '0xb', symbol: 'USDC', decimals: 6, usd: 1 }, fee: 3000, tvlUsd: null, emissionPerSec: null, vol24h: null, vol7d: null },
  ] });

test('the data plane builds its datasets from market and state fields only', () => {
  const feed = createRuntimeFeed({ readOverview: () => overviewOf(T0), readEventLoop: () => lag(T0), readAero: () => aeroState(T0), now: () => T0, log: quiet })();
  const text = JSON.stringify(feed);
  for (const leak of ['ledger_total', '123456', '0xabc', 'internal.example', 'SECRET-KEY', 'rpc.example', 'favourite', 'private', '余额']) assert.ok(!text.includes(leak), leak);
  const byId = Object.fromEntries(feed.datasets.map(item => [item.id, item]));
  assert.deepEqual(Object.keys(byId), ['system.projects', 'system.event-loop', 'market.monitor', 'market.aero']);
  // Monitor metrics only; the source time is the summary's own data time and the expiry follows its staleAfterSeconds.
  assert.deepEqual(byId['market.monitor'].rows.map(item => [item.entity, item.metric, item.value, item.unit, item.asOf, item.expiresAt, item.stale]),
    [['monitor:monitor', 'spread', 3.14159, 'USDT/桶', iso(T0 - 8000), iso(T0 + 112_000), false], ['monitor:monitor', 'modules', 4, '个', iso(T0 - 8000), iso(T0 + 112_000), false]]);
  // Project rows: state and counts, no metric values or messages; link entries are not data sources.
  const states = byId['system.projects'].rows.filter(item => item.metric === 'state').map(item => [item.entity, item.value, item.status]);
  assert.deepEqual(states, [['project:monitor', 'online', 'ok'], ['project:asset', 'partial', 'warn'], ['project:aster', 'disabled', 'ok']]);
  assert.deepEqual(byId['system.projects'].rows.filter(item => item.entity === 'project:asset').map(item => [item.metric, item.value, item.status]),
    [['state', 'partial', 'warn'], ['latency', 800, 'ok'], ['diagnostics', 1, 'warn'], ['last_success_at', iso(T0 - 60_000), 'ok']]);
  assert.deepEqual(byId['system.event-loop'].rows.map(item => [item.metric, item.value, item.status]), [['max_lag_1m', 12, 'ok'], ['stalls_1m', 0, 'ok'], ['max_lag_5m', 450, 'warn'], ['stalls_5m', 2, 'warn']]);
  // Pools by TVL, unpriced ones left out; units converted, unknown values null.
  const aero = byId['market.aero'].rows;
  assert.deepEqual(aero[0], row({ entity: 'token:AERO', metric: 'price', label: 'AERO', value: 0.712346, unit: 'USD', asOf: iso(T0 - 60_000), expiresAt: iso(T0 - 60_000 + 35 * 60_000) }));
  assert.deepEqual(aero.slice(1).map(item => [item.entity, item.metric, item.value, item.status]), [
    ['pool:base:0xbig', 'tvl', 9_000_000, 'ok'], ['pool:base:0xbig', 'fee', 0.01, 'ok'], ['pool:base:0xbig', 'emission', 0, 'ok'], ['pool:base:0xbig', 'daily_vol_24h', null, 'unknown'], ['pool:base:0xbig', 'daily_vol_7d', null, 'unknown'],
    ['pool:base:0xsmall', 'tvl', 1_000_000, 'ok'], ['pool:base:0xsmall', 'fee', 0.05, 'ok'], ['pool:base:0xsmall', 'emission', 43200, 'ok'], ['pool:base:0xsmall', 'daily_vol_24h', 3.12, 'ok'], ['pool:base:0xsmall', 'daily_vol_7d', null, 'unknown']]);
  assert.equal(aero[1].label, 'USDC/USDT · Base · 间距 1');
  // Every dataset passes the API's contract unchanged.
  for (const item of feed.datasets) assert.deepEqual(cleanDataset(item, item.id), item);
});

test('one failing source leaves the other datasets readable, and a stale monitor marks its rows', () => {
  const stale = overviewOf(T0); stale.projects[0].state = 'stale';
  const feed = createRuntimeFeed({ readOverview: () => stale, readEventLoop: () => ({ ...lag(T0), monitoring: false }), readAero: () => { throw new Error('boom'); }, now: () => T0, log: quiet })();
  const byId = Object.fromEntries(feed.datasets.map(item => [item.id, item]));
  assert.ok(byId['market.monitor'].rows.length && byId['market.monitor'].rows.every(item => item.stale));
  assert.deepEqual([byId['system.event-loop'].status, byId['market.aero'].status, byId['market.aero'].message, byId['system.projects'].status], ['unavailable', 'unavailable', '数据集暂时无法生成', 'ok']);
  const none = createRuntimeFeed({ readOverview: () => { throw new Error('db'); }, readEventLoop: () => lag(T0), readAero: () => ({ ...aeroState(T0), config: { enabled: false } }), now: () => T0, log: quiet })();
  assert.deepEqual(none.datasets.map(item => [item.id, item.status, item.rows.length]), [['system.projects', 'unavailable', 0], ['system.event-loop', 'ok', 4], ['market.monitor', 'unavailable', 0], ['market.aero', 'ok', 0]]);
});

const hostReading = at => ({ schemaVersion: 1, generatedAt: iso(at), cpu: { usagePercent: 97.5, cores: 4, model: 'cpu', loadAverage: [1, 2, 3] }, memory: { totalBytes: 100, availableBytes: 40, usedBytes: 60, usedPercent: 60, swap: { totalBytes: 0, usedBytes: 0, usedPercent: null } },
  disks: [{ id: 'data', label: '数据目录', totalBytes: 1000, availableBytes: 100, usedBytes: 900, usedPercent: 90 }, { id: 'root', label: '系统盘', error: '无法读取' }], uptimeSeconds: 3600 });
function feedFixture({ agentFeed, status } = {}) {
  const clock = { at: T0 }; let calls = 0;
  const remote = () => ({ schemaVersion: 1, datasets: createRuntimeFeed({ readOverview: () => overviewOf(clock.at), readEventLoop: () => lag(clock.at), readAero: () => aeroState(clock.at), now: () => clock.at, log: quiet })().datasets });
  const feed = createAgentFeed({ hostStatus: { read: async () => hostReading(clock.at) }, now: () => clock.at, log: quiet,
    supervisor: { status: status ?? (async () => ({ ready: true, degraded: [], modulesEnabled: true, modules: [{ moduleId: 'monitor', state: 'ready', restartCount: 1, consecutiveFailures: 0 }, { moduleId: 'aster', state: 'backoff', restartCount: 6, consecutiveFailures: 3 }] })) },
    runtime: { agentFeed: async () => { calls += 1; return (agentFeed ?? remote)(); } } });
  return { feed, clock, calls: () => calls };
}

test('a snapshot serves the scopes of the token, in the row format of the catalog', async () => {
  const { feed } = feedFixture();
  const all = await feed.snapshot(['public', 'system'], null);
  assert.deepEqual(all.datasets.map(item => item.id), DATASETS.map(item => item.id));
  for (const item of all.datasets) for (const line of item.rows) assert.deepEqual(Object.keys(line), ['entity', 'metric', 'label', 'value', 'unit', 'asOf', 'stale', 'status']);
  assert.deepEqual((await feed.snapshot(['system'], null)).datasets.map(item => item.scope), ['system', 'system', 'system', 'system']);
  assert.deepEqual((await feed.snapshot(['public'], ['market.aero'])).datasets.map(item => item.id), ['market.aero']);
  await assert.rejects(feed.snapshot(['system'], ['market.monitor']), { status: 403 });
  for (const wanted of [[], [''], ['nope'], ['system.host', 'system.host'], ['system.host', 'trading.positions']]) await assert.rejects(feed.snapshot(['public', 'system'], wanted), { status: 400 });
  const host = Object.fromEntries(all.datasets[0].rows.map(item => [`${item.entity}/${item.metric}`, item]));
  assert.deepEqual([host['host/cpu_usage'].value, host['host/cpu_usage'].unit, host['host/cpu_usage'].status, host['disk:data/disk_used'].status, host['disk:root/disk_used'].value, host['disk:root/disk_used'].status, host['host/swap_used']],
    [97.5, '%', 'alert', 'warn', null, 'unknown', undefined]);
  assert.deepEqual(all.datasets[1].rows.filter(item => item.metric !== 'restart_count').map(item => [item.entity, item.metric, item.value, item.status]),
    [['runtime', 'ready', true, 'ok'], ['module:monitor', 'state', 'ready', 'ok'], ['module:monitor', 'consecutive_failures', 0, 'ok'], ['module:aster', 'state', 'backoff', 'alert'], ['module:aster', 'consecutive_failures', 3, 'warn']]);
  assert.deepEqual(feed.catalog(['public']).datasets.map(item => item.id), ['market.monitor', 'market.aero']);
  assert.ok(!JSON.stringify(feed.catalog(['public', 'system'])).includes('origin'));
});

test('readers share one build per interval, and staleness is judged when the snapshot is served', async () => {
  const { feed, clock, calls } = feedFixture();
  const [first] = await Promise.all([feed.snapshot(['public'], ['market.monitor']), feed.snapshot(['system'], null), feed.snapshot(['public', 'system'], null)]);
  assert.equal(calls(), 1);
  assert.deepEqual([first.datasets[0].staleRows, first.datasets[0].rows[0].stale], [0, false]);
  // Served from the same build 4 s later: a new response time, the source time does not move.
  clock.at = T0 + 4000;
  const reused = await feed.snapshot(['public'], ['market.monitor']);
  assert.deepEqual([calls(), reused.generatedAt, reused.datasets[0].rows[0].asOf, reused.datasets[0].rows[0].stale], [1, iso(T0 + 4000), iso(T0 - 8000), false]);
  clock.at = T0 + 5000; await feed.snapshot(['public'], null);
  assert.equal(calls(), 2);
  const expiring = feedFixture({ agentFeed: () => ({ schemaVersion: 1, datasets: [dataset('market.monitor', [row({ entity: 'monitor:monitor', metric: 'spread', value: 3, asOf: iso(T0), expiresAt: iso(T0 + 2000) }), row({ entity: 'monitor:monitor', metric: 'undated', value: 1 })])] }) });
  assert.deepEqual((await expiring.feed.snapshot(['public'], ['market.monitor'])).datasets[0].rows.map(item => item.stale), [false, true]);
  expiring.clock.at = T0 + 2000;
  const later = (await expiring.feed.snapshot(['public'], ['market.monitor'])).datasets[0];
  assert.deepEqual([expiring.calls(), later.staleRows, later.rows.map(item => item.stale)], [1, 2, [true, true]]);
});

test('with the data plane unreachable the host is still served and the rest is reported unavailable', async () => {
  const { feed } = feedFixture({ agentFeed: () => { throw new Error('down'); }, status: async () => { throw new Error('down'); } });
  const snapshot = await feed.snapshot(['public', 'system'], null);
  assert.deepEqual(snapshot.datasets.map(item => [item.id, item.status, item.message]), [['system.host', 'ok', null], ['system.runtime', 'ok', '数据面没有应答'],
    ['system.projects', 'unavailable', '数据面暂时不可用'], ['system.event-loop', 'unavailable', '数据面暂时不可用'], ['market.monitor', 'unavailable', '数据面暂时不可用'], ['market.aero', 'unavailable', '数据面暂时不可用']]);
  assert.deepEqual(snapshot.datasets[1].rows.map(item => [item.entity, item.metric, item.value, item.status]), [['runtime', 'ready', false, 'alert']]);
  // A runtime of an earlier release answers without the datasets this API knows.
  const old = feedFixture({ agentFeed: () => ({ schemaVersion: 1, datasets: [{ id: 'future.dataset', status: 'ok', rows: [] }, { id: 'market.aero', status: 'ok', rows: [{ entity: 'x' }] }] }) });
  assert.deepEqual((await old.feed.snapshot(['public'], null)).datasets.map(item => [item.id, item.status, item.message]), [['market.monitor', 'unavailable', '数据面当前版本不提供该数据集'], ['market.aero', 'unavailable', '数据格式无效，已丢弃']]);
});

// The feed over both transports between the API and the data plane.
const remoteFeed = () => createRuntimeFeed({ readOverview: () => overviewOf(T0), readEventLoop: () => lag(T0), readAero: () => aeroState(T0), now: () => T0, log: quiet })();
async function socketClient(t, dataPlane) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'af-'));
  const server = await startInternalServer({ service: createRuntimeService({ readMaintenance: () => false }), dataPlane, dir, logger: quiet });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  return createSocketDataClient({ dir, backoffMs: [20] });
}
const transports = { 'in-process': async (_t, dataPlane) => createInProcessDataClient(dataPlane, { log: quiet }), socket: socketClient };
for (const [name, connect] of Object.entries(transports)) {
  test(`${name}: the data plane's datasets reach the API unchanged, and a reply that is not a feed is refused`, { skip: name === 'socket' && process.platform === 'win32' }, async t => {
    const client = await connect(t, { agentFeed: remoteFeed });
    assert.deepEqual(await client.agentFeed(), { schemaVersion: 1, datasets: remoteFeed().datasets });
    for (const reply of [null, [], { schemaVersion: 2, datasets: [] }, { schemaVersion: 1, datasets: {} }, { schemaVersion: 1, datasets: Array.from({ length: 65 }, () => ({})) }])
      await assert.rejects((await connect(t, { agentFeed: () => reply })).agentFeed(), error => error.status === 503);
  });
}

test('socket: a data plane of an earlier release is up but provides no dataset', { skip: process.platform === 'win32' }, async t => {
  // The route is looked up before the data plane is called: without it the runtime answers 404 as an earlier release does.
  const client = await socketClient(t, null);
  await assert.rejects(client.agentFeed(), error => error.status === 404 && error.origin === 'runtime');
  const warnings = [];
  const feed = createAgentFeed({ hostStatus: { read: async () => hostReading(T0) }, supervisor: { status: async () => ({ ready: true, modules: [] }) }, runtime: client, now: () => T0, log: { warn: (fields, message) => warnings.push(message) } });
  assert.deepEqual((await feed.snapshot(['public', 'system'], null)).datasets.map(item => [item.id, item.status, item.message]), [['system.host', 'ok', null], ['system.runtime', 'ok', null],
    ...['system.projects', 'system.event-loop', 'market.monitor', 'market.aero'].map(id => [id, 'unavailable', '数据面当前版本不提供该数据集'])]);
  assert.deepEqual(warnings, []);
});

test('the data plane builds the feed from its own state without a request', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hub-agent-plane-'));
  const db = openHubDatabase(path.join(dataDir, 'hub.sqlite')), control = createControlStore(db);
  seedProjects(control, { embeddedModules: false });
  const decrypt = value => value ? JSON.parse(Buffer.from(value, 'base64').toString()) : null;
  const requests = [], original = globalThis.fetch;
  globalThis.fetch = async (...args) => { requests.push(String(args[0])); throw new Error('no network in this test'); };
  const plane = createDataPlane({ db, control, catalog: createProjectCatalog({ control, embeddedModules: false, decrypt }), encrypt: value => value, decrypt, embeddedModules: false, dataDir,
    log: quiet, refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0, baselineIntervalMs: 0 });
  t.after(async () => { globalThis.fetch = original; await plane.close(); db.close(); await rm(dataDir, { recursive: true, force: true }); });
  const before = requests.length, feed = plane.agentFeed();
  assert.equal(requests.length, before);
  assert.deepEqual(feed.datasets.map(item => item.id), ['system.projects', 'system.event-loop', 'market.monitor', 'market.aero']);
  for (const item of feed.datasets) assert.deepEqual(cleanDataset(item, item.id), item);
  // Nothing has been read yet: every project is listed with a state, and no dataset failed to build.
  assert.ok(feed.datasets.every(item => item.message !== '数据集暂时无法生成'));
  assert.ok(feed.datasets[0].rows.length > 0 && feed.datasets[0].rows.every(item => item.metric === 'state' || item.asOf !== null));
});

// The API server against a scripted data plane.
async function apiFixture(t, { agentFeed = async () => ({ schemaVersion: 1, datasets: [] }) } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hub-agent-feed-'));
  const db = openHubDatabase(path.join(dataDir, 'hub.sqlite')), control = createControlStore(db);
  const logs = [], log = { ...quiet, info: (fields, message) => logs.push({ fields, message }) };
  await ensurePassword(control, { initialPassword: PASSWORD, log }); seedProjects(control, { embeddedModules: false });
  const encrypt = value => Buffer.from(JSON.stringify(value)).toString('base64'), decrypt = value => value ? JSON.parse(Buffer.from(value, 'base64').toString()) : null;
  const readMaintenance = () => false, forwarded = [];
  const runtime = { async overview() { return { projects: [], generatedAt: iso(T0) }; }, subscribeOverview: () => () => {}, async projectChanged() { return { accepted: true }; }, async coordinateAssetSync() { return null; },
    async forward(request) { forwarded.push(request.target); return { status: 200, body: {} }; }, async reportApiStats() { return { accepted: true }; }, agentFeed };
  const state = { enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null };
  const api = createApiServer({ control, catalog: createProjectCatalog({ control, embeddedModules: false, decrypt }), encrypt, decrypt, embeddedModules: false, log,
    supervisor: createInProcessClient(createRuntimeService({ moduleRuntime: null, guard: null, readMaintenance })), runtime,
    executionJobs: { state: () => ({ jobs: [] }), openEntries: () => 0, transaction: fn => fn() }, readMaintenance, updatesClient: Object.fromEntries(['status', 'check', 'apply', 'token'].map(method => [method, async () => state])),
    secureCookies: false, configuredOrigin: '', distDir: path.join(dataDir, 'dist') });
  await api.initialize();
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.server.address().port}`;
  t.after(async () => { await api.close(); db.close(); await rm(dataDir, { recursive: true, force: true }); });
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrfToken;
  const page = (route, { method = 'GET', body, headers = { 'X-CSRF-Token': csrf } } = {}) => fetch(origin + route, { method, headers: { Cookie: cookie, Origin: origin, ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const agent = (route, token, options = {}) => fetch(origin + route, { ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const create = async (label, scopes) => (await page('/api/system/agent-feed/tokens', { method: 'POST', body: { label, scopes } })).json();
  return { origin, cookie, control, logs, forwarded, page, agent, create };
}

test('the feed takes its token and nothing else, and the token opens nothing else', async t => {
  const f = await apiFixture(t);
  const { token, entry } = await f.create('巡检', ['public', 'system']);
  // No token, a wrong one, the session cookie, or the token in the query: all refused.
  for (const response of [await f.agent('/api/agent/v1/catalog'), await f.agent('/api/agent/v1/catalog', `paf_${'a'.repeat(43)}`), await f.agent('/api/agent/v1/snapshot', null, { headers: { Cookie: f.cookie } }),
    await f.agent(`/api/agent/v1/catalog?token=${token}`), await f.agent('/api/agent/v1/catalog', null, { headers: { Authorization: `Basic ${token}` } })]) {
    assert.equal(response.status, 401); assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  }
  assert.equal((await f.agent('/api/agent/v1/catalog', token)).status, 200);
  // The token is not a session: every other route still asks for a login, and nothing reaches the data plane.
  for (const route of ['/api/overview', '/api/projects', '/api/system/agent-feed', '/api/system/host', '/api/trading/positions', '/api/trading/execution', '/api/automation/feishu-digest'])
    assert.equal((await f.agent(route, token)).status, 401, route);
  assert.equal((await f.agent('/api/system/agent-feed/tokens', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'x', scopes: ['public'] }) })).status, 401);
  assert.deepEqual(f.forwarded, []);
  // Read-only: no method but GET, with or without a token.
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await f.agent('/api/agent/v1/snapshot', token, { method });
    assert.deepEqual([response.status, response.headers.get('allow')], [405, 'GET']);
  }
  assert.equal((await f.agent('/api/agent/v1/unknown', token)).status, 404);
  assert.equal((await f.agent('/api/agent/v1/catalog?x=1', token)).status, 400);
  assert.equal((await f.agent('/api/agent/v1/snapshot?datasets=system.host&datasets=market.aero', token)).status, 400);
  assert.equal((await f.agent('/api/agent/v1/snapshot?limit=1', token)).status, 400);
  // Revoked from the page: refused at once.
  assert.equal((await f.page(`/api/system/agent-feed/tokens/${entry.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await f.agent('/api/agent/v1/catalog', token)).status, 401);
});

test('tokens are managed from the page only, and the page never shows a token again', async t => {
  const f = await apiFixture(t);
  assert.equal((await f.agent('/api/system/agent-feed')).status, 401);
  assert.equal((await f.page('/api/system/agent-feed/tokens', { method: 'POST', body: { label: 'x', scopes: ['public'] }, headers: {} })).status, 403);
  assert.equal((await f.page('/api/system/agent-feed/tokens', { method: 'POST', body: { label: 'x', scopes: ['public'] }, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await f.page('/api/system/agent-feed', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const created = await f.create('只读系统', ['system']);
  assert.deepEqual(Object.keys(created), ['token', 'entry']);
  const listing = await f.page('/api/system/agent-feed'), text = await listing.text(), state = JSON.parse(text);
  assert.ok(!text.includes(created.token) && !text.includes('hash'));
  assert.deepEqual([state.tokens.map(item => [item.label, item.scopes, item.lastUsedAt]), state.corrupt, state.requestsPerMinute, state.datasets.length], [[['只读系统', ['system'], null]], false, REQUESTS_PER_MINUTE, DATASETS.length]);
  assert.ok(!f.control.getSetting('agent-feed-tokens').includes(created.token));
  // The log names the token's id and scopes, never the token.
  assert.ok(f.logs.some(item => item.fields.tokenId === created.entry.id) && !JSON.stringify(f.logs).includes(created.token));
  // Scopes hold over HTTP.
  const catalog = await (await f.agent('/api/agent/v1/catalog', created.token)).json();
  assert.deepEqual(catalog.datasets.map(item => item.scope), ['system', 'system', 'system', 'system']);
  assert.equal((await f.agent('/api/agent/v1/snapshot?datasets=market.aero', created.token)).status, 403);
  const snapshot = await (await f.agent('/api/agent/v1/snapshot?datasets=system.host,system.runtime', created.token)).json();
  assert.deepEqual(snapshot.datasets.map(item => [item.id, item.status]), [['system.host', 'ok'], ['system.runtime', 'ok']]);
  assert.ok(snapshot.datasets[0].rows.some(item => item.metric === 'memory_used' && typeof item.value === 'number' && item.unit === '%'));
  assert.equal((await f.page('/api/system/agent-feed/tokens/not-an-id', { method: 'DELETE' })).status, 404);
  assert.equal((await f.page('/api/system/agent-feed/tokens', { method: 'PUT', body: {} })).status, 405);
  assert.equal((await f.page(`/api/system/agent-feed/tokens/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, { method: 'DELETE' })).status, 404);
});

test('each token has its own request budget', { timeout: 30_000 }, async t => {
  const f = await apiFixture(t);
  const first = await f.create('a', ['system']), second = await f.create('b', ['system']);
  for (let index = 0; index < REQUESTS_PER_MINUTE; index += 1) assert.equal((await f.agent('/api/agent/v1/catalog', first.token)).status, 200);
  const refused = await f.agent('/api/agent/v1/catalog', first.token);
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) >= 1 && (await refused.json()).retryAfterSeconds >= 1);
  assert.equal((await f.agent('/api/agent/v1/catalog', second.token)).status, 200);
});
