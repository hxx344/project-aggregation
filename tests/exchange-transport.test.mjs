import test from 'node:test';
import assert from 'node:assert/strict';
import { okxAuthHeaders, okxSignature } from '../server/exchange-transport/okx.mjs';
import { ExchangeResponseError, readJsonResponse } from '../server/exchange-transport/response.mjs';
import { binanceSignedQuery } from '../server/exchange-transport/binance.mjs';
import { bybitAuthHeaders } from '../server/exchange-transport/bybit.mjs';
import { gateAuthHeaders } from '../server/exchange-transport/gate.mjs';
import { createOkxProtocol, OkxProtocolError } from '../server/trading-okx-common.mjs';

// Shared exchange transport (docs/evolution-plan.md E2). The pinned signatures
// fix the OKX prehash (tests/trading-okx.test.mjs recomputes it independently);
// the Hub comparison fixes that the signed path, query and body are the ones sent.
const credentials = { apiKey: 'test-key', apiSecret: 'test-secret', passphrase: 'test-pass' };
const at = '2026-11-07T00:00:00.000Z';
const order = '{"instId":"CL-USDT-SWAP","sz":"1"}';

test('OKX signatures match pinned vectors', () => {
  assert.equal(okxSignature('test-secret', { timestamp: at, method: 'GET', requestPath: '/api/v5/account/positions?instType=SWAP' }), 'ULi9Y5NT1+Ne7kQJDvi2GMwoMdQTEnMVz0j0mR1Tg40=');
  assert.equal(okxSignature('test-secret', { timestamp: at, method: 'POST', requestPath: '/api/v5/trade/order', body: order }), 'tFoiuJVhqTaCZRMaPjhejOYXhvc9VQY6SLpaaPyjEwY=');
  assert.deepEqual(Object.keys(okxAuthHeaders(credentials, { timestamp: at, method: 'GET', requestPath: '/api/v5/account/config' })).sort(),
    ['OK-ACCESS-KEY', 'OK-ACCESS-PASSPHRASE', 'OK-ACCESS-SIGN', 'OK-ACCESS-TIMESTAMP']);
});

test('OKX signing refuses a request it cannot sign exactly', () => {
  for (const request of [
    { timestamp: at, method: 'GET', requestPath: '/api/v5/account/config', body: '{}' },
    { timestamp: at, method: 'get', requestPath: '/api/v5/account/config' },
    { timestamp: at, method: 'DELETE', requestPath: '/api/v5/account/config' },
    { timestamp: at, method: 'GET', requestPath: 'https://www.okx.com/api/v5/account/config' },
    { timestamp: '', method: 'GET', requestPath: '/api/v5/account/config' },
    { timestamp: at, method: 'POST', requestPath: '/api/v5/trade/order', body: { sz: '1' } },
  ]) assert.throws(() => okxSignature('test-secret', request), TypeError, JSON.stringify(request));
  assert.throws(() => okxSignature('', { timestamp: at, method: 'GET', requestPath: '/api/v5/account/config' }), TypeError);
});

// Expected signatures computed independently (Python hmac/hashlib).
test('Binance, Bybit and Gate signatures match pinned vectors', () => {
  const signed = binanceSignedQuery(credentials, { symbol: 'CLUSDT', timestamp: '1', recvWindow: '1' }, { timestamp: '1789776000000', recvWindow: '5000' });
  assert.deepEqual(signed, {
    query: 'symbol=CLUSDT&timestamp=1789776000000&recvWindow=5000&signature=28eb33550a1196b6820c375b21360d1501ba3562e1ec026d566dfdbf4ece5b7f',
    headers: { 'X-MBX-APIKEY': 'test-key' },
  }, 'given timestamp and recvWindow are replaced in place');
  const bybit = (payload) => bybitAuthHeaders(credentials, { timestamp: '1789776000000', recvWindow: '5000', payload });
  assert.deepEqual(bybit('category=linear&symbol=CLUSDT'), {
    'X-BAPI-API-KEY': 'test-key', 'X-BAPI-TIMESTAMP': '1789776000000', 'X-BAPI-RECV-WINDOW': '5000',
    'X-BAPI-SIGN': 'e343616e1191829610b517d02de25ec12ad6f30bddf8a7cd18c7596c5c65dc43',
  });
  assert.equal(bybit('{"category":"linear","symbol":"CLUSDT","side":"Buy"}')['X-BAPI-SIGN'], 'e561008309026045f2ec59da11e25f0ad6e4d965ccfe98cf65cb0fede5f916b8');
  assert.deepEqual(gateAuthHeaders(credentials, { method: 'GET', path: '/api/v4/wallet/total_balance', query: 'currency=USDT', timestamp: '1789776000' }), {
    KEY: 'test-key', Timestamp: '1789776000',
    SIGN: '03722785c90e9c0b7afbe926849494961415b6bf6ccc72d3ca4230022e0a21b835672610ee57c4abae0f94b5bb6fb5ef71702e3f670fbb255281ce21e0cc788e',
  });
  assert.equal(gateAuthHeaders(credentials, { method: 'POST', path: '/api/v4/crossex/orders', body: '{"symbol":"BTC_USDT","size":"1"}', timestamp: '1789776000' }).SIGN,
    '47844c4e5da3ecc5d9a541015239c59bb1efb7728dbe448b4452143610572b785f9eada4a010d2a67cfd95aa0d3c38ca13580b664d23adca0183f27b30deeebc');
});

