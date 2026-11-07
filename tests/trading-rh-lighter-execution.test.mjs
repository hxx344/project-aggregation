import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ExecutionExchangeError, createExecutionExchangeClient } from '../server/trading-execution-exchanges.mjs';
import { createRhLighterExecutionClient, clientOrderIndexOf, protectivePrice, orderPrice, RH_LIGHTER_SYMBOLS, RH_LIGHTER_TX_EXPIRES_MS } from '../server/trading-rh-lighter-execution.mjs';

// Fixture values only: no real wallet, account or API key.
const ADDRESS = '0x' + 'Ab'.repeat(20);
const OWNER = ADDRESS.toLowerCase();
const KEY = 'C3'.repeat(40);
const credentials = { address: ADDRESS, accountIndex: 12345, apiKeyIndex: 5, apiKey: '0x' + KEY };
const T0 = Date.UTC(2026, 10, 7, 8);
const DAY = 86_400_000;
const SEND = '/api/v1/sendTx';
const DETAILS = { market_id: 7, symbol: 'ANTHROPIC', market_type: 'perp', status: 'active', is_frozen: false, size_decimals: 2, price_decimals: 2,
  min_base_amount: '0.05', min_quote_amount: '10', order_quote_limit: '250000', default_initial_margin_fraction: 1000 };
const BOOK = { bids: [{ price: '352.00', remaining_base_amount: '3' }, { price: '352.10', remaining_base_amount: '1' }], asks: [{ price: '352.40', remaining_base_amount: '1' }, { price: '352.30', remaining_base_amount: '2' }] };

const isError = (code, extra = {}) => error => error instanceof ExecutionExchangeError && error.code === code && Object.entries(extra).every(([key, value]) => error[key] === value);
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const ok = body => json({ code: 200, ...body });
const spec = (overrides = {}) => ({ symbol: 'ANTHROPIC', side: 'buy', positionSide: 'BOTH', quantity: '0.5', reduceOnly: false, clientId: 'h' + '1'.repeat(30), orderType: 'chase', stopPrice: null, limitPrice: '352.1', assetId: 7, ...overrides });
const indexOf = value => clientOrderIndexOf(value.clientId);
const orderRow = (value, overrides = {}) => ({ market_index: 7, client_order_index: indexOf(value), order_index: 281474976710700, is_ask: value.side === 'sell', reduce_only: value.reduceOnly, type: 'limit',
  time_in_force: value.orderType === 'market' ? 'immediate-or-cancel' : 'post-only', status: 'open', timestamp: T0 / 1000,
  initial_base_amount: value.quantity, filled_base_amount: '0', remaining_base_amount: value.quantity, filled_quote_amount: '0', price: value.limitPrice, ...overrides });

function harness({ routes = {}, sends = [], signer: patch = {}, timeoutMs } = {}) {
  let time = T0, lastHash = null;
  const calls = [], signs = [], sleeps = [], orders = new Map();
  const nonce = { value: 41 };
  const tx = (txType, params) => {
    const { privateKey: _privateKey, ...info } = params;
    const txInfo = JSON.stringify(info);
    lastHash = createHash('sha256').update(txInfo).digest('hex');
    return { txType, txInfo, txHash: lastHash };
  };
  const base = {
    async createOrder(params) { return tx(14, params); },
    async cancelOrder(params) { return tx(15, params); },
    async authToken(params) { return { authToken: `${params.deadline}:${params.accountIndex}:${params.apiKeyIndex}:${'ab'.repeat(40)}` }; },
  };
  const signer = Object.fromEntries(['createOrder', 'cancelOrder', 'authToken'].map(method => [method, async params => {
    signs.push({ method, params, at: time });
    return (patch[method] ?? base[method])(params);
  }]));
  const defaults = {
    '/api/v1/orderBooks': () => ok({ order_books: [{ symbol: 'ETH', market_id: 0, market_type: 'perp' }, { symbol: 'ANTHROPIC', market_id: 7, market_type: 'perp' }, { symbol: 'ANTHROPIC', market_id: 2049, market_type: 'spot' }] }),
    '/api/v1/orderBookDetails': () => ok({ order_book_details: [DETAILS] }),
    '/api/v1/orderBookOrders': () => ok({ total_asks: 2, asks: BOOK.asks, total_bids: 2, bids: BOOK.bids }),
    '/api/v1/accountsByL1Address': () => ok({ l1_address: ADDRESS, sub_accounts: [{ index: 12346, l1_address: ADDRESS }, { index: 12345, l1_address: ADDRESS }] }),
    '/api/v1/accountActiveOrders': () => ok({ orders: [] }),
    '/api/v1/account': () => ok({ accounts: [{ index: 12345, l1_address: ADDRESS, positions: [] }] }),
    '/api/v1/nextNonce': () => ok({ account_index: 12345, api_key_index: 5, nonce: nonce.value }),
    '/api/v1/accountOrders': query => ok({ orders: query.get('client_order_indexes').split(',').map(Number).filter(index => orders.has(index)).map(index => orders.get(index)) }),
    [SEND]: () => ok({ tx_hash: lastHash }),
  };
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url), path = parsed.pathname;
    const form = typeof init.body === 'string' ? new URLSearchParams(init.body) : null;
    calls.push({ url, path, query: parsed.searchParams, form, init, at: time });
    if (path === SEND && sends.length) {
      const next = sends.shift();
      return typeof next === 'function' ? next(form, init) : next;
    }
    const handler = routes[path] ?? defaults[path];
    if (!handler) throw new Error('unexpected request ' + url);
    if (handler instanceof Response) return handler.clone();
    const answer = typeof handler === 'function' ? await handler(path === SEND ? form : parsed.searchParams, init) : handler;
    return answer instanceof Response ? answer : json(answer);
  };
  const client = createRhLighterExecutionClient({ ErrorClass: ExecutionExchangeError, fetchImpl, now: () => time, signer,
    sleep: async ms => { sleeps.push(ms); time += ms; }, ...(timeoutMs ? { timeoutMs } : {}) });
  return {
    client, calls, signs, sleeps, orders, nonce,
    advance: ms => { time += ms; },
    get time() { return time; },
    get lastHash() { return lastHash; },
    paths: () => calls.map(call => call.path),
    of: path => calls.filter(call => call.path === path),
    signed: method => signs.filter(entry => entry.method === method),
  };
}

test('exports name the one Anthropic contract, the signed transaction lifetime and a stable client order index', () => {
  assert.deepEqual([...RH_LIGHTER_SYMBOLS], ['ANTHROPIC']);
  assert.equal(RH_LIGHTER_TX_EXPIRES_MS, 600_000);
  const first = clientOrderIndexOf('h' + '1'.repeat(30));
  assert.equal(clientOrderIndexOf('h' + '1'.repeat(30)), first);
  assert.notEqual(clientOrderIndexOf('h' + '2'.repeat(30)), first);
  for (const id of ['a', 'h' + '1'.repeat(30), 'x:y/z-1.2_3']) {
    const value = clientOrderIndexOf(id);
    assert.ok(Number.isSafeInteger(value) && value >= 1 && value <= 2 ** 48 - 1, id);
  }
  const client = createExecutionExchangeClient('rh-lighter', { fetchImpl: async () => { throw new Error('no network in tests'); } });
  assert.equal(client.exchange, 'rh-lighter');
  for (const method of ['verify', 'account', 'market', 'create', 'amend', 'inspect', 'stop', 'endedStrategies']) assert.equal(typeof client[method], 'function', method);
  assert.throws(() => createRhLighterExecutionClient({ fetchImpl: async () => {} }), TypeError);
  assert.throws(() => createRhLighterExecutionClient({ ErrorClass: ExecutionExchangeError, fetchImpl: null }), TypeError);
  for (const timeoutMs of [0, 120_001, 1.5]) assert.throws(() => createRhLighterExecutionClient({ ErrorClass: ExecutionExchangeError, fetchImpl: async () => {}, timeoutMs }), TypeError);
});

