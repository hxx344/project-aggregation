import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, TypedDataEncoder, recoverAddress } from 'ethers';
import { ExecutionExchangeError } from '../server/trading-execution-exchanges.mjs';
import { createHyperliquidExecutionClient, cloidOf, priceTick, validPrice, protectivePrice } from '../server/trading-hyperliquid-execution.mjs';
import { actionHash } from '../server/trading-hyperliquid-signing.mjs';

// Test-only key from the official SDK test suite; never a real account.
const AGENT_KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';
const AGENT = new Wallet(AGENT_KEY).address.toLowerCase();
const MASTER = '0x' + 'ab'.repeat(20);
const credentials = { address: MASTER, agentKey: AGENT_KEY };
const T0 = Date.UTC(2026, 10, 7, 8);
const DEXES = [null, { name: 'xyz' }, { name: 'io' }];
const META = {
  io: { collateralToken: 0, universe: [{ name: 'io:OTHER', szDecimals: 2, maxLeverage: 5 }, { name: 'io:ANTH', szDecimals: 3, maxLeverage: 15, onlyIsolated: true }] },
  xyz: { collateralToken: 0, universe: [{ name: 'xyz:ANT', szDecimals: 2, maxLeverage: 10 }] },
};
const isError = (code, extra = {}) => error => error instanceof ExecutionExchangeError && error.code === code && Object.entries(extra).every(([key, value]) => error[key] === value);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function harness({ exchange = [], info = {}, timeoutMs } = {}) {
  let time = T0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const payload = JSON.parse(init.body), path = new URL(url).pathname;
    calls.push({ url, path, payload, init });
    if (path === '/exchange') {
      const next = exchange.shift();
      if (!next) throw new Error('unexpected exchange call');
      return typeof next === 'function' ? next(payload, init) : json(next);
    }
    const handler = info[payload.type];
    if (handler) return json(typeof handler === 'function' ? await handler(payload) : handler);
    if (payload.type === 'perpDexs') return json(DEXES);
    if (payload.type === 'meta') return json(META[payload.dex]);
    if (payload.type === 'l2Book') return json({ coin: payload.coin, time, levels: payload.coin === 'io:ANTH' ? [[{ px: '1616.4', sz: '2', n: 1 }], [{ px: '1617', sz: '1', n: 1 }]] : [[{ px: '99.206', sz: '2', n: 1 }], [{ px: '99.316', sz: '1', n: 1 }]] });
    if (payload.type === 'userRole') return json(payload.user === AGENT ? { role: 'agent', data: { user: MASTER } } : { role: 'user' });
    throw new Error('unexpected info ' + payload.type);
  };
  const client = createHyperliquidExecutionClient({ ErrorClass: ExecutionExchangeError, fetchImpl, now: () => time, ...(timeoutMs ? { timeoutMs } : {}) });
  return { client, calls, advance: value => { time += value; }, get exchanges() { return calls.filter(call => call.path === '/exchange'); } };
}
const spec = (overrides = {}) => ({ symbol: 'io:ANTH', side: 'buy', positionSide: 'BOTH', quantity: '0.5', reduceOnly: false, clientId: 'h' + '1'.repeat(30), orderType: 'chase', stopPrice: null, limitPrice: '1616.4', assetId: 120001, ...overrides });
const signer = call => {
  const { action, nonce, expiresAfter, signature } = call.payload;
  const digest = TypedDataEncoder.hash({ chainId: 1337, name: 'Exchange', verifyingContract: '0x0000000000000000000000000000000000000000', version: '1' },
    { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] }, { source: 'a', connectionId: actionHash(action, null, nonce, expiresAfter) });
  return recoverAddress(digest, signature).toLowerCase();
};

