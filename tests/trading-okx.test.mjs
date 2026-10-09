import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createOkxTradingClient } from '../server/trading-okx-readonly.mjs';
import { createOkxExecutionClient } from '../server/trading-okx-execution.mjs';
import { TradingExchangeError } from '../server/trading-exchanges.mjs';
import { ExecutionExchangeError } from '../server/trading-execution-exchanges.mjs';

const NOW = Date.parse('2026-10-09T06:00:00Z');
const DAY = 86_400_000;
const ORDER = '9223372036854775806';
const credentials = Object.freeze({ apiKey: 'fixture-okx-key', apiSecret: 'fixture-okx-secret', passphrase: 'fixture-okx-passphrase' });
const spec = Object.freeze({ symbol: 'CLUSDT', side: 'buy', positionSide: 'BOTH', quantity: '2', reduceOnly: false, clientId: 'execution_fixture_001', stopPrice: '90' });
const nativeId = value => 'ox' + createHash('sha256').update(value).digest('hex').slice(0, 30);
const config = (readOnly = false, overrides = {}) => ({ uid: '1234567890123456789', acctLv: '2', posMode: 'net_mode',
  perm: readOnly ? 'read_only' : 'read_only,trade', ctIsoMode: 'automatic', ...overrides });
const rule = (instId, overrides = {}) => ({ instId, instType: 'SWAP', ctType: 'linear', settleCcy: 'USDT', state: 'live',
  ctValCcy: instId.startsWith('CL-') ? 'CL' : 'BZ', ctVal: instId.startsWith('CL-') ? '0.1' : '0.01', ctMult: '1',
  baseCcy: '', quoteCcy: '', tickSz: '0.01', lotSz: '1', minSz: '1', maxLmtSz: '100000000', maxLmtAmt: '20000000', ...overrides });
const position = (instId = 'CL-USDT-SWAP', overrides = {}) => ({ instId, instType: 'SWAP', posSide: 'net', mgnMode: 'cross',
  pos: '20', ccy: 'USDT', markPx: '80', avgPx: '79.5', upl: '1', lever: '5', liqPx: '65', uTime: String(NOW), notionalUsd: '999999', ...overrides });
const order = (overrides = {}) => ({ instType: 'SWAP', instId: 'CL-USDT-SWAP', ordId: ORDER, clOrdId: nativeId(spec.clientId),
  ordType: 'post_only', state: 'live', tdMode: 'cross', posSide: 'net', side: 'buy', reduceOnly: 'false', sz: '2', accFillSz: '0',
  px: '79.99', avgPx: '', cTime: String(NOW), ccy: 'USDT', algoId: '', attachAlgoOrds: [], ...overrides });
const bill = (instId, subType, overrides = {}) => ({ instType: 'SWAP', instId, subType, type: '8', ccy: 'USDT',
  billId: subType === '173' ? '999999999999999991' : '999999999999999992', ts: String(NOW - 1000),
  pnl: subType === '173' ? '-0.123456789012345678' : '0.234567890123456789',
  balChg: '900', posBalChg: '800', fee: '-700', ...overrides });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
