import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createLiveRuntime } from '../server/live-runtime.mjs';

const epoch = 1791430000000;
const symbols = ['BINANCE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'];
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'crossex-live-'));
  const store = createStore(directory), calls = { create: [], cancel: [], reads: 0, history: [] }, remote = new Map();
  let now = epoch, revision = 'original', rejectCredentials = false, responseMode = 'FILLED', mutate = null, readHook = null, accountHook = null, held = [], open = [];
  let account = { user_id: '123', position_mode: 'DUAL', account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', available_margin: '10000', assets: [{ coin: 'USDT', balance: '1000' }] };
  const client = {
    async getAccount() { calls.reads++; if (accountHook) await accountHook(); if (rejectCredentials) throw new Error('secret should never escape'); return clone(account); },
    async getPositions() { calls.reads++; return clone(held); },
    async getOpenOrders() { calls.reads++; return clone(open.length ? open : [...remote.values()].filter(o => ['NEW', 'OPEN', 'PARTIALLY_FILLED'].includes(o.state))); },
    async getOrder(key) { calls.reads++; if (readHook) readHook(); const result = [...remote.values()].find(o => o.order_id === key || o.text === key); if (!result) throw new Error('TRADE_ORDER_NOT_FOUND_ERROR'); return clone(result); },
    async getHistoryOrders(input) { calls.history.push(input); return clone([...remote.values()].filter(o => ['FILLED', 'CANCELLED', 'FAIL', 'REJECT'].includes(o.state))); },
    async getLeverages(selected) { return Object.fromEntries(selected.map(symbol => [symbol, '10'])); },
    async getRiskLimits(selected) { return selected.map(symbol => ({ symbol, tiers: [{ leverage_max: '100', max_risk_limit_value: '1000000' }] })); },
    async getFees() { return []; }, async getTrades() { return []; }, async getAccountBook() { return []; }, async getAdlRanks() { return []; },
    async createOrder(payload) {
      const intent = store.db.prepare('SELECT state FROM live_orders WHERE text=?').get(payload.text);
      assert.equal(intent?.state, 'SENDING', 'intent must be durable before network write'); calls.create.push(clone(payload));
      if (responseMode === 'TIMEOUT') return new Promise(() => {});
      const row = { ...payload, user_id: account.user_id, order_id: `order-${calls.create.length}`, state: responseMode,
        executed_qty: responseMode === 'FILLED' ? payload.qty : responseMode === 'PARTIALLY_FILLED' ? '0.5' : '0', executed_amount: '100', executed_avg_price: payload.price };
      if (mutate) mutate(row);
      remote.set(row.order_id, row); return { order_id: row.order_id, text: row.text };
    },
    async cancelOrder(key) { calls.cancel.push(key); const row = remote.get(key); return { order_id: row.order_id, text: row.text }; },
  };
  const market = {
    revision: () => revision,
    view: () => ({ now, config: {}, opportunities: [], fx: [] }),
    async previewOpen(signalId) { return { kind: 'open', signalId, base: 'BTC', expiresAt: now + 30000, warnings: [], limits: { maxOpen: 3, maxTotalNotional: '2000', cooldownSeconds: 0 },
      legs: symbols.map((symbol, i) => ({ symbol, exchange: i ? 'bybit' : 'binance', side: i ? 'SELL' : 'BUY', positionSide: i ? 'SHORT' : 'LONG', quantity: '1', price: i ? '101' : '100', quoteCurrency: 'USDT', notionalUSDT: '101' })) }; },
    async revalidateOpen() {},
    async previewClose(p, quantity) { return { kind: 'close', base: p.symbol.split('_')[2], expiresAt: now + 30000, warnings: [], legs: [{ symbol: p.symbol, exchange: 'binance', side: p.position_side === 'LONG' ? 'SELL' : 'BUY', positionSide: p.position_side, quantity: quantity ?? p.position_qty.replace(/^-/, ''), price: '100' }] }; },
    async revalidateClose() {},
  };
  const runtimeOptions = { market, clientFactory: () => client, clock: () => now, requestTimeoutMs: 20, confirmationPollMs: 0, ...options };
  let runtime = createLiveRuntime(store, runtimeOptions);
  t.after(async () => { await runtime.stop(); store.close(); const target = resolve(directory), child = relative(resolve(tmpdir()), target); assert.ok(child && !child.startsWith('..') && !isAbsolute(child) && child.startsWith('crossex-live-')); rmSync(target, { recursive: true, force: true }); });
  return { store, calls, remote, directory, market, client, runtimeOptions,
    get runtime() { return runtime; }, get now() { return now; },
    account(value) { account = { ...account, ...value }; }, positions(value) { held = value; }, orders(value) { open = value; },
    mode(value) { responseMode = value; }, mutate(fn) { mutate = fn; }, onOrderRead(fn) { readHook = fn; }, onAccountRead(fn) { accountHook = fn; }, credentialsFail(value) { rejectCredentials = value; },
    changeConfig() { revision += '-changed'; }, advance(ms) { now += ms; },
    async connect() { return runtime.connection({ apiKey: 'test-api-key-1234', apiSecret: 'test-secret-5678' }); },
    async preview() { return runtime.preview({ kind: 'open', signalId: 'signal-1' }); },
    async confirm(preview, requestId = 'request-test-001') { return runtime.confirm({ previewId: preview.id, requestId }); },
    async reopen() { await runtime.stop(); runtime = createLiveRuntime(store, runtimeOptions); },
  };
}

test('connection encrypts credentials and previews/background reads never write orders', async t => {
  const f = fixture(t); const connection = await f.connect();
  assert.equal(connection.keySuffix, '1234'); assert.equal(connection.permissions.trade, 'unknown');
  const preview = await f.preview(); await f.runtime.refresh();
  assert.equal(preview.expiresAt - preview.createdAt, 30000); assert.equal(preview.canConfirm, true);
  assert.deepEqual(f.calls.create, []); assert.deepEqual(f.calls.cancel, []);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM live_orders').get().n, 0);
  const stored = f.store.db.prepare('SELECT json FROM live_connection').get().json;
  assert.ok(!stored.includes('test-api-key-1234') && !stored.includes('test-secret-5678'));
  assert.ok(!JSON.stringify(f.runtime.view()).includes('test-secret'));
  assert.ok(!readFileSync(join(f.directory, 'crossex.sqlite')).includes(Buffer.from('test-secret-5678')));
});

