import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createMarket } from '../server/market.mjs';
import { createLiveRuntime } from '../server/live-runtime.mjs';
import { D } from '../server/money.mjs';
import { epoch, quote, book, catalog } from './fixtures.mjs';

const symbols = catalog.map(r => r.symbol), clone = value => structuredClone(value);
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'crossex-position-actions-')), store = createStore(directory);
  let now = epoch, mode = options.mode || 'DUAL', response = 'FILLED', depthOverride = null, identityOverride = null;
  let positions = (options.quantities || ['1', '1']).map((quantity, i) => ({ position_id: `position-${i}`, symbol: symbols[i],
    position_side: mode === 'SINGLE' ? 'NONE' : i ? 'SHORT' : 'LONG', position_qty: mode === 'SINGLE' && i ? D(quantity).negated().toString() : quantity,
    mark_price: '100', contract_size: '0.001', user_id: '123' }));
  let rules = catalog.map(r => ({ ...r, max_limit_size: '10000' }));
  const account = { user_id: '123', position_mode: mode, account_mode: 'CROSS_EXCHANGE', available_margin: '10000' }, orders = [], calls = [], remote = new Map();
  const market = createMarket(store, { clock: () => now, catalogReader: async () => rules, fxReader: options.fxReader,
    feedReader: async () => { throw new Error('Monitor unavailable'); },
    identityReader: async symbol => {
      const exchange = symbol.split('_')[0].toLowerCase();
      return identityOverride ? identityOverride(symbol) : quote(exchange, now, { symbol: 'BTCUSDT', rawBase: 'BTC', settlementCurrency: 'USDT',
        collateralCurrency: 'USDT', counterCurrency: 'USDT', contractKind: 'linear', crossexSymbol: symbol, identityScope: 'manual',
        nativeUnit: '0.001', identitySource: 'exchange-instrument-metadata', comparable: true });
    }, depthReader: async q => depthOverride ? depthOverride(q) : book(q, now) });
  market.settings({ config: { maxOpen: 1, cooldownSeconds: 10, ...options.config } });
  const client = {
    async getAccount(venue) { return clone(venue ? { ...account, exchange_type: venue } : account); },
    async getPositions() { return clone(positions); }, async getOpenOrders() { return clone(orders); },
    async getLeverages(selected) { return Object.fromEntries(selected.map(s => [s, '10'])); },
    async getRiskLimits(selected) { return selected.map(symbol => ({ symbol, tiers: [{ leverage_max: '100', max_risk_limit_value: '1000000' }] })); },
    async getFees() { return []; }, async getTrades() { return []; }, async getAccountBook() { return []; }, async getAdlRanks() { return []; },
    async getOrder(key) { const result = [...remote.values()].find(o => o.order_id === key || o.text === key); if (!result) throw new Error('missing'); return clone(result); },
    async getHistoryOrders() { return clone([...remote.values()]); },
    async createOrder(payload) {
      assert.equal(store.prepare('SELECT state FROM live_orders WHERE text=?').get(payload.text)?.state, 'SENDING');
      calls.push(clone(payload));
      if (response === 'UNKNOWN') return new Promise(() => {});
      const result = { ...payload, order_id: `order-${calls.length}`, user_id: '123', state: response,
        executed_qty: response === 'FILLED' ? payload.qty : response === 'PARTIALLY_FILLED' ? D(payload.qty).div(2).toString() : '0' };
      remote.set(result.order_id, result);
      return result;
    },
  };
  const runtime = createLiveRuntime(store, { market, clientFactory: () => client, clock: () => now, requestTimeoutMs: 100,
    confirmationPollMs: 0, postConfirmRefreshMs: 0, ownerLeaseMs: 600000 });
  t.after(async () => { await runtime.stop(); await market.stop(); store.close(); const target = resolve(directory), child = relative(resolve(tmpdir()), target);
    assert.ok(child && child.startsWith('crossex-position-actions-') && !child.startsWith('..') && !isAbsolute(child)); rmSync(target, { recursive: true, force: true }); });
  const input = (action = 'add', extra = {}) => ({ kind: 'position', action, connectionVersion: runtime.connectionView().version,
    positions: positions.slice(0, 2).map((p, i) => ({ positionId: p.position_id, expectedQuantity: D(p.position_qty).abs().toString(),
      expectedSide: p.position_side === 'NONE' ? D(p.position_qty).gt(0) ? 'LONG' : 'SHORT' : p.position_side || (i ? 'SHORT' : 'LONG') })),
    ...(action === 'add' ? { quantity: '0.5' } : { strategy: 'reduce' }), ...extra });
  return { store, market, runtime, client, account, calls, orders, remote, input,
    get positions() { return positions; }, setPositions(value) { positions = value; }, setResponse(value) { response = value; },
    depth(value) { depthOverride = value; }, identity(value) { identityOverride = value; },
    rules(value) { rules = value; store.set('catalog', { at: 0, items: value }); }, advance(ms) { now += ms; },
    connect: () => runtime.connection({ apiKey: 'test-api-key-1234', apiSecret: 'test-api-secret-5678' }),
    preview: (action, extra) => runtime.preview(input(action, extra)),
    confirm: (preview, requestId = 'position-action-001') => runtime.confirm({ previewId: preview.id, requestId }) };
}

