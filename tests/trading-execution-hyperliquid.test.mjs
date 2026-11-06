import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTradingExecution } from '../server/trading-execution.mjs';
import { Wallet } from 'ethers';
import { ExecutionExchangeError } from '../server/trading-execution-exchanges.mjs';
import { createHyperliquidExecutionClient } from '../server/trading-hyperliquid-execution.mjs';

const baseTime = Date.UTC(2026, 10, 7, 8);
const MASTER = '0x' + 'AB'.repeat(20), AGENT_KEY = '0x' + '11'.repeat(32), AGENT = '0x' + 'cd'.repeat(19) + '9f3e';
const SHARES = { outstanding: '12.7', diluted: '16.7' };
const anthropic = (overrides = {}) => ({ market: 'anthropic', preset: 'cross-exchange', action: 'open', shares: SHARES, equalSize: '167', legs: [
  { exchange: 'hyperliquid', symbol: 'io:ANTH', side: 'long', orderType: 'chase' },
  { exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'short', orderType: 'chase' },
], batchCount: 1, batchIntervalMs: 0, repriceIntervalMs: 1000, timeoutMs: 120_000, ...overrides });
const RULES = {
  'binance:ANTHROPICUSDT': { bid: '110.5', ask: '110.6', rule: { tickSize: '0.01', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '1000', minNotional: '5', maxNotional: null, maxMarketQuantity: '100' } },
  'okx:ANTHROPICUSDT': { bid: '110.8', ask: '110.9', rule: { tickSize: '0.01', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '1000', minNotional: '0', maxNotional: null, maxMarketQuantity: '60', contractSize: '1', instrumentId: 'ANTHROPIC-USDT-SWAP' } },
  'hyperliquid:io:ANTH': { bid: '1616.4', ask: '1617', rule: { tickSize: '0.1', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '100000', minNotional: '10', maxNotional: null, maxMarketQuantity: '100000', assetId: 120001, quoteAsset: 'USDC' } },
  'hyperliquid:xyz:ANT': { bid: '99.2', ask: '99.3', rule: { tickSize: '0.001', quantityStep: '0.01', minQuantity: '0.01', maxQuantity: '100000', minNotional: '10', maxNotional: null, maxMarketQuantity: '100000', assetId: 110000, quoteAsset: 'USDC' } },
};

/** The real Hyperliquid adapter over a fake venue: catches spec shapes a hand-written client would accept. */
function venue(clock) {
  const agent = new Wallet(AGENT_KEY).address.toLowerCase(), requests = [];
  let exchange = () => { throw new TypeError('socket hang up'); };
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const answers = {
    perpDexs: () => [null, { name: 'xyz' }, { name: 'io' }],
    meta: ({ dex }) => dex === 'io' ? { collateralToken: 0, universe: [{ name: 'io:OTHER', szDecimals: 2 }, { name: 'io:ANTH', szDecimals: 3, maxLeverage: 15, onlyIsolated: true }] } : { collateralToken: 0, universe: [{ name: 'xyz:ANT', szDecimals: 2, maxLeverage: 10 }] },
    l2Book: ({ coin }) => ({ coin, time: clock(), levels: coin === 'io:ANTH' ? [[{ px: '1616.4', sz: '2', n: 1 }], [{ px: '1617', sz: '1', n: 1 }]] : [[{ px: '99.2', sz: '2', n: 1 }], [{ px: '99.3', sz: '1', n: 1 }]] }),
    userRole: ({ user }) => user === agent ? { role: 'agent', data: { user: MASTER.toLowerCase() } } : { role: 'user' },
    clearinghouseState: () => ({ assetPositions: [] }),
    frontendOpenOrders: () => [],
    activeAssetData: ({ coin }) => ({ coin, leverage: { type: coin === 'io:ANTH' ? 'isolated' : 'cross', value: coin === 'io:ANTH' ? 15 : 10 } }),
    orderStatus: () => ({ status: 'unknownOid' }),
  };
  const fetchImpl = async (url, init) => {
    const payload = JSON.parse(init.body), path = new URL(url).pathname;
    requests.push({ path, payload });
    if (path === '/exchange') return exchange(payload);
    if (!answers[payload.type]) throw new Error('unexpected info ' + payload.type);
    return json(answers[payload.type](payload));
  };
  const client = createHyperliquidExecutionClient({ ErrorClass: ExecutionExchangeError, fetchImpl, now: clock });
  return { client, requests, answers, set exchange(value) { exchange = value; } };
}