test('native history reads master fills for both ANT contracts and never double counts builder fee', async () => {
  const rows = ['xyz:ANT', 'io:ANTH', 'BTC'].map((coin, i) => ({ coin, oid: 120 + i, tid: 20 + i, hash: '0x' + 'ab'.repeat(32), time: T0 - 1000 * (i + 1),
    side: i ? 'B' : 'A', sz: '0.5', px: '100', startPosition: i ? '-1' : '2', closedPnl: i ? undefined : '3', fee: '0.1', feeToken: 'USDC', builderFee: '0.05' }));
  const h = harness({ info: { userFills: payload => { assert.equal(payload.user, MASTER); assert.equal(payload.aggregateByTime, false); return [...rows, rows[0]]; } } });
  const result = await h.client.history(credentials, { start: T0 - 86_400_000, end: T0 });
  assert.equal(result.fills.length, 2); assert.equal(result.truncated, true);
  assert.deepEqual(result.fills.map(row => row.orderId), ['120', '121']);
  assert.deepEqual(result.fills.map(row => [row.symbol, row.base, row.quantityUnit, row.positionBefore, row.positionAfter, row.fee, row.priceCurrency, row.realizedPnl]),
    [['xyz:ANT', 'XYZANT', 'ANT', '2', '1.5', '-0.1', null, '3'], ['io:ANTH', 'IOANTH', 'ANTH', '-1', '-0.5', '-0.1', null, null]]);
  assert.equal(h.exchanges.length, 0); assert.deepEqual(h.calls.map(call => call.payload.type), ['userFills']);
});

test('native Hyperliquid history bounds rows and coverage and rejects malformed candidate fills', async () => {
  const row = { coin: 'xyz:ANT', tid: 1, hash: '0x' + 'cd'.repeat(32), time: T0 - 2000, side: 'B', sz: '1', px: '100', startPosition: '0' };
  for (const patch of [{ tid: 2 ** 54 }, { hash: 'bad' }, { time: T0 + 60_001 }, { sz: '0' }, { side: 'buy' }, { feeToken: 'bad\ntoken' }]) {
    const h = harness({ info: { userFills: [{ ...row, ...patch }] } });
    await assert.rejects(h.client.history(credentials, { start: T0 - 86_400_000, end: T0 }), isError('invalid_data'));
  }
  const full = harness({ info: { userFills: Array.from({ length: 2000 }, (_, i) => ({ ...row, tid: i, time: T0 - 2000 + i })) } });
  const result = await full.client.history(credentials, { start: T0 - 86_400_000, end: T0 });
  assert.equal(result.fills.length, 2000); assert.equal(result.fills[0].time, new Date(T0 - 1).toISOString());
  assert.equal(result.coverageEnd, new Date(T0).toISOString()); assert.equal(result.truncated, true);
  const excess = harness({ info: { userFills: Array.from({ length: 2001 }, () => row) } });
  await assert.rejects(excess.client.history(credentials, { start: T0 - 86_400_000, end: T0 }), isError('response_limit'));
  const empty = await harness({ info: { userFills: [row] } }).client.history(credentials, { start: T0 - 1000, end: T0 });
  assert.equal(empty.coverageStart, null); assert.equal(empty.truncated, true);
});

test('price grid follows five significant figures and 6 - szDecimals decimals; IOC protection rounds outward', () => {
  assert.equal(priceTick('1616.4', 3), '0.1');
  assert.equal(priceTick('99.206', 2), '0.001');
  assert.equal(priceTick('0.012345', 0), '0.000001');
  assert.equal(priceTick('123456', 3), '1');
  assert.ok(validPrice('123456', 3) && validPrice('1616.4', 3) && !validPrice('1616.45', 3) && !validPrice('0.1234567', 0) && !validPrice('1.0001', 3));
  assert.equal(protectivePrice('buy', '1617', 3), '1633.2');
  assert.equal(protectivePrice('sell', '1616.4', 3), '1600.2');
  assert.equal(protectivePrice('buy', '99.316', 2), '100.31');
});

test('rules derive the dynamic HIP-3 asset id, USDC collateral and isolated-only flag from live metadata', async () => {
  const { client } = harness();
  const io = await client.market('io:ANTH');
  assert.deepEqual({ bid: io.bid, ask: io.ask, onlyIsolated: io.onlyIsolated, maxLeverage: io.maxLeverage }, { bid: '1616.4', ask: '1617', onlyIsolated: true, maxLeverage: 15 });
  assert.equal(io.rule.assetId, 120001); assert.equal(io.rule.quantityStep, '0.001'); assert.equal(io.rule.tickSize, '0.1'); assert.equal(io.rule.quoteAsset, 'USDC');
  assert.equal((await client.market('xyz:ANT')).rule.assetId, 110000);
  assert.equal('rule' in await client.market('io:ANTH', { withRule: false }), false);
  await assert.rejects(client.market('ANTHROPICUSDT'), isError('input'));
  const usdh = harness({ info: { meta: { ...META.io, collateralToken: 360 } } });
  await assert.rejects(usdh.client.market('io:ANTH'), isError('not_tradable'));
  const crossed = harness({ info: { l2Book: { coin: 'io:ANTH', time: T0, levels: [[{ px: '1617', sz: '1' }], [{ px: '1617', sz: '1' }]] } } });
  await assert.rejects(crossed.client.market('io:ANTH', { withRule: false }), isError('invalid_data'));
});

