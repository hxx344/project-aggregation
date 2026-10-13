import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { gateGet, syncGate, type GateCredential } from '../lib/gate.ts';
import { connectionSchema } from '../lib/validation.ts';

const credential: GateCredential = { apiKey: 'gate-fixture-key', apiSecret: 'gate-fixture-secret' };
const balancePath = '/api/v4/wallet/total_balance';
const emptyHash = 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e';
function account(amount: unknown = '0', currency: unknown = 'USD') { return { amount, currency }; }
function valuation() { return { total: account('120.5'), details: { spot: account('100'), finance: account('25.5'), futures: account('-5') } }; }
function mock(handler: (url: URL, init: RequestInit) => unknown): typeof fetch {
  return (async (url: RequestInfo | URL, init: RequestInit = {}) => Response.json(handler(new URL(String(url)), init))) as typeof fetch;
}
function response(value: unknown): typeof fetch { return mock(() => value); }

test('Gate connection credentials trim values and reject malformed or extra request fields', () => {
  const input = { exchange: 'gate', ...credential };
  assert.deepEqual(connectionSchema.parse({ ...input, apiKey: ' ' + credential.apiKey + ' ', apiSecret: ' ' + credential.apiSecret + ' ' }), input);
  for (const field of ['apiKey', 'apiSecret']) {
    for (const value of ['', ' ', 'abcd', null, 12, 'x'.repeat(257), 'valid\r\nheader', 'value\u0000value']) {
      assert.throws(() => connectionSchema.parse({ ...input, [field]: value }));
    }
  }
  for (const extra of [{ host: 'https://evil.example' }, { region: 'global' }, { passphrase: 'unused' }, { owner: 'other' }]) {
    assert.throws(() => connectionSchema.parse({ ...input, ...extra }));
  }
});

test('Gate signs the exact fixed USD GET using SHA512 and HMAC-SHA512 and sends credentials only in headers', async t => {
  const now = 1791840123456;
  t.mock.timers.enable({ apis: ['Date'], now });
  const controller = new AbortController();
  const timeoutCalls: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { timeoutCalls.push(milliseconds); return controller.signal; });
  const calls: string[] = [];
  const result = await syncGate(credential, mock((url, init) => {
    calls.push(url.href);
    assert.equal(url.href, 'https://api.gateio.ws/api/v4/wallet/total_balance?currency=USD');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, undefined);
    assert.equal(init.signal, controller.signal);
    const headers = new Headers(init.headers);
    assert.deepEqual([...headers.keys()].sort(), ['accept', 'key', 'sign', 'timestamp']);
    assert.equal(headers.get('Accept'), 'application/json');
    assert.equal(headers.get('KEY'), credential.apiKey);
    assert.equal(headers.get('Timestamp'), '1791840123');
    const signingInput = `GET\n${url.pathname}\n${url.search.slice(1)}\n${emptyHash}\n1791840123`;
    assert.equal(headers.get('SIGN'), createHmac('sha512', credential.apiSecret).update(signingInput).digest('hex'));
    assert.match(headers.get('SIGN')!, /^[a-f0-9]{128}$/);
    for (const secret of Object.values(credential)) assert.equal(url.href.includes(secret), false);
    return valuation();
  }));
  assert.equal(calls.length, 1);
  assert.deepEqual(timeoutCalls, [12000]);
  assert.equal(result.total, 120.5);
  assert.deepEqual(result.details.map(row => row.value), [100, 25.5, -5]);
  assert.ok(result.details.every(row => row.coin === 'USD' && row.quantity === row.value && row.price === 1));
  assert.equal(result.updatedAt, new Date(now).toISOString());
});

test('Gate uses only official total.amount, without summing details, adding P&L or subtracting debt', async () => {
  const result = await syncGate(credential, response({
    total: { ...account('100'), unrealised_pnl: '15', borrowed: '30' },
    details: { spot: account('900'), futures: { ...account('200'), unrealised_pnl: '80' }, margin: { ...account('50'), borrowed: '20' } },
  }));
  assert.equal(result.total, 100);
  assert.deepEqual(result.details.map(row => row.value), [900, 200, 50]);
});