test('confirmation applies refreshed valuations to total, margin and risk-tier checks before any write', async t => {
  for (const scenario of ['total', 'margin', 'tier']) {
    const f = fixture(t), previewOpen = f.market.previewOpen;
    if (scenario === 'total') f.market.previewOpen = async signal => { const plan = await previewOpen(signal); plan.limits.maxTotalNotional = '205'; return plan; };
    if (scenario === 'margin') f.account({ available_margin: '23' });
    if (scenario === 'tier') f.client.getRiskLimits = async selected => selected.map(symbol => ({ symbol, tiers: [{ leverage_max: '100', max_risk_limit_value: '105' }] }));
    await f.connect(); const preview = await f.preview();
    f.market.revalidateOpen = async plan => { for (const leg of plan.legs) { leg.referencePrice = '110'; leg.notionalUSDT = '110'; } };
    await assert.rejects(f.confirm(preview), { message: scenario === 'total' ? '订单超过账户总名义额上限' : scenario === 'margin' ? '账户可用保证金不足以覆盖订单及 10% 预留' : `${symbols[0]} 超过当前杠杆允许的风险档位名义额` });
    assert.deepEqual(f.calls.create, []); assert.deepEqual(f.calls.cancel, []);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM live_orders').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM live_executions').get().n, 0);
  }
});

test('refreshed valuation below all limits preserves exact orders, saved preview and confirmation idempotency', async t => {
  const f = fixture(t); await f.connect(); const preview = await f.preview();
  const original = f.store.db.prepare('SELECT json FROM live_previews WHERE id=?').get(preview.id).json;
  f.market.revalidateOpen = async plan => { for (const leg of plan.legs) { leg.referencePrice = '110'; leg.notionalUSDT = '110'; } };
  const result = await f.confirm(preview);
  assert.equal(result.state, 'completed'); assert.equal(f.calls.create.length, 2);
  assert.deepEqual(f.calls.create.map(({ qty, price, side }) => ({ qty, price, side })), preview.legs.map(({ quantity, price, side }) => ({ qty: quantity, price, side })));
  assert.equal(f.store.db.prepare('SELECT json FROM live_previews WHERE id=?').get(preview.id).json, original);
  assert.equal((await f.confirm(preview)).id, result.id); assert.equal(f.calls.create.length, 2);
});

test('connection setup and background synchronization do not require the full display view', async t => {
  const f = fixture(t);
  f.market.view = () => { throw new Error('Large market display is unavailable'); };
  assert.equal(f.runtime.connectionView().configured, false);
  assert.equal(await f.runtime.refresh({ includeView: false }), undefined);
  assert.equal((await f.connect()).configured, true);
  assert.equal(await f.runtime.refresh({ includeView: false }), undefined);
  assert.equal(f.runtime.connectionView().accountId, '123');
  assert.equal((await f.runtime.disconnect()).configured, false);
  assert.deepEqual(f.calls.create, []); assert.deepEqual(f.calls.cancel, []);
});

test('one display snapshot reuses its order read across a large execution history', t => {
  const f = fixture(t), db = f.store.db;
  f.store.transaction(() => {
    for (let n = 0; n < 100; n++) {
      const executionId = `history-${n}`;
      db.prepare('INSERT INTO live_executions VALUES (?,?,?,?)').run(executionId, `preview-${n}`, epoch + n, JSON.stringify({ id: executionId, kind: 'open' }));
      for (let index = 0; index < 2; index++) {
        const id = `${executionId}-${index}`, order = { id, executionId, index, version: 1, status: 'FILLED', quantity: '1', executedQty: '1', symbol: symbols[index] };
        db.prepare('INSERT INTO live_orders VALUES (?,?,?,?,?,?,?)').run(id, executionId, id, 1, 'FILLED', epoch + n, JSON.stringify(order));
      }
    }
  });
  const statement = f.store.prepare('SELECT json FROM live_orders ORDER BY updated_at DESC');
  const all = statement.all.bind(statement); let orderReads = 0;
  statement.all = (...args) => { orderReads++; return all(...args); };
  try {
    const state = f.runtime.view();
    assert.equal(state.live.executions.length, 100);
    assert.ok(state.live.executions.every(e => e.state === 'completed' && e.legs.length === 2 && e.legs[0].index === 0));
    assert.equal(orderReads, 1, 'each HTTP snapshot must not reread every order for every execution');
  } finally { statement.all = all; }
});

test('double confirmation is idempotent and each complete fill precedes the next leg', async t => {
  const f = fixture(t); await f.connect(); const preview = await f.preview();
  const [a, b] = await Promise.all([f.confirm(preview), f.confirm(preview)]);
  assert.equal(a.id, b.id); assert.equal(a.state, 'completed'); assert.equal(f.calls.create.length, 2);
  assert.equal(new Set(f.calls.create.map(o => o.text)).size, 2);
  assert.ok(f.calls.create.every(o => o.type === 'LIMIT' && o.time_in_force === 'IOC' && o.reduce_only === 'false'));
  await assert.rejects(f.confirm(preview, 'request-other-002'), /已确认/);
  await assert.rejects(f.runtime.confirm({ previewId: 'another-preview', requestId: 'request-test-001' }), /不同操作/);
});

test('partial first leg leaves real fill visible and never submits or resumes second leg', async t => {
  const f = fixture(t); f.mode('PARTIALLY_FILLED'); await f.connect(); const preview = await f.preview(), result = await f.confirm(preview);
  assert.equal(f.calls.create.length, 1); assert.equal(result.legs[0].executedQty, '0.5'); assert.equal(result.legs[1].status, 'UNSENT');
  await f.reopen(); await f.runtime.refresh();
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.cancel.length, 0);
  assert.equal(f.runtime.view().live.executions[0].legs[0].executedQty, '0.5');
});

test('ACK without fill does not send second leg', async t => {
  const f = fixture(t); f.mode('NEW'); await f.connect(); const result = await f.confirm(await f.preview());
  assert.equal(f.calls.create.length, 1); assert.equal(result.legs[0].status, 'NEW'); assert.equal(result.legs[0].executedQty, '0');
  assert.equal(result.legs[1].status, 'UNSENT');
});