test('credentials are refused before any request or signature unless every index and the key are well formed', async () => {
  const bad = [
    null, { ...credentials, address: 'ab'.repeat(20) }, { ...credentials, address: '0x' + 'ab'.repeat(19) },
    { ...credentials, accountIndex: 0 }, { ...credentials, accountIndex: -1 }, { ...credentials, accountIndex: 1.5 }, { ...credentials, accountIndex: '12345' }, { ...credentials, accountIndex: 2 ** 53 },
    { ...credentials, apiKeyIndex: 3 }, { ...credentials, apiKeyIndex: 255 }, { ...credentials, apiKeyIndex: 157 }, { ...credentials, apiKeyIndex: '5' }, { ...credentials, apiKeyIndex: 0 },
    { ...credentials, apiKey: KEY.slice(2) }, { ...credentials, apiKey: KEY + 'ab' }, { ...credentials, apiKey: '0X' + KEY }, { ...credentials, apiKey: 'g'.repeat(80) },
    { ...credentials, apiKey: '0x' + KEY.slice(2) + 'zz' }, { ...credentials, apiKey: undefined },
  ];
  for (const value of bad) {
    const h = harness();
    await assert.rejects(h.client.verify(value), isError('credentials'), JSON.stringify(value));
    await assert.rejects(h.client.create(value, spec()), error => error instanceof ExecutionExchangeError && ['credentials', 'input'].includes(error.code));
    assert.equal(h.signs.length, 0);
    assert.equal(h.of(SEND).length, 0);
  }
  for (const apiKeyIndex of [4, 254]) {
    const h = harness();
    assert.deepEqual(await h.client.verify({ ...credentials, apiKeyIndex, apiKey: KEY }), { identity: OWNER, keyLabel: `12345#${apiKeyIndex}` });
    assert.equal(h.signed('authToken')[0].params.privateKey, KEY.toLowerCase(), 'the key reaches the signer lowercase without its 0x prefix');
  }
});

test('verify proves the account index belongs to the wallet and the API key signs for it', async () => {
  const h = harness();
  assert.deepEqual(await h.client.verify(credentials), { identity: OWNER, keyLabel: '12345#5' });
  assert.deepEqual(h.paths(), ['/api/v1/accountsByL1Address', '/api/v1/accountActiveOrders']);
  const [owned, active] = h.calls;
  assert.equal(owned.query.get('l1_address').toLowerCase(), OWNER);
  assert.equal(owned.init.method, 'GET');
  assert.equal(owned.init.redirect, 'error');
  assert.equal(active.query.get('account_index'), '12345');
  const deadline = T0 / 1000 + 1800;
  assert.deepEqual(h.signed('authToken')[0].params, { privateKey: KEY.toLowerCase(), apiKeyIndex: 5, accountIndex: 12345, deadline });
  assert.ok(active.init.headers.Authorization.startsWith(`${deadline}:12345:5:`));
  assert.ok(!JSON.stringify(h.calls.map(call => [call.url, call.init.headers])).includes(KEY.toLowerCase()), 'the private key never leaves the signer');
  await h.client.verify(credentials);
  assert.equal(h.calls.length, 2, 'a verified binding is reused briefly');
  h.advance(60_000);
  await h.client.verify(credentials);
  assert.equal(h.calls.length, 4, 'and re-read after one minute');

  const refusals = [
    { '/api/v1/accountsByL1Address': ok({ l1_address: ADDRESS, sub_accounts: [{ index: 12346, l1_address: ADDRESS }] }) },
    { '/api/v1/accountsByL1Address': ok({ l1_address: ADDRESS, sub_accounts: [{ index: 12345, l1_address: '0x' + 'cd'.repeat(20) }] }) },
    { '/api/v1/accountsByL1Address': ok({ l1_address: ADDRESS, sub_accounts: [{ index: 12345, l1_address: ADDRESS }, { index: 12345, l1_address: ADDRESS }] }) },
    { '/api/v1/accountsByL1Address': () => json({ code: 21100, message: 'account not found' }, 400) },
    { '/api/v1/accountsByL1Address': { code: 21100, message: 'account not found' } },
    { '/api/v1/accountActiveOrders': () => json({ code: 20013, message: 'invalid auth' }, 400) },
    // The live venue answers an expired or foreign token this way.
    { '/api/v1/accountActiveOrders': () => json({ code: 20013, message: 'invalid auth: expired token' }, 401) },
    { '/api/v1/accountActiveOrders': { code: 21120, message: 'invalid signature' } },
  ];
  for (const routes of refusals) await assert.rejects(harness({ routes }).client.verify(credentials), isError('permissions'), JSON.stringify(Object.keys(routes)));
  await assert.rejects(harness({ routes: { '/api/v1/accountsByL1Address': () => json({}, 429) } }).client.verify(credentials), isError('upstream'));
  await assert.rejects(harness({ routes: { '/api/v1/accountsByL1Address': { code: 23000 } } }).client.verify(credentials), isError('upstream'), 'a rate refusal is not reported as a missing account');
  await assert.rejects(harness({ routes: { '/api/v1/accountsByL1Address': ok({ l1_address: ADDRESS }) } }).client.verify(credentials), isError('invalid_data'));
  await assert.rejects(harness({ routes: { '/api/v1/accountActiveOrders': ok({}) } }).client.verify(credentials), isError('invalid_data'));
  const failing = harness({ signer: { authToken: async () => { throw new Error('bad key'); } } });
  await assert.rejects(failing.client.verify(credentials), isError('credentials'));
  assert.deepEqual(failing.paths(), ['/api/v1/accountsByL1Address'], 'no authenticated request without a token');
  for (const authToken of ['1:12345:5:ab', `${T0 / 1000 + 1800}:12345:6:ab`, `${T0 / 1000 + 1800}:12345:5:` + 'a'.repeat(1024), 7]) {
    await assert.rejects(harness({ signer: { authToken: async () => ({ authToken }) } }).client.verify(credentials), isError('credentials'), String(authToken).slice(0, 20));
  }
});

