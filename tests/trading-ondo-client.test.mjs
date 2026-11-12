import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createOndoClient, OndoError } from '../server/trading-ondo-client.mjs';

const keys = { keyId: 'ondoKeyId_fixture', secret: 'ondoApiSecret_fixture-secret' };
const EPOCH = 1_800_000_000_000;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const order = (extra = {}) => ({ orderId: 'abc123', clientOrderId: 'omm-1', side: 'buy', price: '199.93', size: '0.50', market: 'NVDA-USD.P', filledSize: '0.00', status: 'open', reduceOnly: false, ...extra });
function fixture(replies, options = {}) {
  const calls = [], clock = { now: EPOCH };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(init);
    return reply;
  };
  return { calls, clock, client: createOndoClient({ credentials: keys, fetchImpl, now: () => clock.now, rps: 10, ...options }) };
}
const rejected = (code, extra = {}) => error => error instanceof OndoError && error.code === code && Object.entries(extra).every(([key, value]) => error[key] === value);

test('an order is sent post-only, signed over its exact body, to the fixed host', async () => {
  const { client, calls } = fixture([json({ success: true, result: order() })]);
  const placed = await client.place({ market: 'NVDA-USD.P', side: 'buy', price: '199.93', size: '0.5', clientOrderId: 'omm-1' });
  assert.deepEqual(placed, { id: 'abc123', clientId: 'omm-1', market: 'NVDA-USD.P', side: 'buy', price: '199.93', size: '0.5', filled: '0', status: 'open', reduceOnly: false });
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.ondoperps.xyz/v1/perps/orders');
  assert.deepEqual(JSON.parse(init.body), { market: 'NVDA-USD.P', side: 'buy', price: '199.93', size: '0.5', type: 'limit', timeInForce: 'GTC', postOnly: true, reduceOnly: false, clientOrderId: 'omm-1' });
  assert.equal(init.headers['ONDO-KEY-ID'], keys.keyId);
  assert.equal(init.headers['ONDO-TIMESTAMP'], String(EPOCH));
  assert.equal(init.headers['ONDO-SIGN'], createHmac('sha256', keys.secret).update(`${EPOCH}POST/v1/perps/orders${init.body}`).digest('hex'));
  assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
  await assert.rejects(client.place({ market: 'nvda', side: 'buy', price: '1', size: '1', clientOrderId: 'a' }), TypeError);
  await assert.rejects(client.place({ market: 'NVDA-USD.P', side: 'buy', price: '0', size: '1', clientOrderId: 'a' }), TypeError);
  await assert.rejects(client.cancel('../x'), TypeError);
  assert.equal(calls.length, 1);
});

test('a refusal keeps only the venue code, never its message', async () => {
  const { client } = fixture([json({ success: false, error: `key id not found: ${keys.keyId}`, error_code: 'post_only_has_match' }, 400)]);
  const error = await client.place({ market: 'NVDA-USD.P', side: 'buy', price: '1', size: '1', clientOrderId: 'a' }).catch(value => value);
  assert.ok(rejected('post_only_has_match', { uncertain: false, status: 400 })(error));
  assert.ok(!JSON.stringify({ ...error, message: error.message }).includes(keys.keyId));
});

test('a write that fails after it was sent is uncertain and is not sent again; a read is not', async () => {
  const lost = fixture([new Error('socket hang up'), json({}, 502), new Response('<html>', { status: 200 }), new Error('socket hang up')]);
  const input = { market: 'NVDA-USD.P', side: 'buy', price: '1', size: '1', clientOrderId: 'a' };
  await assert.rejects(lost.client.place(input), rejected('network', { uncertain: true }));
  await assert.rejects(lost.client.place(input), rejected('upstream', { uncertain: true }));
  await assert.rejects(lost.client.cancel('abc'), rejected('invalid_data', { uncertain: true }));
  await assert.rejects(lost.client.positions(), rejected('network', { uncertain: false }));
  assert.equal(lost.calls.length, 4);
});

test('a request that outlives the timeout is aborted', async () => {
  const { client } = fixture([init => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))], { timeoutMs: 20 });
  await assert.rejects(client.cancel('abc'), rejected('timeout', { uncertain: true }));
});