test('equal real positions can add at maxOpen with exact base quantities in DUAL and SINGLE modes', async t => {
  for (const mode of ['DUAL', 'SINGLE']) {
    const f = fixture(t, { mode }); await f.connect();
    const preview = await f.preview();
    assert.equal(preview.kind, 'position'); assert.equal(preview.action, 'add'); assert.equal(preview.targetQuantity, '1.5');
    assert.deepEqual(preview.legs.map(l => [l.quantity, l.heldQuantity, l.targetQuantity, l.reduceOnly]), [['0.5', '1', '1.5', false], ['0.5', '1', '1.5', false]]);
    assert.ok(preview.risk.legs.every(l => D(l.projectedNotional).gte(150)), 'risk includes the existing one-base-unit position');
    assert.equal(f.calls.length, 0);
    const execution = await f.confirm(preview);
    assert.equal(execution.state, 'completed'); assert.equal(execution.action, 'add');
    assert.deepEqual(f.calls.map(o => [o.side, o.position_side, o.qty, o.reduce_only, o.type, o.time_in_force]), [
      ['BUY', mode === 'SINGLE' ? 'NONE' : 'LONG', '0.5', 'false', 'LIMIT', 'IOC'],
      ['SELL', mode === 'SINGLE' ? 'NONE' : 'SHORT', '0.5', 'false', 'LIMIT', 'IOC']]);
    assert.equal((await f.confirm(preview)).id, execution.id); assert.equal(f.calls.length, 2);
    await assert.rejects(f.runtime.preview({ kind: 'open', pair: { longSymbol: symbols[0], shortSymbol: symbols[1], quantity: '0.5' } }), /已有实际持仓/);
  }
});

test('balance strategies derive one or two deltas and mixed adjustments reduce before increasing', async t => {
  const scenarios = [
    { strategy: 'reduce', target: '1', rows: [[1, '1', true]] },
    { strategy: 'increase', target: '2', rows: [[0, '1', false]] },
    { strategy: 'target', target: '1.5', rows: [[1, '0.5', true], [0, '0.5', false]] },
    { strategy: 'target', target: '0.5', rows: [[0, '0.5', true], [1, '1.5', true]] },
    { strategy: 'target', target: '2.5', rows: [[0, '1.5', false], [1, '0.5', false]] },
  ];
  for (const mode of ['DUAL', 'SINGLE']) for (const scenario of scenarios) {
    const f = fixture(t, { mode, quantities: ['1', '2'], config: { notionalPerLeg: 500, maxTotalNotional: 2000 } }); await f.connect();
    const preview = await f.preview('balance', { strategy: scenario.strategy, ...(scenario.strategy === 'target' ? { targetQuantity: scenario.target } : {}) });
    assert.equal(preview.targetQuantity, scenario.target);
    assert.deepEqual(preview.legs.map(l => [symbols.indexOf(l.symbol), l.quantity, l.reduceOnly]), scenario.rows);
    assert.equal((await f.confirm(preview)).state, 'completed');
    assert.deepEqual(f.calls.map(o => [symbols.indexOf(o.symbol), o.qty, o.reduce_only]), scenario.rows.map(([index, quantity, reduce]) => [index, quantity, String(reduce)]));
    assert.ok(f.calls.every(o => o.side === (o.symbol === symbols[0] ? o.reduce_only === 'true' ? 'SELL' : 'BUY' : o.reduce_only === 'true' ? 'BUY' : 'SELL')));
  }
});

