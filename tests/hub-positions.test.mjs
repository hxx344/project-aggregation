import test from 'node:test';
import assert from 'node:assert/strict';
import { createPositionsSource, failedOutcome, matchBase, MAX_POSITION_ITEMS, openTradingRequest, positionItems, positionsReply, positionsRequest, POSITIONS_TIMEOUT_MS } from '../src/hub-positions.ts';
import { ASSET_POSITIONS_TIMEOUT_MS } from '../server/asset-positions.mjs';
import { POSITIONS_TIMEOUT_MS as MODULE_POSITIONS_TIMEOUT_MS } from '../modules/monitor/lib/hub-bridge.ts';

const now = Date.parse('2026-10-22T04:00:00.000Z');
const at = new Date(now - 5_000).toISOString();
const position = (symbol, overrides = {}) => ({ id: `secret-position-${symbol}`, symbol, instrumentId: symbol, side: 'long', quantity: '1.230000000000000001', quantityUnit: 'contracts', contractSize: '0.1', entryPrice: null, markPrice: '70.12', notional: '7.012', unrealizedPnl: null, leverage: '3', liquidationPrice: '1', priceCurrency: 'USDT', notionalCurrency: 'USDT', pnlCurrency: null, marginMode: 'cross', sourceUpdatedAt: null, ...overrides });
const response = (positions, { scopeStatus = 'live', sourceStatus = 'ready', fetchedAt = at } = {}) => ({ generatedAt: at, sources: [
  { projectId: 'asset-secret-project', name: 'Asset 主账本', status: sourceStatus, error: 'token=leak', checkedAt: at, data: { schemaVersion: 1, generatedAt: at, exchanges: [
    { id: 'binance', name: 'Binance', accounts: [{ id: 'account-secret-1', name: '机密账户名', configured: true, revision: 'revision-secret-7', scopes: [
      { id: 'scope-secret-9', label: 'U 本位合约', status: scopeStatus, refreshing: false, fetchedAt, error: '敏感错误 apiKey=leak', positions }] }] }] } },
  { projectId: 'asset-empty', name: 'Asset 待连接', status: 'unconfigured', error: null, checkedAt: null, data: null },
] });
const request = (overrides = {}) => ({ channel: 'project-hub', version: 1, type: 'positions-request', requestId: 'req-1', market: 'oil', symbols: ['CL', 'BZ'], ...overrides });

test('positions requests accept only the documented shape', () => {
  assert.deepEqual(positionsRequest(request()), { requestId: 'req-1', market: 'oil', symbols: ['CL', 'BZ'] });
  for (const market of ['oil', 'cl-xau', 'hynix', 'perpetual']) assert.ok(positionsRequest(request({ market })));
  assert.ok(positionsRequest(request({ requestId: 'a'.repeat(64), symbols: Array.from({ length: 20 }, (_, i) => `B${i}`) })));
  for (const invalid of [
    request({ type: 'positions' }), request({ requestId: '' }), request({ requestId: 'a'.repeat(65) }), request({ requestId: 'bad id' }), request({ requestId: 'x_y' }), request({ requestId: 7 }),
    request({ market: 'gold' }), request({ market: undefined }), request({ symbols: [] }), request({ symbols: 'CL' }), request({ symbols: ['cl'] }), request({ symbols: ['CL-USDT'] }),
    request({ symbols: ['A'.repeat(21)] }), request({ symbols: Array.from({ length: 21 }, (_, i) => `B${i}`) }), request({ symbols: [1] }), null, [], 'positions-request',
  ]) assert.equal(positionsRequest(invalid), null, JSON.stringify(invalid));
  assert.equal(openTradingRequest({ type: 'open-trading', market: 'hynix' }), 'hynix');
  assert.equal(openTradingRequest({ type: 'open-trading', market: 'other' }), null);
  assert.equal(openTradingRequest({ type: 'navigate', market: 'oil' }), null);
});