function harness({ readOnly = false, handler = () => undefined, ...options } = {}) {
  const calls = [], waits = [];
  const state = { now: NOW, order: order(), config: config(readOnly) };
  const client = (readOnly ? createOkxTradingClient : createOkxExecutionClient)({
    ErrorClass: readOnly ? TradingExchangeError : ExecutionExchangeError,
    now: () => state.now, waitImpl: async ms => { waits.push(ms); }, ...options,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url), parameters = init.body === undefined ? Object.fromEntries(parsed.searchParams) : JSON.parse(init.body);
      const call = { url: parsed, init, parameters }; calls.push(call);
      let data = await handler(call, calls, state);
      if (data instanceof Response) return data;
      if (data === undefined) {
        const path = parsed.pathname;
        if (path === '/api/v5/account/config') data = [state.config];
        else if (path === '/api/v5/public/instruments') data = [rule(parameters.instId)];
        else if (path === '/api/v5/market/books') data = [{ bids: [['80', '10', '0', '2']], asks: [['80.1', '12', '0', '2']], ts: String(state.now) }];
        else if (path === '/api/v5/public/time') data = [{ ts: String(state.now + 2000) }];
        else if (path === '/api/v5/account/positions' || path === '/api/v5/account/bills-archive'
          || path === '/api/v5/trade/orders-pending' || path === '/api/v5/trade/orders-algo-pending') data = [];
        else if (path === '/api/v5/trade/order' && init.method === 'GET') data = [state.order];
        else if (path === '/api/v5/trade/order' && init.method === 'POST') data = [{ ordId: ORDER, clOrdId: parameters.clOrdId, sCode: '0' }];
        else if (path === '/api/v5/trade/amend-order') {
          state.order.px = parameters.newPx;
          data = [{ ordId: ORDER, clOrdId: parameters.clOrdId, reqId: parameters.reqId, sCode: '0' }];
        } else if (path === '/api/v5/trade/cancel-order') data = [{ ordId: ORDER, clOrdId: parameters.clOrdId, sCode: '0' }];
        else throw new Error('Unhandled fixture route');
      }
      return response({ code: '0', data });
    },
  });
  return { client, calls, waits, state };
}
const isExecutionError = (code, uncertain = false) => error => error instanceof ExecutionExchangeError && error.code === code && error.uncertain === uncertain;
const mutations = calls => calls.filter(call => call.init.method !== 'GET');
const signed = call => {
  assert.equal(call.url.origin, 'https://www.okx.com'); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.cache, 'no-store');
  assert.equal(call.init.headers['OK-ACCESS-KEY'], credentials.apiKey);
  assert.equal(call.init.headers['OK-ACCESS-PASSPHRASE'], credentials.passphrase);
  const prehash = call.init.headers['OK-ACCESS-TIMESTAMP'] + call.init.method + call.url.pathname + call.url.search + (call.init.body ?? '');
  assert.equal(call.init.headers['OK-ACCESS-SIGN'], createHmac('sha256', credentials.apiSecret).update(prehash).digest('base64'));
};

test('OKX public oil rules preserve different CL/BZ contract sizes and native lot constraints', async () => {
  const { client, calls, state } = harness();
  for (const [symbol, size] of [['CLUSDT', '0.1'], ['BZUSDT', '0.01']]) {
    const market = await client.market(symbol);
    assert.deepEqual(market.rule, { instrumentId: symbol === 'CLUSDT' ? 'CL-USDT-SWAP' : 'BZ-USDT-SWAP', quantityUnit: '张', contractSize: size,
      tickSize: '0.01', quantityStep: '1', minQuantity: '1', maxQuantity: '100000000', minNotional: '0', maxNotional: null, maxNotionalUsd: '20000000' });
  }
  await client.market('CLUSDT');
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/instruments')).length, 2);
  state.now += 60_001;
  await client.market('CLUSDT');
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/instruments')).length, 3);
  assert.ok(calls.every(call => Object.keys(call.init.headers).length === 0));
});

test('OKX refuses unsupported symbols, malformed rules and crossed books before execution', async () => {
  const plain = harness();
  await assert.rejects(plain.client.market('BRNUSDT'), isExecutionError('input'));
  assert.equal(plain.calls.length, 0);
  for (const changes of [{ settleCcy: 'USDC' }, { ctValCcy: 'BTC' }, { ctType: 'inverse' }, { state: 'suspend' }, { ctVal: '0' }, { ctMult: '' }, { minSz: '100000001' }]) {
    const h = harness({ handler: call => call.url.pathname.endsWith('/instruments') ? [rule(call.parameters.instId, changes)] : undefined });
    await assert.rejects(h.client.market('CLUSDT'), error => error instanceof ExecutionExchangeError);
  }
  const crossed = harness({ handler: call => call.url.pathname.endsWith('/books') ? [{ bids: [['80.1', '1']], asks: [['80.1', '2']], ts: String(NOW) }] : undefined });
  await assert.rejects(crossed.client.market('CLUSDT'), isExecutionError('not_tradable'));
  const postOnlyState = harness({ handler: call => call.url.pathname.endsWith('/instruments') ? [rule(call.parameters.instId, { state: 'post_only' })] : undefined });
  assert.equal((await postOnlyState.client.market('CLUSDT')).rule.contractSize, '0.1');
});

