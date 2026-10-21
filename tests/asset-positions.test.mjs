import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetPositions, normalizeAssetPositions, ageAssetPositions } from '../server/asset-positions.mjs';
import { UpstreamError } from '../server/adapters.mjs';

const STAMP = '2026-10-12T00:00:00.000Z';
const NOW = Date.parse(STAMP);
const revision = 'a'.repeat(64);
const position = () => ({ id: 'BTC-USDT-SWAP:long', symbol: 'BTC-USDT-SWAP', instrumentId: 'BTC-USDT-SWAP', side: 'long',
  quantity: '12345678901234567890.00000001', quantityUnit: '张', contractSize: '0.01', entryPrice: '60100', markPrice: '60200', priceCurrency: 'USDT',
  notional: '74283950000123456789.1', notionalCurrency: 'USDT', unrealizedPnl: '-1.000000000000000001', pnlCurrency: 'USDT',
  leverage: null, marginMode: 'cross', liquidationPrice: null, sourceUpdatedAt: STAMP });
const payload = () => ({ schemaVersion: 1, generatedAt: STAMP, exchanges: [{ id: 'okx', name: 'OKX', accounts: [
  { id: 'main', name: '主账户', configured: true, revision, scopes: [{ id: 'swap', label: '永续合约', status: 'live', refreshing: false, fetchedAt: STAMP, error: null, positions: [position()] }] },
] }] });
const target = (id = 'asset', rev = revision) => ({ project: { id, name: `Asset ${id}`, adapter: 'asset', enabled: true, apiUrl: `http://127.0.0.1/${id}`, authOrigin: 'http://127.0.0.1' }, credentials: { password: 'fixture-only-password' }, revision: rev });
const scope = data => data.exchanges[0].accounts[0].scopes[0];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('allowlists dynamic exchange data and preserves decimal strings, units and nulls', () => {
  const raw = payload(); raw.apiSecret = 'do-not-return'; raw.exchanges[0].accounts[0].credentials = { apiKey: 'do-not-return' };
  scope(raw).positions[0].secret = 'do-not-return'; scope(raw).error = 'signed-url-do-not-return';
  raw.exchanges.push({ id: 'future-exchange', name: '未来交易所', accounts: [{ id: 'other', name: '另一账户', configured: false, revision: null,
    scopes: [{ id: 'future', label: '合约', status: 'unconfigured', refreshing: false, fetchedAt: null, error: null, positions: [] }] }] });
  const data = normalizeAssetPositions(raw, NOW);
  assert.equal(data.exchanges.length, 2); assert.deepEqual(scope(data).positions[0], position());
  assert.ok(!JSON.stringify(data).includes('do-not-return')); assert.equal(scope(data).error, null);
});

test('empty, unknown, failed and old positions remain distinct', () => {
  const raw = payload(); scope(raw).positions = [];
  assert.equal(scope(normalizeAssetPositions(raw, NOW)).status, 'live');
  scope(raw).status = 'loading'; scope(raw).fetchedAt = null;
  assert.equal(scope(normalizeAssetPositions(raw, NOW)).status, 'loading');
  scope(raw).status = 'error'; scope(raw).error = 'apiSecret=never-return';
  assert.equal(scope(normalizeAssetPositions(raw, NOW)).error, 'Asset 读取此范围失败，请在 Asset 检查连接与权限');
  const normalized = normalizeAssetPositions(payload(), NOW);
  assert.equal(scope(ageAssetPositions(normalized, NOW + 90_001)).status, 'stale');
  assert.equal(scope(ageAssetPositions(normalized, NOW, true)).status, 'stale');
  assert.equal(scope(normalized).status, 'live', 'aging does not mutate the cached source');
});