test('market maps live order book details to tick, step and limits, and refuses an untradable or ambiguous contract', async () => {
  const h = harness();
  assert.deepEqual(await h.client.market('ANTHROPIC'), { symbol: 'ANTHROPIC', bid: '352.1', ask: '352.3', at: new Date(T0).toISOString(),
    rule: { assetId: 7, tickSize: '0.01', quantityStep: '0.01', minQuantity: '0.05', maxQuantity: '100000', maxMarketQuantity: '100000', minNotional: '10', maxNotional: '250000', quoteAsset: 'USDG' } });
  assert.deepEqual(h.paths(), ['/api/v1/orderBooks', '/api/v1/orderBookDetails', '/api/v1/orderBookOrders']);
  assert.equal(h.calls[1].query.get('market_id'), '7');
  assert.deepEqual(Object.fromEntries(h.calls[2].query), { market_id: '7', limit: '5' });
  assert.ok(h.calls.every(call => call.init.headers.Authorization === undefined), 'no token exists before an account read');
  assert.equal('rule' in await h.client.market('ANTHROPIC', { withRule: false }), false);
  await assert.rejects(h.client.market('ANTHROPICUSDT'), isError('input'));

  const coarse = await harness({ routes: { '/api/v1/orderBookDetails': ok({ order_book_details: [{ ...DETAILS, price_decimals: 0, size_decimals: 4, min_base_amount: '0' }] }),
    '/api/v1/orderBookOrders': ok({ bids: [{ price: '352', remaining_base_amount: '1' }], asks: [{ price: '353', remaining_base_amount: '1' }] }) } }).client.market('ANTHROPIC');
  assert.deepEqual({ tick: coarse.rule.tickSize, step: coarse.rule.quantityStep, min: coarse.rule.minQuantity }, { tick: '1', step: '0.0001', min: '0.0001' });

  const details = overrides => ({ '/api/v1/orderBookDetails': ok({ order_book_details: [{ ...DETAILS, ...overrides }] }) });
  const cases = [
    [details({ status: 'inactive' }), 'not_tradable'], [details({ is_frozen: true }), 'not_tradable'], [details({ market_type: 'spot' }), 'not_tradable'],
    [details({ size_decimals: 9 }), 'invalid_data'], [details({ price_decimals: -1 }), 'invalid_data'], [details({ min_base_amount: '0.055' }), 'invalid_data'],
    [details({ min_base_amount: '-1' }), 'invalid_data'], [details({ min_base_amount: 0.05 }), 'invalid_data'], [details({ order_quote_limit: '0' }), 'invalid_data'],
    [details({ default_initial_margin_fraction: 0 }), 'invalid_data'], [details({ min_quote_amount: undefined }), 'invalid_data'],
    [{ '/api/v1/orderBookDetails': ok({ order_book_details: [DETAILS, DETAILS] }) }, 'invalid_data'],
    [{ '/api/v1/orderBooks': ok({ order_books: [{ symbol: 'ANTHROPIC', market_id: 7, market_type: 'spot' }] }) }, 'not_tradable'],
    [{ '/api/v1/orderBooks': ok({ order_books: [{ symbol: 'ANTHROPIC', market_id: 7, market_type: 'perp' }, { symbol: 'ANTHROPIC', market_id: 9, market_type: 'perp' }] }) }, 'not_tradable'],
    [{ '/api/v1/orderBooks': ok({ order_books: [{ symbol: 'ANTHROPIC', market_id: '7', market_type: 'perp' }] }) }, 'invalid_data'],
    [{ '/api/v1/orderBooks': ok({}) }, 'invalid_data'],
    [{ '/api/v1/orderBookOrders': ok({ bids: [{ price: '352.3', remaining_base_amount: '1' }], asks: BOOK.asks }) }, 'invalid_data'],
    [{ '/api/v1/orderBookOrders': ok({ bids: [], asks: BOOK.asks }) }, 'not_tradable'],
    [{ '/api/v1/orderBookOrders': ok({ bids: [{ price: '-1', remaining_base_amount: '1' }], asks: BOOK.asks }) }, 'invalid_data'],
    [{ '/api/v1/orderBookOrders': ok({ bids: [{ price: '352.1', remaining_base_amount: '0' }], asks: BOOK.asks }) }, 'invalid_data'],
    [{ '/api/v1/orderBookOrders': ok({ bids: [{ price: 352.1, remaining_base_amount: '1' }], asks: BOOK.asks }) }, 'invalid_data'],
    [{ '/api/v1/orderBookOrders': () => new Response('<html>busy</html>', { status: 200 }) }, 'invalid_data'],
    [{ '/api/v1/orderBookOrders': () => json({}, 200, { 'content-length': String(3 * 1024 * 1024) }) }, 'response_limit'],
    [{ '/api/v1/orderBookOrders': () => json({ error: 'busy' }, 503) }, 'upstream'],
  ];
  for (const [routes, code] of cases) await assert.rejects(harness({ routes }).client.market('ANTHROPIC'), isError(code, { uncertain: false }), JSON.stringify(routes));

  let moved = 0;
  const renumbered = harness({ routes: { '/api/v1/orderBookDetails': () => ok({ order_book_details: [{ ...DETAILS, market_id: moved++ ? 7 : 8 }] }) } });
  await assert.rejects(renumbered.client.market('ANTHROPIC'), isError('not_tradable'));
  await renumbered.client.market('ANTHROPIC');
  assert.equal(renumbered.of('/api/v1/orderBooks').length, 2, 'a renumbered contract drops the cached market id');
});

test('book, rule and market id caches expire on their own clocks', async () => {
  const h = harness();
  const count = path => h.of(path).length;
  await h.client.market('ANTHROPIC');
  h.advance(3999); await h.client.market('ANTHROPIC');
  assert.equal(count('/api/v1/orderBookOrders'), 1);
  h.advance(1); const fresh = await h.client.market('ANTHROPIC');
  assert.equal(count('/api/v1/orderBookOrders'), 2, 'an order book is reused for under 4 s');
  assert.equal(fresh.at, new Date(T0 + 4000).toISOString(), 'the quote age is the receive time');
  h.advance(5999); await h.client.market('ANTHROPIC', { withRule: false });
  assert.equal(count('/api/v1/orderBookOrders'), 2, 'display reads accept a book under 6 s old');
  h.advance(1); await h.client.market('ANTHROPIC', { withRule: false });
  assert.equal(count('/api/v1/orderBookOrders'), 3);
  assert.equal(count('/api/v1/orderBookDetails'), 1);
  h.advance(60_000 - 10_000); await h.client.market('ANTHROPIC');
  assert.equal(count('/api/v1/orderBookDetails'), 2, 'contract rules are re-read after one minute');
  assert.equal(count('/api/v1/orderBooks'), 1);
  h.advance(600_000 - 60_000); await h.client.market('ANTHROPIC');
  assert.equal(count('/api/v1/orderBooks'), 2, 'the market id is re-read after ten minutes');
});

test('the auth token is refreshed ten minutes before its deadline and public reads carry it only while valid', async () => {
  const h = harness();
  await h.client.verify(credentials);
  const token = h.of('/api/v1/accountActiveOrders')[0].init.headers.Authorization;
  await h.client.market('ANTHROPIC');
  assert.ok(h.of('/api/v1/orderBooks').every(call => call.init.headers.Authorization === token), 'market reads count against the account, not the shared IP');
  h.advance(1_199_999);
  await assert.rejects(h.client.inspect(credentials, spec({ clientId: 'a1' })), isError('not_found'));
  assert.equal(h.signed('authToken').length, 1);
  assert.equal(h.of('/api/v1/accountOrders')[0].init.headers.Authorization, token);
  h.advance(1);
  await assert.rejects(h.client.inspect(credentials, spec({ clientId: 'a2' })), isError('not_found'));
  assert.equal(h.signed('authToken').length, 2);
  assert.equal(h.signed('authToken')[1].params.deadline, (T0 + 1_200_000) / 1000 + 1800);
  assert.notEqual(h.of('/api/v1/accountOrders')[1].init.headers.Authorization, token);

  const idle = harness();
  await idle.client.verify(credentials);
  idle.advance(1_200_000);
  await idle.client.market('ANTHROPIC');
  assert.ok(idle.of('/api/v1/orderBooks').every(call => call.init.headers.Authorization === undefined), 'an expired token is not sent');
});

test('a token the venue refuses is signed again on the next request, and disconnecting forgets every token and identity', async () => {
  let refuse = true;
  const h = harness({ routes: { '/api/v1/accountOrders': () => refuse ? json({ code: 20013, message: 'invalid auth' }, 401) : ok({ orders: [] }) } });
  await assert.rejects(h.client.inspect(credentials, spec({ clientId: 'd1' })), isError('permissions', { providerCode: 20013 }));
  assert.equal(h.signed('authToken').length, 1);
  refuse = false;
  await assert.rejects(h.client.inspect(credentials, spec({ clientId: 'd2' })), isError('not_found'));
  assert.equal(h.signed('authToken').length, 2, 'the refused token is not reused');
  await h.client.verify(credentials); await h.client.verify(credentials);
  const lookups = h.of('/api/v1/accountsByL1Address').length;
  assert.equal(lookups, 1, 'a verified identity is cached');
  h.client.forget();
  h.advance(600_000);
  const after = h.calls.length;
  await h.client.market('ANTHROPIC');
  const reads = h.calls.slice(after);
  assert.ok(reads.length && reads.every(call => call.init.headers.Authorization === undefined), 'market reads go back to unauthenticated');
  await assert.rejects(h.client.inspect(credentials, spec({ clientId: 'd3' })), isError('not_found'));
  assert.equal(h.signed('authToken').length, 3, 'a new connection signs a new token');
  await h.client.verify(credentials);
  assert.equal(h.of('/api/v1/accountsByL1Address').length, lookups + 1, 'identity is read again');
});

