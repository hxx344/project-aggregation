import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateClient, GateClientError, GATE_ORDER_STATES, GATE_TERMINAL_STATES } from '../server/live-client.mjs';

const NOW = 1700000000123, KEY = 'unit-key', SECRET = 'unit-secret', SYMBOL = 'BINANCE_FUTURE_BTC_USDT';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const payload = () => ({ text: 'cx-001', symbol: SYMBOL, side: 'SELL', type: 'LIMIT', time_in_force: 'IOC', qty: '0.010000000000000000001', price: '65000.10', reduce_only: 'true', position_side: 'NONE' });
const order = (i = 1, changes = {}) => ({ user_id: '123', order_id: String(2000000000000000 + i), text: `cx-${i}`, state: 'PARTIALLY_FILLED', symbol: SYMBOL, exchange_type: 'BINANCE', business_type: 'FUTURE', side: 'BUY', type: 'LIMIT', qty: '1.000000000000000000001', quote_qty: '0', price: '65000.10', time_in_force: 'IOC', executed_qty: '0.500000000000000000001', executed_amount: '32500.050000000000000065', executed_avg_price: '65000.10', fee_coin: 'USDT', fee: '0.003250005', reduce_only: 'false', last_executed_qty: '0.1', last_executed_price: '65000.10', last_executed_amount: '6500.01', position_side: 'NONE', create_time: String(NOW - 1000), update_time: String(NOW), ...changes });
const position = (changes = {}) => ({ user_id: '123', position_id: '1234', symbol: SYMBOL, position_side: 'NONE', position_qty: '-0.123456789012345678901', entry_price: '65000.01', mark_price: '65001.1', update_time: String(NOW), ...changes });
const account = (changes = {}) => ({ user_id: '123', position_mode: 'SINGLE', account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', available_margin: '123.123456789012345678901', margin_balance: '150.00', initial_margin: '26.876543210987654321099', maintenance_margin: '1', initial_margin_rate: '5.6', maintenance_margin_rate: '150', assets: [{ user_id: '123', exchange_type: 'BINANCE', coin: 'USDT', balance: '123.123456789012345678901', upnl: '-0.02', equity: '123.103456789012345678901', available_balance: '123', liability: '0' }], ...changes });
const trade = i => ({ user_id: '123', transaction_id: `t-${i}`, order_id: String(2000000000000000 + i), text: `cx-${i}`, symbol: SYMBOL, exchange_type: 'BINANCE', business_type: 'FUTURE', side: 'SELL', qty: '0.100000000000000000001', price: '65000.1', fee: '-0.005', fee_coin: 'USDT', create_time: String(NOW - 1000) });
function fixture(reply = () => json({})) {
  const calls = [];
  const client = createGateClient({ apiKey: KEY, apiSecret: SECRET, clock: () => NOW, fetcher: async (url, init) => {
    calls.push({ url, init }); return reply(new URL(url), init, calls.length);
  } });
  return { client, calls };
}

test('fixed production host signs exact JSON bytes, timestamp and raw query with SHA512', async () => {
  const f = fixture((url, init) => init.method === 'POST' ? json({ order_id: '2000000000000001', text: 'cx-001' }) : json([]));
  const ack = await f.client.createOrder(payload());
  assert.deepEqual(ack, { order_id: '2000000000000001', text: 'cx-001' });
  assert.equal(f.calls[0].url, 'https://api.gateio.ws/api/v4/crossex/orders');
  assert.equal(f.calls[0].init.headers.SIGN, 'b53c4fe04dc9f6afdee7947903fa569e20e8825af950ac03abef25f8d987512e2295673521b57ca12063a7dc41572fc7fe8cff0773f2d36293ea1c30b2baaabe');
  assert.equal(f.calls[0].init.headers.Timestamp, '1700000000');
  assert.equal(f.calls[0].init.redirect, 'error'); assert.ok(f.calls[0].init.signal);
  assert.equal(JSON.parse(f.calls[0].init.body).qty, payload().qty);
  assert.equal(JSON.parse(f.calls[0].init.body).reduce_only, 'true');
  await f.client.getPositions('GATE');
  assert.equal(f.calls[1].url, 'https://api.gateio.ws/api/v4/crossex/positions?exchange_type=GATE');
  assert.equal(f.calls[1].init.headers.SIGN, '1520902cc8431859e3b01a6e900f7aca937eedffe903972d28cb522ffeb8e66704c909a1fdfaae4d0b9b73ed5500286f21a4f8c4fb6d3624617143749fbd6ec9');
  assert.equal(f.calls[1].init.body, undefined);
});

test('decimal quantities, cumulative partial fills and positions retain exact strings', async () => {
  const f = fixture(url => json(url.pathname.endsWith('/positions') ? [position()] : url.pathname.endsWith('/accounts') ? account() : order()));
  const value = await f.client.getOrder('cx-1');
  assert.equal(value.executed_qty, '0.500000000000000000001'); assert.equal(value.last_executed_qty, '0.1');
  assert.equal((await f.client.getPositions())[0].position_qty, '-0.123456789012345678901');
  assert.equal((await f.client.getAccount()).available_margin, '123.123456789012345678901');
});

test('official state names are explicit and unknown aliases fail closed', async () => {
  assert.deepEqual(GATE_TERMINAL_STATES, ['FILLED', 'FAIL', 'REJECT', 'CANCELLED']);
  for (const state of [...GATE_ORDER_STATES, 'CANCELED', 'EXPIRED', 'finished', 'CANCEL_PENDING']) {
    const f = fixture(() => json(order(1, { state })));
    if (GATE_ORDER_STATES.includes(state)) assert.equal((await f.client.getOrder('cx-1')).state, state);
    else await assert.rejects(f.client.getOrder('cx-1'), { code: 'GATE_INVALID_RESPONSE' });
  }
});

test('request parameter violations and endpoint injection send no request', async () => {
  const f = fixture();
  for (const change of [{ qty: 0.1 }, { qty: '1e-3' }, { qty: '-1' }, { price: '0' }, { reduce_only: true }, { reduce_only: 'yes' }, { text: 'x'.repeat(64) }, { text: 'UPPER' }, { text: '../orders' }, { side: 'sell' }, { symbol: 'KRAKEN_SPOT_BTC_USD' }, { endpoint: 'https://example.com' }, { type: 'MARKET', price: undefined, time_in_force: 'POC' }]) {
    await assert.rejects(f.client.createOrder({ ...payload(), ...change }), { code: 'GATE_INVALID_INPUT' });
  }
  for (const id of ['../accounts', '123?other=1', '', 123]) await assert.rejects(f.client.getOrder(id), { code: 'GATE_INVALID_INPUT' });
  await assert.rejects(f.client.getPositions('https://example.com'), { code: 'GATE_INVALID_INPUT' });
  assert.equal(f.calls.length, 0);
});

test('spot market buys use quote_qty; futures market orders use qty without limit price', async () => {
  const f = fixture((url, init) => json({ order_id: '123', text: JSON.parse(init.body).text }));
  await f.client.createOrder({ text: 'spot-1', symbol: 'BINANCE_SPOT_BTC_USDT', side: 'BUY', type: 'MARKET', quote_qty: '10.01' });
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { text: 'spot-1', symbol: 'BINANCE_SPOT_BTC_USDT', side: 'BUY', type: 'MARKET', time_in_force: 'GTC', quote_qty: '10.01' });
  await f.client.createOrder({ ...payload(), type: 'MARKET', price: undefined });
  assert.equal(JSON.parse(f.calls[1].init.body).price, undefined);
});

test('account mode, scope, UID and identities must match', async () => {
  const f = fixture(() => json(account({ account_mode: 'ISOLATED_EXCHANGE', exchange_type: 'GATE' })));
  assert.equal((await f.client.getAccount('GATE')).exchange_type, 'GATE');
  assert.equal((await f.client.getAccount()).account_mode, 'ISOLATED_EXCHANGE');
  await assert.rejects(f.client.getAccount('OKX'), { code: 'GATE_INVALID_RESPONSE' });
  const g = fixture(() => json([position()]));
  await assert.rejects(g.client.getPositions('GATE'), { code: 'GATE_INVALID_RESPONSE' });
  const h = fixture(() => json(order(1, { exchange_type: 'GATE' })));
  await assert.rejects(h.client.getOrder('cx-1'), { code: 'GATE_INVALID_RESPONSE' });
  const bad = account(); bad.assets[0].user_id = '999';
  await assert.rejects(fixture(() => json(bad)).client.getAccount(), { code: 'GATE_INVALID_RESPONSE' });
});

test('detail preserves UID and restrictions, discards undocumented permission/secret fields', async () => {
  const f = fixture(url => { assert.equal(url.pathname, '/api/v4/account/detail'); return json({ user_id: 123, ip_whitelist: ['127.0.0.1'], currency_pairs: ['BTC_USDT'], key: { mode: 1, secret: SECRET }, perms: [{ name: 'crossx', read_only: false }], write_access: true }); });
  assert.deepEqual(await f.client.getAccountDetail(), { user_id: 123, ip_whitelist: ['127.0.0.1'], currency_pairs: ['BTC_USDT'], key: { mode: 1 } });
  assert.equal(f.calls.length, 1);
});

test('history traverses all pages with a fixed end time and stable decimal values', async () => {
  const f = fixture(url => {
    assert.equal(url.searchParams.get('limit'), '100'); assert.equal(url.searchParams.get('to'), String(NOW));
    const page = Number(url.searchParams.get('page'));
    return json(Array.from({ length: page === 1 ? 100 : 2 }, (_, i) => order((page - 1) * 100 + i + 1)));
  });
  const rows = await f.client.getHistoryOrders({ from: NOW - 2000, symbol: SYMBOL });
  assert.equal(rows.length, 102); assert.equal(rows[101].executed_qty, order().executed_qty); assert.equal(f.calls.length, 2);
});

test('history cap, duplicate pages and ignored filters report failure, never partial success', async () => {
  const cap = fixture(url => json(Array.from({ length: 100 }, (_, i) => order((Number(url.searchParams.get('page')) - 1) * 100 + i))));
  await assert.rejects(cap.client.getHistoryOrders(), { code: 'GATE_INCOMPLETE_HISTORY' }); assert.equal(cap.calls.length, 50);
  const duplicate = fixture(() => json(Array.from({ length: 100 }, (_, i) => order(i))));
  await assert.rejects(duplicate.client.getHistoryOrders(), { code: 'GATE_INVALID_RESPONSE' }); assert.equal(duplicate.calls.length, 2);
  await assert.rejects(fixture(() => json([order()])).client.getHistoryOrders({ symbol: 'OKX_FUTURE_BTC_USDT' }), { code: 'GATE_INVALID_RESPONSE' });
  await assert.rejects(fixture(() => json([order()])).client.getHistoryOrders({ from: NOW }), { code: 'GATE_INVALID_RESPONSE' });
  await assert.rejects(fixture().client.getHistoryOrders({ limit: 1 }), { code: 'GATE_INVALID_INPUT' });
});

test('trade history uses distinct fill IDs and preserves rebates and precision', async () => {
  const f = fixture(url => { assert.equal(url.pathname, '/api/v4/crossex/history_trades'); return json([trade(1), trade(2)]); });
  const rows = await f.client.getTrades({ from: NOW - 2000, to: NOW });
  assert.equal(rows[0].qty, '0.100000000000000000001'); assert.equal(rows[0].fee, '-0.005');
  await assert.rejects(fixture(() => json([trade(1), trade(1)])).client.getTrades(), { code: 'GATE_INVALID_RESPONSE' });
});

test('open orders are a complete native list and tolerate the documented client_order_id alias', async () => {
  const value = order(); value.client_order_id = value.text; delete value.text;
  const f = fixture(() => json([value]));
  assert.equal((await f.client.getOpenOrders())[0].text, 'cx-1');
  await assert.rejects(fixture(() => json([order(), order()])).client.getOpenOrders(), { code: 'GATE_INVALID_RESPONSE' });
  await assert.rejects(fixture(() => json(Array.from({ length: 1001 }, (_, i) => order(i)))).client.getOpenOrders(), { code: 'GATE_INVALID_RESPONSE' });
});

test('cancel returns an ACK and never invents a terminal status', async () => {
  const f = fixture((url, init) => { assert.equal(init.method, 'DELETE'); assert.equal(init.body, undefined); return json({ order_id: '2000000000000001', text: 'cx-1' }); });
  assert.deepEqual(await f.client.cancelOrder('cx-1'), { order_id: '2000000000000001', text: 'cx-1' });
  assert.equal(f.calls.length, 1);
});

test('post and cancel failures never retry and never expose body, URL, credentials or signature', async () => {
  for (const method of ['createOrder', 'cancelOrder']) for (const status of [400, 401, 429, 500, 503]) {
    const f = fixture(() => json({ label: 'malicious-label', message: `${KEY} ${SECRET} https://api.gateio.ws SIGN=secret` }, status));
    await assert.rejects(f.client[method](method === 'createOrder' ? payload() : 'cx-1'), error => {
      assert.ok(error instanceof GateClientError); assert.equal(error.sourceStatus, status); assert.equal(error.uncertain, status >= 500 || status === 429);
      const printed = `${error.stack} ${JSON.stringify(error)}`;
      for (const privateValue of [KEY, SECRET, 'https://api.gateio.ws', 'SIGN=', 'malicious-label']) assert.ok(!printed.includes(privateValue));
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test('not-found is preserved only as a safe label and is not proof of non-execution', async () => {
  const f = fixture(() => json({ label: 'TRADE_ORDER_NOT_FOUND_ERROR', message: 'sensitive detail' }, 400));
  await assert.rejects(f.client.getOrder('cx-1'), error => error.label === 'TRADE_ORDER_NOT_FOUND_ERROR' && !error.message.includes('sensitive'));
  const d = fixture(() => json({ label: 'TRADE_ORDER_DUPLICATE_ERROR' }, 400));
  await assert.rejects(d.client.createOrder(payload()), error => error.uncertain === true);
});

test('malformed or mismatched successful write responses remain unknown', async () => {
  for (const value of [{ order_id: '123', text: 'other' }, { text: 'cx-001' }, { id: '123', text: 'cx-001' }]) {
    const f = fixture(() => json(value));
    await assert.rejects(f.client.createOrder(payload()), error => error.code === 'GATE_INVALID_RESPONSE' && error.uncertain);
    assert.equal(f.calls.length, 1);
  }
});

test('timeout covers uncooperative fetchers and response streams; write results remain unknown', async () => {
  for (const fetcher of [() => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    let calls = 0;
    const client = createGateClient({ apiKey: KEY, apiSecret: SECRET, timeoutMs: 15, fetcher: (...args) => { calls++; return fetcher(...args); } });
    await assert.rejects(client.createOrder(payload()), error => error.code === 'GATE_TIMEOUT' && error.uncertain && !error.message.includes(KEY));
    assert.equal(calls, 1);
  }
});

test('network exceptions are stripped and upstream order rejection reasons never leave the client', async () => {
  const client = createGateClient({ apiKey: KEY, apiSecret: SECRET, fetcher: async () => { throw new Error(`${KEY}:${SECRET}@https://example.com`); } });
  await assert.rejects(client.createOrder(payload()), error => error.code === 'GATE_NETWORK_ERROR' && error.uncertain && !error.stack.includes(KEY));
  const f = fixture(() => json(order(1, { state: 'REJECT', reason: `${KEY}/${SECRET}` })));
  assert.equal((await f.client.getOrder('cx-1')).reason, '交易所拒绝此订单');
  const g = fixture(() => json(order(1, { state: 'FAIL', reason: 'https://upstream.example/body?SIGN=secret' })));
  assert.equal((await g.client.getOrder('cx-1')).reason, 'CrossEx 校验未通过');
});

test('optional null and absent monetary metadata remain unknown without dropping valid balances', async () => {
  const a = account(); a.assets[0].available_balance = null; delete a.assets[0].upnl; a.account_limit = null;
  const f = fixture(url => json(url.pathname.endsWith('/accounts') ? a : [position({ liq_price: null, funding_fee: null })]));
  const result = await f.client.getAccount();
  assert.equal(result.assets[0].available_balance, null); assert.equal(result.assets[0].upnl, undefined); assert.equal(result.account_limit, null);
  assert.equal((await f.client.getPositions())[0].liq_price, null);
});

test('unknown account modes and optional asset metadata permit observation without fabricated defaults', async () => {
  for (const missing of [undefined, null]) {
    const a = account({ position_mode: missing, account_mode: missing, exchange_type: missing });
    a.assets[0].user_id = missing; a.assets[0].balance = missing;
    const f = fixture(() => json(a));
    for (const exchangeType of [undefined, 'GATE']) {
      const result = await f.client.getAccount(exchangeType);
      assert.equal(result.user_id, '123');
      for (const key of ['position_mode', 'account_mode', 'exchange_type']) assert.equal(result[key], missing);
      assert.equal(result.assets[0].user_id, missing); assert.equal(result.assets[0].balance, missing);
    }
  }
  const f = fixture(() => json(account({ account_mode: 'NEW_ACCOUNT_MODE', position_mode: 'NEW_POSITION_MODE', exchange_type: undefined })));
  const unknown = await f.client.getAccount();
  assert.equal(unknown.account_mode, 'NEW_ACCOUNT_MODE'); assert.equal(unknown.position_mode, 'NEW_POSITION_MODE');
  assert.equal((await fixture(() => json(account({ user_id: undefined }))).client.getAccount()).user_id, undefined);
  await assert.rejects(fixture(() => json(account({ account_mode: undefined, exchange_type: 'OKX' }))).client.getAccount('GATE'), { code: 'GATE_INVALID_RESPONSE' });
});

test('position display metadata and trade fees remain optional while identity and fill quantities are required', async () => {
  const p = position(); delete p.entry_price; delete p.mark_price; delete p.update_time;
  const readPosition = await fixture(() => json([p])).client.getPositions();
  assert.equal(readPosition[0].position_qty, p.position_qty); assert.equal(readPosition[0].mark_price, undefined);
  const t = trade(1); delete t.fee; delete t.fee_coin; delete t.text;
  const readTrade = await fixture(() => json([t])).client.getTrades();
  assert.equal(readTrade[0].qty, t.qty); assert.equal(readTrade[0].fee, undefined); assert.equal(readTrade[0].text, undefined);
  await assert.rejects(fixture(() => json([{ ...p, position_qty: undefined }])).client.getPositions(), { code: 'GATE_INVALID_RESPONSE' });
  await assert.rejects(fixture(() => json([{ ...t, qty: undefined }])).client.getTrades(), { code: 'GATE_INVALID_RESPONSE' });
});

test('invalid and excessive JSON cannot masquerade as an empty account or list', async () => {
  for (const response of [new Response('<html>bad</html>'), json({ data: [] }), new Response(' '.repeat(8 * 1024 * 1024 + 1))]) {
    await assert.rejects(fixture(() => response).client.getPositions(), { code: 'GATE_INVALID_RESPONSE' });
  }
  await assert.rejects(fixture(() => json(order(1, { executed_qty: '2' }))).client.getOrder('cx-1'), { code: 'GATE_INVALID_RESPONSE' });
  await assert.rejects(fixture(() => json(order(1, { executed_qty: 0.5 }))).client.getOrder('cx-1'), { code: 'GATE_INVALID_RESPONSE' });
});

test('reference account, position and trade responses may omit UID without creating an identity', async () => {
  const a = account({ user_id: undefined }); a.assets[0].user_id = undefined;
  const p = position({ user_id: undefined }), t = { ...trade(1), user_id: undefined };
  const f = fixture(url => json(url.pathname.endsWith('/accounts') ? a : url.pathname.endsWith('/positions') ? [p] : [t]));
  assert.equal(Object.hasOwn(await f.client.getAccount(), 'user_id'), false);
  assert.equal(Object.hasOwn((await f.client.getPositions())[0], 'user_id'), false);
  assert.equal(Object.hasOwn((await f.client.getTrades())[0], 'user_id'), false);
  assert.deepEqual(await fixture(() => json({})).client.getAccountDetail(), {});
  for (const value of ['bad-uid', 123, '', '0']) {
    await assert.rejects(fixture(() => json(account({ user_id: value }))).client.getAccount(), { code: 'GATE_INVALID_RESPONSE' });
    await assert.rejects(fixture(() => json([position({ user_id: value })])).client.getPositions(), { code: 'GATE_INVALID_RESPONSE' });
  }
  const unknown = account({ user_id: undefined }); unknown.assets.push({ ...unknown.assets[0], exchange_type: 'OKX', user_id: '456' });
  await assert.rejects(fixture(() => json(unknown)).client.getAccount(), { code: 'GATE_INVALID_RESPONSE' });
});

test('sparse finished orders retain unknown descriptors and client_order_id while enforcing identity and fills', async () => {
  const sparse = { order_id: '9001', client_order_id: 'cx-terminal', state: 'FILLED', symbol: SYMBOL, side: 'BUY', type: 'LIMIT', qty: '0.1', executed_qty: '0.1', executed_avg_price: '65000', update_time: String(NOW), price: null, reduce_only: '', fee: null, executed_amount: null, position_side: null, create_time: null, exchange_type: null };
  const f = fixture(url => json(url.pathname.endsWith('/history_orders') ? [sparse] : sparse));
  const result = await f.client.getOrder('cx-terminal');
  assert.equal(result.text, 'cx-terminal'); assert.equal(result.client_order_id, 'cx-terminal');
  assert.equal(result.user_id, undefined); assert.equal(result.position_side, null); assert.equal(result.time_in_force, undefined);
  assert.equal(result.price, null); assert.equal(result.reduce_only, ''); assert.equal(result.executed_amount, null);
  assert.equal((await f.client.getHistoryOrders({ from: NOW - 2000 }))[0].create_time, null);
  await assert.rejects(f.client.getOrder('other'), { code: 'GATE_INVALID_RESPONSE' });
  for (const changes of [{ text: 'different' }, { executed_qty: undefined }, { executed_avg_price: null }, { executed_qty: '0.2' }, { side: undefined }, { type: undefined }, { client_order_id: undefined }, { price: 'NaN' }, { position_side: 'BOTH' }]) {
    await assert.rejects(fixture(() => json({ ...sparse, ...changes })).client.getOrder('9001'), { code: 'GATE_INVALID_RESPONSE' });
  }
});

test('manual limit policies and market quantities use original base units and no broker header', async () => {
  const f = fixture((url, init) => json({ order_id: '123', text: JSON.parse(init.body).text }, 202));
  for (const policy of ['GTC', 'IOC', 'FOK', 'POC']) {
    await f.client.createOrder({ ...payload(), time_in_force: policy, qty: '0.123456789012345678901' });
    const sent = f.calls.at(-1).init;
    assert.equal(JSON.parse(sent.body).time_in_force, policy); assert.equal(JSON.parse(sent.body).qty, '0.123456789012345678901');
    assert.equal(Object.keys(sent.headers).some(key => key.toLowerCase().includes('channel')), false);
  }
  await f.client.createOrder({ text: 'market-1', symbol: SYMBOL, side: 'BUY', type: 'MARKET', qty: '0.123456789012345678901' });
  assert.equal(JSON.parse(f.calls.at(-1).init.body).qty, '0.123456789012345678901');
  assert.equal(Object.hasOwn(JSON.parse(f.calls.at(-1).init.body), 'price'), false);
  const count = f.calls.length;
  for (const change of [{ type: 'MARKET' }, { type: 'MARKET', price: undefined, qty: undefined }, { type: 'MARKET', price: undefined, qty: '0' }, { type: 'LIMIT', price: undefined }, { qty: '1', quote_qty: '1' }]) {
    await assert.rejects(f.client.createOrder({ ...payload(), ...change }), { code: 'GATE_INVALID_INPUT' });
  }
  assert.equal(f.calls.length, count);
});

test('fee arrays preserve rate fractions, symbol overrides, rebates and unavailable metadata', async () => {
  const rates = [{ exchange_type: 'BINANCE', spot_maker_fee: '0.0001', spot_taker_fee: null, future_maker_fee: '-0.00002', future_taker_fee: '0.00022', future_rpi_maker_fee: '', special_fee_list: [{ symbol: SYMBOL, maker_fee_rate: '0', taker_fee_rate: '0.00029', rpi_fee_rate: null }] }, { exchange_type: 'OKX', future_maker_fee: '0.00006', future_taker_fee: '0.00022' }];
  const f = fixture(() => json(rates));
  assert.deepEqual(await f.client.getFees(), rates);
  assert.equal(f.calls[0].url, 'https://api.gateio.ws/api/v4/crossex/fee');
  assert.equal(f.calls[0].init.headers.SIGN, '1066fbe90f1890c614b170b54939e9ca2062b94d0fa68a11ef14df13cf83b1c6f351af462802ef31440aef1819087bdd76060e521b17d1a59a37ec5247738140');
  for (const invalid of [[rates[0], rates[0]], [{ exchange_type: 'BINANCE', future_taker_fee: 0.01 }], [{ ...rates[0], special_fee_list: [{ symbol: 'OKX_FUTURE_BTC_USDT', taker_fee_rate: '0.01' }] }]]) {
    await assert.rejects(fixture(() => json(invalid)).client.getFees(), { code: 'GATE_INVALID_RESPONSE' });
  }
});

test('leverage requests sign a literal comma list and preserve missing symbols as unknown', async () => {
  const requested = [SYMBOL, 'OKX_FUTURE_BTC_USDT'], f = fixture(() => json({ [SYMBOL]: '3.5' }));
  assert.deepEqual(await f.client.getLeverages(requested), { [SYMBOL]: '3.5' });
  assert.equal(f.calls[0].url, `https://api.gateio.ws/api/v4/crossex/positions/leverage?symbols=${requested.join(',')}`);
  assert.equal(f.calls[0].init.headers.SIGN, 'e0f7cddcb1af00f2e193a237dd5b7d2f392662d34194afc0f61a08f4e49a8cda7a6e8f09276a805838a51a8da762b871da210148117c44c7c143e92e00728941');
  assert.deepEqual(await f.client.getLeverages([]), {}); assert.equal(f.calls.length, 1);
  for (const invalid of [{ [SYMBOL]: 3 }, { [SYMBOL]: '0' }, { GATE_FUTURE_BTC_USDT: '3' }]) await assert.rejects(fixture(() => json(invalid)).client.getLeverages(requested), { code: 'GATE_INVALID_RESPONSE' });
});

test('risk tiers use fixed public endpoint without sending credentials or signatures', async () => {
  const limits = [{ symbol: SYMBOL, tiers: [{ min_risk_limit_value: '0', max_risk_limit_value: '50000', leverage_max: '20', maintenance_rate: '0.004', quick_cal_amount: '0', tier: '1' }] }];
  const f = fixture(() => json(limits));
  assert.deepEqual(await f.client.getRiskLimits([SYMBOL]), limits);
  assert.equal(f.calls[0].url, `https://api.gateio.ws/api/v4/crossex/rule/risk_limits?symbols=${SYMBOL}`);
  assert.deepEqual(f.calls[0].init.headers, { Accept: 'application/json', 'Content-Type': 'application/json' });
  assert.equal(f.calls[0].init.redirect, 'error'); assert.ok(f.calls[0].init.signal);
  for (const changes of [{ max_risk_limit_value: '-1' }, { leverage_max: '0' }, { min_risk_limit_value: '60000' }, { maintenance_rate: 0.1 }, { tier: '0' }]) {
    await assert.rejects(fixture(() => json([{ ...limits[0], tiers: [{ ...limits[0].tiers[0], ...changes }] }])).client.getRiskLimits([SYMBOL]), { code: 'GATE_INVALID_RESPONSE' });
  }
  await assert.rejects(fixture(() => json([{ ...limits[0], symbol: 'OKX_FUTURE_BTC_USDT' }])).client.getRiskLimits([SYMBOL]), { code: 'GATE_INVALID_RESPONSE' });
});

test('account book maps statement_type and millisecond range while preserving signed changes', async () => {
  const records = [{ id: '121', business_id: 'position:1750941402661', statement_type: 'FUNDING_FEE', exchange_type: 'BINANCE', coin: 'USDT', symbol: SYMBOL, change: '-0.002000000000000001', balance: '81', create_time: String(NOW - 1000) }];
  const f = fixture(() => json(records));
  assert.deepEqual(await f.client.getAccountBook({ coin: 'USDT', type: 'FUNDING_FEE', from: NOW - 2000, to: NOW, limit: 2 }), records);
  assert.equal(f.calls[0].url, 'https://api.gateio.ws/api/v4/crossex/account_book?page=1&limit=2&coin=USDT&statement_type=FUNDING_FEE&from=1699999998123&to=1700000000123');
  assert.equal(f.calls[0].init.headers.SIGN, '8faf07839d998b79cecbddf2452bf8886007827f0e2652c9319563b905826c1d9c6c64c97719526a7dd63b3ea13fae613ef518464f6dcaf094233ece6ddae590');
  await assert.rejects(f.client.getAccountBook({ coin: 'USDC' }), { code: 'GATE_INVALID_RESPONSE' });
  await assert.rejects(f.client.getAccountBook({ type: 'TRADING_FEE' }), { code: 'GATE_INVALID_RESPONSE' });
  await assert.rejects(f.client.getAccountBook({ from: NOW }), { code: 'GATE_INVALID_RESPONSE' });
  const transfer = { ...records[0], statement_type: 'TRANSFER_IN', symbol: null, exchange_type: 'CROSSEX', change: '1.2' };
  assert.equal((await fixture(() => json([transfer])).client.getAccountBook())[0].symbol, null);
});

test('optional ADL ranks accept official array and reference object responses without reordering priority', async () => {
  const second = 'GATE_FUTURE_BTC_USDT', f = fixture(url => {
    const selected = url.searchParams.get('symbol');
    const row = { symbol: selected, crossex_adl_rank: '5', exchange_adl_rank: selected === SYMBOL ? '4' : '1' };
    assert.equal(url.pathname, '/api/v4/crossex/adl_rank'); return json(selected === SYMBOL ? row : [row]);
  });
  const result = await f.client.getAdlRanks([SYMBOL, second]);
  assert.equal(result[0].crossex_adl_rank, '5'); assert.equal(result[1].exchange_adl_rank, '1'); assert.equal(f.calls.length, 2);
  await assert.rejects(fixture(() => json({ symbol: SYMBOL, crossex_adl_rank: '0', exchange_adl_rank: '0' })).client.getAdlRanks([SYMBOL]), { code: 'GATE_INVALID_RESPONSE' });
});

test('all additional query parameters reject injection and excess ranges before network activity', async () => {
  const f = fixture();
  for (const method of ['getLeverages', 'getRiskLimits', 'getAdlRanks']) for (const values of [[`${SYMBOL}&key=secret`], [SYMBOL, SYMBOL], ['BINANCE_SPOT_BTC_USDT'], 'BTC', [null]]) {
    await assert.rejects(f.client[method](values), { code: 'GATE_INVALID_INPUT' });
  }
  for (const options of [{ coin: 'USDT&x=1' }, { type: 'FUNDING_FEE&x=1' }, { limit: 0 }, { limit: 1001 }, { from: '1700000000' }, { from: NOW, to: NOW - 1 }, { endpoint: '/other' }, { page: 2 }]) {
    await assert.rejects(f.client.getAccountBook(options), { code: 'GATE_INVALID_INPUT' });
  }
  assert.equal(f.calls.length, 0);
});

test('native trade fees, realised PnL and matching metadata remain exact and optional', async () => {
  const value = { ...trade(1), user_id: undefined, fee_rate: '-0.00002', rpnl: '0.123456789012345678901', match_role: 'MAKER', position_mode: 'SINGLE', position_side: 'NONE' };
  const result = (await fixture(() => json([value])).client.getTrades())[0];
  for (const field of ['transaction_id', 'order_id', 'fee', 'fee_coin', 'fee_rate', 'rpnl', 'create_time', 'match_role', 'position_mode', 'position_side']) assert.equal(result[field], value[field]);
});