test('accepts Asset reader field lengths and large scopes while retaining total limits', () => {
  const raw = payload();
  raw.exchanges[0].accounts[0].name = '策略\t二';
  const row = { ...position(), symbol: 'A'.repeat(160), instrumentId: 'B'.repeat(160), quantityUnit: 'C'.repeat(165), priceCurrency: 'D'.repeat(128) };
  scope(raw).positions = Array.from({ length: 3001 }, (_, i) => ({ ...row, id: `position-${i}` }));
  const normalized = normalizeAssetPositions(raw, NOW);
  assert.equal(normalized.exchanges[0].accounts[0].name, '策略 二');
  assert.equal(scope(normalized).positions.length, 3001);
  assert.equal(scope(normalized).positions[0].quantityUnit, row.quantityUnit);
  scope(raw).positions = Array.from({ length: 10001 }, (_, i) => ({ ...row, id: `position-${i}` }));
  assert.throws(() => normalizeAssetPositions(raw, NOW), /invalid_positions/);
});

test('rejects malformed successful snapshots rather than silently dropping rows', () => {
  for (const change of [
    data => { scope(data).positions[0].quantity = '1e9'; },
    data => { scope(data).positions[0].quantity = '0'; },
    data => { scope(data).positions[0].quantity = '-2'; },
    data => { scope(data).positions[0].unrealizedPnl = 3; },
    data => { scope(data).fetchedAt = null; },
    data => { scope(data).fetchedAt = '2099-01-01T00:00:00Z'; },
    data => { scope(data).status = 'unsupported'; },
    data => { scope(data).positions.push(position()); },
    data => { data.exchanges.push(data.exchanges[0]); },
    data => { data.exchanges[0].accounts[0].revision = null; },
    data => { data.exchanges[0].accounts[0].configured = false; },
  ]) {
    const data = payload(); change(data); assert.throws(() => normalizeAssetPositions(data, NOW), /invalid_positions/);
  }
});

function fixture(t, overrides = {}) {
  let clock = NOW, selected = [target()], handler = async () => ({ data: payload() });
  const calls = [];
  const request = async (base, path, options) => {
    calls.push({ base, path, options });
    if (path === '/api/login') return { data: { ok: true }, cookies: ['asset_session=positions-unit-test; HttpOnly; Path=/'] };
    assert.equal(path, '/api/hub/positions'); assert.equal(options.method, 'GET');
    assert.equal(options.requireSecureTransport, true); assert.equal(options.limit, 2 * 1024 * 1024);
    return handler(base, path, options);
  };
  const reader = createAssetPositions({ listTargets: () => selected, request, now: () => clock, ...overrides });
  t.after(() => reader.close());
  return { reader, calls, tick: (ms = 5001) => { clock += ms; }, select: next => { selected = next; }, handle: next => { handler = next; } };
}

test('coalesces in-flight reads and reuses cached data without exporting credentials', async t => {
  const f = fixture(t), gate = deferred(), entered = deferred();
  f.handle(async () => { entered.resolve(); await gate.promise; return { data: payload() }; });
  const first = f.reader.state(); await entered.promise;
  const second = f.reader.state(); gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.equal(a.sources[0].status, 'ready');
  await f.reader.state();
  assert.equal(f.calls.filter(call => call.path === '/api/hub/positions').length, 1);
  assert.ok(f.calls.every(call => !call.path.includes('export')));
  assert.ok(!JSON.stringify(a).includes('fixture-only-password'));
});

test('isolates multiple Asset sources and retains stale snapshots after safe failures', async t => {
  const f = fixture(t);
  f.select([target(), target('asset2'), { ...target('not-configured'), credentials: null }, { ...target('disabled'), project: { ...target('disabled').project, enabled: false } }]);
  f.handle(async base => { if (base.endsWith('asset2')) throw new UpstreamError('offline', 'upstream-key-never-echo', 404); return { data: payload() }; });
  let data = await f.reader.state();
  assert.equal(data.sources.length, 3);
  assert.equal(data.sources[0].status, 'ready'); assert.equal(data.sources[1].status, 'unavailable');
  assert.match(data.sources[1].error, /更新 Asset/); assert.equal(data.sources[2].status, 'unconfigured');
  f.tick(); f.handle(async () => { throw new Error('upstream-key-never-echo'); });
  data = await f.reader.state(); assert.equal(data.sources[0].status, 'stale');
  assert.equal(scope(data.sources[0].data).fetchedAt, STAMP); assert.equal(scope(data.sources[0].data).status, 'stale');
  assert.equal(scope(data.sources[0].data).positions[0].quantity, position().quantity);
  assert.ok(!JSON.stringify(data).includes('upstream-key-never-echo'));
});