test('a call still in flight when the key is forgotten neither signs nor caches anything for it', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ routes: { '/api/v1/accountsByL1Address': async () => { await gate; return ok({ l1_address: ADDRESS, sub_accounts: [{ index: 12345, l1_address: ADDRESS }] }); } } });
  const pending = h.client.verify(credentials);
  await new Promise(resolve => setImmediate(resolve));
  h.client.forget();
  release();
  await assert.rejects(pending, isError('aborted'));
  assert.equal(h.signed('authToken').length, 0, 'no signature for a forgotten key');
  const after = h.calls.length;
  await h.client.market('ANTHROPIC');
  assert.ok(h.calls.slice(after).every(call => call.init.headers.Authorization === undefined), 'no token was cached');
});

test('a create waiting for its nonce when the key is forgotten is refused as not sent, unsigned and unsent', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ routes: { '/api/v1/nextNonce': async () => { await gate; return ok({ account_index: 12345, api_key_index: 5, nonce: 41 }); } } });
  await h.client.market('ANTHROPIC');
  const pending = h.client.create(credentials, spec());
  for (let index = 0; index < 20 && !h.of('/api/v1/nextNonce').length; index += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.of('/api/v1/nextNonce').length, 1, 'the create is held at the nonce read');
  h.client.forget();
  release();
  await assert.rejects(pending, error => isError('aborted', { notSent: true })(error) && !error.uncertain);
  assert.deepEqual([h.signed('createOrder').length, h.of(SEND).length], [0, 0]);
});

test('an order timestamp in milliseconds is refused, since the venue reports seconds', async () => {
  const value = spec({ id: String(indexOf(spec())) });
  const h = harness({ routes: { '/api/v1/accountOrders': ok({ orders: [orderRow(spec(), { timestamp: T0 })] }) } });
  await assert.rejects(h.client.inspect(credentials, value), isError('invalid_data'));
});

test('account reports positions, open orders and the account leverage of the selected contract', async () => {
  const h = harness({ routes: {
    '/api/v1/account': ok({ accounts: [{ index: 12345, l1_address: ADDRESS, positions: [
      { market_id: 0, position: '3', sign: 1, margin_mode: 0, initial_margin_fraction: '10.00' },
      { market_id: 7, position: '1.50', sign: -1, margin_mode: 1, initial_margin_fraction: '20.00' },
    ] }] }),
    '/api/v1/accountActiveOrders': ok({ orders: [
      { market_index: 7, client_order_index: 77, order_index: 5, is_ask: false, reduce_only: true, initial_base_amount: '2', filled_base_amount: '0.5' },
      { market_index: 7, client_order_index: 0, order_index: 281474976710700, is_ask: true, reduce_only: false, initial_base_amount: '1.00', filled_base_amount: '0' },
    ] }),
  } });
  assert.deepEqual(await h.client.account(credentials, { symbols: ['ANTHROPIC'] }), {
    identity: OWNER, modes: { ANTHROPIC: 'one-way' }, strategies: [],
    positions: [{ symbol: 'ANTHROPIC', side: 'short', quantity: '1.5' }],
    openOrders: [
      { id: '77', symbol: 'ANTHROPIC', side: 'buy', positionSide: 'BOTH', quantity: '2', filledQuantity: '0.5', reduceOnly: true },
      { id: '281474976710700', symbol: 'ANTHROPIC', side: 'sell', positionSide: 'BOTH', quantity: '1', filledQuantity: '0', reduceOnly: false },
    ],
    leverage: { ANTHROPIC: { type: 'isolated', value: 5 } },
  });
  assert.deepEqual(Object.fromEntries(h.of('/api/v1/account')[0].query), { by: 'index', value: '12345' });
  assert.deepEqual(Object.fromEntries(h.of('/api/v1/accountActiveOrders')[0].query), { account_index: '12345', market_id: '7' });
  assert.ok(h.of('/api/v1/account')[0].init.headers.Authorization && h.of('/api/v1/accountActiveOrders')[0].init.headers.Authorization);
  assert.equal(h.of(SEND).length, 0, 'reading the account sends nothing');

  const flat = harness();
  const empty = await flat.client.account(credentials);
  assert.deepEqual({ positions: empty.positions, openOrders: empty.openOrders, leverage: empty.leverage }, { positions: [], openOrders: [], leverage: { ANTHROPIC: { type: 'cross', value: 10 } } }, 'no position: the market default leverage');
  const closed = await harness({ routes: { '/api/v1/account': ok({ accounts: [{ index: 12345, l1_address: ADDRESS, positions: [{ market_id: 7, position: '0', sign: 0, margin_mode: 0, initial_margin_fraction: '33.33' }] }] }) } }).client.account(credentials);
  assert.deepEqual({ positions: closed.positions, leverage: closed.leverage }, { positions: [], leverage: { ANTHROPIC: { type: 'cross', value: 3 } } });

  const account = positions => ({ '/api/v1/account': ok({ accounts: [{ index: 12345, l1_address: ADDRESS, positions }] }) });
  const position = overrides => ({ market_id: 7, position: '1', sign: 1, margin_mode: 0, initial_margin_fraction: '20', ...overrides });
  const active = orders => ({ '/api/v1/accountActiveOrders': ok({ orders }) });
  const open = overrides => ({ market_index: 7, client_order_index: 77, order_index: 5, is_ask: false, reduce_only: false, initial_base_amount: '1', filled_base_amount: '0', ...overrides });
  const cases = [
    [{ '/api/v1/account': ok({ accounts: [{ index: 12346, l1_address: ADDRESS, positions: [] }] }) }, 'permissions'],
    [{ '/api/v1/account': ok({ accounts: [{ index: 12345, l1_address: '0x' + 'cd'.repeat(20), positions: [] }] }) }, 'permissions'],
    [{ '/api/v1/account': ok({ accounts: [] }) }, 'invalid_data'],
    [{ '/api/v1/account': ok({ accounts: [{ index: 12345, l1_address: ADDRESS }] }) }, 'invalid_data'],
    [account([position({ sign: 0 })]), 'invalid_data'], [account([position({ position: '-1' })]), 'invalid_data'],
    [account([position({ margin_mode: 2 })]), 'invalid_data'], [account([position({ initial_margin_fraction: '0.5' })]), 'invalid_data'],
    [account([position({ initial_margin_fraction: '0' })]), 'invalid_data'], [account([position(), position()]), 'invalid_data'],
    [{ '/api/v1/accountActiveOrders': ok({ orders: [], next_cursor: 'abc' }) }, 'pagination'],
    [active([open({ market_index: 0 })]), 'invalid_data'], [active([open({ filled_base_amount: '2' })]), 'invalid_data'],
    [active([open({ is_ask: 'false' })]), 'invalid_data'], [active([open({ client_order_index: 0, order_index: 0 })]), 'invalid_data'],
    [{ '/api/v1/accountActiveOrders': ok({}) }, 'pagination'],
  ];
  for (const [routes, code] of cases) await assert.rejects(harness({ routes }).client.account(credentials), isError(code), JSON.stringify(routes));
  await assert.rejects(harness().client.account(credentials, { symbols: ['CLUSDT'] }), isError('input'));
});