test('verify requires a separate API wallet approved by an ordinary master account', async () => {
  const { client, calls } = harness();
  assert.deepEqual(await client.verify(credentials), { identity: MASTER, agentAddress: AGENT });
  const reads = calls.length;
  await client.verify(credentials); assert.equal(calls.length, reads, 'a verified binding is cached briefly');
  await assert.rejects(harness().client.verify({ address: AGENT, agentKey: AGENT_KEY }), isError('permissions'));
  await assert.rejects(harness({ info: { userRole: payload => payload.user === AGENT ? { role: 'agent', data: { user: '0x' + 'cd'.repeat(20) } } : { role: 'user' } } }).client.verify(credentials), isError('permissions'));
  await assert.rejects(harness({ info: { userRole: payload => payload.user === AGENT ? { role: 'missing' } : { role: 'user' } } }).client.verify(credentials), isError('permissions'));
  await assert.rejects(harness({ info: { userRole: payload => payload.user === AGENT ? { role: 'agent', data: { user: MASTER } } : { role: 'subAccount' } } }).client.verify(credentials), isError('account_mode'));
  for (const bad of [{ address: MASTER }, { address: 'abc', agentKey: AGENT_KEY }, { address: MASTER, agentKey: '0x12' }]) await assert.rejects(harness().client.verify(bad), isError('credentials'));
});

test('account reads positions, open orders and live leverage of the master address without changing them', async () => {
  const { client, calls } = harness({ info: {
    clearinghouseState: payload => ({ assetPositions: payload.dex === 'io' ? [{ type: 'oneWay', position: { coin: 'io:ANTH', szi: '-1.25' } }, { type: 'oneWay', position: { coin: 'io:OTHER', szi: '3' } }] : [] }),
    frontendOpenOrders: payload => payload.dex === 'io' ? [{ coin: 'io:ANTH', oid: 7, side: 'B', origSz: '2', sz: '0.5', reduceOnly: false }] : [],
    activeAssetData: payload => ({ coin: payload.coin, leverage: { type: payload.coin === 'io:ANTH' ? 'isolated' : 'cross', value: 3 } }),
  } });
  const value = await client.account(credentials, { symbols: ['io:ANTH', 'xyz:ANT'] });
  assert.deepEqual(value.positions, [{ symbol: 'io:ANTH', side: 'short', quantity: '1.25', risk: { markPrice: null, liquidationPrice: null, at: new Date(T0).toISOString(), noLiquidation: false } }]);
  assert.deepEqual(value.openOrders, [{ id: '7', symbol: 'io:ANTH', side: 'buy', positionSide: 'BOTH', quantity: '2', filledQuantity: '1.5', reduceOnly: false }]);
  assert.deepEqual(value.leverage, { 'io:ANTH': { type: 'isolated', value: 3 }, 'xyz:ANT': { type: 'cross', value: 3 } });
  assert.deepEqual(value.modes, { 'io:ANTH': 'one-way', 'xyz:ANT': 'one-way' });
  assert.ok(calls.every(call => call.path === '/info' && (call.payload.user === undefined || call.payload.user === MASTER)));
  await assert.rejects(client.account(credentials, { symbols: ['CLUSDT'] }), isError('input'));
  const missing = harness({ info: { clearinghouseState: { assetPositions: [] }, frontendOpenOrders: [], activeAssetData: { coin: 'io:ANTH' } } });
  await assert.rejects(missing.client.account(credentials, { symbols: ['io:ANTH'] }), isError('invalid_data'));
});