test('position requests reject forged fields, wrong action fields and nonpositive or imprecise input types', async t => {
  const f = fixture(t); await f.connect();
  const invalid = [
    { symbol: symbols[0] }, { side: 'SELL' }, { reduceOnly: true }, { strategy: 'reduce' }, { targetQuantity: '2' },
    { quantity: '0' }, { quantity: '-1' }, { quantity: 1 }, { quantity: 'NaN' }, { quantity: '1e999999' },
    { quantity: '1'.repeat(31) }, { quantity: `0.${'1'.repeat(31)}` }, { action: 'replace' },
    { action: 'balance', quantity: undefined, strategy: 'reduce' },
    { action: 'balance', quantity: undefined, strategy: 'target', targetQuantity: '0' },
    { positions: f.input().positions.map(p => ({ ...p, symbol: symbols[0] })) },
    { positions: f.input().positions.map(p => ({ ...p, expectedSide: undefined })) },
    { positions: f.input().positions.map(p => ({ ...p, expectedQuantity: 1 })) },
    { positions: f.input().positions.map(p => ({ ...p, expectedQuantity: '1e999999' })) },
    { positions: [f.input().positions[0], f.input().positions[0]] },
    { positions: [f.input().positions[0]] },
  ];
  for (const extra of invalid) await assert.rejects(f.runtime.preview(f.input('add', extra)), /参数无效|真实持仓/);
  for (const version of [0, true, {}, '1.0', 2]) await assert.rejects(f.preview('add', { connectionVersion: version }), /连接已变化/);
  assert.deepEqual(f.calls, []); assert.equal(f.store.prepare('SELECT count(*) n FROM live_previews').get().n, 0);
});

test('binding rejects stale quantity or direction, extra legs and ambiguous pairs before any order', async t => {
  for (const scenario of ['quantity', 'direction', 'missing', 'third', 'same-side', 'same-venue', 'different-base', 'different-quote', 'unknown', 'duplicate']) {
    const f = fixture(t, { mode: scenario === 'direction' ? 'SINGLE' : 'DUAL' }); await f.connect(); const request = f.input();
    if (scenario === 'quantity') f.positions[0].position_qty = '2';
    if (scenario === 'direction') f.positions[0].position_qty = '-1';
    if (scenario === 'missing') f.positions[0].position_id = 'changed';
    if (scenario === 'third') f.positions.push({ ...f.positions[0], position_id: 'third', symbol: 'GATE_FUTURE_BTC_USDT' });
    if (scenario === 'same-side') { f.positions[1].position_side = 'LONG'; request.positions[1].expectedSide = 'LONG'; }
    if (scenario === 'same-venue') f.positions[1].symbol = symbols[0];
    if (scenario === 'different-base') f.positions[1].symbol = 'BYBIT_FUTURE_ETH_USDT';
    if (scenario === 'different-quote') f.positions[1].symbol = 'BYBIT_FUTURE_BTC_USDC';
    if (scenario === 'unknown') f.positions[0].position_side = 'NONE';
    if (scenario === 'duplicate') f.positions.push({ ...f.positions[0] });
    await assert.rejects(f.runtime.preview(request), /变化|不存在|额外持仓|一多一空|无法核实|重复/);
    assert.deepEqual(f.calls, []);
  }
});

