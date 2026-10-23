import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetFills, normalizeAssetFills, ageAssetFills, ASSET_FILLS_RESPONSE_LIMIT, ASSET_FILLS_CACHE_MS, ASSET_FILLS_STALE_MS } from '../server/asset-fills.mjs';
import { NOW, STAMP, payload, fill, scope, deferred } from './fills-fixtures.mjs';

test('fills allowlist preserves precision and coverage without upstream secrets', () => {
  const raw = payload();
  raw.secret = 'do-not-relay'; raw.exchanges[0].accounts[0].credentials = 'do-not-relay';
  scope(raw).error = 'do-not-relay'; scope(raw).fills[0].secret = 'do-not-relay';
  const result = normalizeAssetFills(raw, NOW);
  assert.deepEqual(scope(result).fills, [fill()]);
  assert.ok(!JSON.stringify(result).includes('do-not-relay'));
  const stale = ageAssetFills(result, NOW + ASSET_FILLS_STALE_MS + 1);
  assert.equal(scope(stale).status, 'stale'); assert.equal(scope(stale).fetchedAt, STAMP);
  assert.equal(scope(result).status, 'live');
  assert.equal(scope(ageAssetFills(result, NOW, true)).status, 'stale');
});

test('rejects the entire source for malformed fills, timestamps, flags, identities and counts', () => {
  const invalid = [
    raw => { scope(raw).fills[0].quantity = '1e2'; },
    raw => { scope(raw).fills[0].quantity = '0'; },
    raw => { scope(raw).fills[0].price = '-1'; },
    raw => { scope(raw).fills[0].price = 71; },
    raw => { scope(raw).fills[0].fee = 0; },
    raw => { scope(raw).fills[0].realizedPnl = 'NaN'; },
    raw => { scope(raw).fills[0].positionBefore = 'Infinity'; },
    raw => { scope(raw).fills[0].positionBefore = null; },
    raw => { scope(raw).fills[0].side = 'long'; },
    raw => { scope(raw).fills[0].positionSide = 'both'; },
    raw => { scope(raw).fills[0].base = 'BTC'; },
    raw => { scope(raw).fills[0].symbol = 'CLOUDUSDT'; },
    raw => { scope(raw).fills[0].priceCurrency = 'USD'; },
    raw => { scope(raw).fills[0].quantityUnit = 'BTC'; },
    raw => { scope(raw).fills[0].time = '2026-02-30T00:00:00.000Z'; },
    raw => { scope(raw).fills[0].time = '2099-01-01T00:00:00.000Z'; },
    raw => { scope(raw).fills[0].time = '2026-10-23'; },
    raw => { scope(raw).coverageStart = 'bad'; },
    raw => { scope(raw).coverageEnd = null; },
    raw => { scope(raw).fetchedAt = null; },
    raw => { scope(raw).status = 'unsupported'; },
    raw => { scope(raw).status = 'unknown'; },
    raw => { scope(raw).truncated = 'yes'; },
    raw => { scope(raw).refreshing = 0; },
    raw => { scope(raw).fills.push(fill()); },
    raw => { raw.exchanges.push(raw.exchanges[0]); },
    raw => { raw.exchanges[0].accounts[0].configured = false; },
    raw => { raw.exchanges[0].accounts[0].revision = null; },
    raw => { raw.lookbackStart = new Date(NOW + 1000).toISOString(); },
    raw => { scope(raw).fills = Array.from({ length: 2001 }, (_, i) => fill({ id: `f${i}` })); },
    raw => { raw.exchanges[0].accounts[0].scopes = Array.from({ length: 3 }, (_, s) => ({ ...scope(payload()), id: `s${s}`,
      fills: Array.from({ length: 1700 }, (_, i) => fill({ id: `f${i}` })) })); },
  ];
  for (const mutate of invalid) {
    const raw = payload(); mutate(raw); assert.throws(() => normalizeAssetFills(raw, NOW), /invalid_fills/, mutate.toString());
  }
});

test('accepts empty, pending, unsupported, failed scopes and sorts valid fills', () => {
  for (const status of ['unconfigured', 'loading', 'unsupported', 'error']) {
    const raw = payload(), selected = scope(raw);
    Object.assign(selected, { status, fetchedAt: null, coverageStart: null, coverageEnd: null, fills: [] });
    if (status === 'unconfigured') Object.assign(raw.exchanges[0].accounts[0], { configured: false, revision: null });
    assert.equal(scope(normalizeAssetFills(raw, NOW)).status, status);
  }
  const raw = payload();
  scope(raw).fills = [fill({ id: 'old', time: new Date(NOW - 1000).toISOString(), positionBefore: null, positionAfter: null }), fill()];
  assert.deepEqual(scope(normalizeAssetFills(raw, NOW)).fills.map(row => row.id), ['fill-1', 'old']);
});