test('account risk derives exact marks for both HIP-3 legs and keeps each state receipt time through slow order reads', async () => {
  let releaseState, releaseOrders;
  const stateGate = new Promise(resolve => { releaseState = resolve; });
  const orderGate = new Promise(resolve => { releaseOrders = resolve; });
  const h = harness({ info: {
    clearinghouseState: async payload => {
      if (payload.dex === 'xyz') await stateGate;
      return { assetPositions: [{ type: 'oneWay', position: payload.dex === 'io'
        ? { coin: 'io:ANTH', szi: '-1.25', positionValue: '2000.125', liquidationPx: '1800.1000' }
        : { coin: 'xyz:ANT', szi: '3', positionValue: '1', liquidationPx: '0.2' } }] };
    },
    frontendOpenOrders: async () => { await orderGate; return []; },
    activeAssetData: payload => ({ coin: payload.coin, leverage: { type: 'isolated', value: 3 } }),
  } });
  const pending = h.client.account(credentials, { symbols: ['io:ANTH', 'xyz:ANT'] });
  await new Promise(setImmediate);
  h.advance(7000); releaseState();
  await new Promise(setImmediate);
  h.advance(7000); releaseOrders();
  const value = await pending;
  assert.deepEqual(value.positions.map(row => row.risk), [
    { markPrice: '1600.1', liquidationPrice: '1800.1', at: new Date(T0).toISOString(), noLiquidation: false },
    { markPrice: '0.333333333333333333', liquidationPrice: '0.2', at: new Date(T0 + 7000).toISOString(), noLiquidation: false },
  ]);
  assert.equal(h.exchanges.length, 0);
  assert.ok(h.calls.every(call => call.payload.user === MASTER));
});

test('account risk returns null for missing or malformed prices without losing a valid manual position', async () => {
  for (const invalid of [undefined, null, '', '0', '-1', 42, [], {}, 'NaN', 'Infinity', '1e2', ' 2', '1.1234567890123456789']) {
    for (const field of ['positionValue', 'liquidationPx']) {
      const h = harness({ info: {
        clearinghouseState: { assetPositions: [{ type: 'oneWay', position: { coin: 'io:ANTH', szi: '-2', positionValue: '200', liquidationPx: '120', [field]: invalid } }] },
        frontendOpenOrders: [], activeAssetData: { coin: 'io:ANTH', leverage: { type: 'cross', value: 3 } },
      } });
      const { positions } = await h.client.account(credentials, { symbols: ['io:ANTH'] });
      assert.deepEqual(positions, [{ symbol: 'io:ANTH', side: 'short', quantity: '2',
        risk: { markPrice: field === 'positionValue' ? null : '100', liquidationPrice: field === 'liquidationPx' ? null : '120', at: new Date(T0).toISOString(),
          noLiquidation: field === 'liquidationPx' && (invalid === null || invalid === '0') } }]);
      assert.equal(h.exchanges.length, 0);
    }
  }
});

test('create signs one ALO order with the API wallet, a deterministic cloid and a 30 s expiry, after the final guard', async () => {
  const h = harness({ exchange: [{ status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 77 } }] } } }, { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { oid: 78, totalSz: '0.5', avgPx: '1617' } }] } } }] });
  let guarded = 0;
  assert.deepEqual(await h.client.create(credentials, spec(), { beforeMutation: () => { guarded += 1; assert.equal(h.exchanges.length, 0); } }), { id: '77', kind: 'order' });
  assert.equal(guarded, 1);
  const [first] = h.exchanges;
  assert.deepEqual(first.payload.action, { type: 'order', orders: [{ a: 120001, b: true, p: '1616.4', s: '0.5', r: false, t: { limit: { tif: 'Alo' } }, c: cloidOf(spec().clientId) }], grouping: 'na' });
  assert.deepEqual(Object.keys(first.payload.action.orders[0]), ['a', 'b', 'p', 's', 'r', 't', 'c']);
  assert.equal(first.payload.vaultAddress, null);
  assert.equal(first.payload.expiresAfter, first.payload.nonce + 30_000);
  assert.equal(first.init.redirect, 'error');
  assert.equal(signer(first), AGENT);
  assert.equal(JSON.stringify(first.payload).includes(AGENT_KEY.slice(2)), false);
  await h.client.create(credentials, spec({ orderType: 'market', side: 'sell', limitPrice: '1616.4', clientId: 'h' + '2'.repeat(30) }));
  const second = h.exchanges[1].payload;
  assert.deepEqual(second.action.orders[0].t, { limit: { tif: 'Ioc' } }); assert.equal(second.action.orders[0].p, '1600.2');
  assert.ok(second.nonce > first.payload.nonce, 'nonces stay strictly increasing within one clock millisecond');
});