test('a 429 starts a cooldown in which nothing is sent', async () => {
  const { client, calls, clock } = fixture([json({ success: false, error_code: 'too_many_requests' }, 429, { 'Retry-After': '7' }), json({ success: true, result: [] })]);
  await assert.rejects(client.positions(), rejected('rate_limited', { uncertain: false }));
  assert.equal(client.cooldownUntil(), EPOCH + 7000);
  await assert.rejects(client.cancel('abc'), rejected('rate_limited'));
  await assert.rejects(client.place({ market: 'NVDA-USD.P', side: 'buy', price: '1', size: '1', clientOrderId: 'a' }), rejected('rate_limited'));
  assert.equal(calls.length, 1);
  clock.now += 7000;
  assert.equal((await client.positions()).size, 0);
  // Without Retry-After the wait doubles from 2 s; a restarted session inherits the cooldown.
  const plain = fixture([json({}, 429), json({}, 429)]);
  await assert.rejects(plain.client.positions(), rejected('rate_limited'));
  assert.equal(plain.client.cooldownUntil(), EPOCH + 2000);
  plain.clock.now += 2000;
  await assert.rejects(plain.client.positions(), rejected('rate_limited'));
  assert.equal(plain.client.cooldownUntil(), EPOCH + 2000 + 4000);
  const inherited = fixture([], { cooldownUntil: EPOCH + 5000 });
  await assert.rejects(inherited.client.positions(), rejected('rate_limited'));
  assert.equal(inherited.calls.length, 0);
});

test('a refused timestamp is re-signed once against the venue clock', async () => {
  const date = new Date(EPOCH + 30_000).toUTCString();
  const { client, calls } = fixture([json({ success: false, error_code: 'invalid_timestamp' }, 400, { Date: date }), json({ success: true, result: [] })]);
  await client.positions();
  assert.equal(calls[1].init.headers['ONDO-TIMESTAMP'], String(EPOCH + 30_000));
  const twice = fixture([json({ success: false, error_code: 'invalid_timestamp' }, 400, { Date: date }), json({ success: false, error_code: 'invalid_timestamp' }, 400, { Date: date })]);
  await assert.rejects(twice.client.positions(), rejected('invalid_timestamp'));
  assert.equal(twice.calls.length, 2);
});

test('open orders are complete or an error, and a missing client id is null', async () => {
  const paged = fixture([json({ success: true, result: [order()], pageInfo: { nextCursor: 'N=' } }), json({ success: true, result: [order({ orderId: 'def456', clientOrderId: undefined })], pageInfo: {} })]);
  assert.deepEqual((await paged.client.openOrders()).map(item => [item.id, item.clientId]), [['abc123', 'omm-1'], ['def456', null]]);
  assert.equal(paged.calls[1].url, 'https://api.ondoperps.xyz/v1/perps/orders?status=open&limit=1000&cursor=N%3D');
  const endless = fixture([1, 2, 3].map(() => json({ success: true, result: [order()], pageInfo: { nextCursor: 'N' } })));
  await assert.rejects(endless.client.openOrders(), rejected('incomplete_data'));
  const broken = fixture([json({ success: true, result: [{ orderId: 'x' }] })]);
  await assert.rejects(broken.client.openOrders(), rejected('invalid_data'));
  const lookup = fixture([json({ success: false, error_code: 'order_not_found' }, 400), json({ success: true, result: order({ status: 'fullyfilled' }) }), json({}, 500)]);
  assert.equal(await lookup.client.orderByClientId('omm-1'), null);
  assert.equal(lookup.calls[0].url, 'https://api.ondoperps.xyz/v1/perps/orders/client:omm-1');
  assert.equal((await lookup.client.orderByClientId('omm-1')).status, 'fullyfilled');
  await assert.rejects(lookup.client.orderByClientId('omm-1'), rejected('upstream'));
});

test('positions are signed by direction and market rules come from the public list', async () => {
  const { client, calls } = fixture([json({ success: true, result: [{ market: 'NVDA-USD.P', direction: 'short', netQuantity: '0.50' }, { market: 'BTC-USD.P', direction: 'long', netQuantity: '0.0010' }] }),
    json({ success: true, result: { perps: { tradingPairs: [{ market: 'NVDA-USD.P', baseIncrement: '0.01', quoteIncrement: '0.01', tradingState: 'TRADING' },
      { market: 'TSLA-USD.P', baseIncrement: '0.01', quoteIncrement: '0.01', tradingState: 'TRADING', disabled: true }, { market: 'AMD-USD.P', baseIncrement: '0.1', quoteIncrement: '0.01', tradingState: 'CLOSED' }] } } }),
    json({ success: true, result: [{ market: 'NVDA-USD.P', direction: 'sideways', netQuantity: '1' }] })]);
  assert.deepEqual([...await client.positions()], [['NVDA-USD.P', '-0.5'], ['BTC-USD.P', '0.001']]);
  const rules = await client.markets();
  assert.equal(calls[1].init.headers['ONDO-SIGN'], undefined);
  assert.deepEqual(rules.get('NVDA-USD.P'), { tick: '0.01', step: '0.01', trading: true });
  assert.equal(rules.get('TSLA-USD.P').trading, false); assert.equal(rules.get('AMD-USD.P').trading, false);
  await assert.rejects(client.positions(), rejected('invalid_data'));
});