test('symbol matching only strips separators and allowed quote suffixes', () => {
  const bases = ['CL', 'BZ', 'XAU', 'SKHY', 'SKHX'];
  for (const [symbol, base] of [['CLUSDT', 'CL'], ['CL-USDT-SWAP', 'CL'], ['cl_usdt', 'CL'], ['CL', 'CL'], ['CLUSD', 'CL'], ['CLUSDC', 'CL'], ['CL-PERP', 'CL'], ['CLUSDCPERP', 'CL'], ['CLUSDSWAP', 'CL'], ['CL-USD-PERP', 'CL'], ['BZUSDT', 'BZ'], ['XAU_USDT', 'XAU'], ['SKHYUSDT', 'SKHY'], ['SKHX-USDT-SWAP', 'SKHX']])
    assert.equal(matchBase(symbol, bases), base, symbol);
  for (const symbol of ['CLOUD', 'BZX', 'CLUSDTM', 'XCLUSDT', 'CLUSDT2', 'CLEUR', 'SKHYNIX', 'CL币安USDT', 'BTCUSDT', ''])
    assert.equal(matchBase(symbol, bases), null, symbol);
  assert.equal(matchBase('CLUSD', ['CL', 'CLUSD']), 'CLUSD', 'the longest requested base wins');
  const hynix = ['SKHY', 'SKHX', 'SKHYNIX'];
  for (const [symbol, base] of [['SKHYUSDT', 'SKHY'], ['SKHYNIXUSDT', 'SKHYNIX'], ['SKHYNIX-USDT-SWAP', 'SKHYNIX'], ['SKHYNIX_USDT', 'SKHYNIX'], ['SKHYNIXUSD1', 'SKHYNIX'], ['SKHYUSD1', 'SKHY']])
    assert.equal(matchBase(symbol, hynix), base, `both Hynix legs match the CEX contract names: ${symbol}`);
  assert.equal(matchBase('CLUSD1', ['CL']), 'CL', 'Aster USD1 contracts match');
});

test('items are redacted and keep decimal strings and nulls unchanged', () => {
  const { items } = positionItems(response([position('CLUSDT'), position('CL-USDT-SWAP', { side: 'short', entryPrice: '0' }), position('CLOUDUSDT'), position('BZUSDT', { instrumentId: 'BZ-USDT-SWAP', symbol: 'BRENT' })]), ['CL', 'BZ'], now);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { key: 'binance:CLUSDT:long:1', source: 'Asset 主账本', exchange: 'Binance', exchangeId: 'binance', symbol: 'CLUSDT', base: 'CL', side: 'long', quantity: '1.230000000000000001', quantityUnit: 'contracts', entryPrice: null, markPrice: '70.12', unrealizedPnl: null, pnlCurrency: null, updatedAt: at, stale: false });
  assert.equal(items[1].entryPrice, '0');
  assert.deepEqual(items[2].symbol, 'BRENT', 'instrument id may match while the original symbol is reported');
  const serialized = JSON.stringify(items);
  for (const secret of ['account-secret-1', '机密账户名', 'revision-secret-7', 'scope-secret-9', 'leak', 'secret-position', 'asset-secret-project'])
    assert.ok(!serialized.includes(secret), secret);
  for (const item of items) assert.deepEqual(Object.keys(item).sort(), ['base', 'entryPrice', 'exchange', 'exchangeId', 'key', 'markPrice', 'pnlCurrency', 'quantity', 'quantityUnit', 'side', 'source', 'stale', 'symbol', 'unrealizedPnl', 'updatedAt']);
});

test('stale follows scope, source and read age', () => {
  const stale = options => positionItems(response([position('CLUSDT')], options), ['CL'], now).items[0].stale;
  assert.equal(stale({}), false);
  assert.equal(stale({ scopeStatus: 'stale' }), true);
  assert.equal(stale({ scopeStatus: 'error' }), true);
  assert.equal(stale({ sourceStatus: 'stale' }), true);
  assert.equal(stale({ sourceStatus: 'unavailable' }), true);
  assert.equal(stale({ fetchedAt: null }), true);
  assert.equal(stale({ fetchedAt: new Date(now - 91_000).toISOString() }), true);
});