test('order prices: chase prices must sit on the tick grid inside the chase limit; IOC protection is 1% through the book, rounded outward', () => {
  assert.equal(protectivePrice('buy', '352.3', '0.01'), '355.83');
  assert.equal(protectivePrice('sell', '352.1', '0.01'), '348.57');
  assert.equal(protectivePrice('buy', '100', '0.01'), '101');
  assert.equal(protectivePrice('sell', '100', '0.01'), '99');
  assert.equal(protectivePrice('buy', '0.01', '0.01'), '0.02');
  assert.equal(protectivePrice('sell', '0.01', '0.01'), null, 'a protection price that rounds to zero is refused');
  const chase = overrides => ({ side: 'buy', orderType: 'chase', limitPrice: '352.1', stopPrice: null, ...overrides });
  assert.deepEqual(orderPrice(chase(), '0.01'), { price: '352.1', problem: null });
  assert.deepEqual(orderPrice({ ...chase(), orderType: 'market', limitPrice: '352.3' }, '0.01'), { price: '355.83', problem: null });
  assert.equal(orderPrice(chase({ limitPrice: '352.105' }), '0.01').problem, '价格不满足 Lighter RH 精度');
  assert.equal(orderPrice(chase({ limitPrice: '352.1' }), '1').problem, '价格不满足 Lighter RH 精度');
  assert.equal(orderPrice(chase({ limitPrice: '352.1' }), '0').problem, '价格不满足 Lighter RH 精度');
  assert.equal(orderPrice({ ...chase(), side: 'sell', orderType: 'market', limitPrice: '0.01' }, '0.01').problem, '价格不满足 Lighter RH 精度');
  assert.equal(orderPrice(chase({ limitPrice: '42949672.96' }), '0.01').problem, '价格不满足 Lighter RH 精度', 'the wire price is a 32-bit tick count');
  assert.equal(orderPrice(chase({ limitPrice: '42949672.95' }), '0.01').problem, null);
  assert.equal(orderPrice(chase({ stopPrice: '352.1' }), '0.01').problem, '委托价已达到追价界限');
  assert.equal(orderPrice(chase({ stopPrice: '352.11' }), '0.01').problem, null);
  assert.equal(orderPrice(chase({ side: 'sell', limitPrice: '352.3', stopPrice: '352.3' }), '0.01').problem, '委托价已达到追价界限');
  assert.equal(orderPrice(chase({ side: 'sell', limitPrice: '352.3', stopPrice: '352.29' }), '0.01').problem, null);
});