test('OKX read-only keys must be exactly read_only and execution keys exactly read_only plus trade', async () => {
  for (const [readOnly, scopes] of [[true, ['read_only,trade', 'read_only,withdraw', '', 'read_only,read_only']],
    [false, ['read_only', 'trade', 'read_only,trade,withdraw', 'read_only,trade,unknown', 'read_only,trade,trade']]]) {
    for (const perm of scopes) {
      const h = harness({ readOnly }); h.state.config.perm = perm;
      await assert.rejects(h.client.verify(credentials), error => error.code === 'permissions');
      assert.equal(h.calls.length, 1);
    }
  }
  const execute = harness(); execute.state.config.perm = 'trade,read_only';
  assert.deepEqual(await execute.client.verify(credentials), { identity: '1234567890123456789' });
  signed(execute.calls[0]);
  for (const acctLv of ['1', '4', '', '99']) {
    const h = harness(); h.state.config.acctLv = acctLv;
    await assert.rejects(h.client.verify(credentials), isExecutionError('account_mode'));
  }
  const observer = harness({ readOnly: true }); observer.state.config.acctLv = '4';
  assert.equal((await observer.client.verify(credentials)).positions.length, 0);
  assert.equal(observer.calls.filter(call => call.url.pathname.endsWith('/bills-archive')).length, 4);
  assert.deepEqual(observer.waits, [420, 420, 420]);
});

test('OKX signing binds the exact query/body and passphrase without exposing credentials', async () => {
  const h = harness();
  await h.client.account(credentials);
  await h.client.create(credentials, { ...spec, ordType: 'market', host: 'https://other.invalid', px: '1000', attachAlgoOrds: [{ orderPx: '-1' }] });
  for (const call of h.calls.filter(call => !call.url.pathname.startsWith('/api/v5/public/') && !call.url.pathname.startsWith('/api/v5/market/'))) signed(call);
  const create = mutations(h.calls)[0];
  assert.deepEqual(create.parameters, { instId: 'CL-USDT-SWAP', tdMode: 'cross', clOrdId: nativeId(spec.clientId),
    side: 'buy', posSide: 'net', ordType: 'post_only', px: '80', sz: '2', reduceOnly: false, pxAmendType: '0' });
  assert.match(create.parameters.clOrdId, /^[A-Za-z0-9]{32}$/);
  assert.equal(h.calls.find(call => call.parameters.ordType === 'conditional,oco').url.searchParams.get('ordType'), 'conditional,oco');
  assert.ok(h.calls.every(call => !call.url.href.includes(credentials.apiSecret) && !call.url.href.includes(credentials.passphrase)));
});

test('OKX missing or malformed passphrase is rejected before any authenticated or execution request', async () => {
  for (const passphrase of [undefined, '', 'line\nbreak', 'blank space', 'x'.repeat(513)]) {
    const h = harness();
    await assert.rejects(h.client.verify({ ...credentials, passphrase }), isExecutionError('credentials'));
    await assert.rejects(h.client.create({ ...credentials, passphrase }, spec), isExecutionError('credentials'));
    assert.equal(h.calls.length, 0);
  }
});

test('OKX observations retain both margin modes and compute USDT notional from contracts, not notionalUsd', async () => {
  const h = harness({ readOnly: true, handler: call => call.url.pathname.endsWith('/positions')
    ? call.parameters.instId.startsWith('CL-') ? [position(), position('CL-USDT-SWAP', { mgnMode: 'isolated', pos: '-10', ccy: '', upl: '-0.5' })]
      : [position('BZ-USDT-SWAP', { pos: '200', markPx: '85', ccy: '' })] : undefined });
  const result = await h.client.positions(credentials);
  assert.equal(result.positions.length, 3);
  assert.deepEqual(result.positions.map(row => [row.symbol, row.marginMode, row.side, row.quantity, row.contractSize, row.notional]),
    [['CLUSDT', 'cross', 'long', '20', '0.1', '160'], ['CLUSDT', 'isolated', 'short', '10', '0.1', '80'], ['BZUSDT', 'cross', 'long', '200', '0.01', '170']]);
  assert.equal(new Set(result.positions.map(row => row.id)).size, 3);
  assert.ok(result.positions.every(row => row.quantityUnit === '张'));
  assert.equal(result.positions[0].unrealizedPnl, '1');
  const invalid = harness({ readOnly: true, handler: call => call.url.pathname.endsWith('/positions') ? [position(call.parameters.instId, { ccy: 'USDC' })] : undefined });
  await assert.rejects(invalid.client.positions(credentials), error => error instanceof TradingExchangeError && error.code === 'invalid_data');
});