for (const count of [49, 50, 51, 60]) test(`${count} matching positions report the exact range without raising the item cap`, () => {
  const data = response(Array.from({ length: count }, () => position('CLUSDT')));
  const selection = positionItems(data, ['CL'], now);
  assert.equal(selection.items.length, Math.min(count, MAX_POSITION_ITEMS));
  assert.equal(new Set(selection.items.map(item => item.key)).size, selection.items.length, 'duplicate identities retain distinct keys');
  assert.equal(selection.matchedCount, count);
  assert.equal(selection.itemLimit, MAX_POSITION_ITEMS);
  assert.equal(selection.truncated, count > MAX_POSITION_ITEMS);
  assert.equal(selection.incomplete, count > MAX_POSITION_ITEMS);
  assert.equal(selection.sourcesIncomplete, false, 'truncation alone does not mean a source failed');
  const reply = positionsReply(positionsRequest(request()), { status: 'ok', data, at: 0 }, now);
  assert.equal(reply.status, 'ok');
  for (const field of ['items', 'matchedCount', 'itemLimit', 'truncated', 'incomplete', 'sourcesIncomplete']) assert.deepEqual(reply[field], selection[field], field);
  for (const secret of ['account-secret-1', '机密账户名', 'revision-secret-7', 'scope-secret-9', 'leak', 'secret-position', 'asset-secret-project'])
    assert.ok(!JSON.stringify(reply).includes(secret), secret);
});

test('unrelated positions do not count toward matches or cause truncation', () => {
  for (const count of [0, 49, 50, 51, 60]) {
    const unrelated = Array.from({ length: 60 }, (_, index) => position(index % 2 ? 'CLOUDUSDT' : 'BTCUSDT'));
    const data = response([...unrelated, ...Array.from({ length: count }, () => position('CLUSDT')), ...unrelated]);
    const reply = positionsReply(positionsRequest(request()), { status: 'ok', data, at: 0 }, now);
    assert.equal(reply.matchedCount, count);
    assert.equal(reply.items.length, Math.min(count, MAX_POSITION_ITEMS));
    assert.equal(reply.truncated, count > MAX_POSITION_ITEMS);
    assert.equal(reply.incomplete, count > MAX_POSITION_ITEMS);
  }
});

test('matching totals span every source and malformed positions beyond the cap still reject the response', () => {
  const data = response(Array.from({ length: 50 }, () => position('CLUSDT')));
  const extra = response(Array.from({ length: 10 }, () => position('BZUSDT'))).sources[0];
  data.sources.push(extra);
  const reply = positionsReply(positionsRequest(request()), { status: 'ok', data, at: 0 }, now);
  assert.equal(reply.matchedCount, 60);
  assert.equal(reply.truncated, true);
  assert.equal(reply.incomplete, true);
  const malformed = response([...Array.from({ length: 50 }, () => position('CLUSDT')), position('BZUSDT', { quantity: 2 })]);
  assert.equal(positionsReply(positionsRequest(request()), { status: 'ok', data: malformed, at: 0 }, now).status, 'unavailable');
});

test('source or scope failures remain distinguishable when the matching list is also truncated', () => {
  for (const failure of ['source-unavailable', 'source-stale', 'scope-error', 'scope-loading']) {
    const data = response(Array.from({ length: 60 }, () => position('CLUSDT')));
    if (failure.startsWith('source-')) data.sources.push({ name: 'Asset 备用账本', status: failure.slice(7), data: null });
    else {
      const scopes = data.sources[0].data.exchanges[0].accounts[0].scopes;
      scopes.push({ ...scopes[0], status: failure.slice(6), positions: [] });
    }
    const reply = positionsReply(positionsRequest(request()), { status: 'ok', data, at: 0 }, now);
    assert.equal(reply.status, 'ok', failure);
    assert.equal(reply.matchedCount, 60, 'the count describes only sources/scopes that provided a list');
    assert.equal(reply.items.length, 50);
    assert.equal(reply.sourcesIncomplete, true, failure);
    assert.equal(reply.truncated, true, failure);
    assert.equal(reply.incomplete, true, failure);
  }
});