test('strict equality gates add and the relative-mean 0.1% threshold gates balance', async t => {
  const f = fixture(t, { quantities: ['1', '1.001'] }); await f.connect();
  await assert.rejects(f.preview('add'), /不相等/);
  await assert.rejects(f.preview('balance'), /0.1%/);
  f.positions[1].position_qty = '1'; await assert.rejects(f.preview('balance'), /0.1%/);
  f.positions[1].position_qty = '1.1'; assert.equal((await f.preview('balance')).targetQuantity, '1');
});

test('entry pause allows reduce and targets that only reduce, and rejects every increase', async t => {
  const f = fixture(t, { quantities: ['1', '2'], config: { entryPaused: true } }); await f.connect();
  assert.equal((await f.preview('balance')).risk, null);
  const target = await f.preview('balance', { strategy: 'target', targetQuantity: '0.5' });
  assert.ok(target.legs.every(l => l.reduceOnly)); assert.equal((await f.confirm(target)).state, 'completed');
  for (const extra of [{ strategy: 'increase' }, { strategy: 'target', targetQuantity: '1.5' }, { strategy: 'target', targetQuantity: '3' }]) {
    await assert.rejects(f.preview('balance', extra), /暂停/);
  }
  f.positions[1].position_qty = '1'; await assert.rejects(f.preview('add'), /暂停/);
});

test('increases honor per-order budgets, total notional, existing risk tiers, and unspent margin', async t => {
  for (const scenario of ['budget', 'total', 'margin', 'tier', 'isolated']) {
    const f = fixture(t, { config: scenario === 'total' ? { maxTotalNotional: 250 } : {} });
    if (scenario === 'margin') f.account.available_margin = '10';
    if (scenario === 'isolated') { f.account.account_mode = 'ISOLATED_EXCHANGE'; f.account.available_margin = '5'; }
    if (scenario === 'tier') f.client.getRiskLimits = async selected => selected.map(symbol => ({ symbol, tiers: [{ leverage_max: '100', max_risk_limit_value: '140' }] }));
    await f.connect();
    await assert.rejects(f.preview('add', { quantity: scenario === 'budget' ? '2' : '0.5' }), /预算|总名义额|保证金不足|风险档位/);
    assert.equal(f.calls.length, 0);
  }
  const mixed = fixture(t, { quantities: ['1', '2'] }); mixed.account.available_margin = '0'; await mixed.connect();
  await assert.rejects(mixed.preview('balance', { strategy: 'target', targetQuantity: '1.5' }), /保证金不足/);
  assert.equal(mixed.calls.length, 0, 'anticipated reduce fills must not finance the increase');
});

test('step, minimum notional, maximum size and native identity are checked for both selected positions', async t => {
  const f = fixture(t, { quantities: ['1', '2'] }); await f.connect();
  await assert.rejects(f.preview('balance', { strategy: 'target', targetQuantity: '1.5001' }), /步长/);
  await assert.rejects(f.preview('balance', { strategy: 'target', targetQuantity: '1.999' }), /最小名义额/);
  f.identity(symbol => quote(symbol.split('_')[0].toLowerCase(), epoch, { multiplier: 1000 }));
  await assert.rejects(f.preview('balance'), /身份/);
  const max = fixture(t); max.rules(catalog.map(r => ({ ...r, max_limit_size: '0.2' }))); await max.connect();
  await assert.rejects(max.preview(), /单笔上限/);
});