test('OKX hedge observations and execution account sizes use positive contracts for each side', async () => {
  for (const readOnly of [true, false]) {
    const h = harness({ readOnly, handler: call => call.url.pathname.endsWith('/positions') ? [position(call.parameters.instId, { posSide: 'long', pos: '10' }), position(call.parameters.instId, { posSide: 'short', pos: '20' })] : undefined });
    h.state.config.posMode = 'long_short_mode';
    const value = readOnly ? await h.client.positions(credentials) : await h.client.account(credentials);
    assert.deepEqual(value.positions.map(row => [row.side, row.quantity]), [['long', '10'], ['short', '20'], ['long', '10'], ['short', '20']]);
    if (!readOnly) assert.deepEqual(value.modes, { CLUSDT: 'hedge', BZUSDT: 'hedge' });
  }
});

test('OKX account refuses another margin mode position or ordinary order without changing account settings', async () => {
  for (const accountMode of ['cross', 'isolated']) {
    const other = accountMode === 'cross' ? 'isolated' : 'cross';
    const h = harness({ handler: call => call.url.pathname.endsWith('/positions') ? [position(call.parameters.instId, { mgnMode: other })] : undefined });
    await assert.rejects(h.client.account(credentials, { accountMode }), isExecutionError('account_mode'));
    assert.equal(mutations(h.calls).length, 0);
    const withOrder = harness({ handler: call => call.url.pathname.endsWith('/orders-pending') ? [order({ instId: call.parameters.instId, tdMode: other })] : undefined });
    await assert.rejects(withOrder.client.account(credentials, { accountMode }), isExecutionError('account_mode'));
  }
  const emptyOther = harness({ handler: call => call.url.pathname.endsWith('/positions') ? [position(call.parameters.instId, { mgnMode: 'isolated', pos: '0', avgPx: '', markPx: '', ccy: '' })] : undefined });
  assert.deepEqual((await emptyOther.client.account(credentials)).positions, []);
});

test('OKX account enumerates all active algo types and blocks any oil algo without inventing fills', async () => {
  const expected = ['conditional,oco', 'trigger', 'move_order_stop', 'iceberg', 'twap', 'chase', 'smart_iceberg'];
  const clear = harness();
  await clear.client.account(credentials);
  for (const instId of ['CL-USDT-SWAP', 'BZ-USDT-SWAP']) assert.deepEqual(clear.calls.filter(call => call.url.pathname.endsWith('/orders-algo-pending') && call.parameters.instId === instId).map(call => call.parameters.ordType), expected);
  for (const type of expected) {
    const h = harness({ handler: call => call.url.pathname.endsWith('/orders-algo-pending') && call.parameters.ordType === type ? [{ instId: call.parameters.instId, algoId: '999', ordType: type.split(',')[0] }] : undefined });
    await assert.rejects(h.client.account(credentials), isExecutionError('external_orders'));
    assert.equal(mutations(h.calls).length, 0);
  }
});

test('OKX ordinary pending pagination uses decreasing order IDs and never skips a full page', async () => {
  const h = harness({ handler: call => call.url.pathname.endsWith('/orders-pending') && call.parameters.instId === 'CL-USDT-SWAP'
    ? call.parameters.after ? [] : Array.from({ length: 100 }, (_, i) => order({ ordId: String(1000 - i) })) : undefined });
  const account = await h.client.account(credentials);
  assert.equal(account.openOrders.length, 100);
  const pages = h.calls.filter(call => call.url.pathname.endsWith('/orders-pending') && call.parameters.instId === 'CL-USDT-SWAP');
  assert.equal(pages.length, 2); assert.equal(pages[1].parameters.after, '901');
  const repeated = harness({ handler: call => call.url.pathname.endsWith('/orders-pending') ? Array.from({ length: 100 }, (_, i) => order({ ordId: String(1000 - i) })) : undefined });
  await assert.rejects(repeated.client.account(credentials), isExecutionError('pagination'));
});