test('replies map outcomes and reject malformed responses', () => {
  const parsed = positionsRequest(request());
  const ok = positionsReply(parsed, { status: 'ok', data: response([position('CLUSDT')]), at: 0 }, now);
  assert.equal(ok.status, 'ok'); assert.equal(ok.incomplete, false); assert.equal(ok.generatedAt, at); assert.equal(ok.items.length, 1); assert.equal(ok.requestId, 'req-1'); assert.equal(ok.market, 'oil');
  for (const status of ['unauthorized', 'unavailable']) assert.deepEqual(positionsReply(parsed, { status, at: 0 }, now), { type: 'positions', requestId: 'req-1', market: 'oil', status, generatedAt: null, incomplete: false, items: [] });
  for (const data of [null, {}, { sources: {} }, response([position('CLUSDT', { quantity: 1.23 })]), response([position('CLUSDT', { side: 'flat' })]), response([position('CLUSDT', { markPrice: 0 })])])
    assert.equal(positionsReply(parsed, { status: 'ok', data, at: 0 }, now).status, 'unavailable');
  assert.equal(positionsReply(parsed, { status: 'ok', data: { ...response([]), generatedAt: 'later' }, at: 0 }, now).generatedAt, null);
});

test('unavailable replies name the failing layer so the module can show it', () => {
  const parsed = positionsRequest(request());
  assert.deepEqual(failedOutcome(new DOMException('slow', 'TimeoutError'), 5), { status: 'unavailable', at: 5, reason: 'timeout' });
  assert.deepEqual(failedOutcome(Object.assign(new Error('down'), { status: 503 }), 5), { status: 'unavailable', at: 5, reason: 'http', httpStatus: 503 });
  assert.deepEqual(failedOutcome(Object.assign(new Error('bad body'), { status: 200 }), 5), { status: 'unavailable', at: 5, reason: 'malformed' });
  assert.deepEqual(failedOutcome(Object.assign(new Error('login'), { status: 401 }), 5), { status: 'unauthorized', at: 5 });
  assert.deepEqual(failedOutcome(new TypeError('Failed to fetch'), 5), { status: 'unavailable', at: 5, reason: 'network' });
  const reply = positionsReply(parsed, { status: 'unavailable', at: 0, reason: 'http', httpStatus: 503 }, now);
  assert.equal(reply.reason, 'http'); assert.equal(reply.httpStatus, 503); assert.deepEqual(reply.items, []);
  assert.equal(positionsReply(parsed, { status: 'unavailable', at: 0, reason: 'background' }, now).httpStatus, undefined);
  assert.equal(positionsReply(parsed, { status: 'ok', data: null, at: 0 }, now).reason, 'malformed');
});

test('incomplete marks sources and scopes that could not confirm positions', () => {
  const parsed = positionsRequest(request());
  const reply = data => positionsReply(parsed, { status: 'ok', data, at: 0 }, now);
  const withSources = (...extra) => { const value = response([position('CLUSDT')]); value.sources = [value.sources[0], ...extra]; return value; };
  const missing = status => ({ projectId: `asset-${status}`, name: `Asset ${status}`, status, error: '来源不可用', checkedAt: at, data: null });
  const healthy = reply(withSources());
  assert.equal(healthy.incomplete, false); assert.equal(healthy.items.length, 1);
  const unavailable = reply(withSources(missing('unavailable')));
  assert.equal(unavailable.status, 'ok'); assert.equal(unavailable.incomplete, true); assert.equal(unavailable.items.length, 1, 'healthy source items are still returned');
  assert.equal(reply(withSources(missing('stale'))).incomplete, true);
  assert.equal(reply(withSources(missing('unconfigured'))).incomplete, false, 'unconfigured sources are not incomplete');
  assert.equal(reply(response([], { scopeStatus: 'error' })).incomplete, true, 'error scope without positions');
  assert.equal(reply(response([], { scopeStatus: 'loading' })).incomplete, true, 'loading scope without positions');
  assert.equal(reply(response([position('CLUSDT')], { scopeStatus: 'error' })).incomplete, false, 'error scope keeps old positions, already marked stale');
  for (const scopeStatus of ['unsupported', 'unconfigured', 'live']) assert.equal(reply(response([], { scopeStatus })).incomplete, false, scopeStatus);
});

