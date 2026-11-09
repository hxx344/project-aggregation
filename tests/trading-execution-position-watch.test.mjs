import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionPositionWatch } from '../server/trading-execution-position-watch.mjs';

const EXCHANGES = ['binance', 'okx', 'hyperliquid', 'rh-lighter'];
const MODES = { binance: 'standard', okx: 'cross', hyperliquid: 'agent', 'rh-lighter': 'api-key' };
const SYMBOLS = { binance: 'ANTHROPICUSDT', okx: 'ANTHROPICUSDT', hyperliquid: 'io:ANTH', 'rh-lighter': 'ANTHROPIC' };
const descriptor = (exchange, extra = {}) => ({ exchange, connected: true, revision: 1, identity: `verified-${exchange}`, accountMode: MODES[exchange], ...(exchange === 'rh-lighter' ? { accountIndex: 27 } : {}), ...extra });
const position = (exchange, at, extra = {}) => ({ symbol: SYMBOLS[exchange], side: 'short', quantity: '3', quantityUnit: exchange === 'okx' ? '张' : 'ANTHROPIC',
  entryPrice: '100', markPrice: '100', notional: '300', unrealizedPnl: '0', leverage: '3', marginMode: 'cross', liquidationPrice: '110', riskFetchedAt: at, ...extra });
function harness(exchanges = EXCHANGES) {
  let current = Date.parse('2026-11-09T00:00:00Z');
  const h = { connections: exchanges.map(exchange => descriptor(exchange)), calls: [], responses: {}, now: () => current, advance: ms => { current += ms; }, at: () => new Date(current).toISOString() };
  h.snapshot = (exchange, binding, extra = {}) => ({ identity: binding.identity, ...(exchange === 'rh-lighter' ? { accountIndex: binding.accountIndex } : {}), fetchedAt: h.at(), positions: [position(exchange, h.at())], ...extra });
  h.watch = createExecutionPositionWatch({ readConnections: () => h.connections, now: h.now, read: async (exchange, binding, options) => {
    h.calls.push({ exchange, binding, signal: options.signal });
    return h.responses[exchange] ? h.responses[exchange](binding, options) : h.snapshot(exchange, binding);
  } });
  h.source = exchange => h.watch.state().find(source => source.exchange === exchange);
  return h;
}

test('execution position getters do no IO, whitelist fields, and retain native quantity and stable mode-specific ids', async () => {
  const h = harness();
  h.connections[0].apiKey = 'connection-secret';
  h.responses.okx = binding => h.snapshot('okx', binding, { secret: 'snapshot-secret', positions: [
    position('okx', h.at(), { quantity: '0.125', contractSize: '10', id: 'raw-uid', credentials: 'position-secret' }),
    position('okx', h.at(), { marginMode: 'isolated' }),
    { symbol: 'CLUSDT', credentials: 'unrelated-secret' },
  ] });
  for (let count = 0; count < 20; count++) assert.equal(h.source('binance').state, 'loading');
  assert.equal(h.calls.length, 0);
  await h.watch.refresh();
  assert.deepEqual(h.calls.map(call => call.exchange), EXCHANGES);
  const source = h.source('okx');
  assert.equal(source.state, 'live'); assert.equal(source.origin, 'execution');
  assert.deepEqual(source.executionBinding, { revision: 1, identity: 'verified-okx', accountMode: 'cross', accountIndex: null });
  assert.deepEqual(source.positions.map(row => [row.quantity, row.quantityUnit, row.marginMode]), [['0.125', '张', 'cross'], ['3', '张', 'isolated']]);
  assert.notEqual(source.positions[0].id, source.positions[1].id);
  assert.equal(source.positions[0].contractSize, '10');
  assert.equal(JSON.stringify(h.watch.state()).includes('secret'), false);
  assert.equal(JSON.stringify(h.calls.map(call => call.binding)).includes('secret'), false);
  assert.equal(JSON.stringify(source.positions).includes('verified'), false);
  assert.equal(JSON.stringify(source.positions).includes('raw-uid'), false);
  const originalId = source.positions[0].id;
  source.positions[0].quantity = '999'; source.executionBinding.identity = 'changed-by-caller';
  assert.equal(h.source('okx').positions[0].quantity, '0.125');
  h.connections[1] = descriptor('okx', { identity: 'second-okx', revision: 2 });
  await h.watch.refresh();
  assert.equal(h.source('okx').positions[0].id, originalId, 'position id contains no account UID');
  await h.watch.close();
});