test('Gate accepts true zero and negative balances, including negative zero normalization', async () => {
  const zero = await syncGate(credential, response({ total: account('-0.000'), details: { spot: account('0'), futures: account('-0.000') } }));
  assert.equal(zero.total, 0);
  assert.deepEqual(zero.details.map(row => [row.quantity, row.value, row.price]), [[0, 0, 1], [0, 0, 1]]);
  const negative = await syncGate(credential, response({ total: account('-10.5'), details: { spot: account('5'), margin: account('-15.5') } }));
  assert.equal(negative.total, -10.5);
  assert.equal(negative.details[1].value, -15.5);
});

test('Gate preserves every documented account and new account type with fixed safe labels', async () => {
  const names = ['cross_margin', 'spot', 'finance', 'margin', 'quant', 'futures', 'delivery', 'warrant', 'cbbc', 'meme_box', 'options', 'payment'];
  const unsafeNames = ['constructor', '__proto__', credential.apiSecret, '<script>alert(1)</script>', 'https://evil.example'];
  const details = Object.fromEntries([...names, ...unsafeNames].map((name, i) => [name, account(String(i + 1))]));
  const result = await syncGate(credential, response({ total: account('153'), details }));
  assert.equal(result.total, 153);
  assert.equal(result.details.length, 17);
  assert.deepEqual(result.details.map(row => row.value), Array.from({ length: 17 }, (_, i) => i + 1));
  assert.equal(result.details[0].account, '全仓杠杆账户（USD 估值）');
  assert.equal(result.details[9].account, 'Alpha 账户（USD 估值）');
  assert.equal(result.details[11].account, '支付账户（USD 估值）');
  assert.deepEqual(result.details.slice(12).map(row => row.account), [1, 2, 3, 4, 5].map(i => `其他账户 ${i}（USD 估值）`));
  for (const unsafe of unsafeNames) assert.equal(JSON.stringify(result).includes(unsafe), false);
});

test('Gate records retrieval time after a validated response, ignoring undocumented upstream timestamps', async t => {
  const now = 1791840123456;
  t.mock.timers.enable({ apis: ['Date'], now });
  const result = await syncGate(credential, async () => {
    const response = Response.json(valuation());
    response.json = async () => { t.mock.timers.setTime(now + 6000); return { ...valuation(), ts: '1', updated_at: 'invalid' }; };
    return response;
  });
  assert.equal(result.updatedAt, new Date(now + 6000).toISOString());
});

test('Gate rejects incomplete wrappers, total objects and detail structures instead of treating them as zero', async () => {
  for (const invalid of [undefined, null, false, 0, '', [], {}, { data: valuation() }, { details: valuation().details }, { total: null, details: valuation().details }, { total: [], details: valuation().details }]) {
    await assert.rejects(syncGate(credential, response(invalid)), /数据不完整|读取失败/);
  }
  for (const invalid of [undefined, null, false, '', [], {}, { spot: null }, { spot: [] }, { spot: false }, { spot: '0' }, { spot: {} }]) {
    await assert.rejects(syncGate(credential, response({ total: account('0'), details: invalid })), /数据不完整|币种不是 USD/);
  }
  await assert.rejects(syncGate(credential, response({ total: account('1'), details: { spot: account('1'), future_account: {} } })), /币种不是 USD/);
});

test('Gate requires explicit USD in the total and every account without silently converting other currencies', async () => {
  for (const currency of [undefined, null, false, 0, '', 'USD ', 'usd', 'USDT', 'BTC', {}, ['USD']]) {
    const invalid = { amount: '1', currency };
    await assert.rejects(syncGate(credential, response({ ...valuation(), total: invalid })), /币种不是 USD/);
    for (const name of ['spot', 'unknown']) await assert.rejects(syncGate(credential, response({ ...valuation(), details: { [name]: invalid } })), /币种不是 USD/);
  }
});

