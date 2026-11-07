import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { ExecutionExchangeError } from '../server/trading-execution-exchanges.mjs';
import { createRhLighterSigner } from '../server/trading-rh-lighter-signer.mjs';
import { createRhLighterExecutionClient, clientOrderIndexOf } from '../server/trading-rh-lighter-execution.mjs';

// Random test-only keys: never registered on any Lighter account. Signing is offline.
const KEY_A = 'a1'.repeat(40), KEY_B = 'b2'.repeat(40);
const ACCOUNT = { apiKeyIndex: 5, accountIndex: 12345 };
const ORDER = { marketIndex: 7, clientOrderIndex: 99, baseAmount: 50, price: 35210, isAsk: 1, orderType: 0, timeInForce: 2, reduceOnly: 1, nonce: 41 };
const WORKER_URL = new URL('../server/trading-rh-lighter-signer-worker.mjs', import.meta.url);

// The signer unrefs its worker and timers; a referenced timer keeps the test process alive while a call is pending.
async function held(promise) {
  const keep = setInterval(() => {}, 1000);
  try { return await promise; } finally { clearInterval(keep); }
}

test('the real signer builds create, cancel and auth token payloads from exactly the given fields, offline', async t => {
  const signer = createRhLighterSigner();
  t.after(() => signer.close());
  const orderExpiry = Date.now() + 28 * 86_400_000;
  const before = Date.now();
  const created = await held(signer.createOrder({ ...ACCOUNT, ...ORDER, orderExpiry, privateKey: KEY_A }));
  const after = Date.now();
  assert.deepEqual(Object.keys(created).sort(), ['authToken', 'txHash', 'txInfo', 'txType']);
  assert.equal(created.authToken, undefined);
  assert.equal(created.txType, 14);
  assert.match(created.txHash, /^[0-9a-f]{64,128}$/);
  const info = JSON.parse(created.txInfo);
  assert.deepEqual({ AccountIndex: info.AccountIndex, ApiKeyIndex: info.ApiKeyIndex, MarketIndex: info.MarketIndex, ClientOrderIndex: info.ClientOrderIndex, BaseAmount: info.BaseAmount,
    Price: info.Price, IsAsk: info.IsAsk, Type: info.Type, TimeInForce: info.TimeInForce, ReduceOnly: info.ReduceOnly, TriggerPrice: info.TriggerPrice, OrderExpiry: info.OrderExpiry, Nonce: info.Nonce },
  { AccountIndex: 12345, ApiKeyIndex: 5, MarketIndex: 7, ClientOrderIndex: 99, BaseAmount: 50, Price: 35210, IsAsk: 1, Type: 0, TimeInForce: 2, ReduceOnly: 1, TriggerPrice: 0, OrderExpiry: orderExpiry, Nonce: 41 });
  assert.ok(info.ExpiredAt >= before + 599_000 - 1000 && info.ExpiredAt <= after + 600_000, 'the signed transaction expires about ten minutes after signing');
  assert.equal(typeof info.Sig, 'string');
  assert.ok(Buffer.from(info.Sig, 'base64').length >= 64);
  assert.ok(!created.txInfo.includes(KEY_A), 'the private key is not part of the transaction');

  const ioc = JSON.parse((await held(signer.createOrder({ ...ACCOUNT, ...ORDER, isAsk: 0, timeInForce: 0, reduceOnly: 0, orderExpiry: 0, nonce: 42, privateKey: KEY_A }))).txInfo);
  assert.deepEqual({ IsAsk: ioc.IsAsk, TimeInForce: ioc.TimeInForce, ReduceOnly: ioc.ReduceOnly, OrderExpiry: ioc.OrderExpiry, Nonce: ioc.Nonce }, { IsAsk: 0, TimeInForce: 0, ReduceOnly: 0, OrderExpiry: 0, Nonce: 42 });

  const cancel = await held(signer.cancelOrder({ ...ACCOUNT, marketIndex: 7, index: 99, nonce: 43, privateKey: KEY_A }));
  assert.equal(cancel.txType, 15);
  assert.match(cancel.txHash, /^[0-9a-f]{64,128}$/);
  const cancelled = JSON.parse(cancel.txInfo);
  assert.deepEqual({ AccountIndex: cancelled.AccountIndex, ApiKeyIndex: cancelled.ApiKeyIndex, MarketIndex: cancelled.MarketIndex, Index: cancelled.Index, Nonce: cancelled.Nonce },
    { AccountIndex: 12345, ApiKeyIndex: 5, MarketIndex: 7, Index: 99, Nonce: 43 });

  const deadline = Math.floor(Date.now() / 1000) + 1800;
  const { authToken, txType } = await held(signer.authToken({ ...ACCOUNT, deadline, privateKey: KEY_A }));
  assert.equal(txType, undefined);
  assert.match(authToken, new RegExp(`^${deadline}:12345:5:[0-9a-f]+$`));
});