test('timeout plus not-found/history absence remains unknown and cannot resend or rotate keys', async t => {
  const f = fixture(t); f.mode('TIMEOUT'); await f.connect(); const preview = await f.preview();
  const result = await f.confirm(preview); assert.equal(result.state, 'reconciling'); assert.equal(f.calls.create.length, 1);
  await f.runtime.refresh(); await f.reopen(); await f.runtime.refresh();
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.cancel.length, 0);
  assert.equal(f.runtime.view().live.executions[0].legs[0].status, 'UNKNOWN');
  assert.equal(f.runtime.view().live.tradingAllowed, false);
  assert.ok(f.calls.history.every(range => range.from === epoch - 60000 && range.to === epoch));
  await assert.rejects(f.connect(), /活动或未知订单/);
  assert.equal((await f.confirm(preview)).id, result.id);
});

test('manual cancellation stays pending after ACK and open read; background never cancels again', async t => {
  const f = fixture(t); f.mode('OPEN'); await f.connect(); const execution = await f.confirm(await f.preview()), order = execution.legs[0];
  const cancellation = await f.runtime.cancel({ orderId: order.id, requestId: 'cancel-request-01' });
  assert.equal(cancellation.order.status, 'CANCEL_PENDING');
  await f.runtime.refresh(); assert.equal(f.calls.cancel.length, 1);
  assert.equal(f.runtime.view().live.orders.find(o => o.id === order.id).status, 'CANCEL_PENDING');
  await assert.rejects(f.runtime.cancel({ orderId: order.id, requestId: 'cancel-request-02' }), /不能重复撤单/);
  await f.runtime.cancel({ orderId: order.id, requestId: 'cancel-request-01' }); assert.equal(f.calls.cancel.length, 1);
  f.remote.get(order.orderId).state = 'CANCELLED'; await f.runtime.refresh();
  assert.equal(f.runtime.view().live.orders.find(o => o.id === order.id).status, 'CANCELLED');
  assert.equal(f.calls.cancel.length, 1);
});

test('order identity mismatch and overfill freeze confirmation', async t => {
  for (const mutation of [row => { row.symbol = 'GATE_FUTURE_ETH_USDT'; }, row => { row.executed_qty = '2'; }, row => { row.user_id = '999'; }]) {
    const f = fixture(t); f.mutate(mutation); await f.connect(); const result = await f.confirm(await f.preview());
    assert.equal(result.legs[0].status, 'INVALID'); assert.equal(result.legs[0].executedQty, '0'); assert.equal(f.calls.create.length, 1);
    assert.equal(f.runtime.view().live.tradingAllowed, false);
  }
});

test('cumulative fills never regress', async t => {
  const f = fixture(t); f.mode('PARTIALLY_FILLED'); await f.connect(); const result = await f.confirm(await f.preview());
  f.remote.get(result.legs[0].orderId).executed_qty = '0.4'; await f.runtime.refresh();
  const order = f.runtime.view().live.orders.find(o => o.id === result.legs[0].id);
  assert.equal(order.status, 'INVALID'); assert.equal(order.filledQuantity, '0.5');
});

test('restart converts persisted unsent intent to UNSENT and in-flight intent to UNKNOWN', async t => {
  const f = fixture(t); f.mode('OPEN'); await f.connect(); const result = await f.confirm(await f.preview());
  for (const [i, order] of result.legs.entries()) {
    order.status = i ? 'PREPARED' : 'SENDING';
    f.store.db.prepare('UPDATE live_orders SET state=?,json=? WHERE id=?').run(order.status, JSON.stringify(order), order.id);
  }
  await f.reopen();
  const restored = f.runtime.view().live.executions[0];
  assert.deepEqual(restored.legs.map(o => o.status), ['UNKNOWN', 'UNSENT']);
  await f.runtime.refresh(); assert.equal(f.calls.create.length, 1); assert.equal(f.calls.cancel.length, 0);
});

test('failed candidate credentials do not replace working encrypted connection', async t => {
  const f = fixture(t); await f.connect(); const before = f.store.db.prepare('SELECT json FROM live_connection').get().json;
  f.credentialsFail(true); await assert.rejects(f.connect());
  assert.equal(f.store.db.prepare('SELECT json FROM live_connection').get().json, before);
  assert.ok(!JSON.stringify(f.runtime.view()).includes('secret should'));
});

test('preview expires and config or position snapshot changes require a new preview', async t => {
  const f = fixture(t); await f.connect(); const a = await f.preview(); f.advance(30000);
  await assert.rejects(f.confirm(a), /过期/);
  const b = await f.preview(); f.changeConfig(); await assert.rejects(f.confirm(b), /设置已变化/);
  const c = await f.preview(); f.positions([{ user_id: '123', symbol: 'GATE_FUTURE_ETH_USDT', position_side: 'LONG', position_qty: '1', mark_price: '100' }]);
  await assert.rejects(f.confirm(c), /持仓或设置已变化/); assert.equal(f.calls.create.length, 0);
});

test('external positions support partial reduce-only close without Monitor signal', async t => {
  const f = fixture(t); f.positions([{ user_id: '123', symbol: symbols[0], position_side: 'LONG', position_qty: '2', mark_price: '100' }]); await f.connect();
  const selected = f.runtime.view().live.positions[0]; assert.equal(selected.baseQuantity, '2');
  const preview = await f.runtime.preview({ kind: 'close', positionId: selected.id, quantity: '0.25' });
  const result = await f.confirm(preview);
  assert.equal(result.state, 'completed'); assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.create[0].qty, '0.25'); assert.equal(f.calls.create[0].side, 'SELL');
  assert.equal(f.calls.create[0].position_side, 'LONG'); assert.equal(f.calls.create[0].reduce_only, 'true');
});

test('unknown mode fails closed and SINGLE quantity-sign inference remains explicit', async t => {
  const f = fixture(t); f.account({ position_mode: 'UNRECOGNIZED' }); await f.connect();
  await assert.rejects(f.preview(), /持仓模式不明/);
  f.account({ position_mode: 'SINGLE' }); f.positions([{ user_id: '123', symbol: symbols[0], position_side: 'NONE', position_qty: '1', mark_price: '100' }]);
  await f.runtime.refresh();
  const preview = await f.runtime.preview({ kind: 'close', positionId: `${symbols[0]}:NONE` });
  assert.equal(preview.selectedPositionSide, 'LONG'); assert.equal(preview.positions[0].directionSource, 'quantity_sign');
  assert.equal(f.calls.create.length, 0);
});