test('Gate rejects invalid, overflowing and underflowing monetary values in totals and all details', async () => {
  for (const invalid of [undefined, null, false, 0, 1, [], {}, '', ' ', ' 1', '1 ', 'NaN', 'Infinity', '-Infinity', '0x10', '1e3', '+1', '1,000', '.1', '1.', '9'.repeat(400), '0.' + '0'.repeat(400) + '1']) {
    const invalidAccount = { currency: 'USD', amount: invalid };
    await assert.rejects(syncGate(credential, response({ ...valuation(), total: invalidAccount })), /不是有效数值/);
    for (const name of ['spot', 'unknown']) await assert.rejects(syncGate(credential, response({ ...valuation(), details: { [name]: invalidAccount } })), /不是有效数值/);
  }
});

test('Gate rejects all paths except the balance endpoint and rejects empty credentials before network access', async () => {
  let calls = 0;
  const never = mock(() => { calls++; return {}; });
  for (const path of ['/api/v4/spot/orders', '/api/v4/wallet/transfers', '/api/v4/withdrawals', '/api/v4/account/detail', '/api/v4/account/main_keys', '/api/v4/spot/accounts', 'constructor', 'https://evil.example' + balancePath, balancePath + '?currency=USD', balancePath + '?currency=BTC', balancePath + '/../transfers', balancePath + '#anything']) {
    await assert.rejects(gateGet(credential, path, never), /只读账户接口/);
  }
  for (const key of ['apiKey', 'apiSecret']) {
    for (const value of ['', ' ', null, undefined, 1, {}]) await assert.rejects(gateGet({ ...credential, [key]: value } as GateCredential, balancePath, never), /不能为空/);
  }
  assert.equal(calls, 0);
});

test('Gate sanitizes network failures, error labels, raw bodies and JSON parse failures', async () => {
  const sensitive = Object.values(credential).join(' ') + ' signature=private-signature https://evil.example';
  const safeError = (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Gate 读取失败/);
    for (const secret of [...Object.values(credential), 'signature=', 'private-signature', 'evil.example']) assert.equal(error.message.includes(secret), false);
    return true;
  };
  for (const label of ['INVALID_SIGNATURE', 'FORBIDDEN', sensitive, null, {}, '']) {
    await assert.rejects(syncGate(credential, response({ ...valuation(), label, message: sensitive, detail: sensitive })), safeError);
  }
  for (const fetcher of [
    (async () => { throw new Error(sensitive); }) as typeof fetch,
    (async () => new Response(sensitive, { status: 200 })) as typeof fetch,
    ...[401, 403, 429, 500, 503].map(status => (async () => new Response(sensitive, { status })) as typeof fetch),
  ]) await assert.rejects(syncGate(credential, fetcher), safeError);
});

test('Gate aborts timed out requests and does not expose abort reasons', async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  let calls = 0;
  const result = syncGate(credential, (async (_url: unknown, init: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error(credential.apiSecret)), { once: true }));
  }) as typeof fetch);
  controller.abort();
  await assert.rejects(result, error => error instanceof Error && /Gate 读取失败/.test(error.message) && !error.message.includes(credential.apiSecret));
  assert.equal(calls, 1);
});

test('Gate refuses redirects without forwarding authenticated headers to another host', async () => {
  let calls = 0;
  const redirect = (async (_url: unknown, init: RequestInit) => {
    calls++;
    assert.equal(init.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'https://evil.example' } });
  }) as typeof fetch;
  await assert.rejects(syncGate(credential, redirect), /HTTP 302/);
  assert.equal(calls, 1);
  const followed = (async () => {
    const result = Response.json(valuation());
    Object.defineProperty(result, 'redirected', { value: true });
    return result;
  }) as typeof fetch;
  await assert.rejects(syncGate(credential, followed), /读取失败/);
});
