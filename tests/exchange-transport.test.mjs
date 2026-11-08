import test from 'node:test';
import assert from 'node:assert/strict';
import { okxAuthHeaders, okxSignature } from '../server/exchange-transport/okx.mjs';
import { ExchangeResponseError, readJsonResponse } from '../server/exchange-transport/response.mjs';
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