test('create signs one post-only order with the next nonce and a 2 hour expiry, sends it after the final guard and claims it once visible', async () => {
  const h = harness();
  const chase = spec();
  h.orders.set(indexOf(chase), orderRow(chase));
  let guarded = 0;
  assert.deepEqual(await h.client.create(credentials, chase, { beforeMutation: () => { guarded += 1; assert.equal(h.of(SEND).length, 0); } }), { id: String(indexOf(chase)), kind: 'order' });
  assert.equal(guarded, 1);
  assert.deepEqual(h.paths(), ['/api/v1/orderBooks', '/api/v1/orderBookDetails', '/api/v1/nextNonce', SEND, '/api/v1/accountOrders']);
  assert.deepEqual(Object.fromEntries(h.of('/api/v1/nextNonce')[0].query), { account_index: '12345', api_key_index: '5' });
  assert.ok(h.of('/api/v1/nextNonce')[0].init.headers.Authorization);
  assert.deepEqual(h.signed('createOrder')[0].params, { marketIndex: 7, clientOrderIndex: indexOf(chase), baseAmount: 50, price: 35210, isAsk: 0, orderType: 0, timeInForce: 2, reduceOnly: 0,
    orderExpiry: T0 + 2 * 3_600_000, privateKey: KEY.toLowerCase(), apiKeyIndex: 5, accountIndex: 12345, nonce: 41 });
  const [send] = h.of(SEND);
  assert.equal(send.init.method, 'POST');
  assert.equal(send.init.redirect, 'error');
  assert.equal(send.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(send.init.headers.Authorization, undefined);
  assert.deepEqual([...send.form.keys()], ['tx_type', 'tx_info', 'price_protection']);
  assert.equal(send.form.get('tx_type'), '14');
  assert.equal(send.form.get('price_protection'), 'true');
  assert.equal(JSON.parse(send.form.get('tx_info')).clientOrderIndex, indexOf(chase), 'tx_info is the signer output verbatim');
  assert.ok(!send.init.body.toLowerCase().includes(KEY.toLowerCase()));
  assert.equal(h.of('/api/v1/accountOrders')[0].query.get('client_order_indexes'), String(indexOf(chase)));
  assert.deepEqual(h.sleeps, [300]);

  const taker = spec({ orderType: 'market', side: 'sell', reduceOnly: true, limitPrice: '352.1', clientId: 'h' + '2'.repeat(30) });
  h.orders.set(indexOf(taker), orderRow(taker, { status: 'filled', filled_base_amount: '0.5', remaining_base_amount: '0', filled_quote_amount: '174.3', price: '348.57' }));
  assert.deepEqual(await h.client.create(credentials, taker), { id: String(indexOf(taker)), kind: 'order' });
  const ioc = h.signed('createOrder')[1].params;
  assert.deepEqual({ price: ioc.price, isAsk: ioc.isAsk, timeInForce: ioc.timeInForce, reduceOnly: ioc.reduceOnly, orderExpiry: ioc.orderExpiry, nonce: ioc.nonce },
    { price: 34857, isAsk: 1, timeInForce: 0, reduceOnly: 1, orderExpiry: 0, nonce: 42 });
  assert.equal(h.of('/api/v1/nextNonce').length, 1, 'an accepted send advances the cached nonce');
});

test('create waits for the predicted execution time, bounded, before looking for the order', async () => {
  for (const [offset, expected] of [[5000, 1800], [200, 500], [-1000, 300]]) {
    const h = harness({ sends: [() => ok({ tx_hash: h.lastHash, predicted_execution_time_ms: h.time + offset })] });
    h.orders.set(indexOf(spec()), orderRow(spec()));
    await h.client.create(credentials, spec());
    assert.deepEqual(h.sleeps, [expected], String(offset));
  }
});

test('an accepted create that never becomes visible, or reads back wrong, stays uncertain', async () => {
  const missing = harness();
  await assert.rejects(missing.client.create(credentials, spec()), isError('not_found', { uncertain: true, accepted: true }));
  assert.deepEqual(missing.sleeps, [300, 1000]);
  assert.equal(missing.of('/api/v1/accountOrders').length, 2);
  assert.equal(missing.of(SEND).length, 1, 'never re-sent');

  let reads = 0;
  const late = harness({ routes: { '/api/v1/accountOrders': () => ok({ orders: reads++ ? [orderRow(spec())] : [] }) } });
  assert.equal((await late.client.create(credentials, spec())).id, String(indexOf(spec())));

  for (const row of [orderRow(spec(), { is_ask: true }), orderRow(spec(), { time_in_force: 'good-till-time' }), orderRow(spec(), { status: 'weird' })]) {
    const wrong = harness({ routes: { '/api/v1/accountOrders': ok({ orders: [row] }) } });
    await assert.rejects(wrong.client.create(credentials, spec()), isError('invalid_data', { uncertain: true, accepted: true }));
  }
  const unreadable = harness({ routes: { '/api/v1/accountOrders': () => json({ error: 'busy' }, 500) } });
  await assert.rejects(unreadable.client.create(credentials, spec()), isError('upstream', { uncertain: true, accepted: true }));
  const duplicate = harness({ routes: { '/api/v1/accountOrders': ok({ orders: [orderRow(spec()), orderRow(spec())] }) } });
  await assert.rejects(duplicate.client.create(credentials, spec()), isError('invalid_data', { uncertain: true }));
});

test('sends are serialized so nonces stay in order, and any unaccepted send re-reads the nonce', async () => {
  const h = harness();
  const a = spec({ clientId: 'n1' }), b = spec({ clientId: 'n2' });
  h.orders.set(indexOf(a), orderRow(a)); h.orders.set(indexOf(b), orderRow(b));
  await Promise.all([h.client.create(credentials, a), h.client.create(credentials, b)]);
  assert.deepEqual(h.signed('createOrder').map(entry => entry.params.nonce), [41, 42]);
  assert.equal(h.of('/api/v1/nextNonce').length, 1);

  const failures = [
    () => json({ code: 21104, message: 'invalid nonce' }, 400),
    () => ok({ tx_hash: 'f'.repeat(64) }),
    () => json({ error: 'busy' }, 502),
  ];
  for (const failure of failures) {
    const f = harness({ sends: [failure] });
    const first = spec({ clientId: 'f1' }), second = spec({ clientId: 'f2' });
    f.orders.set(indexOf(second), orderRow(second));
    await assert.rejects(f.client.create(credentials, first));
    f.nonce.value = 57;
    await f.client.create(credentials, second);
    assert.equal(f.of('/api/v1/nextNonce').length, 2);
    assert.deepEqual(f.signed('createOrder').map(entry => entry.params.nonce), [41, 57]);
  }

  for (const nonce of [-1, '41', 1.5, null]) {
    const bad = harness({ routes: { '/api/v1/nextNonce': ok({ nonce }) } });
    await assert.rejects(bad.client.create(credentials, spec()), isError('invalid_data', { uncertain: false }), String(nonce));
    assert.equal(bad.signed('createOrder').length, 0);
    assert.equal(bad.of(SEND).length, 0);
  }

  const unsigned = harness({ signer: { createOrder: async () => { throw new Error('wasm failed'); } } });
  await assert.rejects(unsigned.client.create(credentials, spec()), isError('credentials', { uncertain: false }));
  assert.equal(unsigned.of(SEND).length, 0);
  for (const result of [{ txType: 14, txInfo: '{}', txHash: 'XYZ' }, { txType: '14', txInfo: '{}', txHash: 'a'.repeat(64) }, { txType: 14, txInfo: 'x'.repeat(8193), txHash: 'a'.repeat(64) }, null]) {
    const malformed = harness({ signer: { createOrder: async () => result } });
    await assert.rejects(malformed.client.create(credentials, spec()), isError('credentials'));
    assert.equal(malformed.of(SEND).length, 0);
  }
});

test('create refuses a stale market id, an off-grid order or a reached chase limit before signing', async () => {
  const refusals = [
    [spec({ assetId: 8 }), 'not_tradable'], [spec({ quantity: '0.005' }), 'input'], [spec({ limitPrice: '352.105' }), 'input'],
    [spec({ stopPrice: '352.1' }), 'input'], [spec({ positionSide: 'LONG' }), 'input'], [spec({ orderType: 'market', stopPrice: '360' }), 'input'],
    [spec({ clientId: 'bad id' }), 'input'], [spec({ clientId: 'x'.repeat(33) }), 'input'], [spec({ quantity: '3000000000000' }), 'input'],
    [spec({ limitPrice: undefined }), 'input'], [spec({ orderType: 'stop' }), 'input'], [spec({ symbol: 'io:ANTH' }), 'input'], [spec({ reduceOnly: 'false' }), 'input'],
    [spec({ orderType: 'market', side: 'sell', limitPrice: '0.01' }), 'input'],
  ];
  for (const [value, code] of refusals) {
    const h = harness();
    await assert.rejects(h.client.create(credentials, value, { beforeMutation: () => assert.fail('must not reach the final guard') }), isError(code), JSON.stringify(value));
    assert.equal(h.signed('createOrder').length, 0);
    assert.equal(h.of(SEND).length, 0);
  }
  const guarded = harness();
  await assert.rejects(guarded.client.create(credentials, spec(), { beforeMutation: () => { throw new Error('lease lost'); } }), /lease lost/);
  assert.equal(guarded.of(SEND).length, 0, 'a refused final guard sends nothing');
  await assert.rejects(guarded.client.amend(credentials, spec({ id: String(indexOf(spec())) })), isError('input'));
  await assert.rejects(guarded.client.endedStrategies(credentials, { symbol: 'ANTHROPIC' }), isError('input'));
});

test('sendTx answers: only explicit refusals are definitive, a duplicate client index and anything ambiguous stay uncertain', async () => {
  const cases = [
    [() => json({ code: 21728, message: 'order already exists' }, 400), isError('upstream', { uncertain: true, providerCode: 21728 })],
    [() => json({ code: 20013, message: 'invalid auth' }, 400), isError('permissions', { uncertain: false, providerCode: 20013 })],
    [() => json({ code: 21109, message: 'api key not found' }, 400), isError('permissions', { uncertain: false })],
    [() => json({ code: 21120, message: 'invalid signature' }, 400), isError('permissions', { uncertain: false })],
    [() => json({ code: 21739, message: 'not enough margin' }, 400), error => isError('rejected', { uncertain: false, providerCode: 21739 })(error) && /保证金不足/.test(error.message)],
    [() => json({ code: 21733, message: 'price too far' }, 400), error => isError('rejected', { uncertain: false })(error) && /偏离标记价格/.test(error.message)],
    [() => json({ code: 52002 }, 400), isError('rejected', { uncertain: false })],
    [() => json({ code: 99999 }, 400), error => isError('rejected', { uncertain: false, providerCode: 99999 })(error) && /代码 99999/.test(error.message)],
    [() => json({ code: 'x' }, 400), isError('rejected', { uncertain: false })],
    [() => new Response('bad request', { status: 400 }), isError('rejected', { uncertain: false })],
    [() => json({}, 429), isError('rejected', { uncertain: false })],
    [() => json({}, 405), isError('rejected', { uncertain: false })],
    ...[401, 403, 404, 413, 415, 422].map(status => [() => json({}, status), isError('rejected', { uncertain: false })]),
    ...[408, 500, 502, 504].map(status => [() => json({}, status), isError('upstream', { uncertain: true })]),
    [() => new Response(null, { status: 302, headers: { location: 'https://example.invalid' } }), isError('upstream', { uncertain: true })],
    [() => new Response('not json', { status: 200 }), isError('invalid_data', { uncertain: true })],
    [() => json([]), isError('invalid_data', { uncertain: true })],
    [() => json({ code: 21739, message: 'in a 200 body' }), isError('upstream', { uncertain: true })],
    [() => json({ code: 21120 }), isError('upstream', { uncertain: true })],
    [() => ok({}), isError('invalid_data', { uncertain: true })],
    [() => ok({ tx_hash: 'f'.repeat(64) }), isError('invalid_data', { uncertain: true })],
    [() => json({ code: 200 }, 200, { 'content-length': String(3 * 1024 * 1024) }), isError('response_limit', { uncertain: true })],
    [() => { throw new TypeError('socket hang up'); }, isError('transport', { uncertain: true })],
  ];
  for (const [answer, expected] of cases) {
    const h = harness({ sends: [answer] });
    await assert.rejects(h.client.create(credentials, spec()), expected, answer.toString());
    assert.equal(h.of(SEND).length, 1, 'never retried');
    assert.equal(h.of('/api/v1/accountOrders').length, 0);
  }
  const slow = harness({ timeoutMs: 20, sends: [(_form, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))] });
  await assert.rejects(slow.client.create(credentials, spec()), isError('timeout', { uncertain: true }));
  const controller = new AbortController();
  const aborted = harness({ sends: [() => new Promise(() => { controller.abort(); })] });
  await assert.rejects(aborted.client.create(credentials, spec(), { signal: controller.signal }), isError('aborted', { uncertain: true }));
  const early = harness();
  await assert.rejects(early.client.create(credentials, spec(), { signal: AbortSignal.abort() }), isError('aborted', { uncertain: false }));
  assert.equal(early.calls.length, 0);
  const slowRead = harness({ timeoutMs: 20, routes: { '/api/v1/accountsByL1Address': (_query, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) } });
  await assert.rejects(slowRead.client.verify(credentials), isError('timeout', { uncertain: false }));
});