test('Binance, Bybit and Gate signing refuse a request they cannot sign exactly', () => {
  const window = { timestamp: '1789776000000', recvWindow: '5000' };
  for (const options of [{ ...window, timestamp: '1.5' }, { ...window, timestamp: 1789776000000 }, { ...window, recvWindow: '' }]) {
    assert.throws(() => binanceSignedQuery(credentials, {}, options), TypeError);
    assert.throws(() => bybitAuthHeaders(credentials, options), TypeError);
  }
  assert.throws(() => binanceSignedQuery({ ...credentials, apiSecret: '' }, {}, window), TypeError);
  assert.throws(() => bybitAuthHeaders({ ...credentials, apiSecret: '' }, window), TypeError);
  assert.throws(() => bybitAuthHeaders(credentials, { ...window, payload: {} }), TypeError);
  const gate = { method: 'GET', path: '/api/v4/wallet/total_balance', timestamp: '1789776000' };
  for (const request of [{ ...gate, method: 'get' }, { ...gate, path: 'https://api.gateio.ws/api/v4/x' }, { ...gate, query: '?a=1' }, { ...gate, body: {} }, { ...gate, timestamp: '1789776000000.5' }]) {
    assert.throws(() => gateAuthHeaders(credentials, request), TypeError);
  }
  assert.throws(() => gateAuthHeaders({ ...credentials, apiSecret: '' }, gate), TypeError);
});

test('the Hub protocol signs with the exact path, query and body it sends', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url: new URL(url), init });
    return Response.json({ code: '0', data: [{ sCode: '0', ordId: '1' }] });
  };
  const protocol = createOkxProtocol({ fetchImpl, now: () => Date.parse(at) });
  await protocol.request('positions', credentials, { instType: 'SWAP' });
  await protocol.request('create', credentials, JSON.parse(order));
  for (const { url, init } of sent) {
    const expected = okxAuthHeaders(credentials, { timestamp: at, method: init.method, requestPath: url.pathname + url.search, ...(init.body ? { body: init.body } : {}) });
    for (const [name, value] of Object.entries(expected)) assert.equal(init.headers[name], value, `${init.method} ${url.pathname} ${name}`);
  }
  assert.equal(sent.length, 2);
});

// The Hub keeps its own codes on top of the shared reader: a mutation whose
// response is unreadable stays uncertain, a read does not.
test('the Hub protocol maps shared reading failures to its codes and uncertainty', async () => {
  const cases = [
    ['positions', () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), 'response_limit', false],
    ['create', () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), 'response_limit', true],
    ['create', () => new Response('{"code":'), 'invalid_data', true],
    ['positions', () => new Response('<html></html>', { status: 200 }), 'invalid_data', false],
    ['positions', () => new Response('\ufeff{"code":"0","data":[]}'), null, false],
  ];
  // A failure code the shared reader does not have today.
  const future = () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({
    read: async () => { throw new ExchangeResponseError('future_code'); }, cancel: async () => {}, releaseLock() {} }) } });
  cases.push(['create', future, 'invalid_data', true], ['positions', future, 'invalid_data', false]);
  for (const [operation, reply, expected, uncertain] of cases) {
    const protocol = createOkxProtocol({ fetchImpl: async () => reply(), now: () => Date.parse(at) });
    const call = protocol.request(operation, credentials, operation === 'create' ? JSON.parse(order) : { instType: 'SWAP' });
    if (expected === null) { assert.deepEqual(await call, [], 'a leading BOM is accepted'); continue; }
    await assert.rejects(call, (error) => error instanceof OkxProtocolError && error.code === expected && error.uncertain === uncertain, `${operation} ${expected}`);
  }
});