test('OKX funds use signed pnl for expense and income, including isolated balance deltas', async () => {
  const h = harness({ readOnly: true, handler: call => call.url.pathname.endsWith('/bills-archive') ? [bill(call.parameters.instId, call.parameters.subType)] : undefined });
  const value = await h.client.funding(credentials, { start: NOW - DAY, end: NOW });
  assert.equal(value.complete, true); assert.equal(value.events.length, 4);
  assert.deepEqual(new Set(value.events.map(row => row.amount)), new Set(['-0.123456789012345678', '0.234567890123456789']));
  assert.deepEqual(value.coverage, [{ start: NOW - DAY, end: NOW }]);
  for (const call of h.calls.filter(call => call.url.pathname.endsWith('/bills-archive'))) {
    signed(call); assert.equal(call.parameters.begin, String(NOW - DAY)); assert.equal(call.parameters.end, String(NOW - 1));
    assert.equal(call.parameters.ccy, 'USDT'); assert.equal(call.parameters.ctType, 'linear');
  }
});

test('OKX funding full pages advance with billId and retain distinct int64 IDs', async () => {
  const h = harness({ readOnly: true, handler: call => {
    if (!call.url.pathname.endsWith('/bills-archive') || call.parameters.instId !== 'CL-USDT-SWAP' || call.parameters.subType !== '173') return undefined;
    if (call.parameters.after) return [bill('CL-USDT-SWAP', '173', { billId: '9223372036854775707' })];
    return Array.from({ length: 100 }, (_, i) => bill('CL-USDT-SWAP', '173', { billId: String(9223372036854775807n - BigInt(i)) }));
  } });
  const value = await h.client.funding(credentials, { start: NOW - DAY, end: NOW });
  assert.equal(value.complete, true); assert.equal(value.events.length, 101);
  const pages = h.calls.filter(call => call.url.pathname.endsWith('/bills-archive') && call.parameters.instId === 'CL-USDT-SWAP' && call.parameters.subType === '173');
  assert.equal(pages[1].parameters.after, '9223372036854775708');
  assert.ok(value.events.some(row => row.id.endsWith(':9223372036854775807')));
});

test('OKX failed or repeated funding pages leave the current window incomplete', async () => {
  for (const invalid of [
    call => [bill(call.parameters.instId, call.parameters.subType, { ts: String(NOW) })],
    call => [bill(call.parameters.instId, call.parameters.subType, { ccy: 'USDC' })],
    call => [bill(call.parameters.instId, call.parameters.subType, { pnl: '1' })],
    call => Array.from({ length: 100 }, (_, i) => bill(call.parameters.instId, call.parameters.subType, { billId: String(1000 - i) })),
  ]) {
    const h = harness({ readOnly: true, handler: call => call.url.pathname.endsWith('/bills-archive') ? invalid(call) : undefined });
    const value = await h.client.funding(credentials, { start: NOW - DAY, end: NOW });
    assert.equal(value.complete, false); assert.deepEqual(value.coverage, []); assert.ok(value.error);
  }
});

test('OKX funding preserves already completed windows after a later failure and honors abort', async () => {
  const progress = [];
  const h = harness({ readOnly: true, handler: call => call.url.pathname.endsWith('/bills-archive') && Number(call.parameters.begin) >= NOW - DAY
    ? response({ code: '50011', msg: 'must not expose fixture secret' }, 429) : undefined });
  const value = await h.client.funding(credentials, { start: NOW - 8 * DAY, end: NOW, onProgress: state => progress.push(state) });
  assert.equal(value.complete, false); assert.deepEqual(value.coverage, [{ start: NOW - 8 * DAY, end: NOW - DAY }]);
  assert.equal(progress.length, 1); assert.equal(value.error.includes('fixture secret'), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.client.funding(credentials, { start: NOW - DAY, end: NOW, signal: controller.signal }), error => error.name === 'AbortError');
});