test('a 429, 405 or code 23000 starts a 60 s cooldown during which nothing is requested', async () => {
  for (const routes of [{ '/api/v1/orderBooks': () => json({}, 429) }, { '/api/v1/orderBooks': () => json({}, 405) }, { '/api/v1/orderBooks': { code: 23000 } }, { '/api/v1/orderBooks': () => json({ code: 23000 }, 400) }]) {
    let refusing = true;
    const h = harness({ routes: { '/api/v1/orderBooks': (...args) => refusing ? (typeof routes['/api/v1/orderBooks'] === 'function' ? routes['/api/v1/orderBooks'](...args) : json(routes['/api/v1/orderBooks'])) : ok({ order_books: [{ symbol: 'ANTHROPIC', market_id: 7, market_type: 'perp' }] }) } });
    await assert.rejects(h.client.market('ANTHROPIC'), isError('upstream', { rateLimited: true, retryAt: T0 + 60_000 }));
    refusing = false;
    h.advance(59_999);
    await assert.rejects(h.client.market('ANTHROPIC'), error => isError('upstream')(error) && /冷却/.test(error.message));
    await assert.rejects(h.client.verify(credentials), isError('upstream'));
    assert.equal(h.calls.length, 1, 'the cooldown blocks every path');
    h.advance(1);
    await h.client.market('ANTHROPIC');
  }

  const limited = harness({ sends: [() => json({ code: 23000, message: 'too many requests' }, 400)] });
  await assert.rejects(limited.client.create(credentials, spec()), error => isError('rejected', { uncertain: false, providerCode: 23000, rateLimited: true, retryAt: T0 + 60_000 })(error) && error.notSent === undefined, 'a venue refusal reached the venue');
  const before = limited.calls.length;
  await assert.rejects(limited.client.create(credentials, spec({ clientId: 'c2' })), error => error instanceof ExecutionExchangeError && error.uncertain === false);
  assert.equal(limited.calls.length, before, 'a refused send is not followed by another request inside the cooldown');

  let refuse = false;
  const primed = harness({ routes: { '/api/v1/accountOrders': () => refuse ? json({}, 429) : ok({ orders: [] }) } });
  // Leaves the market rule and the next nonce cached, so the next create goes straight to sendTx.
  await assert.rejects(primed.client.create(credentials, spec()), isError('not_found', { uncertain: true }));
  refuse = true;
  await assert.rejects(primed.client.inspect(credentials, spec({ clientId: 'c3' })), isError('upstream'));
  await assert.rejects(primed.client.create(credentials, spec({ clientId: 'c4' })), error => isError('rejected', { uncertain: false, notSent: true })(error) && /冷却/.test(error.message));
  await assert.rejects(primed.client.stop(credentials, spec({ id: String(indexOf(spec())) })), error => error instanceof ExecutionExchangeError && error.uncertain === false && error.notSent === true, 'a cancel refused locally is marked not sent');
  assert.equal(primed.of(SEND).length, 1, 'a send inside the cooldown is refused locally');
});

test('only failures before the final send guard are marked not sent; an abort after acceptance stays uncertain', async () => {
  const value = spec({ id: String(indexOf(spec())) });
  const noNonce = harness({ routes: { '/api/v1/nextNonce': () => json({}, 503) } });
  await assert.rejects(noNonce.client.stop(credentials, value), isError('upstream', { notSent: true }));
  const unsigned = harness({ signer: { cancelOrder: async () => { throw new Error('boom'); } } });
  await assert.rejects(unsigned.client.stop(credentials, value), isError('credentials', { notSent: true }));
  const noRule = harness({ routes: { '/api/v1/orderBookDetails': () => json({}, 503) } });
  await assert.rejects(noRule.client.stop(credentials, value), isError('upstream', { notSent: true }));
  const refused = harness({ sends: [() => json({ code: 21709 }, 400)] });
  await assert.rejects(refused.client.stop(credentials, value), error => isError('rejected')(error) && error.notSent === undefined);
  const lost = harness({ sends: [() => json({}, 500)] });
  await assert.rejects(lost.client.stop(credentials, value), error => isError('upstream', { uncertain: true })(error) && error.notSent === undefined);
  assert.equal(noNonce.of(SEND).length + unsigned.of(SEND).length + noRule.of(SEND).length, 0);

  const controller = new AbortController();
  const accepted = harness({ sends: [() => { controller.abort(); return ok({ tx_hash: accepted.lastHash }); }] });
  await assert.rejects(accepted.client.create(credentials, spec(), { signal: controller.signal }), error => isError('aborted', { uncertain: true })(error) && error.notSent === undefined);
  assert.equal(accepted.of(SEND).length, 1);
});

test('a bounced post-only order drops the cached book so the re-send reads a new one', async () => {
  const h = harness();
  await h.client.market('ANTHROPIC');
  h.orders.set(indexOf(spec()), orderRow(spec(), { status: 'canceled-post-only', remaining_base_amount: '0' }));
  assert.equal((await h.client.inspect(credentials, spec({ id: String(indexOf(spec())) }))).bounced, true);
  await h.client.market('ANTHROPIC');
  assert.equal(h.of('/api/v1/orderBookOrders').length, 2);
});

test('the local limit admits 40 requests per rolling minute and fails a request that would wait longer than 8 s', async () => {
  const h = harness({ routes: { '/api/v1/accountOrders': ok({ orders: [] }) } });
  for (let index = 0; index < 40; index += 1) await assert.rejects(h.client.inspect(credentials, spec({ clientId: 'r' + index })), isError('not_found'));
  assert.equal(h.calls.length, 40);
  await assert.rejects(h.client.inspect(credentials, spec({ clientId: 'r40' })), error => isError('upstream', { uncertain: false, rateLimited: true, retryAt: T0 + 60_000 })(error) && /本地限速/.test(error.message));
  h.advance(51_999);
  await assert.rejects(h.client.inspect(credentials, spec({ clientId: 'r51' })), error => isError('upstream')(error) && /本地限速/.test(error.message));
  assert.equal(h.calls.length, 40, 'refused before sending');
  assert.deepEqual(h.sleeps, [], 'a long wait is not queued');
  h.advance(1);
  await assert.rejects(h.client.inspect(credentials, spec({ clientId: 'r52' })), isError('not_found'));
  assert.deepEqual(h.sleeps, [8000], 'a wait of up to 8 s is slept, then sent');
  assert.equal(h.calls.length, 41);
  assert.equal(h.calls[40].at, T0 + 60_000);

  const m = harness();
  m.orders.set(indexOf(spec()), orderRow(spec()));
  await m.client.create(credentials, spec());
  const used = m.calls.length;
  for (let index = used; index < 40; index += 1) await assert.rejects(m.client.inspect(credentials, spec({ clientId: 'm' + index })), isError('not_found'));
  await assert.rejects(m.client.create(credentials, spec({ clientId: 'm-next' })), error => isError('rejected', { uncertain: false, rateLimited: true })(error) && /本地限速/.test(error.message));
  assert.equal(m.of(SEND).length, 1);
});