test('requests share one bucket and cancels go ahead of new quotes', async () => {
  const timers = [], sent = [];
  const clock = { now: EPOCH };
  const client = createOndoClient({ credentials: keys, now: () => clock.now, rps: 1, setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeoutImpl() {},
    fetchImpl: async (url, init) => { sent.push(init.method); return init.method === 'DELETE' ? json({ success: true, result: order({ status: 'canceled' }) }) : json({ success: true, result: order() }); } });
  const input = { market: 'NVDA-USD.P', side: 'buy', price: '1', size: '1', clientOrderId: 'a' };
  const all = [client.place(input), client.place(input), client.cancel('abc')];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ['POST']);
  for (let round = 0; round < 2; round++) { clock.now += 1000; const due = timers.find(timer => timer.ms <= 1000 && !timer.fired); due.fired = true; due.fn(); await new Promise(resolve => setImmediate(resolve)); }
  await Promise.all(all);
  assert.deepEqual(sent, ['POST', 'DELETE', 'POST']);
  client.close();
  await assert.rejects(client.positions(), rejected('closed'));
});

test('an accepted placement that cannot be read is uncertain', async () => {
  const { client } = fixture([json({ success: true, result: { orderId: 'abc123' } })]);
  await assert.rejects(client.place({ market: 'NVDA-USD.P', side: 'buy', price: '1', size: '1', clientOrderId: 'a' }), rejected('invalid_data', { uncertain: true }));
});

test('a cancel waits out a shorter, bounded part of a cooldown, and its own 429 is counted once per burst', async () => {
  const ok = () => json({ success: true, result: order({ status: 'canceled' }) });
  const { client, calls, clock } = fixture([json({}, 429, { 'Retry-After': '120' }), ok(), json({}, 429), json({}, 429), ok()]);
  await assert.rejects(client.positions(), rejected('rate_limited'));
  clock.now += 14_999;
  await assert.rejects(client.cancel('abc123'), rejected('rate_limited'));
  clock.now += 1;
  assert.equal((await client.cancel('abc123')).status, 'canceled');
  await assert.rejects(client.place({ market: 'NVDA-USD.P', side: 'buy', price: '1', size: '1', clientOrderId: 'a' }), rejected('rate_limited'));
  await assert.rejects(client.openOrders(), rejected('rate_limited'));
  assert.equal(calls.length, 2);
  // Two cancels sent together are both refused: one strike, the next cancel may go after 2 s.
  const pair = await Promise.allSettled([client.cancel('abc123'), client.cancel('abc124')]);
  assert.ok(pair.every(result => result.status === 'rejected' && result.reason.code === 'rate_limited'));
  assert.equal(client.cooldownUntil(), EPOCH + 120_000);
  clock.now += 1999;
  await assert.rejects(client.cancel('abc123'), rejected('rate_limited'));
  clock.now += 1;
  assert.equal((await client.cancel('abc123')).status, 'canceled');
  assert.equal(calls.length, 5);
});

test('venue codes of any case are kept, lower-cased, and a 2xx write without a verdict is uncertain', async () => {
  const input = { market: 'NVDA-USD.P', side: 'buy', price: '1', size: '1', clientOrderId: 'a' };
  const { client } = fixture([json({ success: false, error_code: 'clientOrderID_collision' }, 400), json({ success: false, error_code: 'Order_Not_Found' }, 400), json({}, 404), json({ result: order() })]);
  await assert.rejects(client.place(input), rejected('clientorderid_collision', { uncertain: false }));
  assert.equal(await client.orderByClientId('a'), null);
  assert.equal(await client.orderByClientId('a'), null);
  await assert.rejects(client.place(input), rejected('invalid_data', { uncertain: true }));
});