test('changing the private key of the same account and key index rebuilds the signing client', async t => {
  const signer = createRhLighterSigner();
  t.after(() => signer.close());
  const order = { ...ACCOUNT, ...ORDER, orderExpiry: 0, timeInForce: 0 };
  assert.equal((await held(signer.createOrder({ ...order, privateKey: KEY_A }))).txType, 14);
  // A reused client would still sign with KEY_A; a rebuilt one must refuse the malformed key.
  await assert.rejects(held(signer.createOrder({ ...order, privateKey: 'zz' })), /signer rejected the request/);
  assert.equal((await held(signer.createOrder({ ...order, privateKey: KEY_B }))).txType, 14);
  assert.equal((await held(signer.createOrder({ ...order, privateKey: KEY_A }))).txType, 14);
  await assert.rejects(held(signer.authToken({ ...ACCOUNT, deadline: 1, privateKey: 'zz' })), /signer rejected the request/);
});

test('the worker signs only the three listed transactions; every other method is refused', async t => {
  const worker = new Worker(WORKER_URL);
  t.after(() => worker.terminate());
  const replies = new Map();
  worker.on('message', message => { replies.get(message.id)?.(message); replies.delete(message.id); });
  const ask = (id, method) => new Promise(resolve => { replies.set(id, resolve); worker.postMessage({ id, method, params: { ...ACCOUNT, ...ORDER, timeInForce: 0, orderExpiry: 0, privateKey: KEY_A, deadline: 1 } }); });
  const methods = ['SignTransfer', 'SignWithdraw', 'SignUpdateLeverage', 'SignChangePubKey', 'transfer', 'withdraw', 'constructor', '__proto__', 'toString', 'hasOwnProperty', ''];
  for (const [index, method] of methods.entries()) {
    assert.deepEqual(await ask(index + 1, method), { id: index + 1, error: 'unsupported signer method' }, method);
  }
  const accepted = await ask(100, 'createOrder');
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.result.txType, 14);
  const signer = createRhLighterSigner();
  assert.deepEqual(Object.keys(signer).sort(), ['authToken', 'cancelOrder', 'close', 'createOrder']);
  await signer.close();
});

class FakeWorker extends EventEmitter {
  static created = [];
  static answer = () => {};
  constructor(url) { super(); this.url = url; this.posted = []; this.terminated = 0; FakeWorker.created.push(this); }
  postMessage(message) { this.posted.push(message); FakeWorker.answer(this, message); }
  reply(message) { this.emit('message', message); }
  terminate() { this.terminated += 1; return Promise.resolve(1); }
  unref() {}
}
const fake = answer => { FakeWorker.created = []; FakeWorker.answer = answer; return createRhLighterSigner({ timeoutMs: 30, WorkerClass: FakeWorker }); };