test('SINGLE inferred direction rejects a conflicting override and keeps close reduce-only', async t => {
  const f = fixture(t); f.account({ position_mode: 'SINGLE' }); f.positions([{ user_id: '123', symbol: symbols[0], position_side: 'NONE', position_qty: '1', mark_price: '100' }]);
  await f.connect(); await assert.rejects(f.runtime.preview({ kind: 'close', positionId: `${symbols[0]}:NONE`, positionSide: 'SHORT' }), /不一致/);
  const preview = await f.runtime.preview({ kind: 'close', positionId: `${symbols[0]}:NONE`, positionSide: 'LONG' });
  assert.equal(preview.selectedPositionSide, 'LONG'); assert.ok(preview.warnings.some(w => w.includes('符号推导')));
  f.mode('REJECT'); await f.confirm(preview);
  assert.equal(f.calls.create[0].position_side, 'NONE'); assert.equal(f.calls.create[0].side, 'SELL'); assert.equal(f.calls.create[0].reduce_only, 'true');
  await f.runtime.refresh(); assert.equal(f.calls.create.length, 1);
});

test('asynchronous acceptance can settle within the same manual confirmation read budget', async t => {
  const f = fixture(t, { confirmationPollMs: 1000, pollIntervalMs: 5 }); f.mode('OPEN');
  f.mutate(row => { setTimeout(() => { row.state = 'FILLED'; row.executed_qty = row.qty; }, 10); });
  await f.connect(); const result = await f.confirm(await f.preview());
  assert.equal(result.state, 'completed'); assert.equal(f.calls.create.length, 2);
});

test('only definite pre-submission errors are labeled not_submitted', async t => {
  const f = fixture(t); await f.connect(); const preview = await f.preview(); f.advance(30000);
  await assert.rejects(f.confirm(preview), error => error.requestStatus === 'not_submitted');
  const next = await f.preview(); f.mode('TIMEOUT'); await f.confirm(next);
  await assert.rejects(f.runtime.confirm({ requestId: 'request-test-001', previewId: 'changed-id' }), error => error.requestStatus === undefined);
});

test('known SINGLE direction closes with NONE and reduce-only', async t => {
  const f = fixture(t); f.account({ position_mode: 'SINGLE' }); f.positions([{ user_id: '123', symbol: symbols[0], position_side: 'SHORT', position_qty: '1', mark_price: '100' }]);
  await f.connect(); const preview = await f.runtime.preview({ kind: 'close', positionId: `${symbols[0]}:SHORT` }); await f.confirm(preview);
  assert.equal(f.calls.create[0].position_side, 'NONE'); assert.equal(f.calls.create[0].side, 'BUY'); assert.equal(f.calls.create[0].reduce_only, 'true');
});

test('another runtime cannot write while the first owns its SQLite lease', async t => {
  const f = fixture(t); await f.connect(); const preview = await f.preview(), follower = createLiveRuntime(f.store, f.runtimeOptions);
  assert.equal(follower.view().live.tradingAllowed, false);
  await assert.rejects(follower.confirm({ previewId: preview.id, requestId: 'follower-confirm-1' }), /另一服务实例/);
  assert.equal(f.calls.create.length, 0); await follower.stop();
  assert.equal(f.runtime.view().live.tradingAllowed, true);
});

test('expired lease makes the process permanently read-only even when no new owner exists', async t => {
  const f = fixture(t); await f.connect(); const preview = await f.preview(); f.advance(61000);
  assert.equal(f.runtime.view().live.tradingAllowed, false);
  await assert.rejects(f.runtime.refresh(), /执行锁已失效/);
  await assert.rejects(f.confirm(preview), /执行锁已失效/); assert.equal(f.calls.create.length, 0);
  f.store.db.prepare('UPDATE live_owner SET expires_at=?').run(f.now + 60000);
  assert.equal(f.runtime.view().live.tradingAllowed, false, 'a late lease extension does not restore authority');
});

test('unknown account mode is observable but cannot submit orders', async t => {
  const f = fixture(t); f.account({ account_mode: null }); await f.connect();
  assert.equal(f.runtime.view().live.connection.connected, true);
  assert.equal(f.runtime.view().live.tradingAllowed, false);
  await assert.rejects(f.preview(), /账户模式不明/); assert.equal(f.calls.create.length, 0);
});

test('slow order reconciliation cannot make an older account snapshot look fresh', async t => {
  const f = fixture(t); f.mode('OPEN'); await f.connect(); const execution = await f.confirm(await f.preview());
  const order = f.remote.get(execution.legs[0].orderId); order.state = 'FILLED'; order.executed_qty = order.qty;
  f.onOrderRead(() => f.advance(16000)); await f.runtime.refresh();
  assert.equal(f.runtime.view().live.asOf, epoch); assert.equal(f.runtime.view().live.stale, true);
  assert.equal(f.runtime.view().live.tradingAllowed, false);
});

test('normal zero-base-quantity spot buy orders do not prevent read-only account synchronization', async t => {
  const f = fixture(t); f.orders([{ user_id: '123', order_id: 'spot-1', text: '', symbol: 'BINANCE_SPOT_BTC_USDT', qty: '0', executed_qty: '0', state: 'OPEN', side: 'BUY' }]);
  await f.connect(); assert.equal(f.runtime.view().live.connection.connected, true);
  assert.equal(f.runtime.view().live.orders[0].quantity, '0'); assert.equal(f.calls.create.length, 0);
});

test('hub summary has the standard health/metrics contract and does not evaluate market candidates', async t => {
  const f = fixture(t);
  assert.equal(f.runtime.summary().health.state, 'offline'); assert.equal(f.runtime.summary().updatedAt, null);
  await f.connect(); f.market.view = () => { throw new Error('summary must not evaluate market data'); };
  const summary = f.runtime.summary(); assert.equal(summary.health.state, 'online'); assert.ok(Array.isArray(summary.metrics));
  assert.equal(summary.health.staleAfterSeconds, 15); assert.equal(summary.updatedAt, new Date(epoch).toISOString());
  f.advance(16000); assert.equal(f.runtime.summary().health.state, 'stale');
  assert.equal(f.runtime.summary().updatedAt, new Date(epoch).toISOString());
});

