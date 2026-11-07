import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTradingExecution } from '../server/trading-execution.mjs';
import { checkContract } from '../server/trading-execution-plan.mjs';
import { ExecutionExchangeError } from '../server/trading-execution-exchanges.mjs';
import { createRhLighterExecutionClient } from '../server/trading-rh-lighter-execution.mjs';

const baseTime = Date.UTC(2026, 10, 7, 8);
// Fixture-only values: the clients are fakes and never reach a venue.
const ADDRESS = '0x' + 'Ab'.repeat(20), OWNER = ADDRESS.toLowerCase();
const API_KEY = 'C3'.repeat(40);
const SHARES = { outstanding: '12.7', diluted: '16.7' };
const TEN_MINUTES = 600_000, CALL_TIMEOUT = 35_000, ARRIVAL_MARGIN = 60_000;
const anthropic = (overrides = {}) => ({ market: 'anthropic', preset: 'cross-exchange', action: 'open', shares: SHARES, equalSize: '167', legs: [
  { exchange: 'rh-lighter', symbol: 'ANTHROPIC', side: 'long', orderType: 'chase' },
  { exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'short', orderType: 'chase' },
], batchCount: 1, batchIntervalMs: 0, repriceIntervalMs: 1000, timeoutMs: 1_800_000, ...overrides });
const LIGHTER_RULE = { tickSize: '0.01', quantityStep: '0.01', minQuantity: '0.01', maxQuantity: '100000', minNotional: '10', maxNotional: '250000', maxMarketQuantity: '100000', assetId: 7, quoteAsset: 'USDG' };
const RULES = {
  'binance:ANTHROPICUSDT': { bid: '110.5', ask: '110.6', rule: { tickSize: '0.01', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '1000', minNotional: '5', maxNotional: null, maxMarketQuantity: '100' } },
  'hyperliquid:io:ANTH': { bid: '1616.4', ask: '1617', rule: { tickSize: '0.1', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '100000', minNotional: '10', maxNotional: null, maxMarketQuantity: '100000', assetId: 120001, quoteAsset: 'USDC' } },
  'rh-lighter:ANTHROPIC': { bid: '352.1', ask: '352.3', rule: LIGHTER_RULE },
};

/** The real Lighter RH adapter over a fake venue and a fake signer: an accepted create that never shows up. */
function venue(clock) {
  const requests = [];
  let lastHash = null;
  const ok = body => new Response(JSON.stringify({ code: 200, ...body }), { status: 200 });
  const signed = (txType, { privateKey: _key, ...params }) => {
    const txInfo = JSON.stringify(params);
    lastHash = createHash('sha256').update(txInfo).digest('hex');
    return { txType, txInfo, txHash: lastHash };
  };
  const signer = {
    async createOrder(params) { return signed(14, params); },
    async cancelOrder(params) { return signed(15, params); },
    async authToken({ deadline, accountIndex, apiKeyIndex }) { return { authToken: `${deadline}:${accountIndex}:${apiKeyIndex}:${'ab'.repeat(40)}` }; },
  };
  const answers = {
    '/api/v1/orderBooks': () => ok({ order_books: [{ symbol: 'ANTHROPIC', market_id: 7, market_type: 'perp' }] }),
    '/api/v1/orderBookDetails': () => ok({ order_book_details: [{ market_id: 7, symbol: 'ANTHROPIC', market_type: 'perp', status: 'active', is_frozen: false, size_decimals: 2, price_decimals: 2,
      min_base_amount: '0.01', min_quote_amount: '10', order_quote_limit: '250000', default_initial_margin_fraction: 1000 }] }),
    '/api/v1/orderBookOrders': () => ok({ bids: [{ price: '352.10', remaining_base_amount: '5' }], asks: [{ price: '352.30', remaining_base_amount: '5' }] }),
    '/api/v1/accountsByL1Address': () => ok({ sub_accounts: [{ index: 12345, l1_address: ADDRESS }] }),
    '/api/v1/accountActiveOrders': () => ok({ orders: [] }),
    '/api/v1/account': () => ok({ accounts: [{ index: 12345, l1_address: ADDRESS, positions: [] }] }),
    '/api/v1/nextNonce': () => ok({ nonce: 3 }),
    '/api/v1/sendTx': () => ok({ tx_hash: lastHash }),
    '/api/v1/accountOrders': () => ok({ orders: [] }),
  };
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    requests.push({ path: pathname, query: searchParams, form: init.body ? new URLSearchParams(init.body) : null });
    if (!answers[pathname]) throw new Error('unexpected request ' + url);
    return answers[pathname]();
  };
  const client = createRhLighterExecutionClient({ ErrorClass: ExecutionExchangeError, fetchImpl, now: clock, signer, sleep: async () => {} });
  return { client, requests, answers };
}