test('a call that times out terminates the stuck worker and fails every call waiting on it; the next call starts a fresh one', async () => {
  const signer = fake((worker, message) => { if (FakeWorker.created.indexOf(worker) > 0) queueMicrotask(() => worker.reply({ id: message.id, result: { authToken: 'ok' } })); });
  const first = signer.authToken({ deadline: 1 }), second = signer.createOrder({});
  const [timedOut, restarted] = await held(Promise.allSettled([first, second]));
  assert.equal(timedOut.reason.message, 'signer timeout');
  assert.equal(restarted.reason.message, 'signer restarted');
  assert.equal(FakeWorker.created.length, 1);
  assert.equal(FakeWorker.created[0].terminated, 1);
  assert.equal(FakeWorker.created[0].url.href, WORKER_URL.href);
  assert.deepEqual(FakeWorker.created[0].posted.map(message => message.method), ['authToken', 'createOrder']);
  assert.deepEqual(await held(signer.authToken({ deadline: 2 })), { authToken: 'ok' });
  assert.equal(FakeWorker.created.length, 2);
  FakeWorker.created[0].reply({ id: 1, result: { authToken: 'late' } });
  assert.equal(FakeWorker.created[1].terminated, 0);
  await signer.close();
  assert.equal(FakeWorker.created[1].terminated, 1);
});

test('worker errors, exits and close reject pending calls without guessing a result', async () => {
  const refusing = fake((worker, message) => queueMicrotask(() => worker.reply({ id: message.id, error: 'signer rejected the request' })));
  await assert.rejects(held(refusing.createOrder({})), /^Error: signer rejected the request$/);
  await assert.rejects(held(refusing.cancelOrder({})), /signer rejected the request/);
  assert.equal(FakeWorker.created.length, 1, 'a refused signature keeps the worker');

  const exiting = fake(() => {});
  const pending = exiting.createOrder({});
  FakeWorker.created[0].emit('exit', 1);
  await assert.rejects(held(pending), /signer stopped/);
  const crashed = exiting.cancelOrder({});
  assert.equal(FakeWorker.created.length, 2, 'a lost worker is replaced on the next call');
  FakeWorker.created[1].emit('error', new Error('wasm trap'));
  await assert.rejects(held(crashed), /signer stopped/);

  const closing = fake(() => {});
  const open = closing.authToken({});
  FakeWorker.created[0].reply({ id: 99, result: { authToken: 'stray' } });
  await closing.close();
  await assert.rejects(held(open), /signer closed/);
  assert.equal(FakeWorker.created[0].terminated, 1);
  await closing.close();
  assert.equal(FakeWorker.created[0].terminated, 1, 'closing twice terminates once');
});