test('inspect maps venue order states, flags a bounced post-only order and averages fills from quote over base', async () => {
  const look = async (row, value = spec({ id: String(indexOf(spec())) })) => harness({ routes: { '/api/v1/accountOrders': ok({ orders: [row] }) } }).client.inspect(credentials, value);
  assert.deepEqual(await look(orderRow(spec())), { id: String(indexOf(spec())), kind: 'order', status: 'working', quantity: '0.5', filledQuantity: '0', price: '352.1', averagePrice: null,
    terminal: false, childrenSettled: false, symbol: 'ANTHROPIC', side: 'buy', reduceOnly: false, positionSide: 'BOTH', createdAt: new Date(T0).toISOString() });
  for (const status of ['pending', 'in-progress']) assert.equal((await look(orderRow(spec(), { status }))).terminal, false, status);
  const filled = await look(orderRow(spec(), { status: 'filled', filled_base_amount: '0.5', remaining_base_amount: '0', filled_quote_amount: '176.1' }));
  assert.deepEqual({ status: filled.status, terminal: filled.terminal, settled: filled.childrenSettled, filled: filled.filledQuantity, average: filled.averagePrice, bounced: filled.bounced },
    { status: 'terminal', terminal: true, settled: true, filled: '0.5', average: '352.2', bounced: undefined });
  const partial = await look(orderRow(spec(), { status: 'canceled', filled_base_amount: '0.2', remaining_base_amount: '0', filled_quote_amount: '70.43' }));
  assert.deepEqual({ terminal: partial.terminal, filled: partial.filledQuantity, average: partial.averagePrice }, { terminal: true, filled: '0.2', average: '352.15' });
  const bounced = await look(orderRow(spec(), { status: 'canceled-post-only', remaining_base_amount: '0' }));
  assert.deepEqual({ terminal: bounced.terminal, bounced: bounced.bounced, filled: bounced.filledQuantity }, { terminal: true, bounced: true, filled: '0' });
  assert.equal('bounced' in await look(orderRow(spec(), { status: 'canceled-post-only', filled_base_amount: '0.1', remaining_base_amount: '0', filled_quote_amount: '35.21' })), false, 'a partly filled order did not bounce');
  assert.equal('bounced' in await look(orderRow(spec(), { status: 'canceled' })), false);
  const taker = spec({ orderType: 'market', side: 'sell' });
  const ioc = await look(orderRow(taker, { status: 'canceled-not-enough-liquidity', filled_base_amount: '0.3', remaining_base_amount: '0', filled_quote_amount: '105.6' }), taker);
  assert.deepEqual({ terminal: ioc.terminal, average: ioc.averagePrice, side: ioc.side, bounced: ioc.bounced }, { terminal: true, average: '352', side: 'sell', bounced: undefined });

  const bad = [
    orderRow(spec(), { status: 'weird' }), orderRow(spec(), { time_in_force: 'good-till-time' }), orderRow(spec(), { market_index: 8 }), orderRow(spec(), { is_ask: true }),
    orderRow(spec(), { reduce_only: true }), orderRow(spec(), { type: 'market' }), orderRow(spec(), { timestamp: 0 }), orderRow(spec(), { timestamp: undefined }),
    orderRow(spec(), { status: 'filled', filled_base_amount: '0.4', remaining_base_amount: '0', filled_quote_amount: '140' }),
    orderRow(spec(), { filled_base_amount: '0.2', remaining_base_amount: '0.4', filled_quote_amount: '70' }), orderRow(spec(), { filled_base_amount: '0.6' }),
    orderRow(spec(), { filled_base_amount: '0.2', remaining_base_amount: '0.3', filled_quote_amount: undefined }), orderRow(spec(), { filled_base_amount: '0.2', remaining_base_amount: '0.3', filled_quote_amount: '0' }),
    orderRow(spec(), { price: '-1' }), orderRow(spec(), { initial_base_amount: 0.5 }), orderRow(spec(), { remaining_base_amount: '-0.1' }),
  ];
  for (const row of bad) await assert.rejects(look(row), isError('invalid_data'), JSON.stringify(row));
  await assert.rejects(harness({ routes: { '/api/v1/accountOrders': ok({ orders: [orderRow(spec()), orderRow(spec())] }) } }).client.inspect(credentials, spec()), isError('invalid_data'));
  await assert.rejects(harness({ routes: { '/api/v1/accountOrders': ok({ orders: Array.from({ length: 21 }, () => orderRow(spec({ clientId: 'other' }))) }) } }).client.inspect(credentials, spec()), isError('invalid_data'));
  await assert.rejects(harness().client.inspect(credentials, spec()), isError('not_found', { notFound: true }));
  await assert.rejects(harness().client.inspect(credentials, spec({ id: '1' })), isError('input'), 'an id must be the client order index of this client id');
  const unanswered = harness();
  unanswered.orders.set(indexOf(spec()), orderRow(spec()));
  assert.equal((await unanswered.client.inspect(credentials, spec({ id: null }))).id, String(indexOf(spec())), 'an unanswered create is found by client index alone');
});

test('order reads are shared for 4 s and dropped by every send', async () => {
  const h = harness();
  const value = spec({ id: String(indexOf(spec())) });
  h.orders.set(indexOf(spec()), orderRow(spec()));
  await h.client.inspect(credentials, value);
  h.advance(3999);
  await h.client.inspect(credentials, value);
  assert.equal(h.of('/api/v1/accountOrders').length, 1);
  h.advance(1);
  await h.client.inspect(credentials, value);
  assert.equal(h.of('/api/v1/accountOrders').length, 2);
  await h.client.stop(credentials, value);
  h.orders.set(indexOf(spec()), orderRow(spec(), { status: 'canceled' }));
  assert.equal((await h.client.inspect(credentials, value)).terminal, true, 'a cancel is never answered from a read taken before it');
  assert.equal(h.of('/api/v1/accountOrders').length, 3);
});

test('stop signs a cancel by client order index after the final guard and returns the same id', async () => {
  const h = harness();
  const value = spec({ id: String(indexOf(spec())) });
  let guarded = 0;
  assert.deepEqual(await h.client.stop(credentials, value, { beforeMutation: () => { guarded += 1; assert.equal(h.of(SEND).length, 0); } }), { id: value.id });
  assert.equal(guarded, 1);
  assert.deepEqual(h.signed('cancelOrder')[0].params, { marketIndex: 7, index: indexOf(spec()), privateKey: KEY.toLowerCase(), apiKeyIndex: 5, accountIndex: 12345, nonce: 41 });
  assert.equal(h.of(SEND)[0].form.get('tx_type'), '15');
  assert.equal(h.of('/api/v1/accountOrders').length, 0, 'a cancel ACK is confirmed by a later inspect');
  await h.client.stop(credentials, value);
  assert.equal(h.signed('cancelOrder')[1].params.nonce, 42);

  for (const [stopValue, code] of [[spec({ id: null }), 'input'], [spec(), 'input'], [spec({ id: '1' }), 'input'], [spec({ id: value.id, assetId: 8 }), 'not_tradable']]) {
    const refused = harness();
    await assert.rejects(refused.client.stop(credentials, stopValue, { beforeMutation() {} }), isError(code), JSON.stringify(stopValue));
    assert.equal(refused.of(SEND).length, 0);
  }
  const gone = harness({ sends: [() => json({ code: 21709, message: 'order not found' }, 400)] });
  await assert.rejects(gone.client.stop(credentials, value), error => isError('rejected', { uncertain: false })(error) && /已成交、已撤销或不存在/.test(error.message));
  const lost = harness({ sends: [() => json({}, 500)] });
  await assert.rejects(lost.client.stop(credentials, value), isError('upstream', { uncertain: true }));
});