test('changing settings while the first leg settles prevents the second leg from being sent', async t => {
  const f = fixture(t, { confirmationPollMs: 1000, pollIntervalMs: 5 }); f.mode('OPEN');
  f.mutate(row => { setTimeout(() => { f.changeConfig(); row.state = 'FILLED'; row.executed_qty = row.qty; }, 10); });
  await f.connect(); const result = await f.confirm(await f.preview());
  assert.equal(f.calls.create.length, 1); assert.equal(result.state, 'partial');
  assert.equal(result.legs[0].status, 'FILLED'); assert.equal(result.legs[1].status, 'UNSENT');
  assert.match(result.legs[1].error, /设置\/连接已变化/);
  await f.runtime.refresh(); assert.equal(f.calls.create.length, 1);
});

test('manual confirmations immediately refresh actual positions after complete or partial fills', async t => {
  for (const state of ['FILLED', 'PARTIALLY_FILLED']) {
    const f = fixture(t); f.mode(state);
    f.mutate(row => f.positions(f.calls.create.map((payload, i) => ({ user_id: '123', position_id: `position-${i}`, symbol: payload.symbol,
      position_side: payload.position_side, position_qty: state === 'FILLED' ? payload.qty : row.executed_qty, mark_price: payload.price }))));
    await f.connect(); const result = await f.confirm(await f.preview());
    const positions = f.runtime.view().live.positions;
    assert.equal(positions.length, state === 'FILLED' ? 2 : 1);
    assert.equal(positions[0].quantity, state === 'FILLED' ? '1' : '0.5');
    assert.equal(result.legs[0].executedQty, positions[0].quantity);
  }
});

test('a failed post-confirm account read preserves recorded fills and flags cached positions', async t => {
  const f = fixture(t); await f.connect(); const preview = await f.preview();
  f.mutate(() => f.credentialsFail(true)); const result = await f.confirm(preview);
  assert.equal(result.state, 'completed'); assert.equal(f.calls.create.length, 2);
  assert.ok(f.runtime.view().live.connection.error); assert.equal(f.runtime.view().live.tradingAllowed, false);
  assert.equal((await f.confirm(preview)).id, result.id);
});

test('post-confirm reads use a small bounded allowance and never delay durable execution indefinitely', async t => {
  const f = fixture(t, { postConfirmRefreshMs: 10 }); await f.connect(); const preview = await f.preview();
  f.onAccountRead(() => f.calls.create.length ? new Promise(() => {}) : undefined);
  const result = await f.confirm(preview);
  assert.equal(result.state, 'completed'); assert.equal(f.calls.create.length, 2);
  assert.ok(f.runtime.view().live.connection.error);
});

test('request status waits for preflight completion and reports a known non-submission without writes', async t => {
  const f = fixture(t, { requestTimeoutMs: 1000 }); await f.connect(); const preview = await f.preview();
  let release, settled = false;
  f.market.revalidateOpen = () => new Promise((_, reject) => { release = () => reject(new Error('read validation failed')); });
  const confirmation = f.confirm(preview); const rejected = assert.rejects(confirmation);
  await new Promise(setImmediate); assert.equal(typeof release, 'function');
  const lookup = f.runtime.requestStatus('request-test-001').then(value => { settled = true; return value; });
  await new Promise(setImmediate); assert.equal(settled, false);
  release(); await rejected;
  assert.deepEqual(await lookup, { requestId: 'request-test-001', requestStatus: 'not_submitted' });
  assert.equal(f.calls.create.length, 0); assert.equal(f.calls.cancel.length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM live_requests').get().n, 0);
});

test('request status recovers persisted confirmation and cancel results without exchange writes', async t => {
  const f = fixture(t); f.mode('OPEN'); await f.connect(); const result = await f.confirm(await f.preview());
  const confirmation = await f.runtime.requestStatus('request-test-001');
  assert.equal(confirmation.requestStatus, 'submitted'); assert.equal(confirmation.kind, 'confirm'); assert.equal(confirmation.result.id, result.id);
  await f.runtime.cancel({ orderId: result.legs[0].id, requestId: 'request-cancel-001' });
  const cancellation = await f.runtime.requestStatus('request-cancel-001');
  assert.equal(cancellation.requestStatus, 'submitted'); assert.equal(cancellation.kind, 'cancel'); assert.equal(cancellation.result.order.status, 'CANCEL_PENDING');
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.cancel.length, 1);
});

test('a follower cannot claim that another process has not submitted a request', async t => {
  const f = fixture(t); await f.connect(); const follower = createLiveRuntime(f.store, f.runtimeOptions);
  try { await assert.rejects(follower.requestStatus('missing-request-1'), /执行锁已失效/); }
  finally { await follower.stop(); }
});

test('UID-less account snapshots and sparse final order descriptors remain usable', async t => {
  const f = fixture(t); f.account({ user_id: undefined });
  f.mutate(row => { for (const key of ['user_id', 'position_side', 'reduce_only', 'time_in_force', 'price']) delete row[key]; });
  await f.connect(); assert.equal(f.runtime.view().live.connection.accountId, null);
  const result = await f.confirm(await f.preview());
  assert.equal(result.state, 'completed'); assert.equal(f.calls.create.length, 2);
  const stored = JSON.parse(f.store.db.prepare('SELECT json FROM live_connection').get().json);
  assert.equal(typeof stored.accountReference, 'string'); assert.equal(stored.accountReference.length, 64);
  assert.ok(!JSON.stringify(f.runtime.view()).includes(stored.accountReference));
});

test('optional account detail UID is checked and later snapshots cannot mix account identities', async t => {
  const f = fixture(t); f.client.getAccountDetail = async () => ({ user_id: 456 });
  await assert.rejects(f.connect(), /账户验证/); assert.equal(f.runtime.view().live.connection.connected, false);
  f.account({ user_id: undefined }); delete f.client.getAccountDetail; await f.connect();
  f.account({ user_id: '123' }); f.positions([{ user_id: '456', symbol: symbols[0], position_side: 'LONG', position_qty: '1' }]);
  await f.runtime.refresh(); assert.equal(f.runtime.view().live.tradingAllowed, false);
  assert.ok(f.runtime.view().live.connection.error); assert.equal(f.calls.create.length, 0);
});