async function fixture(t, { realLighter = false } = {}) {
  const db = new DatabaseSync(':memory:');
  let time = baseTime, serial = 0;
  const records = new Map(), calls = [], handlers = {}, overrides = {};
  const accounts = {
    binance: { identity: null, modes: { ANTHROPICUSDT: 'one-way' }, positions: [], openOrders: [], strategies: [] },
    bybit: { identity: 'fixture-uid', modes: {}, positions: [], openOrders: [], strategies: [] },
    okx: { identity: 'fixture-uid', modes: {}, positions: [], openOrders: [], strategies: [] },
    hyperliquid: { identity: OWNER, modes: { 'io:ANTH': 'one-way', 'xyz:ANT': 'one-way' }, positions: [], openOrders: [], strategies: [], leverage: { 'io:ANTH': { type: 'isolated', value: 15 }, 'xyz:ANT': { type: 'cross', value: 10 } } },
    'rh-lighter': { identity: OWNER, modes: { ANTHROPIC: 'one-way' }, positions: [], openOrders: [], strategies: [], leverage: { ANTHROPIC: { type: 'cross', value: 10 } } },
  };
  const factory = exchange => Object.fromEntries(['verify', 'account', 'endedStrategies', 'market', 'create', 'amend', 'inspect', 'stop'].map(method => [method, async (...args) => {
    calls.push({ exchange, method, args, at: time });
    if (handlers[`${exchange}:${method}`]) return handlers[`${exchange}:${method}`](...args);
    if (method === 'verify') return { identity: accounts[exchange].identity, ...(exchange === 'rh-lighter' ? { keyLabel: `${args[0].accountIndex}#${args[0].apiKeyIndex}` } : {}), ...(exchange === 'hyperliquid' ? { agentAddress: '0x' + 'cd'.repeat(20) } : {}) };
    if (method === 'account') return structuredClone(accounts[exchange]);
    if (method === 'market') {
      const base = RULES[`${exchange}:${args[0]}`] ?? { bid: '70', ask: '70.01', rule: { tickSize: '0.01', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '100', minNotional: '5', maxNotional: null, maxMarketQuantity: '1' } };
      const result = { symbol: args[0], at: new Date(time).toISOString(), ...structuredClone(base), ...structuredClone(overrides[`${exchange}:${args[0]}`] ?? {}) };
      if (args[1]?.withRule === false) delete result.rule;
      return result;
    }
    const spec = args[1];
    if (method === 'create') {
      args[2].beforeMutation();
      const id = String(++serial), record = { ...spec, id, kind: 'order', status: 'working', terminal: false, childrenSettled: false, filledQuantity: '0', price: spec.limitPrice ?? '110.6', averagePrice: null, createdAt: new Date(time).toISOString() };
      records.set(id, record); return { id, kind: 'order' };
    }
    const record = spec.id ? records.get(spec.id) : [...records.values()].find(item => item.clientId === spec.clientId);
    if (!record) throw new ExecutionExchangeError('not_found', { notFound: true });
    if (method === 'inspect') { const { clientId: _clientId, assetId: _assetId, limitPrice: _limitPrice, orderType: _orderType, stopPrice: _stopPrice, ...value } = structuredClone(record); return value; }
    if (method === 'stop') { args[2].beforeMutation(); Object.assign(record, { status: 'terminal', terminal: true, childrenSettled: true }); return { id: record.id }; }
    throw new ExecutionExchangeError('input');
  }]));
  const stored = [], real = realLighter ? venue(() => time) : null;
  const wrapped = exchange => {
    if (exchange !== 'rh-lighter' || !real) return factory(exchange);
    return Object.fromEntries(Object.entries(real.client).map(([method, value]) => [method, typeof value === 'function' ? (...args) => { calls.push({ exchange, method, args, at: time }); return value(...args); } : value]));
  };
  const instance = createTradingExecution({ db, stmt: null, now: () => time, intervalMs: 0, encrypt: value => { stored.push(value); return JSON.stringify(value); }, decrypt: JSON.parse, clientFactory: wrapped });
  t.after(async () => { await instance.close(); db.close(); });
  await instance.initializeProtection();
  await instance.connect('binance', { revision: 0, accountMode: 'standard', apiKey: 'fixture_key', apiSecret: 'fixture_secret' });
  const lighterBody = (body = {}) => ({ revision: 0, accountMode: 'api-key', address: ADDRESS, accountIndex: 12345, apiKeyIndex: 5, apiKey: '0x' + API_KEY, ...body });
  return { db, records, calls, accounts, handlers, overrides, stored, real, service: instance, get time() { return time; }, advance(value) { time += value; },
    lighterBody,
    preview: (body = anthropic()) => instance.preview(body, 'session-a'),
    start: preview => instance.start({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, 'session-a'),
    connectLighter: (body = {}) => instance.connect('rh-lighter', lighterBody(body)),
    connectHyperliquid: () => instance.connect('hyperliquid', { revision: 0, accountMode: 'agent', address: ADDRESS, agentKey: '0x' + '11'.repeat(32) }),
    creates: exchange => calls.filter(call => call.method === 'create' && (!exchange || call.exchange === exchange)),
    stops: exchange => calls.filter(call => call.method === 'stop' && call.exchange === exchange),
    lighterOrder: () => [...records.values()].filter(record => record.symbol === 'ANTHROPIC').at(-1),
    get job() { return instance.state().jobs[0]; } };
}
const message = item => item.message ?? item;

const limitedRead = (f, offset = 60_000) => Object.assign(new ExecutionExchangeError('upstream', { detail: '请求过于频繁，已达到本地限速' }), { rateLimited: true, retryAt: f.time + offset });
async function advanceTicks(f, duration) {
  const end = f.time + duration;
  while (f.time < end) { f.advance(Math.min(10_000, end - f.time)); await f.service.tick(); }
}

test('Lighter RH rate-limited market reads keep the partly filled hedge and wait for the admission time', async t => {
  const f = await fixture(t); await f.connectLighter();
  f.start(await f.preview()); await f.service.tick();
  const sibling = [...f.records.values()].find(row => row.symbol === 'ANTHROPICUSDT');
  Object.assign(sibling, { filledQuantity: sibling.quantity, terminal: true, childrenSettled: true, status: 'terminal' });
  f.lighterOrder().filledQuantity = '0.4';
  f.handlers['rh-lighter:market'] = async () => { throw limitedRead(f); };
  await f.service.tick();
  assert.equal(f.job.status, 'running');
  assert.match(f.job.reason, /Lighter RH ANTHROPIC.*限速.*自动/);
  const before = f.calls.length;
  await advanceTicks(f, 59_999);
  assert.equal(f.calls.length, before, 'cooldown ticks do not poll or mutate');
  assert.equal(f.stops('rh-lighter').length, 0, 'the partly filled hedge stays on the book');
  delete f.handlers['rh-lighter:market'];
  await advanceTicks(f, 1);
  assert.equal(f.job.status, 'running'); assert.equal(f.job.reason, null);
  assert.equal(f.creates('binance').length, 1); assert.equal(f.creates('rh-lighter').length, 1);
  assert.equal(lighterLeg(f).filledQuantity, '0.4');
});

test('Lighter RH rate-limited pre-send reads cover verify, account and market and revalidate after cooling', async t => {
  for (const method of ['verify', 'account', 'market']) {
    const f = await fixture(t); await f.connectLighter();
    f.start(await f.preview());
    f.handlers[`rh-lighter:${method}`] = async () => { throw limitedRead(f); };
    await f.service.tick();
    assert.equal(f.job.status, 'queued', method); assert.equal(f.creates().length, 0);
    const before = f.calls.length;
    await advanceTicks(f, 59_999); assert.equal(f.calls.length, before);
    delete f.handlers[`rh-lighter:${method}`];
    await advanceTicks(f, 1);
    assert.equal(f.job.status, 'running'); assert.equal(f.creates().length, 2);
    assert.equal(f.job.reason, null);
  }
  const changed = await fixture(t); await changed.connectLighter();
  changed.start(await changed.preview());
  changed.handlers['rh-lighter:account'] = async () => { throw limitedRead(changed); };
  await changed.service.tick();
  delete changed.handlers['rh-lighter:account'];
  changed.accounts['rh-lighter'].openOrders = [{ symbol: 'ANTHROPIC', id: 'external-order' }];
  await advanceTicks(changed, 60_000);
  assert.equal(changed.job.status, 'paused'); assert.equal(changed.creates().length, 0, 'new external orders block recovery');
});

test('Lighter RH rate-limited status reads wait beyond the generic 20 s window without duplicate sends', async t => {
  const f = await fixture(t); await f.connectLighter();
  f.start(await f.preview()); await f.service.tick();
  f.handlers['rh-lighter:inspect'] = async () => { throw limitedRead(f); };
  await f.service.tick();
  const before = f.calls.length;
  await advanceTicks(f, 59_999);
  assert.equal(f.job.status, 'running'); assert.equal(f.calls.length, before);
  delete f.handlers['rh-lighter:inspect'];
  for (const row of f.records.values()) Object.assign(row, { filledQuantity: row.quantity, status: 'terminal', terminal: true, childrenSettled: true });
  await advanceTicks(f, 1);
  assert.equal(f.job.status, 'completed'); assert.equal(f.creates().length, 2); assert.equal(f.stops('rh-lighter').length, 0);
});

test('Lighter RH rate-limited cancel reconciliation preserves the partial fill and sends only the confirmed remainder', async t => {
  const f = await fixture(t); await f.connectLighter();
  f.start(await f.preview()); await f.service.tick();
  const original = f.lighterOrder(); original.filledQuantity = '0.4';
  const sibling = [...f.records.values()].find(row => row.symbol === 'ANTHROPICUSDT');
  Object.assign(sibling, { filledQuantity: sibling.quantity, status: 'terminal', terminal: true, childrenSettled: true });
  f.overrides['rh-lighter:ANTHROPIC'] = { bid: '352.2', ask: '352.3' };
  f.handlers['rh-lighter:stop'] = async (_credentials, _spec, options) => {
    options.beforeMutation();
    Object.assign(original, { status: 'terminal', terminal: true, childrenSettled: true });
    f.handlers['rh-lighter:inspect'] = async () => { throw limitedRead(f); };
    return { id: original.id };
  };
  await advanceTicks(f, 5000);
  assert.equal(f.job.status, 'running'); assert.equal(f.creates('rh-lighter').length, 1);
  const before = f.calls.length;
  await advanceTicks(f, 59_999); assert.equal(f.calls.length, before);
  delete f.handlers['rh-lighter:inspect']; delete f.handlers['rh-lighter:stop'];
  await advanceTicks(f, 1);
  assert.equal(f.job.status, 'running'); assert.equal(f.creates('rh-lighter').length, 2);
  assert.equal(f.creates('rh-lighter')[1].args[1].quantity, '9.6');
  assert.equal(f.creates('binance').length, 1); assert.equal(f.stops('rh-lighter').length, 1);
});

test('Lighter RH rate-limited reads have fixed time and attempt bounds despite successful status reads', async t => {
  for (const [offset, bound] of [[10_000, 30_000], [60_000, 180_000], [600_000, 180_000]]) {
    const f = await fixture(t); await f.connectLighter();
    f.start(await f.preview()); await f.service.tick();
    let reads = 0;
    f.handlers['rh-lighter:market'] = async () => { reads += 1; throw limitedRead(f, offset); };
    await f.service.tick();
    await advanceTicks(f, bound - 1); assert.equal(f.job.status, 'running');
    await advanceTicks(f, 1); assert.equal(f.job.status, 'paused');
    assert.equal(reads, offset === 10_000 ? 4 : offset === 60_000 ? 3 : 1);
    assert.match(f.job.reason, /限速.*(?:上限|超时|持续)/);
  }
});

test('Lighter RH rate-limited waits yield to user stop, deadline and hard sibling failures', async t => {
  for (const action of ['stop', 'deadline']) {
    const f = await fixture(t); await f.connectLighter();
    f.start(await f.preview(anthropic({ timeoutMs: 30_000 }))); await f.service.tick();
    f.handlers['rh-lighter:market'] = async () => { throw limitedRead(f); };
    await f.service.tick(); assert.equal(f.job.status, 'running');
    if (action === 'stop') f.service.stop(f.job.id, {});
    await advanceTicks(f, action === 'stop' ? 1000 : 30_000);
    assert.equal(f.job.status, action === 'stop' ? 'stopped' : 'paused');
    assert.equal(f.stops('rh-lighter').length, 1); assert.equal(f.creates().length, 2);
  }
  const f = await fixture(t); await f.connectLighter();
  f.start(await f.preview()); await f.service.tick();
  f.handlers['rh-lighter:inspect'] = async () => { throw limitedRead(f); };
  f.handlers['binance:inspect'] = async () => { throw new ExecutionExchangeError('invalid_data'); };
  await f.service.tick();
  assert.notEqual(f.job.status, 'running', 'a bad sibling response is not hidden by a rate limit');
});

test('Lighter RH rate-limited real adapter quota exhaustion holds a queued job and recovers after the rolling window', async t => {
  const f = await fixture(t, { realLighter: true }); await f.connectLighter();
  const preview = await f.preview();
  while (f.real.requests.length < 40) {
    try { await f.real.client.account(f.lighterBody(), { symbols: ['ANTHROPIC'] }); }
    catch (error) { assert.equal(error.rateLimited, true); break; }
  }
  assert.equal(f.real.requests.length, 40);
  f.start(preview); await f.service.tick();
  assert.equal(f.job.status, 'queued'); assert.match(f.job.reason, /已达到本地限速/);
  const before = f.real.requests.length;
  await advanceTicks(f, 59_999); assert.equal(f.real.requests.length, before);
  await advanceTicks(f, 1);
  assert.equal(f.job.status, 'running'); assert.equal(f.creates('rh-lighter').length, 1); assert.equal(f.creates('binance').length, 1);
});

test('Lighter RH rate-limited real adapter 429 cooldown is observed without sending or polling early', async t => {
  const f = await fixture(t, { realLighter: true }); await f.connectLighter();
  f.start(await f.preview());
  const original = f.real.answers['/api/v1/account'];
  f.real.answers['/api/v1/account'] = () => new Response('{}', { status: 429 });
  await f.service.tick();
  assert.equal(f.job.status, 'queued'); assert.equal(f.creates().length, 0);
  const count = f.real.requests.length;
  await advanceTicks(f, 59_999); assert.equal(f.real.requests.length, count);
  f.real.answers['/api/v1/account'] = original;
  await advanceTicks(f, 1);
  assert.equal(f.job.status, 'running'); assert.equal(f.creates().length, 2);
});

test('Lighter RH rate-limited read classification does not hide sibling errors or uncertain/unclassified results', async t => {
  for (const method of ['account', 'market']) {
    const f = await fixture(t); await f.connectLighter(); f.start(await f.preview());
    f.handlers[`rh-lighter:${method}`] = async () => { throw limitedRead(f); };
    f.handlers[`binance:${method}`] = async () => { await new Promise(resolve => setImmediate(resolve)); throw new ExecutionExchangeError('invalid_data'); };
    await f.service.tick();
    assert.equal(f.job.status, 'paused', method); assert.equal(f.creates().length, 0);
    assert.doesNotMatch(f.job.reason, /等待限速恢复/);
  }
  for (const change of [{ uncertain: true }, { rateLimited: false }, { retryAt: NaN }]) {
    const f = await fixture(t); await f.connectLighter(); f.start(await f.preview());
    f.handlers['rh-lighter:account'] = async () => { throw Object.assign(limitedRead(f), change); };
    await f.service.tick(); assert.equal(f.job.status, 'paused'); assert.equal(f.creates().length, 0);
  }
});

test('Lighter RH rate-limited reads clear only after a whole successful round and do not shorten accepted-create observation', async t => {
  const f = await fixture(t); await f.connectLighter();
  f.handlers['rh-lighter:create'] = async (_credentials, _spec, options) => { options.beforeMutation(); throw acceptedUnseen(); };
  f.start(await f.preview()); await f.service.tick();
  f.handlers['rh-lighter:inspect'] = async () => { throw limitedRead(f); };
  await f.service.tick();
  await advanceTicks(f, 59_999);
  delete f.handlers['rh-lighter:inspect'];
  await advanceTicks(f, 1);
  await advanceTicks(f, 130_000);
  assert.equal(f.job.status, 'running', 'confirmed not-found remains inside the accepted transaction lifetime');
  assert.equal(f.creates('rh-lighter').length, 1, 'an accepted create is never duplicated');
  assert.equal(f.job.reason, null);

  const g = await fixture(t); await g.connectLighter(); g.start(await g.preview()); await g.service.tick();
  g.handlers['rh-lighter:market'] = async () => { throw limitedRead(g, 10_000); };
  await g.service.tick(); await advanceTicks(g, 20_000);
  delete g.handlers['rh-lighter:market']; await advanceTicks(g, 10_000);
  assert.equal(g.job.reason, null);
  g.handlers['rh-lighter:market'] = async () => { throw limitedRead(g, 10_000); };
  await g.service.tick(); assert.equal(g.job.status, 'running', 'a successful complete round resets the previous attempt budget');
});

test('Lighter RH rate-limited reads never hide hard facts in fulfilled sibling responses', async t => {
  for (const mode of ['future-book', 'stop-price', 'early-terminal', 'external-order']) {
    const f = await fixture(t); await f.connectLighter();
    const body = anthropic(); body.legs[1].stopPrice = '100';
    f.start(await f.preview(body));
    if (mode !== 'external-order') await f.service.tick();
    if (mode === 'early-terminal') {
      const sibling = [...f.records.values()].find(row => row.symbol === 'ANTHROPICUSDT');
      Object.assign(sibling, { status: 'terminal', terminal: true, childrenSettled: true, filledQuantity: '0.1' });
      f.handlers['rh-lighter:inspect'] = async () => { throw limitedRead(f); };
    } else if (mode === 'external-order') {
      f.accounts.binance.openOrders = [{ symbol: 'ANTHROPICUSDT', id: 'external' }];
      f.handlers['rh-lighter:account'] = async () => { throw limitedRead(f); };
    } else {
      f.handlers['rh-lighter:market'] = async () => { throw limitedRead(f); };
      f.overrides['binance:ANTHROPICUSDT'] = mode === 'future-book' ? { at: new Date(f.time + 120_000).toISOString() } : { bid: '98', ask: '99' };
    }
    await f.service.tick();
    assert.notEqual(f.job.status, 'running', mode);
    assert.notEqual(f.job.status, 'queued', mode);
    assert.doesNotMatch(f.job.reason, /等待限速恢复/, mode);
    const diagnostic = mode === 'future-book' ? /盘口时间超前/ : mode === 'stop-price' ? /追价界限/ : mode === 'early-terminal' ? /提前终止/ : /本任务之外/;
    assert.ok(f.job.events.some(event => diagnostic.test(message(event))), mode);
    assert.equal(f.creates().length, mode === 'external-order' ? 0 : 2);
  }
});

test('Anthropic market legs refresh the fast book after a slow sibling before sending either leg', async t => {
  const f = await fixture(t); await f.connectLighter();
  const body = anthropic({ legs: anthropic().legs.map(leg => ({ ...leg, orderType: 'market' })) });
  f.start(await f.preview(body));
  f.handlers['rh-lighter:market'] = async symbol => {
    f.advance(11_000);
    return { symbol, at: new Date(f.time).toISOString(), ...structuredClone(RULES['rh-lighter:ANTHROPIC']) };
  };
  const before = f.calls.filter(call => call.method === 'market' && call.exchange === 'binance').length;
  await f.service.tick();
  assert.equal(f.job.status, 'running'); assert.equal(f.creates().length, 2);
  assert.ok(f.creates().every(call => call.args[1].orderType === 'market'));
  assert.equal(f.calls.filter(call => call.method === 'market' && call.exchange === 'binance').length - before, 2);
});

test('Anthropic market legs wait without sending on stale books and send once after fresh recovery', async t => {
  const f = await fixture(t); await f.connectLighter();
  const body = anthropic({ legs: anthropic().legs.map(leg => ({ ...leg, orderType: 'market' })) });
  f.start(await f.preview(body));
  f.overrides['binance:ANTHROPICUSDT'] = { at: new Date(f.time - 11_000).toISOString() };
  await f.service.tick();
  assert.equal(f.creates().length, 0); assert.equal(f.job.status, 'queued');
  assert.match(f.job.reason, /Binance ANTHROPICUSDT.*盘口已过期.*11\.0 秒/);
  f.advance(1000); await f.service.tick();
  assert.equal(f.creates().length, 0);
  delete f.overrides['binance:ANTHROPICUSDT'];
  await f.service.tick();
  assert.equal(f.job.status, 'running'); assert.equal(f.job.reason, null); assert.equal(f.creates().length, 2);
  for (const record of f.records.values()) Object.assign(record, { terminal: true, childrenSettled: true, status: 'terminal', filledQuantity: record.quantity });
  await f.service.tick();
  assert.equal(f.job.status, 'completed'); assert.equal(f.creates().length, 2);
});

test('a Lighter RH connection accepts exactly address, account index, API key index and API key, and shows only public labels', async t => {
  const f = await fixture(t);
  const refused = [
    { agentKey: '0x' + '11'.repeat(32) }, { apiSecret: 'fixture_secret' }, { passphrase: 'fixture-passphrase' },
    { apiKey: undefined }, { address: undefined }, { accountIndex: undefined }, { apiKeyIndex: undefined },
    { address: '0x12' }, { address: 'ab'.repeat(20) },
    { accountIndex: 0 }, { accountIndex: -1 }, { accountIndex: '-1' }, { accountIndex: 'abc' }, { accountIndex: 1.5 }, { accountIndex: '1.5' }, { accountIndex: '0x10' },
    { apiKeyIndex: 3 }, { apiKeyIndex: 255 }, { apiKeyIndex: 157 }, { apiKeyIndex: '157' }, { apiKeyIndex: ' 5' },
    { apiKey: API_KEY.slice(2) }, { apiKey: API_KEY + 'ab' }, { apiKey: 'g'.repeat(80) }, { apiKey: '0X' + API_KEY },
    { accountMode: 'agent' }, { accountMode: 'standard' },
  ];
  for (const patch of refused) {
    await assert.rejects(f.service.connect('rh-lighter', JSON.parse(JSON.stringify(f.lighterBody(patch)))), error => error.status === 400, JSON.stringify(patch));
  }
  assert.equal(f.calls.filter(call => call.exchange === 'rh-lighter').length, 0, 'malformed input never reaches the venue');

  const state = await f.connectLighter({ accountIndex: '12345', apiKeyIndex: '5' });
  const row = state.connections.find(item => item.exchange === 'rh-lighter');
  assert.deepEqual({ connected: row.connected, accountMode: row.accountMode, identity: row.identity, keyLabel: row.keyLabel }, { connected: true, accountMode: 'api-key', identity: OWNER, keyLabel: '12345#5' });
  assert.equal(JSON.stringify(state).toLowerCase().includes(API_KEY.toLowerCase()), false);
  const expected = { address: OWNER, accountIndex: 12345, apiKeyIndex: 5, apiKey: API_KEY.toLowerCase() };
  assert.deepEqual(f.stored.at(-1), { purpose: 'execution', exchange: 'rh-lighter', ...expected });
  const verify = f.calls.find(call => call.exchange === 'rh-lighter' && call.method === 'verify');
  assert.deepEqual(verify.args[0], expected, 'string indexes become numbers and the key loses its prefix before the adapter sees it');
  assert.deepEqual(f.calls.find(call => call.exchange === 'rh-lighter' && call.method === 'account').args[1].symbols, ['ANTHROPIC']);

  for (const apiKeyIndex of [4, 254]) {
    const g = await fixture(t);
    const connected = await g.connectLighter({ apiKeyIndex });
    assert.equal(connected.connections.find(item => item.exchange === 'rh-lighter').keyLabel, `12345#${apiKeyIndex}`);
  }
  f.start(await f.preview()); await f.service.tick();
  assert.deepEqual(f.creates('rh-lighter')[0].args[0], expected, 'orders are signed with the stored credentials');
});

test('an Anthropic preview sizes Lighter RH on diluted shares and reports its account leverage without changing it', async t => {
  const f = await fixture(t); await f.connectLighter();
  const preview = await f.preview();
  const legs = Object.fromEntries(preview.legs.map(leg => [leg.exchange, leg]));
  assert.equal(legs['rh-lighter'].quantity, '10', '167 B of value at 1 B diluted shares per unit');
  assert.equal(legs.binance.quantity, '13.149');
  assert.deepEqual(legs['rh-lighter'].leverage, { type: 'cross', value: 10 });
  assert.equal(legs['rh-lighter'].rule.quoteAsset, 'USDG');
  assert.ok(preview.notes.some(note => /Lighter RH ANTHROPIC 全仓 10x/.test(note) && /不修改/.test(note)));
  assert.ok(preview.notes.some(note => /Lighter RH 同样以只挂单（post-only）/.test(note) && /追价间隔至少 5 秒/.test(note)));
  const wider = await f.preview(anthropic({ shares: { outstanding: '12.7', diluted: '20' } }));
  assert.equal(wider.legs.find(leg => leg.exchange === 'rh-lighter').quantity, '8.35');
  const outstandingOnly = await f.preview(anthropic({ shares: { outstanding: '10', diluted: '16.7' } }));
  assert.equal(outstandingOnly.legs.find(leg => leg.exchange === 'rh-lighter').quantity, '10', 'the outstanding count does not move a diluted-basis leg');

  await f.connectHyperliquid();
  const pair = await f.preview(anthropic({ legs: [{ exchange: 'rh-lighter', symbol: 'ANTHROPIC', side: 'long' }, { exchange: 'hyperliquid', symbol: 'io:ANTH', side: 'short' }] }));
  assert.deepEqual(pair.legs.map(leg => leg.quantity), ['10', '10'], 'both venues price 1 B diluted shares per unit');
  const taker = await f.preview(anthropic({ legs: [{ exchange: 'rh-lighter', symbol: 'ANTHROPIC', side: 'long', orderType: 'market' }, { exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'short' }] }));
  assert.ok(taker.notes.some(note => /Lighter RH 市价腿按对手价 ±1% 的 IOC 限价委托发送/.test(note)));

  f.accounts['rh-lighter'].leverage = {};
  await assert.rejects(f.preview(), error => error.status === 502 && /Lighter RH ANTHROPIC 当前杠杆/.test(error.message));
  f.accounts['rh-lighter'].leverage = { ANTHROPIC: { type: 'cross', value: 101 } };
  await assert.rejects(f.preview(), error => error.status === 502);
  assert.equal(f.creates().length, 0, 'previews never send');
});

test('the contract check compares Lighter RH market id, quantity step and tick size', async t => {
  const leg = { exchange: 'rh-lighter', rule: { ...LIGHTER_RULE } };
  assert.doesNotThrow(() => checkContract(leg, { rule: { ...LIGHTER_RULE } }));
  for (const change of [{ tickSize: '0.1' }, { tickSize: '0.001' }]) {
    assert.throws(() => checkContract(leg, { rule: { ...LIGHTER_RULE, ...change } }), error => error.status === 409 && /Lighter RH 合约价格精度已改变/.test(error.message), JSON.stringify(change));
  }
  for (const change of [{ assetId: 8 }, { quantityStep: '0.1' }]) {
    assert.throws(() => checkContract(leg, { rule: { ...LIGHTER_RULE, ...change } }), error => error.status === 409 && /Lighter RH 合约编号或数量精度已改变/.test(error.message), JSON.stringify(change));
  }
  assert.throws(() => checkContract({ exchange: 'rh-lighter', rule: { ...LIGHTER_RULE, assetId: undefined } }, { rule: LIGHTER_RULE }), error => error.status === 409);
  const hyperliquid = { exchange: 'hyperliquid', rule: RULES['hyperliquid:io:ANTH'].rule };
  assert.doesNotThrow(() => checkContract(hyperliquid, { rule: { ...hyperliquid.rule, tickSize: '1' } }), 'Hyperliquid ticks follow the price and are not compared');

  const f = await fixture(t); await f.connectLighter();
  const preview = await f.preview();
  f.overrides['rh-lighter:ANTHROPIC'] = { bid: '352.1', ask: '352.3', rule: { ...LIGHTER_RULE, tickSize: '0.1' } };
  f.start(preview); await f.service.tick();
  assert.equal(f.creates().length, 0, 'no leg is sent once the tick changed');
  assert.notEqual(f.job.status, 'running');
  assert.match(f.job.reason ?? '', /Lighter RH 合约价格精度已改变/);
});

test('Lighter RH chase legs rest at the same-side best price and are repriced by exact cancel and re-send no faster than every 5 s', async t => {
  const f = await fixture(t); await f.connectLighter();
  f.start(await f.preview()); await f.service.tick();
  const [first] = f.creates('rh-lighter');
  assert.deepEqual({ assetId: first.args[1].assetId, limitPrice: first.args[1].limitPrice, side: first.args[1].side, positionSide: first.args[1].positionSide, quantity: first.args[1].quantity, orderType: first.args[1].orderType, reduceOnly: first.args[1].reduceOnly },
    { assetId: 7, limitPrice: '352.1', side: 'buy', positionSide: 'BOTH', quantity: '10', orderType: 'chase', reduceOnly: false });
  const original = f.lighterOrder();
  original.filledQuantity = '0.4';
  f.overrides['rh-lighter:ANTHROPIC'] = { bid: '352.2', ask: '352.3' };
  for (const step of [1000, 1000, 1000, 1000]) { f.advance(step); await f.service.tick(); }
  assert.equal(f.stops('rh-lighter').length, 0, 'a 1 s reprice interval is stretched to 5 s on Lighter RH');
  f.advance(999); await f.service.tick();
  assert.equal(f.stops('rh-lighter').length, 0);
  f.advance(1); await f.service.tick();
  assert.equal(f.stops('rh-lighter').length, 1);
  assert.equal(f.stops('rh-lighter')[0].args[1].id, original.id);
  assert.equal(f.calls.filter(call => call.method === 'amend' && call.exchange === 'rh-lighter').length, 0, 'Lighter RH orders are never amended');
  const resent = f.creates('rh-lighter');
  assert.equal(resent.length, 2);
  assert.deepEqual({ quantity: resent[1].args[1].quantity, limitPrice: resent[1].args[1].limitPrice }, { quantity: '9.6', limitPrice: '352.2' });
  assert.notEqual(resent[1].args[1].clientId, first.args[1].clientId);
  assert.equal(f.job.status, 'running');

  const slow = await fixture(t); await slow.connectLighter();
  slow.start(await slow.preview(anthropic({ repriceIntervalMs: 10_000 }))); await slow.service.tick();
  slow.overrides['rh-lighter:ANTHROPIC'] = { bid: '352.2', ask: '352.3' };
  for (let index = 0; index < 9; index += 1) { slow.advance(1000); await slow.service.tick(); }
  assert.equal(slow.stops('rh-lighter').length, 0, 'a longer configured interval is kept');
  slow.advance(1000); await slow.service.tick();
  assert.equal(slow.stops('rh-lighter').length, 1);
});

test('a post-only order the venue cancelled on arrival is re-sent in full from the next book; other early ends still pause', async t => {
  const f = await fixture(t); await f.connectLighter();
  f.start(await f.preview()); await f.service.tick();
  Object.assign(f.lighterOrder(), { status: 'terminal', terminal: true, childrenSettled: true, bounced: true });
  f.overrides['rh-lighter:ANTHROPIC'] = { bid: '352.2', ask: '352.4' };
  f.advance(1000); await f.service.tick();
  assert.equal(f.job.status, 'running');
  assert.equal(f.creates('rh-lighter').length, 1, 'a bounced order is not re-sent within 5 s of the last send');
  f.advance(4000); await f.service.tick();
  assert.equal(f.job.status, 'running');
  assert.equal(f.job.events.filter(item => /只挂单因盘口变化被取消/.test(message(item))).length, 1);
  const sent = f.creates('rh-lighter');
  assert.equal(sent.length, 2);
  assert.deepEqual({ quantity: sent[1].args[1].quantity, limitPrice: sent[1].args[1].limitPrice }, { quantity: '10', limitPrice: '352.2' });
  assert.equal(f.stops('rh-lighter').length, 0, 'nothing rests, so nothing is cancelled');
  assert.equal(f.creates('binance').length, 1, 'the sibling leg is not re-sent');
  Object.assign(f.lighterOrder(), { status: 'terminal', terminal: true, childrenSettled: true, bounced: true });
  f.advance(1000); await f.service.tick();
  assert.equal(f.creates('rh-lighter').length, 2);
  f.advance(4000); await f.service.tick();
  assert.equal(f.creates('rh-lighter').length, 3);
  assert.equal(f.job.events.filter(item => /只挂单因盘口变化被取消/.test(message(item))).length, 1, 'repeated bounces of one leg are reported once');

  const early = [
    ['an unfilled cancel without the bounce flag', { status: 'terminal', terminal: true, childrenSettled: true }],
    ['a bounce flag on a partly filled order', { status: 'terminal', terminal: true, childrenSettled: true, bounced: true, filledQuantity: '0.5' }],
  ];
  for (const [name, change] of early) {
    const g = await fixture(t); await g.connectLighter();
    g.start(await g.preview()); await g.service.tick();
    Object.assign(g.lighterOrder(), change);
    g.advance(1000); await g.service.tick();
    assert.notEqual(g.job.status, 'running', name);
    assert.match(g.job.reason ?? '', /委托提前终止且未全部成交/, name);
    assert.equal(g.creates('rh-lighter').length, 1, name);
  }

  const h = await fixture(t); await h.connectLighter(); await h.connectHyperliquid();
  h.start(await h.preview(anthropic({ legs: [{ exchange: 'hyperliquid', symbol: 'io:ANTH', side: 'long' }, { exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'short' }] }))); await h.service.tick();
  Object.assign([...h.records.values()].find(record => record.symbol === 'io:ANTH'), { status: 'terminal', terminal: true, childrenSettled: true, bounced: true });
  h.advance(1000); await h.service.tick();
  assert.notEqual(h.job.status, 'running', 'only Lighter RH inspections can report a bounce');
  assert.match(h.job.reason ?? '', /委托提前终止且未全部成交/);
});

test('a Lighter RH market leg starts from the opposite best price, is checked on the tick grid and never chased', async t => {
  const f = await fixture(t); await f.connectLighter();
  f.start(await f.preview(anthropic({ legs: [{ exchange: 'rh-lighter', symbol: 'ANTHROPIC', side: 'long', orderType: 'market' }, { exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'short', orderType: 'chase' }] })));
  await f.service.tick();
  const [order] = f.creates('rh-lighter');
  assert.deepEqual({ orderType: order.args[1].orderType, limitPrice: order.args[1].limitPrice, stopPrice: order.args[1].stopPrice, assetId: order.args[1].assetId }, { orderType: 'market', limitPrice: '352.3', stopPrice: null, assetId: 7 });
  f.overrides['rh-lighter:ANTHROPIC'] = { bid: '350', ask: '350.5' };
  for (let index = 0; index < 6; index += 1) { f.advance(1000); await f.service.tick(); }
  assert.equal(f.stops('rh-lighter').length, 0);
  assert.equal(f.creates('rh-lighter').length, 1);

  const g = await fixture(t); await g.connectLighter();
  const fine = { ...LIGHTER_RULE, tickSize: '0.000001' };
  g.overrides['rh-lighter:ANTHROPIC'] = { bid: '4200', ask: '4200.5', rule: fine };
  const preview = await g.preview(anthropic({ legs: [{ exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'short', orderType: 'chase' }, { exchange: 'rh-lighter', symbol: 'ANTHROPIC', side: 'long', orderType: 'market' }] }));
  // 1% through this ask exceeds 2^32 - 1 ticks of 0.000001, the largest wire price.
  g.overrides['rh-lighter:ANTHROPIC'] = { bid: '4252.5', ask: '4253', rule: fine };
  g.start(preview); await g.service.tick();
  assert.equal(g.creates().length, 0, 'the Binance sibling is not sent either');
  assert.notEqual(g.job.status, 'running');
  assert.match(g.job.reason ?? '', /Lighter RH ANTHROPIC 价格不满足 Lighter RH 精度，本组交易腿均未发送/);
});

test('cancels the adapter refused before sending do not use up the cancel budget; venue refusals still do', async t => {
  const run = async (refusal, refusals) => {
    const f = await fixture(t); await f.connectLighter();
    f.start(await f.preview()); await f.service.tick();
    let left = refusals;
    f.handlers['rh-lighter:stop'] = async (_credentials, spec, options) => {
      if (left > 0) { left -= 1; throw refusal(); }
      options.beforeMutation();
      Object.assign(f.records.get(spec.id), { status: 'terminal', terminal: true, childrenSettled: true });
      return { id: spec.id };
    };
    f.service.stop(f.job.id, {});
    for (let step = 0; step < 40; step += 1) { await f.service.tick(); f.advance(15_000); }
    return { stops: f.stops('rh-lighter').length, status: f.job.status, order: f.lighterOrder() };
  };
  const cooldown = () => Object.assign(new ExecutionExchangeError('rejected', { detail: '请求过于频繁，Lighter RH 冷却中' }), { notSent: true });
  const local = await run(cooldown, 8);
  assert.equal(local.stops, 9, 'eight local refusals, then the cancel goes out');
  assert.equal(local.order.terminal, true);
  assert.equal(local.status, 'stopped');

  const venueRefusal = await run(() => new ExecutionExchangeError('rejected', { providerCode: 21739 }), 8);
  assert.equal(venueRefusal.stops, 5, 'refusals that reached the venue keep the 5 attempt limit');
  assert.equal(venueRefusal.status, 'attention');

  const endless = await run(cooldown, 1000);
  assert.ok(endless.stops <= 30 + 5, `local refusals are capped too (${endless.stops})`);
  assert.equal(endless.status, 'attention');
});

test('an uncertain Lighter RH create is not settled before its signed transaction can no longer execute', async t => {
  const f = await fixture(t); await f.connectLighter();
  f.handlers['rh-lighter:create'] = async (_credentials, _spec, options) => { options.beforeMutation(); throw new ExecutionExchangeError('not_found', { uncertain: true }); };
  f.start(await f.preview()); await f.service.tick();
  const createdAt = f.time;
  const leg = () => f.job.legs.find(item => item.exchange === 'rh-lighter');
  assert.equal(leg().currentOrder.unknown, true);
  const settleAt = createdAt + TEN_MINUTES + CALL_TIMEOUT + ARRIVAL_MARGIN;
  while (f.time + 10_000 < settleAt) { f.advance(10_000); await f.service.tick(); }
  assert.equal(leg().currentOrder.unknown, true, 'a miss before the signed expiry is not proof of absence, unlike the 2 min window of other venues');
  assert.equal(f.creates('rh-lighter').length, 1);
  const clientId = f.creates('rh-lighter')[0].args[1].clientId;
  const lookups = f.calls.filter(call => call.exchange === 'rh-lighter' && call.method === 'inspect');
  assert.ok(lookups.length >= 2 && lookups.every(call => call.args[1].clientId === clientId && call.args[1].id === null), 'reads look the order up by its own client index');
  for (let index = 0; index < 10; index += 1) { f.advance(10_000); await f.service.tick(); }
  assert.notEqual(leg().currentOrder?.unknown, true, 'after the expiry and repeated misses with a clean account the create is settled');
  assert.equal(f.creates('rh-lighter').length, 1, 'settling never replays the uncertain create');
});

test('through the real adapter, an accepted create that never shows up is looked up by client index and settled only after the signed expiry', async t => {
  const f = await fixture(t, { realLighter: true }); await f.connectLighter();
  f.start(await f.preview()); await f.service.tick();
  const sends = () => f.real.requests.filter(request => request.path === '/api/v1/sendTx');
  assert.equal(sends().length, 1, 'one signed order left for the venue');
  const index = JSON.parse(sends()[0].form.get('tx_info')).clientOrderIndex;
  const leg = () => f.job.legs.find(item => item.exchange === 'rh-lighter');
  assert.equal(leg().currentOrder.unknown, true);
  for (let step = 0; step < 66; step += 1) { f.advance(10_000); await f.service.tick(); }
  assert.equal(leg().currentOrder.unknown, true, 'still unknown at 11 minutes');
  for (let step = 0; step < 10; step += 1) { f.advance(10_000); await f.service.tick(); }
  const lookups = f.real.requests.filter(request => request.path === '/api/v1/accountOrders');
  assert.ok(lookups.length >= 4 && lookups.every(request => request.query.get('client_order_indexes') === String(index)), `looked up by client order index (${lookups.length})`);
  assert.notEqual(leg().currentOrder?.unknown, true, 'repeated misses after the expiry settle the create');
  assert.equal(sends().length, 1, 'the unanswered order is never replayed');
});

const acceptedUnseen = () => Object.assign(new ExecutionExchangeError('not_found', { uncertain: true, notFound: true, detail: '委托已提交但尚未在交易所查到' }), { accepted: true });
const lighterLeg = f => f.job.legs.find(item => item.exchange === 'rh-lighter');

test('an accepted Lighter RH create that is not visible yet holds the task without pausing or cancelling the hedge, then continues once it shows up', async t => {
  const f = await fixture(t); await f.connectLighter();
  f.handlers['rh-lighter:create'] = async (_credentials, _spec, options) => { options.beforeMutation(); throw acceptedUnseen(); };
  f.start(await f.preview()); await f.service.tick();
  assert.equal(f.job.status, 'running');
  assert.equal(f.job.events.filter(item => /委托已被交易所接受但尚未查到/.test(message(item))).length, 1);
  const created = f.creates('rh-lighter')[0], hedges = f.creates('binance').length;
  assert.equal(hedges, 1);
  f.overrides['binance:ANTHROPICUSDT'] = { bid: '1260', ask: '1260.5' };
  for (let step = 0; step < 6; step += 1) { f.advance(10_000); await f.service.tick(); }
  assert.equal(f.job.status, 'running', 'a miss inside the signed lifetime does not pause');
  assert.equal(f.creates('rh-lighter').length, 1, 'never re-sent');
  assert.deepEqual([f.stops('binance').length, f.stops('rh-lighter').length, f.creates('binance').length, f.calls.filter(call => call.method === 'amend').length], [0, 0, hedges, 0], 'nothing is repriced, cancelled or sent meanwhile');
  delete f.overrides['binance:ANTHROPICUSDT'];
  const spec = created.args[1];
  f.records.set('late', { ...spec, id: 'late', kind: 'order', status: 'working', terminal: false, childrenSettled: false, filledQuantity: '0', price: spec.limitPrice ?? '352.1', averagePrice: null, createdAt: new Date(created.at).toISOString() });
  f.advance(10_000); await f.service.tick();
  assert.equal(f.job.status, 'running', f.job.reason);
  assert.equal(lighterLeg(f).currentOrder.unknown, false, 'found by its client index and claimed');
});

test('an accepted Lighter RH create still unseen after its signed lifetime and the recheck pauses the task', async t => {
  const f = await fixture(t); await f.connectLighter();
  f.handlers['rh-lighter:create'] = async (_credentials, _spec, options) => { options.beforeMutation(); throw acceptedUnseen(); };
  f.start(await f.preview()); await f.service.tick();
  f.accounts['rh-lighter'].openOrders = [{ symbol: 'ANTHROPIC', id: 'foreign' }];
  const createdAt = f.time, holdUntil = createdAt + TEN_MINUTES + CALL_TIMEOUT + ARRIVAL_MARGIN + 60_000;
  while (f.time + 10_000 < holdUntil) { f.advance(10_000); await f.service.tick(); }
  assert.equal(f.job.status, 'running', f.job.reason ?? 'held until the signed lifetime and the recheck have passed');
  for (let step = 0; step < 3; step += 1) { f.advance(10_000); await f.service.tick(); }
  assert.notEqual(f.job.status, 'running');
  assert.ok(f.job.events.some(item => /提交结果不明/.test(message(item))), 'paused because the accepted create is still unaccounted for');
  assert.equal(f.creates('rh-lighter').length, 1);
});

test('a Lighter RH create refused before it left (rate limit, cooldown) is re-planned after a spacing, capped at 30 in a row', async t => {
  const f = await fixture(t); await f.connectLighter();
  const cooled = () => Object.assign(new ExecutionExchangeError('rejected', { detail: '请求过于频繁，Lighter RH 冷却中' }), { notSent: true, rateLimited: true, retryAt: f.time + 30_000 });
  f.handlers['rh-lighter:create'] = async () => { throw cooled(); };
  const fallback = f.handlers['rh-lighter:create'];
  f.start(await f.preview()); await f.service.tick();
  const deferred = () => f.job.events.filter(item => /本次建单未送达交易所/.test(message(item))).length;
  assert.equal(f.job.status, 'running');
  assert.equal(deferred(), 1);
  assert.match(message(f.job.events.find(item => /本次建单未送达交易所/.test(message(item)))), /30 秒后/);
  f.advance(20_000); await f.service.tick();
  assert.equal(f.creates('rh-lighter').length, 1, 'not re-sent before the cooldown ends');
  f.advance(10_000); await f.service.tick();
  assert.equal(f.creates('rh-lighter').length, 2, 're-sent from the latest book once the cooldown ends');
  assert.equal(deferred(), 1, 'consecutive deferrals are reported once');
  delete f.handlers['rh-lighter:create'];
  f.advance(30_000); await f.service.tick();
  assert.equal(f.creates('rh-lighter').length, 3);
  assert.equal(lighterLeg(f).currentOrder.unknown, false);
  Object.assign(f.lighterOrder(), { status: 'terminal', terminal: true, childrenSettled: true, bounced: true });
  f.handlers['rh-lighter:create'] = fallback;
  f.advance(5000); await f.service.tick();
  assert.equal(f.creates('rh-lighter').length, 4);
  assert.equal(deferred(), 2, 'a real send resets the streak');
  assert.equal(f.job.status, 'running');

  const g = await fixture(t); await g.connectLighter();
  g.handlers['rh-lighter:create'] = async () => { throw Object.assign(new ExecutionExchangeError('transport', {}), { notSent: true }); };
  g.start(await g.preview()); await g.service.tick();
  for (let step = 0; step < 40 && g.job.status === 'running'; step += 1) { g.advance(10_000); await g.service.tick(); }
  assert.equal(g.creates('rh-lighter').length, 31, 'thirty deferrals, then the next refusal pauses');
  assert.notEqual(g.job.status, 'running');
  assert.match(g.job.reason ?? '', /下单结果/);

  const u = await fixture(t); await u.connectLighter();
  u.handlers['rh-lighter:create'] = async () => { throw Object.assign(new ExecutionExchangeError('rejected', { providerCode: 21700 }), {}); };
  u.start(await u.preview()); await u.service.tick();
  assert.notEqual(u.job.status, 'running', 'a refusal that reached the venue still pauses');
});

test('disconnecting Lighter RH makes the adapter forget its tokens, identities and signer', async t => {
  const f = await fixture(t, { realLighter: true }); await f.connectLighter();
  f.service.disconnect('rh-lighter', { revision: 1 });
  assert.equal(f.calls.filter(call => call.exchange === 'rh-lighter' && call.method === 'forget').length, 1);
});

test('while an accepted Lighter RH create is pending, a stop still cancels and an earlier transient read streak is cleared', async t => {
  const f = await fixture(t); await f.connectLighter();
  f.handlers['rh-lighter:create'] = async (_credentials, _spec, options) => { options.beforeMutation(); throw acceptedUnseen(); };
  f.start(await f.preview()); await f.service.tick();
  f.handlers['binance:inspect'] = async () => { throw new ExecutionExchangeError('timeout', {}); };
  for (let step = 0; step < 3; step += 1) { f.advance(1000); await f.service.tick(); }
  assert.equal(f.job.status, 'running', 'three quick transient misses stay inside the read window');
  delete f.handlers['binance:inspect'];
  f.advance(10_000); await f.service.tick();
  assert.ok(f.job.events.some(item => /委托状态已恢复读取/.test(message(item))), 'a clean pass while holding ends the streak');
  f.advance(30_000);
  f.handlers['binance:inspect'] = async () => { throw new ExecutionExchangeError('timeout', {}); };
  await f.service.tick();
  assert.equal(f.job.status, 'running', 'a later single transient miss starts a new streak instead of pausing');
  delete f.handlers['binance:inspect'];

  f.service.stop(f.job.id, {});
  f.advance(1000); await f.service.tick();
  assert.notEqual(f.job.status, 'running', 'a stop request is handled before the pending hold');
  assert.equal(f.stops('binance').length, 1, 'the hedge order is cancelled on request');
});

test('a Lighter RH deferral hint in the past waits the 10 s floor and a far one is capped at 120 s', async t => {
  for (const [offset, seconds] of [[-5000, 10], [600_000, 120]]) {
    const f = await fixture(t); await f.connectLighter();
    f.handlers['rh-lighter:create'] = async () => { throw Object.assign(new ExecutionExchangeError('rejected', { detail: '请求过于频繁' }), { notSent: true, rateLimited: true, retryAt: f.time + offset }); };
    f.start(await f.preview()); await f.service.tick();
    const note = f.job.events.map(message).find(text => /本次建单未送达交易所/.test(text));
    assert.match(note, new RegExp(`${seconds} 秒后`));
    const start = f.time;
    while (f.time + 10_000 < start + seconds * 1000 - 1000) { f.advance(10_000); await f.service.tick(); }
    f.advance(start + seconds * 1000 - 1000 - f.time); await f.service.tick();
    assert.equal(f.creates('rh-lighter').length, 1, `not re-sent before ${seconds} s`);
    f.advance(1000); await f.service.tick();
    assert.equal(f.creates('rh-lighter').length, 2, `re-sent at ${seconds} s`);
  }
});