test('credential changes clear snapshots and discard an earlier request that completes late', async t => {
  const f = fixture(t);
  await f.reader.state(); f.tick();
  const entered = deferred(), gate = deferred();
  f.handle(async () => { entered.resolve(); await gate.promise; return { data: payload() }; });
  const old = f.reader.state(); await entered.promise;
  f.select([target('asset', 'b'.repeat(64))]); f.reader.invalidate('asset');
  gate.resolve();
  const late = await old;
  assert.equal(late.sources[0].data, null);
  f.handle(async () => ({ data: { ...payload(), exchanges: [] } }));
  const current = await f.reader.state(); assert.deepEqual(current.sources[0].data.exchanges, []);
  f.select([]); assert.deepEqual((await f.reader.state()).sources, []);
});

test('malformed new data preserves the complete earlier snapshot and its timestamp', async t => {
  const f = fixture(t); await f.reader.state(); f.tick();
  f.handle(async () => { const bad = payload(); scope(bad).positions[0].side = 'unknown'; return { data: bad }; });
  const result = await f.reader.state(); assert.equal(result.sources[0].status, 'stale');
  assert.equal(scope(result.sources[0].data).fetchedAt, STAMP); assert.match(result.sources[0].error, /响应格式无效/);
});

test('times out with a controlled error and aborts pending requests on close', async t => {
  const f = fixture(t, { timeoutMs: 30 });
  f.handle((_base, _path, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const timer = setTimeout(() => {}, 100);
  try {
    const result = await f.reader.state(); assert.equal(result.sources[0].status, 'unavailable'); assert.match(result.sources[0].error, /超时/);
  } finally { clearTimeout(timer); }
  f.tick(); const pending = f.reader.state(); await f.reader.close();
  assert.deepEqual((await pending).sources, []);
});

test('background reads keep sources warm without a page, never overlap, and stop on close', async t => {
  const f = fixture(t, { backgroundIntervalMs: 20, cacheMs: 0 }); let active = 0, maximum = 0;
  f.handle(async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 30)); active--; return { data: payload() }; });
  await new Promise(resolve => setTimeout(resolve, 150));
  const reads = () => f.calls.filter(call => call.path === '/api/hub/positions').length;
  assert.ok(reads() >= 2, 'reads happen without any caller'); assert.equal(maximum, 1);
  await f.reader.close(); const after = reads();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(reads(), after);
});

test('optional cycle summaries are allowlisted, absent for older Asset versions and dropped when malformed', () => {
  const cycle = () => ({ status: 'complete', since: '2026-10-11T00:00:00.000Z', closedQuantity: '1', closePrice: '60300.5', realizedPnl: '12.000000000000000001', fees: '-0.3', funding: '-0.1', net: '11.600000000000000001', currency: 'USDT', note: null, updatedAt: '2026-10-11T23:00:00.000Z' });
  const raw = payload(); scope(raw).positions[0].cycle = { ...cycle(), secret: 'do-not-return' };
  assert.deepEqual(scope(normalizeAssetPositions(raw, NOW)).positions[0].cycle, cycle());
  assert.equal('cycle' in scope(normalizeAssetPositions(payload(), NOW)).positions[0], false);
  for (const bad of [{ ...cycle(), status: 'done' }, { ...cycle(), net: 12 }, { ...cycle(), note: 'x'.repeat(301) }, { ...cycle(), updatedAt: '2030-01-01T00:00:00.000Z' }, 'complete']) {
    const broken = payload(); scope(broken).positions[0].cycle = bad;
    const data = normalizeAssetPositions(broken, NOW);
    assert.equal(scope(data).positions[0].cycle, null); assert.equal(scope(data).positions.length, 1);
  }
});