test('native position amounts and negative SINGLE direction map without fabricated zeroes', async t => {
  const f = fixture(t); f.account({ position_mode: 'SINGLE' });
  f.positions([{ position_id: 'signed-short', symbol: symbols[0], position_side: 'NONE', position_qty: '-2', avg_price: '99', mark_price: '100',
    position_value: '-200', upnl: '-2', upnl_rate: '-0.01', initial_margin: '20', maintenance_margin: '3', leverage: '10', max_leverage: '100',
    risk_limit: '100000', fee: '-0.2', funding_fee: '0.4', funding_time: epoch - 1000, closed_pnl: '7', liq_price: '120', update_time: epoch - 10 }]);
  f.client.getAdlRanks = async () => [{ symbol: symbols[0], crossex_adl_rank: 2, exchange_adl_rank: 3 }];
  await f.connect(); await f.runtime.refreshDetails();
  const p = f.runtime.view().live.positions[0];
  assert.equal(p.side, 'SHORT'); assert.equal(p.directionSource, 'quantity_sign'); assert.equal(p.signedQuantity, '-2'); assert.equal(p.quantity, '2');
  assert.equal(p.entryPrice, '99'); assert.equal(p.notional, '200'); assert.equal(p.positionValue, '-200'); assert.equal(p.unrealizedPnlRate, '-0.01');
  assert.equal(p.maintenanceMargin, '3'); assert.equal(p.fundingFee, '0.4'); assert.equal(p.realizedPnl, '7'); assert.equal(p.crossExAdlRank, 2); assert.equal(p.sourceAt, epoch - 10);
  const preview = await f.runtime.preview({ kind: 'close', positionId: p.id, quantity: '0.25' });
  await f.confirm(preview); assert.equal(f.calls.create[0].side, 'BUY'); assert.equal(f.calls.create[0].position_side, 'NONE');
  f.positions([{ position_id: 'sparse', symbol: symbols[0], position_side: 'NONE', position_qty: '-1' }]); await f.runtime.refresh();
  const sparse = f.runtime.view().live.positions[0]; assert.equal(sparse.unrealizedPnl, null); assert.equal(sparse.notional, null); assert.equal(sparse.liquidationPrice, null);
});