test('failed position snapshots preserve real fills and fully truncated scopes retain their known end', () => {
  const raw = payload(), selected = scope(raw);
  Object.assign(selected, { status: 'error', fetchedAt: null });
  Object.assign(selected.fills[0], { positionBefore: null, positionAfter: null });
  const normalized = normalizeAssetFills(raw, NOW);
  assert.equal(scope(normalized).fills.length, 1); assert.equal(scope(normalized).fetchedAt, null);
  Object.assign(selected, { status: 'live', fetchedAt: STAMP, fills: [], truncated: true, coverageStart: null });
  assert.equal(scope(normalizeAssetFills(raw, NOW)).coverageEnd, STAMP);
});

test('Bybit USDC native PERP codes and opaque trade identifiers survive normalization', () => {
  const raw = payload(); raw.exchanges[0].id = 'bybit';
  Object.assign(scope(raw).fills[0], { id: 'opaque/trade|id', symbol: 'CLPERP', priceCurrency: 'USDC' });
  assert.equal(scope(normalizeAssetFills(raw, NOW)).fills[0].symbol, 'CLPERP');
  raw.exchanges[0].id = 'binance'; assert.throws(() => normalizeAssetFills(raw, NOW), /invalid_fills/);
});

const target = (revision = 'a') => ({ project: { id: 'asset', name: 'Asset', adapter: 'asset', enabled: true, embedded: true, apiUrl: 'http://127.0.0.1' }, revision });
function fixture(t, options = {}) {
  let selected = [target()], clock = NOW, handler = async () => ({ data: payload() }), calls = 0;
  const reader = createAssetFills({ listTargets: () => selected, now: () => clock, request: async (_base, route, options) => {
    calls++; assert.equal(route, '/api/hub/fills'); assert.equal(options.requireSecureTransport, true); assert.equal(options.limit, ASSET_FILLS_RESPONSE_LIMIT);
    return handler(options);
  }, ...options });
  t.after(() => reader.close());
  return { reader, calls: () => calls, tick: (ms = ASSET_FILLS_CACHE_MS) => { clock += ms; }, handle: fn => { handler = fn; }, select: value => { selected = value; } };
}

test('coalesces reads and caches successes and sanitized failures for twenty seconds', async t => {
  const f = fixture(t), entered = deferred(), gate = deferred();
  f.handle(async () => { entered.resolve(); await gate.promise; return { data: payload() }; });
  const first = f.reader.state(); await entered.promise; const second = f.reader.state(); gate.resolve();
  assert.deepEqual(await first, await second); assert.equal(f.calls(), 1);
  f.tick(19_999); await f.reader.state(); assert.equal(f.calls(), 1);
  f.tick(1); f.handle(async () => { throw new Error('secret-upstream'); });
  const stale = (await f.reader.state()).sources[0];
  assert.equal(stale.status, 'stale'); assert.equal(scope(stale.data).status, 'stale'); assert.equal(scope(stale.data).fetchedAt, STAMP);
  assert.ok(!JSON.stringify(stale).includes('secret-upstream'));
  await f.reader.state(); assert.equal(f.calls(), 2);
});

test('malformed refresh retains the earlier snapshot; revision changes discard it and late completions', async t => {
  const f = fixture(t); await f.reader.state(); f.tick();
  f.handle(async () => ({ data: { ...payload(), schemaVersion: 2 } }));
  const stale = (await f.reader.state()).sources[0]; assert.equal(stale.status, 'stale'); assert.match(stale.error, /格式无效/);
  f.tick(); const gate = deferred(), entered = deferred();
  f.handle(async () => { entered.resolve(); await gate.promise; return { data: payload() }; });
  const pending = f.reader.state(); await entered.promise;
  f.select([target('b')]); f.reader.invalidate('asset'); gate.resolve();
  assert.equal((await pending).sources[0].data, null);
  f.handle(async () => { throw new Error('secret'); });
  assert.equal((await f.reader.state()).sources[0].status, 'unavailable');
  f.select([]); assert.deepEqual((await f.reader.state()).sources, []);
});

test('times out and closes pending requests without publishing a late result', async t => {
  const f = fixture(t, { timeoutMs: 30 });
  f.handle(({ signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const timer = setTimeout(() => {}, 200);
  try {
    const source = (await f.reader.state()).sources[0]; assert.equal(source.status, 'unavailable'); assert.match(source.error, /超时/);
    f.tick(); const pending = f.reader.state(); await f.reader.close();
    assert.deepEqual((await pending).sources, []);
  } finally { clearTimeout(timer); }
});

test('the bounded response budget accommodates five thousand large decimal fills', () => {
  const raw = payload();
  const large = fill({ quantity: '1'.repeat(128), price: '1'.repeat(128), fee: '-' + '1'.repeat(127), realizedPnl: '1'.repeat(128),
    positionBefore: '1'.repeat(128), positionAfter: '1'.repeat(128) });
  raw.exchanges[0].accounts[0].scopes = [2000, 2000, 1000].map((count, s) => ({ ...scope(payload()), id: `s${s}`,
    fills: Array.from({ length: count }, (_, i) => ({ ...large, id: `f${i}` })) }));
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) > 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) < ASSET_FILLS_RESPONSE_LIMIT);
  assert.equal(normalizeAssetFills(raw, NOW).exchanges[0].accounts[0].scopes.reduce((sum, row) => sum + row.fills.length, 0), 5000);
});
