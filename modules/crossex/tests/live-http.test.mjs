import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { createLiveHttpFixture } from './live-http-fixture.mjs';

const writes = f => f.calls.filter(c => c.method !== 'GET');
async function fixture(t) { const f = await createLiveHttpFixture(); t.after(() => f.close()); return f; }
async function connect(f) { const result = await f.connect(); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
async function preview(f, body = { kind: 'open', signalId: 'fixture-btc' }) {
  const result = await f.request('/api/live/preview', { method: 'POST', body });
  assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data;
}
async function confirm(f, plan, requestId) {
  const result = await f.request('/api/live/confirm', { method: 'POST', body: { previewId: plan.id, requestId } });
  assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data;
}
async function refresh(f) {
  const result = await f.request('/api/live/refresh', { method: 'POST', body: {} });
  assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data;
}

test('real HTTP accepts a within-budget price increase and submits only the reviewed order once', async t => {
  const f = await fixture(t); await connect(f);
  f.remote.fillAfterReads = 1;
  const plan = await preview(f, { kind: 'open', order: { symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', quantity: '0.5', orderType: 'LIMIT', price: '90', timeInForce: 'GTC' } });
  assert.equal(plan.legs[0].notionalUSDT, '49.5'); assert.equal(plan.legs[0].singleLegBudgetUSDT, '100');
  f.remote.depthDelta = 0.01;
  const execution = await confirm(f, plan, 'http-budget-success-01');
  assert.equal(execution.state, 'completed'); assert.equal(writes(f).length, 1);
  assert.equal(writes(f)[0].body.qty, '0.5'); assert.equal(writes(f)[0].body.price, '90');
  assert.equal(writes(f)[0].body.side, 'SELL'); assert.equal(writes(f)[0].body.time_in_force, 'GTC');
  assert.equal((await confirm(f, plan, 'http-budget-success-01')).id, execution.id);
  assert.equal(writes(f).length, 1);
});

test('real HTTP refresh rejects budget or margin excess without any exchange write', async t => {
  for (const scenario of ['budget', 'margin']) {
    const f = await fixture(t);
    if (scenario === 'margin') f.remote.account.available_margin = '18.15';
    await connect(f);
    const plan = await preview(f, { kind: 'open', order: { symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', quantity: scenario === 'budget' ? '1' : '0.5', orderType: 'LIMIT', price: '90', timeInForce: 'GTC' } });
    f.remote.depthDelta = scenario === 'budget' ? 2 : 0.01;
    const result = await f.request('/api/live/confirm', { method: 'POST', body: { previewId: plan.id, requestId: `http-${scenario}-rejection` } });
    assert.equal(result.status, 409);
    assert.match(result.data.error, scenario === 'budget' ? /101 USDT.*100 USDT.*1 USDT/ : /保证金不足/);
    assert.equal(writes(f).length, 0); assert.equal(f.orders.length, 0);
  }
});

test('real HTTP protects manual writes with Basic auth, same origin and CSRF', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/health', { auth: false })).status, 200);
  assert.equal((await f.request('/api/state', { auth: false })).status, 401);
  const initial = await f.request('/api/state');
  assert.equal(initial.status, 200); assert.equal(initial.data.live.connection.connected, false);
  assert.ok(initial.data.csrfToken); assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/api/live/connection', { method: 'PUT', auth: false, body: f.credentials })).status, 401);
  assert.equal((await f.request('/api/live/connection', { method: 'PUT', csrf: false, body: f.credentials })).status, 403);
  assert.equal((await f.request('/api/live/connection', { method: 'PUT', headers: { Origin: 'https://other.invalid' }, body: f.credentials })).status, 403);
  assert.equal((await f.request('/api/live/connection', { method: 'PUT', headers: { 'Sec-Fetch-Site': 'cross-site' }, body: f.credentials })).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/api/live/requests/http-missing-request', { auth: false })).status, 401);
  assert.equal((await f.request('/api/live/requests/http-missing-request')).data.requestStatus, 'not_submitted');
  const connection = await connect(f);
  assert.equal(connection.accountId, '12345'); assert.equal(connection.permissions.read, 'verified');
  assert.equal(connection.permissions.trade, 'unknown'); assert.equal(writes(f).length, 0);
  assert.ok(f.calls.every(call => call.signatureVerified || call.public));
});

test('account bootstrap stays usable when full state fails and never exposes credentials', async t => {
  const f = await fixture(t);
  const original = f.app.market.view;
  f.app.market.view = () => { throw new Error('Unrelated full market state unavailable'); };
  assert.equal((await f.request('/api/state')).status, 500);
  assert.equal((await f.request('/api/bootstrap', { auth: false })).status, 401);
  const initial = await f.request('/api/bootstrap');
  assert.equal(initial.status, 200); assert.equal(initial.data.connection.configured, false);
  assert.equal(initial.data.config.notionalPerLeg, 100); assert.ok(initial.data.csrfToken);
  assert.equal(initial.headers.get('cache-control'), 'no-store'); assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/api/live/connection', { method: 'PUT', csrf: false, body: f.credentials })).status, 403);
  assert.equal((await f.request('/api/live/connection', { method: 'PUT', headers: { Origin: 'https://other.invalid' }, body: f.credentials })).status, 403);
  await connect(f);
  const connected = await f.request('/api/bootstrap');
  assert.equal(connected.status, 200); assert.equal(connected.data.connection.accountId, '12345');
  assert.equal(connected.data.connection.configured, true);
  assert.ok(!JSON.stringify(connected.data).includes(f.credentials.apiKey));
  assert.ok(!JSON.stringify(connected.data).includes(f.credentials.apiSecret));
  assert.equal((await f.request('/api/live/connection', { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await f.request('/api/bootstrap')).data.connection.configured, false);
  assert.equal(writes(f).length, 0);
  f.app.market.view = original;
});

test('light state omits opportunity work without losing the live account or fresh source', async t => {
  const f = await fixture(t);
  const full = await f.request('/api/state'), light = await f.request('/api/state?opportunities=0');
  assert.equal(full.data.opportunities.length, 1); assert.deepEqual(light.data.opportunities, []);
  assert.deepEqual(light.data.live.connection, full.data.live.connection);
  assert.equal(light.data.source.updatedAt, full.data.source.updatedAt);
  assert.deepEqual(light.data.config, full.data.config); assert.equal(light.data.csrfToken, full.data.csrfToken);
});

test('real HTTP preview is read-only, ACKs are polled, duplicate confirmation never writes twice, partial close uses reduce_only', async t => {
  const f = await fixture(t); await connect(f);
  const plan = await preview(f);
  assert.equal(plan.kind, 'open'); assert.equal(plan.legs.length, 2); assert.equal(writes(f).length, 0);
  assert.equal(f.app.store.positions().length, 0); assert.equal(f.app.store.executions().length, 0);
  const execution = await confirm(f, plan, 'http-open-confirm-01');
  assert.equal(execution.state, 'completed'); assert.deepEqual(execution.legs.map(l => l.status), ['FILLED', 'FILLED']);
  assert.equal(writes(f).length, 2); assert.equal(f.orders.length, 2);
  for (const [index, call] of writes(f).entries()) {
    assert.equal(call.method, 'POST'); assert.equal(call.body.reduce_only, 'false');
    assert.equal(call.body.type, 'LIMIT'); assert.equal(call.body.time_in_force, 'IOC');
    assert.equal(typeof call.body.qty, 'string'); assert.equal(typeof call.body.price, 'string');
    assert.equal(call.body.symbol, plan.legs[index].symbol);
    assert.ok(f.calls.filter(c => c.method === 'GET' && c.path.endsWith(`/orders/${execution.legs[index].orderId}`)).length >= 2);
  }
  const duplicate = await confirm(f, plan, 'http-open-confirm-01');
  assert.equal(duplicate.id, execution.id); assert.equal(writes(f).length, 2);
  const requestStatus = await f.request('/api/live/requests/http-open-confirm-01');
  assert.equal(requestStatus.status, 200); assert.equal(requestStatus.data.requestStatus, 'submitted');
  assert.equal(requestStatus.data.result.id, execution.id); assert.equal(writes(f).length, 2);
  const reused = await f.request('/api/live/confirm', { method: 'POST', body: { previewId: plan.id, requestId: 'http-open-confirm-02' } });
  assert.equal(reused.status, 409); assert.equal(reused.data.requestStatus, 'not_submitted'); assert.equal(writes(f).length, 2);
  const opened = await refresh(f), selected = opened.live.positions.find(p => p.side === 'LONG');
  assert.equal(opened.live.positions.length, 2); assert.equal(selected.quantity, plan.legs[0].quantity);
  assert.equal(f.app.store.positions().length, 0); assert.equal(f.app.store.executions().length, 0);
  const closePlan = await preview(f, { kind: 'close', positionId: selected.id, quantity: '0.25' });
  assert.equal(closePlan.legs.length, 1); assert.equal(closePlan.legs[0].reduceOnly, true); assert.equal(writes(f).length, 2);
  const closed = await confirm(f, closePlan, 'http-close-confirm-01');
  assert.equal(closed.state, 'completed'); assert.equal(writes(f).length, 3);
  const closeWrite = writes(f).at(-1).body;
  assert.equal(closeWrite.symbol, selected.symbol); assert.equal(closeWrite.side, 'SELL');
  assert.equal(closeWrite.qty, '0.25'); assert.equal(closeWrite.reduce_only, 'true');
  const after = await refresh(f);
  assert.equal(after.live.positions.find(p => p.id === selected.id).quantity, new Decimal(selected.quantity).minus('0.25').toString());
  assert.equal(after.live.positions.find(p => p.side === 'SHORT').quantity, plan.legs[1].quantity);
});

test('real HTTP cancellation ACK stays pending until remote terminal state and never repeats DELETE', async t => {
  const f = await fixture(t), external = f.addOrder({ time_in_force: 'GTC' }); await connect(f);
  const result = await f.request('/api/live/cancel', { method: 'POST', body: { orderId: external.order_id, requestId: 'http-cancel-confirm-01' } });
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.order.status, 'CANCEL_PENDING');
  assert.equal(external.state, 'OPEN'); assert.equal(writes(f).length, 1); assert.equal(writes(f)[0].method, 'DELETE');
  const pending = await refresh(f);
  assert.equal(pending.live.orders.find(o => o.orderId === external.order_id).status, 'CANCEL_PENDING');
  assert.equal(pending.live.tradingAllowed, false); assert.equal(writes(f).length, 1);
  const duplicate = await f.request('/api/live/cancel', { method: 'POST', body: { orderId: external.order_id, requestId: 'http-cancel-confirm-01' } });
  assert.equal(duplicate.status, 200); assert.equal(writes(f).length, 1);
  external.state = 'CANCELLED'; external.update_time = String(Date.now());
  const terminal = await refresh(f);
  assert.equal(terminal.live.orders.find(o => o.orderId === external.order_id).status, 'CANCELLED');
  assert.equal(terminal.live.tradingAllowed, true); assert.equal(writes(f).length, 1);
});

test('real HTTP lost write response is never resent and reconciliation never sends the other leg', async t => {
  const f = await fixture(t); await connect(f); const plan = await preview(f);
  f.remote.nextCreate = 'unknown';
  const execution = await confirm(f, plan, 'http-unknown-confirm-01');
  assert.equal(execution.state, 'reconciling'); assert.deepEqual(execution.legs.map(l => l.status), ['UNKNOWN', 'UNSENT']);
  assert.equal(writes(f).length, 1); assert.equal(f.orders.length, 1);
  assert.equal((await confirm(f, plan, 'http-unknown-confirm-01')).id, execution.id); assert.equal(writes(f).length, 1);
  f.fill(f.orders[0]);
  const state = await refresh(f), reconciled = state.live.executions.find(e => e.id === execution.id);
  assert.equal(reconciled.state, 'partial'); assert.deepEqual(reconciled.legs.map(l => l.status), ['FILLED', 'UNSENT']);
  assert.equal(state.live.positions.length, 1); assert.equal(state.live.positions[0].quantity, plan.legs[0].quantity);
  await refresh(f); await confirm(f, plan, 'http-unknown-confirm-01');
  assert.equal(writes(f).length, 1); assert.equal(f.orders.length, 1);
});

test('browser fixture seeds optional external positions without connecting or making remote calls', async t => {
  const f = await fixture(t); f.seed();
  assert.equal(f.positions.length, 2); assert.equal(f.calls.length, 0);
  const state = await f.request('/api/state');
  assert.equal(state.data.live.connection.connected, false); assert.equal(state.data.live.positions.length, 0);
  await connect(f); assert.equal((await refresh(f)).live.positions.length, 2); assert.equal(writes(f).length, 0);
  f.seed(false); assert.equal((await refresh(f)).live.positions.length, 0);
});

test('manual HTTP tickets use independent terminal data and genuine order payload types', async t => {
  const f = await fixture(t); await connect(f); f.remote.marketOffline = true;
  assert.equal((await f.request('/api/live/instruments', { auth: false })).status, 401);
  const instruments = await f.request('/api/live/instruments'); assert.equal(instruments.status, 200); assert.equal(instruments.data.items.length, 4);
  const quote = await f.request('/api/live/market?symbol=BINANCE_FUTURE_BTC_USDT&interval=5m');
  assert.equal(quote.status, 200); assert.equal(quote.data.status, 'live'); assert.equal(quote.data.candles.length, 48); assert.equal(quote.data.book.quantityUnit, 'base');
  assert.equal((await f.request('/api/live/market?symbol=http%3A%2F%2Flocalhost')).status, 400); assert.equal(writes(f).length, 0);
  const plan = await preview(f, { kind: 'open', order: { symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', quantity: '0.1', orderType: 'MARKET', timeInForce: 'IOC' } });
  assert.equal(plan.source, 'direct'); assert.ok(new Decimal(plan.risk.requiredMargin).gt(0));
  await confirm(f, plan, 'http-direct-market-01');
  assert.equal(writes(f).length, 1); assert.equal(writes(f)[0].body.type, 'MARKET'); assert.equal(writes(f)[0].body.price, undefined);
});

test('group close submits only selected exact quantities and never opens exposure', async t => {
  const f = await fixture(t); f.seed(); await connect(f);
  const state = await refresh(f), selections = state.live.positions.map(p => ({ positionId: p.id, quantity: '0.5' }));
  const plan = await preview(f, { kind: 'close', positions: selections });
  assert.equal(plan.legs.length, 2); assert.equal(writes(f).length, 0);
  const result = await confirm(f, plan, 'http-group-close-01');
  assert.equal(result.legs.length, 2); assert.equal(writes(f).length, 2);
  assert.ok(writes(f).every(c => c.body.reduce_only === 'true' && c.body.qty === '0.5'));
  const updated = await refresh(f); assert.deepEqual(updated.live.positions.map(p => p.quantity), ['1.5', '1.5']);
});

test('existing external pending orders block all new manual opening while reduce-only close remains available', async t => {
  const f = await fixture(t); f.seed(); f.addOrder({ symbol: 'BINANCE_FUTURE_BTC_USDT', time_in_force: 'GTC' }); await connect(f);
  const opening = await f.request('/api/live/preview', { method: 'POST', body: { kind: 'open', pair: { longSymbol: 'BINANCE_FUTURE_BTC_USDT', shortSymbol: 'BYBIT_FUTURE_BTC_USDT', quantity: '0.1' } } });
  assert.equal(opening.status, 409); assert.equal(writes(f).length, 0);
  const state = await refresh(f); await preview(f, { kind: 'close', positionId: state.live.positions[0].id, quantity: '0.5' });
  assert.equal(writes(f).length, 0);
});