test('confirmation rejects changed held snapshots, native identity, settings, expiry and current margin', async t => {
  for (const scenario of ['quantity', 'direction', 'third', 'config', 'expiry', 'identity', 'margin', 'leverage', 'depth']) {
    const f = fixture(t, { mode: 'SINGLE' }); await f.connect(); const preview = await f.preview();
    if (scenario === 'quantity') f.positions[0].position_qty = '2';
    if (scenario === 'direction') f.positions[0].position_qty = '-1';
    if (scenario === 'third') f.positions.push({ ...f.positions[0], position_id: 'third', symbol: 'GATE_FUTURE_BTC_USDT' });
    if (scenario === 'config') f.market.settings({ config: { entryPaused: true } });
    if (scenario === 'expiry') f.advance(30000);
    if (scenario === 'identity') f.identity(symbol => quote(symbol.split('_')[0].toLowerCase(), epoch, { multiplier: 1000 }));
    if (scenario === 'margin') f.account.available_margin = '0';
    if (scenario === 'leverage') f.client.getLeverages = async selected => Object.fromEntries(selected.map(s => [s, '5']));
    if (scenario === 'depth') f.depth(q => ({ ...book(q, epoch), asks: [[q.ask + 2, 100]] }));
    await assert.rejects(f.confirm(preview), /变化|过期|身份|保证金|价格限制/);
    assert.equal(f.calls.length, 0); assert.equal(f.store.prepare('SELECT count(*) n FROM live_requests').get().n, 0);
  }
});

test('partial or unknown first fills stop every later position leg and retries cannot resubmit', async t => {
  for (const response of ['PARTIALLY_FILLED', 'UNKNOWN', 'CANCELLED']) {
    const f = fixture(t, { quantities: ['1', '2'] }); await f.connect();
    const preview = await f.preview('balance', { strategy: 'target', targetQuantity: '1.5' });
    f.setResponse(response); const execution = await f.confirm(preview);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].reduce_only, 'true');
    assert.equal(execution.legs[1].status, 'UNSENT');
    assert.equal(execution.legs[0].status, response);
    assert.equal((await f.confirm(preview)).id, execution.id); assert.equal(f.calls.length, 1);
    await f.runtime.refresh({ includeView: false }); assert.equal(f.calls.length, 1);
    assert.equal((await f.runtime.requestStatus('position-action-001')).requestStatus, 'submitted');
  }
});