test('OKX PostOnly open/close orders preserve native contracts, margin selection and explicit hedge sides', async () => {
  const cases = [
    [{ ...spec, positionSide: 'LONG' }, 'long', undefined],
    [{ ...spec, side: 'sell', positionSide: 'SHORT', stopPrice: '70' }, 'short', undefined],
    [{ ...spec, side: 'sell', positionSide: 'LONG', reduceOnly: true, stopPrice: '70' }, 'long', undefined],
    [{ ...spec, positionSide: 'SHORT', reduceOnly: true }, 'short', undefined],
    [{ ...spec, side: 'sell', reduceOnly: true, stopPrice: '70' }, 'net', true],
  ];
  for (const [input, posSide, reduceOnly] of cases) {
    const h = harness(); await h.client.create(credentials, input, { accountMode: 'isolated' });
    const sent = mutations(h.calls)[0].parameters;
    assert.equal(sent.tdMode, 'isolated'); assert.equal(sent.posSide, posSide); assert.equal(sent.reduceOnly, reduceOnly);
    assert.equal(sent.sz, '2'); assert.equal(sent.ordType, 'post_only'); assert.equal(sent.px, input.side === 'buy' ? '80' : '80.1');
  }
  const invalid = harness();
  await assert.rejects(invalid.client.create(credentials, { ...spec, side: 'sell', positionSide: 'LONG' }), isExecutionError('input'));
  await assert.rejects(invalid.client.create(credentials, { ...spec, positionSide: 'LONG', reduceOnly: true }), isExecutionError('input'));
  assert.equal(invalid.calls.length, 0);
});

test('OKX create and amend stop before writing when fresh quotes cross the stop or expire', async () => {
  for (const action of ['create', 'amend']) {
    const h = harness();
    await assert.rejects(h.client[action](credentials, { ...spec, id: ORDER, stopPrice: '80' }), isExecutionError('rejected'));
    assert.equal(mutations(h.calls).length, 0);
    const stale = harness({ handler: call => call.url.pathname.endsWith('/books') ? [{ bids: [['80', '1']], asks: [['80.1', '1']], ts: String(NOW - 10_001) }] : undefined });
    await assert.rejects(stale.client[action](credentials, { ...spec, id: ORDER }), isExecutionError('not_tradable'));
    assert.equal(mutations(stale.calls).length, 0);
    const expires = harness();
    await assert.rejects(expires.client[action](credentials, { ...spec, id: ORDER }, { beforeMutation: () => { expires.state.now += 11_000; } }), isExecutionError('not_tradable'));
    assert.equal(mutations(expires.calls).length, 0);
  }
});

test('OKX native quantity limits and refreshed contract sizes block invalid submission', async () => {
  for (const quantity of ['0.5', '1.5', '100000001']) {
    const h = harness();
    await assert.rejects(h.client.create(credentials, { ...spec, quantity }), isExecutionError('input'));
    assert.equal(mutations(h.calls).length, 0);
  }
  const bz = harness(); await bz.client.create(credentials, { ...spec, symbol: 'BZUSDT', quantity: '3000000' });
  assert.equal(mutations(bz.calls)[0].parameters.sz, '3000000');
  for (const action of ['create', 'amend']) {
    const h = harness();
    await assert.rejects(h.client[action](credentials, { ...spec, id: ORDER, contractSize: '1', instrumentId: 'CL-USDT-SWAP' }), isExecutionError('not_tradable'));
    assert.equal(mutations(h.calls).length, 0);
    let instrumentReads = 0;
    const changed = harness({ handler: call => call.url.pathname.endsWith('/instruments')
      ? [rule(call.parameters.instId, ++instrumentReads > 1 ? { ctVal: '1' } : {})] : undefined });
    const preview = await changed.client.market('CLUSDT');
    await assert.rejects(changed.client[action](credentials, { ...spec, id: ORDER, contractSize: preview.rule.contractSize,
      instrumentId: preview.rule.instrumentId }), isExecutionError('not_tradable'));
    assert.equal(mutations(changed.calls).length, 0);
  }
});

test('OKX native amendment preserves ID and original total and reconciles the asynchronous acknowledgement', async () => {
  const h = harness(); h.state.order = order({ sz: '10', accFillSz: '3', state: 'partially_filled', avgPx: '79.9' });
  let guards = 0;
  const result = await h.client.amend(credentials, { ...spec, id: ORDER, quantity: '10' }, { beforeMutation: () => { guards += 1; } });
  assert.equal(result.id, ORDER); assert.equal(result.quantity, '10'); assert.equal(result.filledQuantity, '3'); assert.equal(result.price, '80');
  assert.equal(result.terminal, false); assert.equal(guards, 1);
  const sent = mutations(h.calls); assert.equal(sent.length, 1);
  assert.equal(sent[0].url.pathname, '/api/v5/trade/amend-order');
  assert.equal(sent[0].parameters.ordId, ORDER); assert.equal(sent[0].parameters.newPx, '80');
  assert.equal(sent[0].parameters.cxlOnFail, false); assert.equal(sent[0].parameters.newSz, undefined);
  assert.match(sent[0].parameters.reqId, /^[A-Za-z0-9]{32}$/); signed(sent[0]);
  assert.equal(h.calls.filter(call => call.url.pathname === '/api/v5/trade/order' && call.init.method === 'GET').length, 2);
});