test('positions source coalesces reads, caches every outcome for 20 seconds and never retries', async () => {
  let clock = 0, calls = 0, release, fail = null;
  const source = createPositionsSource(() => { calls++; return new Promise((resolve, reject) => { release = () => fail ? reject(fail) : resolve({ sources: [] }); }); }, { clock: () => clock });
  assert.deepEqual(await source.read(false), { status: 'unavailable', at: 0, reason: 'background' }, 'inactive pages never start a read');
  assert.equal(calls, 0);
  const first = source.read(true), second = source.read(true), hidden = source.read(false);
  assert.equal(calls, 1, 'one in-flight read'); release();
  assert.deepEqual((await Promise.all([first, second, hidden])).map(value => value.status), ['ok', 'ok', 'ok']);
  clock = 19_999; assert.equal((await source.read(true)).status, 'ok'); assert.equal(calls, 1, 'fresh cache is reused');
  clock = 20_000; fail = Object.assign(new Error('expired'), { status: 401 });
  const expired = source.read(true); release();
  assert.equal((await expired).status, 'unauthorized'); assert.equal(calls, 2);
  assert.equal((await source.read(true)).status, 'unauthorized'); assert.equal(calls, 2, 'failures are cached, not retried');
  clock = 40_000; fail = new DOMException('timeout', 'TimeoutError');
  const timeout = source.read(true); release();
  assert.deepEqual(await timeout, { status: 'unavailable', at: 40_000, reason: 'timeout' }); assert.equal(calls, 3);
  clock = 60_000; const pending = source.read(true); source.dispose(); release(); await pending;
  assert.equal((await source.read(false)).status, 'unavailable', 'dispose discards the in-flight result');
});

test('each positions deadline outlasts the one it waits on, so a slow source is reported by the layer that knows why', () => {
  // Server -> Asset, host page -> server, Monitor -> host page.
  assert.ok(POSITIONS_TIMEOUT_MS >= ASSET_POSITIONS_TIMEOUT_MS + 2_000, 'the host waits for the server to give up on Asset and answer with kept positions');
  assert.ok(MODULE_POSITIONS_TIMEOUT_MS >= POSITIONS_TIMEOUT_MS + 2_000, 'Monitor waits for the host to answer, including its own failure reply');
});

test('cycle summaries are forwarded field by field and stay absent for older Asset versions', () => {
  const cycle = { status: 'partial', since: at, closedQuantity: '2', closePrice: '70.5', realizedPnl: '-3.2', fees: null, funding: '0.1', net: null, currency: 'USDT', note: '部分手续费以其他币种扣除，未计入', updatedAt: at };
  const { items } = positionItems(response([position('CLUSDT', { cycle: { ...cycle, secret: 'leak' } }), position('BZUSDT'), position('CL-USDT-SWAP', { side: 'short', cycle: null })]), ['CL', 'BZ'], now);
  assert.deepEqual(items[0].cycle, cycle); assert.equal('cycle' in items[1], false); assert.equal(items[2].cycle, null);
  for (const bad of [{ ...cycle, status: 'done' }, { ...cycle, net: 1 }, 'partial']) assert.throws(() => positionItems(response([position('CLUSDT', { cycle: bad })]), ['CL'], now));
});