test('create refuses a stale asset id, an off-grid price or quantity, and a price beyond the chase limit before signing', async () => {
  for (const value of [spec({ assetId: 120000 }), spec({ limitPrice: '1616.45' }), spec({ quantity: '0.0005' }), spec({ stopPrice: '1616.4' }), spec({ positionSide: 'LONG' }), spec({ orderType: 'market', stopPrice: '1700' })]) {
    const h = harness();
    await assert.rejects(h.client.create(credentials, value, { beforeMutation: () => assert.fail('must not reach the final guard') }));
    assert.equal(h.exchanges.length, 0);
  }
  const guarded = harness();
  await assert.rejects(guarded.client.create(credentials, spec(), { beforeMutation: () => { throw new Error('lease lost'); } }), /lease lost/);
  assert.equal(guarded.exchanges.length, 0, 'a refused final guard sends nothing');
});

test('create classifies venue answers: only explicit refusals are definitive, everything ambiguous stays uncertain', async () => {
  const cases = [
    [{ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Post only order would have immediately matched, bbo was 1616.4@1617. asset=120001' }] } } }, isError('rejected', { uncertain: false, repriceable: true })],
    [{ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Insufficient margin to place order. asset=120001' }] } } }, error => isError('rejected', { uncertain: false })(error) && !error.repriceable && /保证金不足/.test(error.message)],
    [{ status: 'err', response: 'User or API Wallet 0x0000000000000000000000000000000000000001 does not exist.' }, isError('rejected', { uncertain: false })],
    [{ status: 'err', response: 'Something new happened' }, isError('upstream', { uncertain: true })],
    [{ status: 'ok', response: { type: 'order', data: { statuses: [{ waitingForFill: { oid: 1 } }] } } }, isError('invalid_data', { uncertain: true })],
    [{ status: 'ok', response: { type: 'order', data: { statuses: [] } } }, isError('invalid_data', { uncertain: true })],
    [() => json({ error: 'busy' }, 502), isError('upstream', { uncertain: true })],
    [() => json({}, 429), isError('rejected', { uncertain: false })],
    [() => json({}, 422), isError('rejected', { uncertain: false })],
    // Proxy and timeout statuses do not prove the venue refused the body.
    [() => json({}, 408), isError('upstream', { uncertain: true })],
    [() => json({}, 499), isError('upstream', { uncertain: true })],
    [{ status: 'err', response: 'Order 77 does not exist' }, isError('upstream', { uncertain: true })],
    [() => new Response('not json', { status: 200 }), isError('invalid_data', { uncertain: true })],
    [() => { throw new TypeError('socket hang up'); }, isError('transport', { uncertain: true })],
  ];
  for (const [answer, expected] of cases) await assert.rejects(harness({ exchange: [answer] }).client.create(credentials, spec()), expected);
  const slow = harness({ timeoutMs: 20, exchange: [(_payload, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))] });
  await assert.rejects(slow.client.create(credentials, spec()), isError('timeout', { uncertain: true }));
  const controller = new AbortController();
  const aborted = harness({ exchange: [() => new Promise(() => { controller.abort(); })] });
  await assert.rejects(aborted.client.create(credentials, spec(), { signal: controller.signal }), isError('aborted', { uncertain: true }));
});

const status = (overrides = {}, order = {}) => ({ status: 'order', order: { status: 'open', statusTimestamp: T0, order: { coin: 'io:ANTH', side: 'B', limitPx: '1616.4', sz: '0.5', oid: 77, timestamp: T0, origSz: '0.5', tif: 'Alo', reduceOnly: false, cloid: cloidOf(spec().clientId), ...order }, ...overrides } });
const fill = (oid, sz, px, tid, time = T0 + 1) => ({ coin: 'io:ANTH', oid, sz, px, tid, hash: '0x' + String(tid).padStart(64, '0'), time });

test('inspect looks up the cloid and proves a canceled remainder against the fill history', async () => {
  const open = harness({ info: { orderStatus: status() } });
  const working = await open.client.inspect(credentials, spec({ id: '77' }));
  assert.deepEqual({ id: working.id, terminal: working.terminal, filledQuantity: working.filledQuantity, status: working.status, positionSide: working.positionSide }, { id: '77', terminal: false, filledQuantity: '0', status: 'working', positionSide: 'BOTH' });
  assert.equal(open.calls.find(call => call.payload.type === 'orderStatus').payload.oid, cloidOf(spec().clientId));
  const partial = harness({ info: { orderStatus: status({ status: 'canceled' }, { sz: '0.2' }), userFillsByTime: [fill(77, '0.1', '1616.4', 1), fill(9, '5', '1', 2), fill(77, '0.2', '1616.5', 3), fill(77, '0.2', '1616.5', 3)] } });
  const ended = await partial.client.inspect(credentials, spec({ id: '77' }));
  assert.deepEqual({ terminal: ended.terminal, childrenSettled: ended.childrenSettled, filledQuantity: ended.filledQuantity }, { terminal: true, childrenSettled: true, filledQuantity: '0.3' });
  assert.equal(ended.averagePrice, '1616.466666666666666666');
  // A canceled order reported unfilled is still checked: fills it does not show block a resend.
  const hidden = harness({ info: { orderStatus: status({ status: 'canceled' }), userFillsByTime: [fill(77, '0.1', '1616.4', 1)] } });
  await assert.rejects(hidden.client.inspect(credentials, spec({ id: '77' })), isError('invalid_data'));
  const clean = harness({ info: { orderStatus: status({ status: 'canceled' }), userFillsByTime: [] } });
  assert.equal((await clean.client.inspect(credentials, spec({ id: '77' }))).filledQuantity, '0');
  await assert.rejects(harness({ info: { orderStatus: { status: 'unknownOid' } } }).client.inspect(credentials, spec()), isError('not_found', { notFound: true }));
  // An unanswered create has no venue order id yet: the engine passes id: null and the cloid alone looks it up.
  const unanswered = harness({ info: { orderStatus: { status: 'unknownOid' } } });
  await assert.rejects(unanswered.client.inspect(credentials, spec({ id: null })), isError('not_found', { notFound: true }));
  assert.equal(unanswered.calls.filter(call => call.payload.type === 'orderStatus').length, 1);
  assert.equal((await harness({ info: { orderStatus: status() } }).client.inspect(credentials, spec({ id: null }))).id, '77');
  await assert.rejects(harness().client.stop(credentials, spec({ id: null }), { beforeMutation() {} }), isError('input'));
  for (const bad of [status({ status: 'someNewStatus' }), status({}, { oid: 78 }), status({}, { cloid: '0x' + '0'.repeat(32) }), status({}, { side: 'A' }), status({}, { tif: 'Gtc' }), status({ status: 'filled' }, { sz: '0.1' }), status({}, { sz: '0.6' })]) {
    await assert.rejects(harness({ info: { orderStatus: bad, userFillsByTime: [] } }).client.inspect(credentials, spec({ id: '77' })), isError('invalid_data'));
  }
});

test('fill history pages forward from the order time and fails closed when it cannot advance', async () => {
  let pages = 0;
  const rows = Array.from({ length: 2000 }, (_, index) => fill(index === 0 ? 77 : 5, '0.1', '1616.4', index + 10, T0 + index));
  const paged = harness({ info: { orderStatus: status({ status: 'filled' }, { sz: '0' }), userFillsByTime: payload => { pages += 1; return pages === 1 ? rows : [fill(77, '0.4', '1616.4', 99999, payload.startTime)]; } } });
  assert.equal((await paged.client.inspect(credentials, spec({ id: '77' }))).filledQuantity, '0.5');
  assert.equal(pages, 2);
  const stuck = Array.from({ length: 2000 }, (_, index) => fill(5, '0.1', '1', index, T0));
  await assert.rejects(harness({ info: { orderStatus: status({ status: 'filled' }, { sz: '0' }), userFillsByTime: stuck } }).client.inspect(credentials, spec({ id: '77' })), isError('pagination'));
});

test('stop cancels exactly the original order id and never builds any other action', async () => {
  const h = harness({ exchange: [{ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }, { status: 'ok', response: { type: 'cancel', data: { statuses: [{ error: 'Order was never placed, already canceled, or filled.' }] } } }] });
  assert.deepEqual(await h.client.stop(credentials, spec({ id: '77' })), { id: '77' });
  assert.deepEqual(h.exchanges[0].payload.action, { type: 'cancel', cancels: [{ a: 120001, o: 77 }] });
  await assert.rejects(h.client.stop(credentials, spec({ id: '77' })), isError('rejected', { uncertain: false }));
  await assert.rejects(h.client.stop(credentials, spec()), isError('input'));
  await assert.rejects(h.client.amend(credentials, spec({ id: '77' })), isError('input'));
  await assert.rejects(h.client.endedStrategies(credentials, {}), isError('input'));
  assert.ok(h.exchanges.every(call => ['order', 'cancel'].includes(call.payload.action.type)));
  assert.ok(h.calls.every(call => call.url.startsWith('https://api.hyperliquid.xyz/')));
});