test('all connection dimensions immediately revoke cached positions and proof until a matching snapshot arrives', async () => {
  const h = harness(['binance', 'rh-lighter']);
  await h.watch.refresh();
  const changes = [
    ['binance', { revision: 2 }], ['binance', { identity: 'new-account' }], ['binance', { accountMode: 'portfolio-margin' }],
    ['rh-lighter', { accountIndex: 28 }], ['binance', { connected: false }], ['binance', { connected: true, revision: 3 }],
  ];
  for (const [exchange, change] of changes) {
    const before = h.source(exchange), calls = h.calls.length;
    Object.assign(h.connections.find(item => item.exchange === exchange), change);
    const after = h.source(exchange);
    assert.notEqual(after.connectionKey, before.connectionKey);
    assert.deepEqual(after.positions, []); assert.equal(Object.hasOwn(after, 'executionBinding'), false);
    assert.equal(h.calls.length, calls, 'invalidating GET cannot fetch');
    await h.watch.refresh();
    assert.equal(h.source(exchange).state, change.connected === false ? 'unconfigured' : 'live');
  }
  assert.equal(h.source('rh-lighter').positions[0].account, 28);
  assert.equal(h.source('okx').state, 'unconfigured');
  await h.watch.close();
});

test('refresh shares one concurrent round and discards a late result from a changed connection', async () => {
  const h = harness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  h.responses.binance = async binding => { await gate; return h.snapshot('binance', binding); };
  const round = h.watch.refresh();
  assert.equal(h.watch.refresh(), round);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.calls.length, 4, 'one slow venue does not delay starting the other three');
  assert.equal(h.source('binance').refreshing, true);
  h.connections[0] = descriptor('binance', { revision: 2, identity: 'replacement' });
  assert.equal(h.source('binance').refreshing, false);
  release(); await round;
  assert.equal(h.source('binance').state, 'loading'); assert.deepEqual(h.source('binance').positions, []);
  assert.equal(h.source('okx').state, 'live');
  await h.watch.refresh(); assert.equal(h.source('binance').executionBinding.identity, 'replacement');
  await h.watch.close();
});

test('failures and old risk timestamps never renew source freshness or disclose raw errors', async () => {
  const h = harness(['binance', 'okx']);
  await h.watch.refresh();
  const fetchedAt = h.source('binance').fetchedAt;
  h.advance(60_000);
  h.responses.binance = () => { throw new Error('apiSecret=never-return-this'); };
  await h.watch.refresh();
  assert.equal(h.source('binance').state, 'stale'); assert.equal(h.source('binance').fetchedAt, fetchedAt);
  assert.equal(h.source('binance').positions[0].riskFetchedAt, fetchedAt);
  assert.equal(h.source('binance').positions.length, 1); assert.equal(h.source('okx').state, 'live');
  assert.equal(JSON.stringify(h.watch.state()).includes('never-return-this'), false);
  h.advance(16_000);
  h.responses.binance = binding => h.snapshot('binance', binding, { positions: [position('binance', fetchedAt)] });
  await h.watch.refresh();
  assert.equal(h.source('binance').fetchedAt, h.at()); assert.equal(h.source('binance').state, 'stale');
  h.responses.binance = binding => h.snapshot('binance', binding);
  await h.watch.refresh(); assert.equal(h.source('binance').state, 'live');
  const current = h.source('binance').fetchedAt, calls = h.calls.length;
  h.advance(75_001);
  assert.equal(h.source('binance').state, 'stale'); assert.equal(h.source('binance').fetchedAt, current);
  assert.equal(h.calls.length, calls);
  await h.watch.close();
});