test('OKX unchanged or terminal original order skips unnecessary amendment', async () => {
  for (const changes of [{ px: '80' }, { state: 'filled', accFillSz: '2', avgPx: '79.99' }, { state: 'canceled' }]) {
    const h = harness(); h.state.order = order(changes);
    await h.client.amend(credentials, { ...spec, id: ORDER });
    assert.equal(mutations(h.calls).length, 0);
  }
});

test('OKX wrong original identity, order type or size cannot be amended or claimed', async () => {
  for (const changes of [{ clOrdId: 'foreign' }, { ordId: '999' }, { ordType: 'limit' }, { tdMode: 'isolated' }, { sz: '3' }, { side: 'sell' }, { attachAlgoOrds: [{ algoId: '8' }] }]) {
    const h = harness(); h.state.order = order(changes);
    await assert.rejects(h.client.amend(credentials, { ...spec, id: ORDER }), isExecutionError('invalid_data'));
    assert.equal(mutations(h.calls).length, 0);
  }
});

test('OKX unresolved amendment ACK performs only bounded reads and never resubmits', async () => {
  const h = harness({ handler: call => call.url.pathname.endsWith('/amend-order')
    ? [{ ordId: ORDER, clOrdId: call.parameters.clOrdId, reqId: call.parameters.reqId, sCode: '0' }] : undefined });
  await assert.rejects(h.client.amend(credentials, { ...spec, id: ORDER }), isExecutionError('upstream', true));
  assert.equal(mutations(h.calls).length, 1);
  assert.equal(h.calls.filter(call => call.url.pathname === '/api/v5/trade/order' && call.init.method === 'GET').length, 4);
});

test('OKX read failure after accepted amendment remains uncertain and never recreates the order', async () => {
  let amended = false;
  const h = harness({ handler: call => {
    if (call.url.pathname.endsWith('/amend-order')) { amended = true; return undefined; }
    if (amended && call.url.pathname === '/api/v5/trade/order' && call.init.method === 'GET') return response({ code: '51603' });
    return undefined;
  } });
  await assert.rejects(h.client.amend(credentials, { ...spec, id: ORDER }), isExecutionError('not_found', true));
  assert.equal(mutations(h.calls).length, 1);
});

test('OKX lookup by deterministic clOrdId recovers unknown create without creating an order', async () => {
  const h = harness();
  const result = await h.client.inspect(credentials, { ...spec, id: null });
  assert.equal(result.id, ORDER); assert.equal(h.calls[0].parameters.clOrdId, nativeId(spec.clientId));
  assert.equal(h.calls[0].parameters.ordId, undefined); assert.equal(mutations(h.calls).length, 0);
  const missing = harness({ handler: call => call.url.pathname === '/api/v5/trade/order' ? [] : undefined });
  await assert.rejects(missing.client.inspect(credentials, spec), error => isExecutionError('not_found')(error) && error.notFound === true);
});

test('OKX canceled post-only can be terminal without a live event and retains partial fills', async () => {
  for (const accFillSz of ['0', '1']) {
    const h = harness(); h.state.order = order({ state: 'canceled', accFillSz, avgPx: accFillSz === '1' ? '79.99' : '' });
    const result = await h.client.inspect(credentials, { ...spec, id: ORDER });
    assert.equal(result.terminal, true); assert.equal(result.childrenSettled, true); assert.equal(result.filledQuantity, accFillSz);
  }
});

test('OKX cancel ACK does not imply terminal state and own system-trimmed order remains cancelable', async () => {
  const h = harness();
  await h.client.stop(credentials, { ...spec, id: ORDER });
  assert.equal((await h.client.inspect(credentials, { ...spec, id: ORDER })).terminal, false);
  assert.equal(mutations(h.calls)[0].url.pathname, '/api/v5/trade/cancel-order');
  const trimmed = harness(); trimmed.state.order = order({ sz: '1' });
  await assert.rejects(trimmed.client.inspect(credentials, { ...spec, id: ORDER }), isExecutionError('invalid_data'));
  await trimmed.client.stop(credentials, { ...spec, id: ORDER });
  assert.equal(mutations(trimmed.calls).length, 1);
  const foreign = harness(); foreign.state.order = order({ clOrdId: 'foreign' });
  await assert.rejects(foreign.client.stop(credentials, { ...spec, id: ORDER }), isExecutionError('invalid_data'));
  assert.equal(mutations(foreign.calls).length, 0);
});