test('pending external orders and cooldown remain blockers for position additions', async t => {
  const f = fixture(t); await f.connect(); const preview = await f.preview();
  f.orders.push({ order_id: 'external', symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY', state: 'OPEN', qty: '1', executed_qty: '0' });
  await assert.rejects(f.preview(), /活动委托/); await assert.rejects(f.confirm(preview), /持仓或设置已变化/);
  f.orders.pop(); assert.equal((await f.confirm(preview)).state, 'completed');
  await assert.rejects(f.preview(), /冷却期/);
  assert.equal(f.calls.length, 2);
});

test('confirmed native aliases preserve their raw contracts and still reject hidden third legs', async t => {
  const f = fixture(t), aliasSymbols = ['GATE_FUTURE_LUNA_USDT', 'BINANCE_FUTURE_LUNA2_USDT'];
  f.positions.forEach((p, index) => { p.symbol = aliasSymbols[index]; });
  f.rules(catalog.map((r, index) => ({ ...r, symbol: aliasSymbols[index], exchange_type: index ? 'BINANCE' : 'GATE', max_limit_size: '10000' })));
  f.identity(symbol => {
    const gate = symbol.startsWith('GATE'), exchange = gate ? 'gate' : 'binance', rawBase = gate ? 'LUNA' : 'LUNA2';
    return quote(exchange, epoch, { base: 'LUNA2', rawBase, symbol: gate ? 'LUNA_USDT' : 'LUNA2USDT', settlementCurrency: 'USDT',
      collateralCurrency: 'USDT', counterCurrency: 'USDT', contractKind: 'linear', crossexSymbol: symbol, identityScope: 'manual',
      nativeUnit: '1', identitySource: 'exchange-instrument-metadata', comparable: true });
  });
  await f.connect(); const preview = await f.preview(); assert.equal(preview.base, 'LUNA2');
  assert.deepEqual(preview.legs.map(l => l.symbol), aliasSymbols);
  const request = f.input(); f.positions.push({ ...f.positions[0], position_id: 'alias-third', symbol: 'OKX_FUTURE_LUNA_USDT' });
  await assert.rejects(f.runtime.preview(request), /额外持仓/);
  await assert.rejects(f.confirm(preview), /已变化/); assert.equal(f.calls.length, 0);
});

test('confirmation rechecks changed market valuation against position increase budgets and total exposure', async t => {
  for (const scenario of ['budget', 'total', 'tier']) {
    const f = fixture(t, { config: scenario === 'budget' ? { notionalPerLeg: 51, maxTotalNotional: 1000 }
      : scenario === 'total' ? { maxTotalNotional: 301.525 } : {} });
    if (scenario === 'tier') f.client.getRiskLimits = async selected => selected.map(symbol => ({ symbol, tiers: [{ leverage_max: '100', max_risk_limit_value: '153' }] }));
    await f.connect(); const preview = await f.preview();
    // SELL improvements remain fillable within the original IOC protection price,
    // but increase the valuation used for the budget, total and risk checks.
    f.depth(q => q.exchange === 'bybit' ? { at: epoch, bids: [[104, 100]], asks: [[105, 100]] } : book(q, epoch));
    await assert.rejects(f.confirm(preview), /预算|总名义额|风险档位/);
    assert.equal(f.calls.length, 0); assert.equal(f.store.prepare('SELECT count(*) n FROM live_requests').get().n, 0);
  }
});

test('opposite mixed direction also reduces first, and a request key cannot confirm a different preview', async t => {
  const f = fixture(t, { mode: 'SINGLE', quantities: ['2', '1'] }); await f.connect();
  const first = await f.preview('balance', { strategy: 'target', targetQuantity: '1.5' });
  const second = await f.preview('balance', { strategy: 'target', targetQuantity: '1.5' });
  assert.deepEqual(first.legs.map(l => [l.symbol, l.side, l.positionSide, l.reduceOnly]), [[symbols[0], 'SELL', 'NONE', true], [symbols[1], 'SELL', 'NONE', false]]);
  assert.equal((await f.confirm(first)).state, 'completed');
  await assert.rejects(f.confirm(second), /请求标识不能用于不同操作/);
  assert.equal(f.calls.length, 2);
});

test('Hyperliquid and Bybit USDC position pairs use verified counter currencies through preview and confirmation', async t => {
  const f = fixture(t, { fxReader: async () => ({ baseCurrency: 'USDT', staleAfterMs: 180000,
    rates: { USDC: { bid: 1, ask: 1.001, at: epoch, source: 'isolated-test' } } }) });
  const selected = ['HYPERLIQUID_FUTURE_BTC_USDC', 'BYBIT_FUTURE_BTC_USDC'];
  f.positions.forEach((position, index) => { position.symbol = selected[index]; });
  f.rules(catalog.map((rule, index) => ({ ...rule, symbol: selected[index], exchange_type: index ? 'BYBIT' : 'HYPERLIQUID', max_limit_size: '10000' })));
  f.identity(symbol => {
    const hyperliquid = symbol.startsWith('HYPERLIQUID');
    return quote(hyperliquid ? 'hyperliquid' : 'bybit', epoch, { symbol: hyperliquid ? 'BTC' : 'BTCPERP', rawBase: 'BTC',
      quoteCurrency: hyperliquid ? 'USDT' : 'USDC', counterCurrency: 'USDC', settlementCurrency: 'USDC', collateralCurrency: 'USDC',
      contractKind: hyperliquid ? 'quanto' : 'linear', crossexSymbol: symbol, identityScope: 'manual', nativeUnit: '1',
      identitySource: 'exchange-instrument-metadata', comparable: true });
  });
  await f.connect(); const preview = await f.preview();
  assert.equal(preview.targetQuantity, '1.5');
  assert.deepEqual(preview.positionQuotes.map(q => [q.quoteCurrency, q.counterCurrency]), [['USDT', 'USDC'], ['USDC', 'USDC']]);
  assert.ok(preview.legs.every(leg => leg.quantity === '0.5' && leg.budgetFxRate === '1.001'));
  assert.equal((await f.confirm(preview)).state, 'completed');
  assert.deepEqual(f.calls.map(order => [order.symbol, order.side, order.qty, order.reduce_only]), [
    [selected[0], 'BUY', '0.5', 'false'], [selected[1], 'SELL', '0.5', 'false']]);
});