test('supplemental records deduplicate, preserve known details, survive restart and isolate connection versions', async t => {
  const f = fixture(t);
  const trade = { transaction_id: 'trade-1', order_id: 'external-1', symbol: symbols[0], side: 'BUY', qty: '1', price: '100', create_time: epoch, fee: '0.05', fee_currency: 'USDT' };
  let trades = [trade, trade], entries = [{ id: 'entry-1', coin: 'USDT', change: '-0.05', create_time: epoch }];
  f.client.getTrades = async () => clone(trades); f.client.getAccountBook = async () => clone(entries);
  await f.connect(); await f.runtime.refreshDetails();
  trades = [{ ...trade, fee: null, fee_currency: undefined }]; await f.runtime.refreshDetails();
  let live = f.runtime.view().live; assert.equal(live.recentTrades.length, 1); assert.equal(live.recentTrades[0].fee, '0.05'); assert.equal(live.accountBook.length, 1);
  assert.equal(live.recentTradesAsOf, epoch); await f.reopen(); assert.equal(f.runtime.view().live.recentTrades[0].fee, '0.05');
  trades = [{ ...trade, qty: '2' }]; await f.runtime.refreshDetails(); live = f.runtime.view().live;
  assert.ok(live.recentTradesError); assert.equal(live.recentTrades[0].qty, '1'); assert.equal(live.tradingAllowed, true);
  trades = []; entries = []; await f.connect(); await f.runtime.refreshDetails();
  assert.equal(f.runtime.view().live.recentTrades.length, 0); assert.equal(f.runtime.view().live.accountBook.length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM live_trades').get().n, 1);
  assert.deepEqual(f.calls.create, []); assert.deepEqual(f.calls.cancel, []);
});

test('supplemental failures remain independent and cannot block a verified reduce-only close', async t => {
  const f = fixture(t); f.positions([{ position_id: 'closeable', symbol: symbols[0], position_side: 'LONG', position_qty: '1', mark_price: '100' }]);
  for (const method of ['getTrades', 'getAccountBook', 'getFees', 'getAdlRanks', 'getLeverages', 'getRiskLimits']) f.client[method] = async () => { throw new Error('unavailable'); };
  await f.connect(); await f.runtime.refreshDetails();
  const live = f.runtime.view().live; assert.ok(live.feesError); assert.ok(live.recentTradesError); assert.ok(live.accountBookError); assert.equal(live.tradingAllowed, true);
  const preview = await f.runtime.preview({ kind: 'close', positionId: 'closeable' }); assert.equal(preview.risk, null);
  assert.equal((await f.confirm(preview)).state, 'completed'); assert.equal(f.calls.create[0].reduce_only, 'true');
});

test('new opens require leverage, eligible risk tiers and sufficient reserved margin', async t => {
  for (const scenario of ['leverage', 'tier', 'margin', 'missing-margin']) {
    const f = fixture(t);
    if (scenario === 'leverage') f.client.getLeverages = async () => ({});
    if (scenario === 'tier') f.client.getRiskLimits = async selected => selected.map(symbol => ({ symbol, tiers: [{ leverage_max: '5', max_risk_limit_value: '1000000' }] }));
    if (scenario === 'margin') f.account({ available_margin: '22.21' });
    if (scenario === 'missing-margin') f.account({ available_margin: undefined });
    await f.connect(); await assert.rejects(f.preview(), /杠杆|保证金|风险档位/); assert.equal(f.calls.create.length, 0);
  }
  const f = fixture(t); await f.connect(); const preview = await f.preview();
  assert.equal(preview.risk.requiredMargin, '22.22'); assert.equal(preview.risk.reserveFactor, '1.10');
  f.client.getLeverages = async selected => Object.fromEntries(selected.map(symbol => [symbol, '5']));
  await assert.rejects(f.confirm(preview), /杠杆已变化/); assert.equal(f.calls.create.length, 0);
});

test('isolated accounts must cover each venue requirement independently', async t => {
  const f = fixture(t); let bybitMargin = '1'; const venues = [];
  f.client.getAccount = async venue => { venues.push(venue); return { user_id: '123', position_mode: 'DUAL', account_mode: 'ISOLATED_EXCHANGE',
    exchange_type: venue || 'BINANCE', available_margin: venue === 'BYBIT' ? bybitMargin : '10000', assets: [] }; };
  await f.connect(); await assert.rejects(f.preview(), /BYBIT.*保证金不足/); assert.equal(f.calls.create.length, 0);
  bybitMargin = '100'; const preview = await f.preview();
  assert.deepEqual(preview.risk.accounts.map(a => a.exchangeType).sort(), ['BINANCE', 'BYBIT']); assert.ok(venues.includes('BYBIT'));
  bybitMargin = '1'; await assert.rejects(f.confirm(preview), /BYBIT.*保证金不足/); assert.equal(f.calls.create.length, 0);
});

test('risk-tier valuation cannot shrink to a lower SELL protection price', async t => {
  const f = fixture(t), original = f.market.previewOpen;
  f.market.previewOpen = async () => { const plan = await original(); plan.legs[1].price = '90'; plan.legs[1].referencePrice = '101'; return plan; };
  f.client.getRiskLimits = async selected => selected.map(symbol => ({ symbol, tiers: [{ leverage_max: '100', max_risk_limit_value: '100' }] }));
  await f.connect(); await assert.rejects(f.preview(), /风险档位名义额/); assert.equal(f.calls.create.length, 0);
});

test('USDC isolated margin uses converted USDT cost while risk limits retain native quote units', async t => {
  const f = fixture(t), symbol = 'BYBIT_FUTURE_BTC_USDC'; let available = '12';
  f.client.getAccount = async () => ({ user_id: '123', position_mode: 'DUAL', account_mode: 'ISOLATED_EXCHANGE', exchange_type: 'BYBIT', available_margin: available, assets: [] });
  f.market.previewDirect = async () => ({ kind: 'open', base: 'BTC', expiresAt: f.now + 30000, limits: { maxOpen: 3, maxTotalNotional: '2000', cooldownSeconds: 0 },
    legs: [{ symbol, exchange: 'bybit', side: 'BUY', positionSide: 'LONG', quantity: '1', price: '100', referencePrice: '100', quoteCurrency: 'USDC', notionalUSDT: '120' }] });
  f.client.getRiskLimits = async () => [{ symbol, tiers: [{ leverage_max: '100', max_risk_limit_value: '105' }] }];
  await f.connect(); await assert.rejects(f.runtime.preview({ kind: 'open', order: { symbol } }), /保证金不足/);
  available = '13.2'; const preview = await f.runtime.preview({ kind: 'open', order: { symbol } });
  assert.equal(preview.risk.marginCurrency, 'USDT'); assert.equal(preview.risk.requiredMargin, '13.2');
  assert.equal(preview.risk.legs[0].projectedNotional, '100'); assert.equal(preview.risk.legs[0].quoteCurrency, 'USDC');
  assert.equal(f.calls.create.length, 0);
});

test('an unrelated active order blocks opening but permits a different-contract close', async t => {
  const f = fixture(t); f.orders([{ order_id: 'external-eth', text: '', symbol: 'GATE_FUTURE_ETH_USDT', qty: '1', executed_qty: '0', state: 'OPEN', side: 'BUY' }]);
  f.positions([{ position_id: 'held-btc', symbol: symbols[0], position_side: 'LONG', position_qty: '1', mark_price: '100' }]);
  await f.connect(); await assert.rejects(f.preview(), /活动委托/);
  const preview = await f.runtime.preview({ kind: 'close', positionId: 'held-btc' }); assert.equal(preview.canConfirm, true);
  assert.equal(f.calls.create.length, 0);
  f.orders([{ order_id: 'unknown-order', text: '', symbol: 'GATE_FUTURE_ETH_USDT', qty: '1', executed_qty: '0', state: 'UNRECOGNIZED', side: 'BUY' }]);
  await f.runtime.refresh(); assert.equal(f.runtime.view().live.tradingAllowed, false);
  await assert.rejects(f.runtime.preview({ kind: 'close', positionId: 'held-btc' }), /未知/);
});

test('manual LIMIT/GTC and MARKET orders preserve their execution contracts', async t => {
  for (const orderType of ['LIMIT', 'MARKET']) {
    const f = fixture(t); let received;
    f.market.previewDirect = async input => { received = input; const plan = await f.market.previewOpen(); return { ...plan, legs: [{ ...plan.legs[0], orderType, timeInForce: orderType === 'LIMIT' ? 'GTC' : 'IOC' }] }; };
    await f.connect(); const preview = await f.runtime.preview({ kind: 'open', order: { symbol: symbols[0], orderType, quantity: '1' } });
    assert.equal(received.orderType, orderType); assert.equal(preview.legs[0].orderType, orderType);
    assert.equal((await f.confirm(preview)).state, 'completed'); const payload = f.calls.create[0];
    assert.equal(payload.type, orderType); assert.equal(payload.time_in_force, orderType === 'LIMIT' ? 'GTC' : 'IOC');
    assert.equal(Object.hasOwn(payload, 'price'), orderType === 'LIMIT'); assert.equal(f.calls.create.length, 1);
  }
});

test('manual pair previews dispatch explicitly and retain guarded IOC sequential opens', async t => {
  const f = fixture(t); let received;
  f.market.previewPair = async input => { received = input; return f.market.previewOpen(); };
  await f.connect(); const pair = { base: 'BTC', longSymbol: symbols[0], shortSymbol: symbols[1], quantity: '1' };
  const preview = await f.runtime.preview({ kind: 'open', pair }); assert.deepEqual(received, pair);
  assert.equal((await f.confirm(preview)).state, 'completed'); assert.equal(f.calls.create.length, 2);
  assert.ok(f.calls.create.every(o => o.type === 'LIMIT' && o.time_in_force === 'IOC'));
  await assert.rejects(f.runtime.preview({ kind: 'open', pair, signalId: 'signal-1' }), /一种开仓方式/);
});

test('group close sends each selected reduce-only leg once despite earlier partial fill', async t => {
  const f = fixture(t); f.positions(symbols.map((symbol, i) => ({ position_id: `held-${i}`, symbol, position_side: i ? 'SHORT' : 'LONG', position_qty: '2', mark_price: '100' })));
  f.mode('PARTIALLY_FILLED'); await f.connect();
  const preview = await f.runtime.preview({ kind: 'close', positions: [{ positionId: 'held-0', quantity: '1' }, { positionId: 'held-1', quantity: '1' }] });
  const result = await f.confirm(preview); assert.equal(f.calls.create.length, 2); assert.equal(result.legs.length, 2);
  assert.deepEqual(f.calls.create.map(o => o.side), ['SELL', 'BUY']); assert.ok(f.calls.create.every(o => o.reduce_only === 'true'));
  assert.ok(result.legs.every(o => o.status === 'PARTIALLY_FILLED' && o.executedQty === '0.5'));
  await f.runtime.refresh(); await f.reopen(); await f.runtime.refresh(); assert.equal(f.calls.create.length, 2); assert.equal(f.calls.cancel.length, 0);
});

test('group close rejects duplicate, oversized, mixed-asset or over-position requests', async t => {
  const f = fixture(t); f.positions([{ position_id: 'btc', symbol: symbols[0], position_side: 'LONG', position_qty: '1', mark_price: '100' },
    { position_id: 'eth', symbol: 'GATE_FUTURE_ETH_USDT', position_side: 'SHORT', position_qty: '1', mark_price: '100' }]);
  await f.connect();
  await assert.rejects(f.runtime.preview({ kind: 'close', positions: [{ positionId: 'btc' }, { positionId: 'btc' }] }), /不同的真实持仓/);
  await assert.rejects(f.runtime.preview({ kind: 'close', positions: Array.from({ length: 17 }, (_, i) => ({ positionId: `held-${i}` })) }), /1–16/);
  await assert.rejects(f.runtime.preview({ kind: 'close', positions: [{ positionId: 'btc' }, { positionId: 'eth' }] }), /同一基础资产/);
  await assert.rejects(f.runtime.preview({ kind: 'close', positions: [{ positionId: 'btc', quantity: '1.01' }] }), /不能越过零/);
  assert.equal(f.calls.create.length, 0);
});

test('external cancellation retains descriptors and accepts its matching terminal response', async t => {
  const f = fixture(t); const raw = { order_id: 'external-limit', text: '', symbol: symbols[0], type: 'LIMIT', time_in_force: 'GTC', side: 'BUY',
    position_side: 'LONG', qty: '1', price: '100', executed_qty: '0', state: 'OPEN', reduce_only: false };
  f.orders([raw]); f.client.cancelOrder = async key => { f.calls.cancel.push(key); return { ...raw, state: 'CANCELLED' }; };
  await f.connect(); const result = await f.runtime.cancel({ orderId: raw.order_id, requestId: 'external-cancel-001' });
  assert.equal(result.order.status, 'CANCELLED'); assert.equal(result.order.orderType, 'LIMIT'); assert.equal(result.order.timeInForce, 'GTC');
  assert.equal(f.calls.cancel.length, 1); assert.equal(f.calls.create.length, 0);
});

test('workspace update readiness blocks queued work and unsettled orders but permits ordinary positions', async t => {
  const f = fixture(t);
  await f.connect();
  f.positions([{ symbol: symbols[0], position_side: 'LONG', position_qty: '1', user_id: '123' }]);
  await f.runtime.refresh();
  assert.deepEqual(f.runtime.updateStatus(), { busy: false });
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.onAccountRead(async () => { started(); await gate; });
  const pending = f.runtime.refresh();
  await ready;
  assert.equal(f.runtime.updateStatus().busy, true);
  release(); await pending;
  assert.deepEqual(f.runtime.updateStatus(), { busy: false });
  f.orders([{ symbol: symbols[0], order_id: 'exchange-open', state: 'OPEN', qty: '1', executed_qty: '0', user_id: '123' }]);
  await f.runtime.refresh();
  assert.equal(f.runtime.updateStatus().busy, true);
  f.orders([]); await f.runtime.refresh();
  assert.deepEqual(f.runtime.updateStatus(), { busy: false });
});

test('workspace update readiness rejects failed account or order reads until a complete refresh succeeds', async t => {
  for (const method of ['getAccount', 'getOpenOrders']) {
    const f = fixture(t);
    await f.connect();
    assert.deepEqual(f.runtime.updateStatus(), { busy: false });
    const original = f.client[method];
    f.client[method] = async () => { throw new Error('upstream read failed'); };
    await f.runtime.refresh();
    assert.ok(f.runtime.view().live.connection.error);
    assert.equal(f.runtime.view().live.orders.length, 0, 'last known empty orders cannot establish current safety');
    assert.equal(f.runtime.updateStatus().busy, true, method);
    f.client[method] = original;
    await f.runtime.refresh();
    assert.deepEqual(f.runtime.updateStatus(), { busy: false });
  }
});

test('workspace update readiness rejects stale, future, mismatched and incomplete connected snapshots', async t => {
  const f = fixture(t);
  assert.deepEqual(f.runtime.updateStatus(), { busy: false }, 'an unconfigured account needs no exchange snapshot');
  await f.connect();
  f.advance(20000);
  assert.equal(f.runtime.updateStatus().busy, true, 'the prior empty order snapshot is stale');
  await f.runtime.refresh();
  assert.deepEqual(f.runtime.updateStatus(), { busy: false });
  const saved = JSON.parse(f.store.prepare('SELECT json FROM live_cache WHERE singleton=1').get().json);
  for (const patch of [{ asOf: f.now + 1001 }, { asOf: null }, { version: saved.version + 1 }, { account: { ...saved.account, position_mode: 'UNKNOWN' } }, { account: { ...saved.account, account_mode: 'UNKNOWN' } }]) {
    f.store.prepare('UPDATE live_cache SET json=? WHERE singleton=1').run(JSON.stringify({ ...saved, ...patch }));
    assert.equal(f.runtime.updateStatus().busy, true, JSON.stringify(patch));
  }
  await f.runtime.refresh();
  assert.deepEqual(f.runtime.updateStatus(), { busy: false });
  await f.runtime.disconnect(); f.advance(20000);
  assert.deepEqual(f.runtime.updateStatus(), { busy: false }, 'an explicitly disconnected account does not require fresh private reads');
});

test('workspace update readiness cannot be authorized by a follower or expired execution lease', async t => {
  const f = fixture(t);
  await f.connect();
  const follower = createLiveRuntime(f.store, f.runtimeOptions);
  try { assert.equal(follower.updateStatus().busy, true); }
  finally { await follower.stop(); }
  assert.deepEqual(f.runtime.updateStatus(), { busy: false });
  f.store.prepare('UPDATE live_owner SET expires_at=? WHERE singleton=1').run(f.now - 1);
  assert.equal(f.runtime.updateStatus().busy, true, 'fresh data does not replace execution ownership');
  f.store.prepare('UPDATE live_owner SET expires_at=? WHERE singleton=1').run(f.now + 60000);
  assert.equal(f.runtime.updateStatus().busy, true, 'a lost lease remains invalid after a late extension');
});