test('OKX mutation transport, malformed ACK, timeout and unknown provider errors remain uncertain without retry', async () => {
  const cases = [
    () => { throw new Error('private response fixture-okx-secret'); },
    () => new Response('{'),
    () => response({ code: '0', data: [{}] }),
    () => response({ code: '0', data: [{ ordId: ORDER, clOrdId: 'foreign', sCode: '0' }] }),
    () => response({ code: '50004', msg: credentials.apiSecret }),
    () => response({ code: '51011', msg: credentials.passphrase }),
    () => response({ code: '51603' }),
    () => response({ code: '51008' }, 503),
    () => new Promise(() => {}),
  ];
  for (const makeResponse of cases) {
    const h = harness({ timeoutMs: 10, handler: call => call.init.method === 'POST' ? makeResponse() : undefined });
    await assert.rejects(h.client.create(credentials, spec), error => error instanceof ExecutionExchangeError && error.uncertain && !error.message.includes('fixture-okx'));
    assert.equal(mutations(h.calls).length, 1);
  }
});

test('OKX explicit single-order business rejection does not pretend execution is unknown', async () => {
  for (const data of [{ code: '51008' }, { code: '1', data: [{ sCode: '51008' }] }]) {
    const h = harness({ handler: call => call.init.method === 'POST' ? response(data) : undefined });
    await assert.rejects(h.client.create(credentials, spec), isExecutionError('rejected'));
    assert.equal(mutations(h.calls).length, 1);
  }
});

test('OKX response limits and redirects fail closed without retaining upstream text', async () => {
  for (const makeResponse of [
    () => new Response('private response', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    () => new Response('private response', { status: 302, headers: { location: 'https://other.invalid' } }),
  ]) {
    const h = harness({ handler: call => call.init.method === 'POST' ? makeResponse() : undefined });
    await assert.rejects(h.client.create(credentials, spec), error => error instanceof ExecutionExchangeError && error.uncertain && !error.message.includes('private'));
    assert.equal(mutations(h.calls).length, 1);
    assert.equal(mutations(h.calls)[0].init.redirect, 'error');
  }
});

test('OKX timestamp rejection allows exactly one bounded clock correction with the same order intent', async () => {
  let attempts = 0, guards = 0;
  const h = harness({ handler: call => call.init.method === 'POST' && ++attempts === 1 ? response({ code: '50102' }) : undefined });
  await h.client.create(credentials, spec, { beforeMutation: () => { guards += 1; } });
  const posts = mutations(h.calls);
  assert.equal(posts.length, 2); assert.equal(guards, 2); assert.deepEqual(posts[0].parameters, posts[1].parameters);
  assert.equal(posts[1].init.headers['OK-ACCESS-TIMESTAMP'], new Date(NOW + 2000).toISOString());
  const excessive = harness({ handler: call => call.init.method === 'POST' ? response({ code: '50102' })
    : call.url.pathname.endsWith('/time') ? [{ ts: String(NOW + 300_001) }] : undefined });
  await assert.rejects(excessive.client.create(credentials, spec), isExecutionError('clock'));
  assert.equal(mutations(excessive.calls).length, 1);
});

test('OKX lease guard errors remain original and an aborted dispatched order remains unknown', async () => {
  const h = harness(), expected = new Error('fixture lost lease');
  await assert.rejects(h.client.create(credentials, spec, { beforeMutation: () => { throw expected; } }), error => error === expected);
  assert.equal(mutations(h.calls).length, 0);
  const controller = new AbortController();
  const aborted = harness({ handler: call => {
    if (call.init.method !== 'POST') return undefined;
    controller.abort(); return new Promise(() => {});
  } });
  await assert.rejects(aborted.client.create(credentials, spec, { signal: controller.signal }), isExecutionError('aborted', true));
  assert.equal(mutations(aborted.calls).length, 1);
});