async function fixture(t, { realHyperliquid = false } = {}) {
  const db = new DatabaseSync(':memory:');
  let time = baseTime, serial = 0;
  const records = new Map(), calls = [], handlers = {}, overrides = {};
  const accounts = {
    binance: { identity: null, modes: { ANTHROPICUSDT: 'one-way' }, positions: [], openOrders: [], strategies: [] },
    bybit: { identity: 'fixture-uid', modes: {}, positions: [], openOrders: [], strategies: [] },
    okx: { identity: 'fixture-uid', modes: { ANTHROPICUSDT: 'one-way' }, positions: [], openOrders: [], strategies: [] },
    hyperliquid: { identity: MASTER.toLowerCase(), modes: { 'io:ANTH': 'one-way', 'xyz:ANT': 'one-way' }, positions: [], openOrders: [], strategies: [], leverage: { 'io:ANTH': { type: 'isolated', value: 15 }, 'xyz:ANT': { type: 'cross', value: 10 } } },
  };
  const factory = exchange => Object.fromEntries(['verify', 'account', 'endedStrategies', 'market', 'create', 'amend', 'inspect', 'stop'].map(method => [method, async (...args) => {
    calls.push({ exchange, method, args });
    if (handlers[`${exchange}:${method}`]) return handlers[`${exchange}:${method}`](...args);
    if (method === 'verify') return { identity: accounts[exchange].identity, ...(exchange === 'hyperliquid' ? { agentAddress: AGENT } : {}) };
    if (method === 'account') return structuredClone(accounts[exchange]);
    if (method === 'market') { const base = RULES[`${exchange}:${args[0]}`] ?? { bid: '70', ask: '70.01', rule: { tickSize: '0.01', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '100', minNotional: '5', maxNotional: null, maxMarketQuantity: '1' } }; return { symbol: args[0], at: new Date(time).toISOString(), ...structuredClone(base), ...overrides[`${exchange}:${args[0]}`] }; }
    const spec = args[1];
    if (method === 'create') {
      args[2].beforeMutation();
      const id = String(++serial), record = { ...spec, id, kind: 'order', status: 'working', terminal: false, childrenSettled: false, filledQuantity: '0', price: spec.limitPrice ?? '110.6', averagePrice: null, createdAt: new Date(time).toISOString() };
      records.set(id, record); return { id, kind: 'order' };
    }
    const record = spec.id ? records.get(spec.id) : [...records.values()].find(item => item.clientId === spec.clientId);
    if (!record) throw new ExecutionExchangeError('not_found', { notFound: true });
    if (method === 'inspect') return structuredClone(record);
    if (method === 'amend') { args[2].beforeMutation(); return structuredClone(record); }
    if (method === 'stop') { args[2].beforeMutation(); Object.assign(record, { status: 'terminal', terminal: true, childrenSettled: true }); return { id: record.id }; }
  }]));
  const stored = [], real = realHyperliquid ? venue(() => time) : null;
  const wrapped = exchange => {
    if (exchange !== 'hyperliquid' || !real) return factory(exchange);
    return Object.fromEntries(Object.entries(real.client).map(([method, value]) => [method, typeof value === 'function' ? (...args) => { calls.push({ exchange, method, args }); return value(...args); } : value]));
  };
  const instance = createTradingExecution({ db, stmt: null, now: () => time, intervalMs: 0, encrypt: value => { stored.push(value); return JSON.stringify(value); }, decrypt: JSON.parse, clientFactory: wrapped });
  t.after(async () => { await instance.close(); db.close(); });
  await instance.initializeProtection();
  await instance.connect('binance', { revision: 0, accountMode: 'standard', apiKey: 'fixture_key', apiSecret: 'fixture_secret' });
  return { db, records, calls, accounts, handlers, overrides, stored, real, service: instance, get time() { return time; }, advance(value) { time += value; },
    preview: (body = anthropic()) => instance.preview(body, 'session-a'),
    start: preview => instance.start({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, 'session-a'),
    connectWallet: (body = {}) => instance.connect('hyperliquid', { revision: 0, accountMode: 'agent', address: MASTER, agentKey: AGENT_KEY, ...body }),
    creates: exchange => calls.filter(call => call.method === 'create' && (!exchange || call.exchange === exchange)),
    stops: exchange => calls.filter(call => call.method === 'stop' && call.exchange === exchange),
    get job() { return instance.state().jobs[0]; } };
}

test('a Hyperliquid connection takes the master address and API wallet key, shows only public labels and reads its own contracts', async t => {
  const f = await fixture(t);
  for (const body of [{ apiKey: 'fixture_key', apiSecret: 'fixture_secret', address: undefined, agentKey: undefined }, { address: '0x12' }, { agentKey: '0x' + '1'.repeat(63) }, { accountMode: 'cross' }]) {
    await assert.rejects(f.service.connect('hyperliquid', JSON.parse(JSON.stringify({ revision: 0, accountMode: 'agent', address: MASTER, agentKey: AGENT_KEY, ...body }))), error => error.status === 400);
  }
  assert.equal(f.calls.filter(call => call.exchange === 'hyperliquid').length, 0, 'malformed input never reaches the venue');
  const state = await f.connectWallet();
  const row = state.connections.find(item => item.exchange === 'hyperliquid');
  assert.deepEqual({ connected: row.connected, accountMode: row.accountMode, identity: row.identity, keyLabel: row.keyLabel }, { connected: true, accountMode: 'agent', identity: MASTER.toLowerCase(), keyLabel: '9f3e' });
  assert.equal(JSON.stringify(state).includes(AGENT_KEY.slice(2)), false);
  assert.deepEqual(f.stored.at(-1), { purpose: 'execution', exchange: 'hyperliquid', address: MASTER.toLowerCase(), agentKey: AGENT_KEY });
  assert.deepEqual(f.calls.find(call => call.exchange === 'hyperliquid' && call.method === 'account').args[1].symbols, ['io:ANTH', 'xyz:ANT']);
  const binance = state.connections.find(item => item.exchange === 'binance');
  assert.equal(binance.keyLabel, '_key');
});

test('an Anthropic preview sizes equal shares from editable share counts and reports the live Hyperliquid leverage', async t => {
  const f = await fixture(t); await f.connectWallet();
  const preview = await f.preview();
  const legs = Object.fromEntries(preview.legs.map(leg => [leg.exchange, leg]));
  assert.equal(legs.hyperliquid.quantity, '10');
  assert.equal(legs.binance.quantity, '13.149');
  assert.deepEqual(legs.hyperliquid.leverage, { type: 'isolated', value: 15 });
  assert.ok(preview.notes.some(note => /io:ANTH 逐仓 15x/.test(note) && /不修改/.test(note)));
  assert.ok(preview.notes.some(note => /流通 12\.7 十亿股、完全稀释 16\.7 十亿股/.test(note)));
  const wider = await f.preview(anthropic({ shares: { outstanding: '12.7', diluted: '20' } }));
  assert.equal(wider.legs.find(leg => leg.exchange === 'hyperliquid').quantity, '8.35');
  assert.equal(f.creates().length, 0, 'previews never send');
});

test('Anthropic previews refuse missing assumptions, unlisted venue contracts, four legs and unbalanced shares', async t => {
  const f = await fixture(t); await f.connectWallet();
  const refused = [
    anthropic({ shares: undefined }),
    anthropic({ shares: { outstanding: '17', diluted: '16.7' } }),
    anthropic({ shares: { outstanding: '0.5', diluted: '16.7' } }),
    anthropic({ legs: [{ exchange: 'hyperliquid', symbol: 'io:ANTH', side: 'long' }, { exchange: 'bybit', symbol: 'ANTHROPICUSDT', side: 'short' }] }),
    anthropic({ legs: [{ exchange: 'hyperliquid', symbol: 'ANTHROPICUSDT', side: 'long' }, { exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'short' }] }),
    anthropic({ preset: 'four-leg' }),
    anthropic({ equalSize: undefined, legs: [{ exchange: 'hyperliquid', symbol: 'io:ANTH', side: 'long', quantity: '10' }, { exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'short', quantity: '10' }] }),
    { ...anthropic(), market: ['anthropic'] },
  ];
  for (const body of refused) await assert.rejects(f.preview(JSON.parse(JSON.stringify(body))), error => error.status === 400, JSON.stringify(body).slice(0, 200));
  await assert.rejects(f.preview({ ...anthropic(), market: 'oil' }), error => error.status === 400);
  // io long against xyz short on the same venue is a legal same-exchange pair.
  const same = await f.preview(anthropic({ preset: 'same-exchange', equalSize: '100', legs: [{ exchange: 'hyperliquid', symbol: 'io:ANTH', side: 'long' }, { exchange: 'hyperliquid', symbol: 'xyz:ANT', side: 'short' }] }));
  assert.deepEqual(same.legs.map(leg => leg.quantity), ['5.988', '100']);
  delete f.accounts.hyperliquid.leverage['io:ANTH'];
  await assert.rejects(f.preview(), error => error.status === 502 && /杠杆/.test(error.message));
  assert.equal(f.creates().length, 0);
});

test('Hyperliquid chase legs rest at the same-side best price; repricing cancels the exact original and re-sends only the remainder', async t => {
  const f = await fixture(t); await f.connectWallet();
  f.start(await f.preview()); await f.service.tick();
  const [first] = f.creates('hyperliquid');
  assert.deepEqual({ assetId: first.args[1].assetId, limitPrice: first.args[1].limitPrice, side: first.args[1].side, positionSide: first.args[1].positionSide, quantity: first.args[1].quantity, orderType: first.args[1].orderType }, { assetId: 120001, limitPrice: '1616.4', side: 'buy', positionSide: 'BOTH', quantity: '10', orderType: 'chase' });
  assert.equal(f.creates('binance').length, 1);
  assert.equal(f.creates('binance')[0].args[1].limitPrice, undefined, 'Binance manual chase keeps its native queue pricing');
  f.advance(1000); await f.service.tick();
  assert.equal(f.stops('hyperliquid').length, 0, 'an unchanged book is not chased');
  const original = [...f.records.values()].find(record => record.symbol === 'io:ANTH');
  original.filledQuantity = '0.004';
  f.overrides['hyperliquid:io:ANTH'] = { bid: '1616.5', ask: '1617' };
  f.advance(1000); await f.service.tick();
  assert.equal(f.stops('hyperliquid').length, 1);
  assert.equal(f.stops('hyperliquid')[0].args[1].id, original.id);
  assert.equal(f.calls.filter(call => call.method === 'amend' && call.exchange === 'hyperliquid').length, 0);
  const resent = f.creates('hyperliquid');
  assert.equal(resent.length, 2);
  assert.deepEqual({ quantity: resent[1].args[1].quantity, limitPrice: resent[1].args[1].limitPrice }, { quantity: '9.996', limitPrice: '1616.5' });
  assert.notEqual(resent[1].args[1].clientId, first.args[1].clientId);
  assert.equal(f.job.status, 'running');
  assert.equal(f.job.legs.find(leg => leg.exchange === 'hyperliquid').filledQuantity, '0.004');
});

test('a Hyperliquid reprice cancel that leaves the order working is retried with spacing and a bounded budget', async t => {
  const f = await fixture(t); await f.connectWallet();
  f.handlers['hyperliquid:stop'] = async (_credentials, spec, options) => { options.beforeMutation(); return { id: spec.id }; };
  f.start(await f.preview()); await f.service.tick();
  f.overrides['hyperliquid:io:ANTH'] = { bid: '1616.5', ask: '1617' };
  f.advance(1000); await f.service.tick();
  assert.equal(f.stops('hyperliquid').length, 1);
  f.advance(1000); await f.service.tick();
  assert.equal(f.stops('hyperliquid').length, 1, 'no retry inside the spacing window');
  for (let index = 0; index < 8; index += 1) { f.advance(10_000); await f.service.tick(); }
  assert.ok(f.stops('hyperliquid').length <= 5, `cancel attempts stay within budget (${f.stops('hyperliquid').length})`);
  assert.ok(f.stops('hyperliquid').length >= 2);
  assert.equal(f.creates('hyperliquid').length, 1, 'nothing is re-sent while the original may still rest');
  assert.notEqual(f.job.status, 'running');
});

test('a post-only bounce is re-sent from the next book instead of pausing the pair', async t => {
  const f = await fixture(t); await f.connectWallet();
  let bounced = 0;
  f.handlers['hyperliquid:create'] = async (_credentials, spec, options) => {
    options.beforeMutation();
    if (!bounced++) { const error = new ExecutionExchangeError('rejected', { detail: '只挂单会立即成交，已被拒绝' }); error.repriceable = true; throw error; }
    return { id: 'hl-2', kind: 'order' };
  };
  f.start(await f.preview()); await f.service.tick();
  assert.equal(f.job.status, 'running');
  assert.ok(f.job.events.some(item => /只挂单因盘口变化被拒绝/.test(item.message ?? item)));
  f.advance(1000); await f.service.tick();
  assert.equal(f.creates('hyperliquid').length, 2);
  assert.equal(f.creates('binance').length, 1, 'the sibling leg is not re-sent');
  // Any other definitive refusal still pauses the job.
  const g = await fixture(t); await g.connectWallet();
  g.handlers['hyperliquid:create'] = async (_credentials, _spec, options) => { options.beforeMutation(); throw new ExecutionExchangeError('rejected', { detail: '保证金不足' }); };
  g.start(await g.preview()); await g.service.tick();
  assert.notEqual(g.job.status, 'running');
});

test('a Hyperliquid market leg starts from the opposite best price and is never chased', async t => {
  const f = await fixture(t); await f.connectWallet();
  f.start(await f.preview(anthropic({ legs: [{ exchange: 'hyperliquid', symbol: 'io:ANTH', side: 'long', orderType: 'market' }, { exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'short', orderType: 'chase' }] })));
  await f.service.tick();
  const [order] = f.creates('hyperliquid');
  assert.deepEqual({ orderType: order.args[1].orderType, limitPrice: order.args[1].limitPrice, stopPrice: order.args[1].stopPrice }, { orderType: 'market', limitPrice: '1617', stopPrice: null });
  f.overrides['hyperliquid:io:ANTH'] = { bid: '1610', ask: '1611' };
  f.advance(1000); await f.service.tick();
  assert.equal(f.stops('hyperliquid').length, 0);
  assert.equal(f.creates('hyperliquid').length, 1);
});

test('an off-grid Hyperliquid price stops the whole group before any leg is sent', async t => {
  const f = await fixture(t); await f.connectWallet();
  const preview = await f.preview(anthropic({ preset: 'same-exchange', equalSize: '100', legs: [{ exchange: 'hyperliquid', symbol: 'io:ANTH', side: 'long', orderType: 'chase' }, { exchange: 'hyperliquid', symbol: 'xyz:ANT', side: 'short', orderType: 'chase' }] }));
  // Across a power of ten the tick taken from the bid admits an ask with six
  // significant figures, which Hyperliquid refuses; the short leg rests at it.
  f.overrides['hyperliquid:xyz:ANT'] = { bid: '9.999', ask: '10.0005', rule: { ...RULES['hyperliquid:xyz:ANT'].rule, tickSize: '0.0001' } };
  f.start(preview); await f.service.tick();
  assert.equal(f.creates().length, 0, 'the io:ANTH sibling is not sent either');
  assert.notEqual(f.job.status, 'running');
  assert.match(f.job.reason ?? '', /Hyperliquid xyz:ANT 价格不满足 Hyperliquid 精度，本组交易腿均未发送/);
});

test('an uncertain Hyperliquid create is never re-sent and settles as not created only after spaced cloid misses', async t => {
  const f = await fixture(t); await f.connectWallet();
  f.handlers['hyperliquid:create'] = async (_credentials, _spec, options) => { options.beforeMutation(); throw new ExecutionExchangeError('timeout', { uncertain: true }); };
  f.start(await f.preview()); await f.service.tick();
  assert.equal(f.job.status, 'attention');
  const leg = () => f.job.legs.find(item => item.exchange === 'hyperliquid');
  assert.equal(leg().currentOrder.unknown, true);
  const clientId = f.creates('hyperliquid')[0].args[1].clientId;
  for (let index = 0; index < 6; index += 1) { f.advance(10_000); await f.service.tick(); }
  assert.equal(f.creates('hyperliquid').length, 1, 'inside the observation window nothing is re-sent');
  assert.equal(leg().currentOrder.unknown, true, 'a miss inside the window is not proof of absence');
  const inspects = f.calls.filter(call => call.exchange === 'hyperliquid' && call.method === 'inspect');
  assert.ok(inspects.length >= 2 && inspects.every(call => call.args[1].clientId === clientId), 'reads look the order up by its own client id');
  for (let index = 0; index < 10; index += 1) { f.advance(10_000); await f.service.tick(); }
  assert.notEqual(leg().currentOrder?.unknown, true, 'after the window and repeated misses with a clean account the create is settled');
  assert.equal(f.creates('hyperliquid').length, 1, 'settling never replays the uncertain create');
});

test('through the real adapter, an unanswered Hyperliquid create is looked up by cloid and settled as not created, never re-sent', async t => {
  const f = await fixture(t, { realHyperliquid: true }); await f.connectWallet();
  f.start(await f.preview()); await f.service.tick();
  const sent = f.real.requests.filter(request => request.path === '/exchange');
  assert.equal(sent.length, 1, 'one signed order left for the venue');
  assert.equal(f.job.status, 'attention');
  const leg = () => f.job.legs.find(item => item.exchange === 'hyperliquid');
  assert.equal(leg().currentOrder.unknown, true);
  for (let index = 0; index < 16; index += 1) { f.advance(10_000); await f.service.tick(); }
  const lookups = f.real.requests.filter(request => request.payload.type === 'orderStatus');
  assert.ok(lookups.length >= 2, `the unanswered order is looked up by its cloid (${lookups.length})`);
  assert.ok(lookups.every(request => request.payload.oid === sent[0].payload.action.orders[0].c));
  assert.notEqual(leg().currentOrder?.unknown, true, 'repeated misses after the window settle the create');
  assert.equal(f.real.requests.filter(request => request.path === '/exchange').length, 1, 'the unanswered order is never replayed');
});

test('a Hyperliquid remainder below the venue minimum keeps resting instead of being cancelled for a reprice', async t => {
  const f = await fixture(t); await f.connectWallet();
  f.start(await f.preview()); await f.service.tick();
  const original = [...f.records.values()].find(record => record.symbol === 'io:ANTH');
  // 0.005 × 1616.5 ≈ 8.08 USDC, below the 10 USDC minimum: a re-sent remainder would be refused.
  original.filledQuantity = '9.995';
  f.overrides['hyperliquid:io:ANTH'] = { bid: '1616.5', ask: '1617' };
  f.advance(1000); await f.service.tick();
  f.advance(1000); await f.service.tick();
  assert.equal(f.stops('hyperliquid').length, 0, 'the remainder is not cancelled');
  assert.equal(f.creates('hyperliquid').length, 1);
  assert.equal(f.job.status, 'running');
  assert.equal(f.job.events.filter(item => /剩余数量低于交易所最小下单量/.test(item.message ?? item)).length, 1, 'the hold is reported once per batch');
});