test('the adapter and the real signer agree on every order, cancel and token parameter', async t => {
  const real = createRhLighterSigner();
  t.after(() => real.close());
  let lastHash = null;
  const signer = Object.fromEntries(['createOrder', 'cancelOrder', 'authToken'].map(method => [method, async params => {
    const result = await held(real[method](params));
    if (result.txHash) lastHash = result.txHash;
    return result;
  }]));
  const address = '0x' + 'ab'.repeat(20);
  const credentials = { address, accountIndex: 12345, apiKeyIndex: 5, apiKey: KEY_A };
  const ok = body => new Response(JSON.stringify({ code: 200, ...body }), { status: 200 });
  const sent = [], visible = [];
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/api/v1/orderBooks') return ok({ order_books: [{ symbol: 'ANTHROPIC', market_id: 7, market_type: 'perp' }] });
    if (pathname === '/api/v1/orderBookDetails') return ok({ order_book_details: [{ market_id: 7, symbol: 'ANTHROPIC', market_type: 'perp', status: 'active', is_frozen: false, size_decimals: 2, price_decimals: 2, min_base_amount: '0.01', min_quote_amount: '10', order_quote_limit: '250000', default_initial_margin_fraction: 1000 }] });
    if (pathname === '/api/v1/accountsByL1Address') return ok({ sub_accounts: [{ index: 12345, l1_address: address }] });
    if (pathname === '/api/v1/accountActiveOrders') { sent.push({ token: init.headers.Authorization }); return ok({ orders: [] }); }
    if (pathname === '/api/v1/nextNonce') return ok({ nonce: 7 });
    if (pathname === '/api/v1/sendTx') { const form = new URLSearchParams(init.body); sent.push({ type: form.get('tx_type'), info: JSON.parse(form.get('tx_info')) }); return ok({ tx_hash: lastHash }); }
    if (pathname === '/api/v1/accountOrders') return ok({ orders: visible.filter(row => String(row.client_order_index) === searchParams.get('client_order_indexes')) });
    throw new Error('unexpected request ' + url);
  };
  const client = createRhLighterExecutionClient({ ErrorClass: ExecutionExchangeError, fetchImpl, signer, sleep: async () => {} });
  assert.deepEqual(await client.verify(credentials), { identity: address, keyLabel: '12345#5' });
  assert.match(sent[0].token, /^\d+:12345:5:[0-9a-f]+$/);

  const row = (spec, tif) => ({ market_index: 7, client_order_index: clientOrderIndexOf(spec.clientId), is_ask: spec.side === 'sell', reduce_only: spec.reduceOnly, type: 'limit', time_in_force: tif,
    status: 'open', timestamp: Math.floor(Date.now() / 1000), initial_base_amount: spec.quantity, filled_base_amount: '0', remaining_base_amount: spec.quantity, filled_quote_amount: '0', price: spec.limitPrice });
  const chase = { symbol: 'ANTHROPIC', side: 'buy', positionSide: 'BOTH', quantity: '0.5', reduceOnly: false, clientId: 'hchase', orderType: 'chase', stopPrice: null, limitPrice: '352.1', assetId: 7 };
  visible.push(row(chase, 'post-only'));
  const before = Date.now();
  await client.create(credentials, chase);
  const placed = sent.at(-1);
  assert.equal(placed.type, '14');
  assert.deepEqual({ MarketIndex: placed.info.MarketIndex, ClientOrderIndex: placed.info.ClientOrderIndex, BaseAmount: placed.info.BaseAmount, Price: placed.info.Price, IsAsk: placed.info.IsAsk,
    TimeInForce: placed.info.TimeInForce, ReduceOnly: placed.info.ReduceOnly, Nonce: placed.info.Nonce, AccountIndex: placed.info.AccountIndex, ApiKeyIndex: placed.info.ApiKeyIndex },
  { MarketIndex: 7, ClientOrderIndex: clientOrderIndexOf('hchase'), BaseAmount: 50, Price: 35210, IsAsk: 0, TimeInForce: 2, ReduceOnly: 0, Nonce: 7, AccountIndex: 12345, ApiKeyIndex: 5 });
  assert.ok(placed.info.OrderExpiry >= before + 2 * 3_600_000 && placed.info.OrderExpiry <= Date.now() + 2 * 3_600_000);

  const taker = { ...chase, side: 'sell', reduceOnly: true, clientId: 'htaker', orderType: 'market' };
  visible.push(row(taker, 'immediate-or-cancel'));
  await client.create(credentials, taker);
  const market = sent.at(-1).info;
  assert.deepEqual({ Price: market.Price, IsAsk: market.IsAsk, TimeInForce: market.TimeInForce, ReduceOnly: market.ReduceOnly, OrderExpiry: market.OrderExpiry, Nonce: market.Nonce },
    { Price: 34857, IsAsk: 1, TimeInForce: 0, ReduceOnly: 1, OrderExpiry: 0, Nonce: 8 });

  await client.stop(credentials, { ...chase, id: String(clientOrderIndexOf('hchase')) });
  assert.equal(sent.at(-1).type, '15');
  assert.deepEqual({ MarketIndex: sent.at(-1).info.MarketIndex, Index: sent.at(-1).info.Index, Nonce: sent.at(-1).info.Nonce }, { MarketIndex: 7, Index: clientOrderIndexOf('hchase'), Nonce: 9 });
});