test('an explicit cooldown blocks every refresh until its absolute deadline and a new connection clears it', async () => {
  const h = harness(['rh-lighter', 'okx']);
  const retryAt = h.now() + 180_000;
  h.responses['rh-lighter'] = () => { throw Object.assign(new Error('raw sensitive limit body'), { retryAt }); };
  await h.watch.refresh(); assert.equal(h.source('rh-lighter').state, 'error');
  assert.equal(h.source('okx').state, 'live');
  for (let round = 0; round < 3; round++) { h.advance(30_000); await h.watch.refresh(); }
  assert.equal(h.calls.filter(call => call.exchange === 'rh-lighter').length, 1);
  h.advance(89_999); await h.watch.refresh();
  assert.equal(h.calls.filter(call => call.exchange === 'rh-lighter').length, 1);
  h.responses['rh-lighter'] = null;
  h.advance(1); await h.watch.refresh();
  assert.equal(h.source('rh-lighter').state, 'live');
  h.responses['rh-lighter'] = () => { throw Object.assign(new Error('limited'), { retryAt: h.now() + 600_000 }); };
  await h.watch.refresh();
  const calls = h.calls.filter(call => call.exchange === 'rh-lighter').length;
  h.connections[0] = descriptor('rh-lighter', { revision: 2, accountIndex: 28 });
  h.responses['rh-lighter'] = null;
  await h.watch.refresh();
  assert.equal(h.calls.filter(call => call.exchange === 'rh-lighter').length, calls + 1);
  assert.equal(h.source('rh-lighter').state, 'live'); assert.equal(h.source('rh-lighter').error, null);
  await h.watch.close();
});

test('identity and selected Lighter subaccount must match and unknown identity cannot start a read', async () => {
  const h = harness();
  h.connections[0].identity = null;
  h.responses.okx = binding => h.snapshot('okx', binding, { identity: 'other-account' });
  h.responses['rh-lighter'] = binding => h.snapshot('rh-lighter', binding, { accountIndex: binding.accountIndex + 1 });
  await h.watch.refresh();
  assert.equal(h.calls.some(call => call.exchange === 'binance'), false);
  for (const exchange of ['binance', 'okx', 'rh-lighter']) {
    const source = h.source(exchange);
    assert.equal(source.state, 'error'); assert.deepEqual(source.positions, []); assert.equal(Object.hasOwn(source, 'executionBinding'), false);
  }
  assert.match(h.source('binance').error, /连接待核验/);
  assert.match(h.source('okx').error, /身份或子账户不一致/);
  assert.match(h.source('rh-lighter').error, /身份或子账户不一致/);
  assert.equal(h.source('hyperliquid').state, 'live');
  await h.watch.close();
});

test('known read failure codes expose fixed diagnostics without trusting the upstream message', async () => {
  const h = harness(['binance']);
  for (const [code, reason] of [
    ['position_binding_changed', /执行连接已变化/], ['position_identity', /身份或子账户不一致/],
    ['unsupported_reader', /不支持独立仓位读取/], ['invalid_data', /数据无法核验/], ['timeout', /读取超时/],
  ]) {
    h.responses.binance = () => { throw Object.assign(new Error('apiKey=private-material'), { code }); };
    await h.watch.refresh();
    assert.match(h.source('binance').error, reason);
    assert.equal(JSON.stringify(h.watch.state()).includes('private-material'), false);
  }
  await h.watch.close();
});

test('future or missing source/risk times cannot become fresh and close aborts then waits for in-flight work', async () => {
  const h = harness(['binance', 'okx']);
  h.responses.binance = binding => h.snapshot('binance', binding, { fetchedAt: new Date(h.now() + 2000).toISOString() });
  h.responses.okx = binding => h.snapshot('okx', binding, { positions: [position('okx', null)] });
  await h.watch.refresh();
  assert.equal(h.source('binance').state, 'error'); assert.equal(h.source('okx').state, 'stale');
  h.responses.okx = binding => h.snapshot('okx', binding, { positions: [position('okx', new Date(h.now() + 2000).toISOString())] });
  await h.watch.refresh(); assert.equal(h.source('okx').state, 'stale');
  let release, aborted = false, finished = false;
  const gate = new Promise(resolve => { release = resolve; });
  h.responses.binance = async (binding, { signal }) => { signal.addEventListener('abort', () => { aborted = true; }, { once: true }); await gate; finished = true; return h.snapshot('binance', binding); };
  const round = h.watch.refresh(); await Promise.resolve();
  const closing = h.watch.close();
  assert.equal(aborted, true); assert.equal(finished, false); assert.deepEqual(h.source('okx').positions, []);
  release(); await Promise.all([round, closing]);
  assert.equal(finished, true); assert.deepEqual(h.source('binance').positions, []);
  const calls = h.calls.length; await h.watch.refresh(); assert.equal(h.calls.length, calls);
});