const stream = (chunks, { length } = {}) => new Response(new ReadableStream({
  pull(controller) { const next = chunks.shift(); if (next === undefined) controller.close(); else controller.enqueue(new TextEncoder().encode(next)); },
}), { headers: length === undefined ? {} : { 'content-length': length } });
const code = (expected) => (error) => error instanceof ExchangeResponseError && error.code === expected;

test('bounded JSON reading parses a body within the limit', async () => {
  assert.deepEqual(await readJsonResponse(stream(['{"code":', '"0"}']), { maxBytes: 16 }), { code: '0' });
  assert.deepEqual(await readJsonResponse(Response.json([1, 2]), { maxBytes: 5 }), [1, 2]);
  assert.deepEqual(await readJsonResponse(stream(['\ufeff{"a":1}']), { maxBytes: 16 }), { a: 1 }, 'a leading BOM is ignored');
});

test('bounded JSON reading refuses oversized, unreadable and cancelled bodies', async () => {
  await assert.rejects(readJsonResponse(stream(['{}'], { length: '17' }), { maxBytes: 16 }), code('response_limit'));
  await assert.rejects(readJsonResponse(stream(['{}'], { length: '1e3' }), { maxBytes: 16 }), code('response_limit'));
  let declaredCancelled = false;
  const declared = new Response(new ReadableStream({ pull() {}, cancel() { declaredCancelled = true; } }), { headers: { 'content-length': '17' } });
  await assert.rejects(readJsonResponse(declared, { maxBytes: 16 }), code('response_limit'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(declaredCancelled, true, 'a body refused by its declared length is cancelled unread');
  let cancelled = false;
  const endless = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(8)); }, cancel() { cancelled = true; } }));
  await assert.rejects(readJsonResponse(endless, { maxBytes: 20 }), code('response_limit'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true, 'an oversized body is cancelled');
  await assert.rejects(readJsonResponse(stream(['PRIVATE not json']), { maxBytes: 64 }), code('invalid_data'));
  await assert.rejects(readJsonResponse({ headers: new Headers(), body: null }, { maxBytes: 64 }), code('invalid_data'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readJsonResponse(stream(['{}']), { maxBytes: 64, signal: controller.signal }), code('aborted'));
  await assert.rejects(readJsonResponse(stream(['{}']), { maxBytes: 0 }), TypeError);
});

test('bounded JSON reading applies a reviver and passes its refusal through', async () => {
  const keepSource = (key, value, context) => key === 'id' ? context.source : value;
  assert.deepEqual(await readJsonResponse(stream(['{"id":9007199254740993}']), { maxBytes: 64, reviver: keepSource }), { id: '9007199254740993' });
  const refusal = new RangeError('id refused');
  await assert.rejects(readJsonResponse(stream(['{"id":1}']), { maxBytes: 64, reviver: () => { throw refusal; } }), (error) => error === refusal);
  await assert.rejects(readJsonResponse(stream(['{}']), { maxBytes: 64, reviver: 'id' }), TypeError);
  await assert.rejects(readJsonResponse(stream(['not json']), { maxBytes: 64, reviver: keepSource }), code('invalid_data'));
  const holders = [];
  await readJsonResponse(stream(['{"a":{"b":1}}']), { maxBytes: 64, reviver(key, value) { if (key === 'b') holders.push(this); return value; } });
  assert.deepEqual(holders, [{ b: 1 }], 'the reviver sees the holding object as this');
});

test('bounded JSON reading cancels a body that stalls when its signal aborts', async () => {
  let cancelled = false;
  const stalled = new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel() { cancelled = true; } }));
  const controller = new AbortController();
  const reading = readJsonResponse(stalled, { maxBytes: 64, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(reading, code('aborted'));
  assert.equal(cancelled, true, 'the pending read is cancelled');
});
