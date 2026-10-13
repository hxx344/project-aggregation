import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { gateGet, syncGate, type GateCredential } from '../lib/gate.ts';
import { connectionSchema } from '../lib/validation.ts';

const credential: GateCredential = { apiKey: 'gate-fixture-key', apiSecret: 'gate-fixture-secret' };
const balancePath = '/api/v4/wallet/total_balance';
const primaryQuoteUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd&include_last_updated_at=true';
const fallbackQuoteUrl = 'https://api.coinbase.com/v2/exchange-rates?currency=USDT';
const emptyHash = 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e';
function account(amount: unknown = '0', currency: unknown = 'USDT') { return { amount, currency }; }
function valuation() { return { total: account('120.5'), details: { spot: account('100'), finance: account('25.5'), futures: account('-5') } }; }
function quote(price: unknown = 1, at: unknown = Math.floor(Date.now() / 1000)) { return { tether: { usd: price, last_updated_at: at } }; }
function publicRequest(url: URL, init: RequestInit) {
  assert.ok([primaryQuoteUrl, fallbackQuoteUrl].includes(url.href), 'Only fixed public quote endpoints are allowed');
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.body, undefined);
  assert.ok(init.signal instanceof AbortSignal);
  const headers = new Headers(init.headers);
  assert.deepEqual([...headers.keys()], ['accept'], 'Gate headers must never reach public quote providers');
  assert.equal(headers.get('Accept'), 'application/json');
  for (const secret of Object.values(credential)) assert.equal(url.href.includes(secret), false);
}
function mock(handler: (url: URL, init: RequestInit) => unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.gateio.ws') {
      publicRequest(url, init);
      assert.equal(url.href, primaryQuoteUrl);
      return Response.json(quote());
    }
    return Response.json(handler(url, init));
  }) as typeof fetch;
}
function response(value: unknown): typeof fetch { return mock(() => value); }
function quotedResponse(value: unknown, handler: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.gateio.ws') return Response.json(value);
    publicRequest(url, init);
    return handler(url, init);
  }) as typeof fetch;
}
const sensitive = Object.values(credential).join(' ') + ' signature=private-signature https://evil.example signed-request';
function diagnostic(error: unknown, checks: readonly RegExp[] = []): boolean {
  assert.ok(error instanceof Error);
  assert.match(error.message, /^Gate 读取失败/);
  assert.match(error.message, /本次未更新资产数据/);
  for (const secret of [...Object.values(credential), 'signature=', 'private-signature', 'evil.example', 'signed-request']) {
    assert.equal(error.message.includes(secret), false, 'Diagnostics must not expose untrusted response or transport details');
  }
  for (const check of checks) assert.match(error.message, check);
  return true;
}
function quoteDiagnostic(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.match(error.message, /^Gate /);
  assert.match(error.message, /USDT\/USD/);
  assert.match(error.message, /保留|未更新/);
  for (const secret of [...Object.values(credential), 'signature=', 'private-signature', 'evil.example', 'signed-request']) {
    assert.equal(error.message.includes(secret), false, 'Public quote failures must not expose untrusted details');
  }
  assert.doesNotMatch(error.message, /api\.coingecko\.com|api\.coinbase\.com|ENOTFOUND|timeout|network|aborted/i);
  return true;
}
function streamedResponse(chunks: Uint8Array[], headers: HeadersInit = {}, status = 403) {
  let reads = 0, canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[reads++];
      if (chunk) controller.enqueue(chunk); else controller.close();
    },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status, headers }), reads: () => reads, canceled: () => canceled };
}

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

test('Gate signs the exact fixed USDT GET using SHA512 and HMAC-SHA512 and sends credentials only in headers', async t => {
  const now = 1791840123000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const controller = new AbortController();
  const timeoutCalls: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { timeoutCalls.push(milliseconds); return controller.signal; });
  const calls: string[] = [];
  const result = await syncGate(credential, mock((url, init) => {
    calls.push(url.href);
    assert.equal(url.href, 'https://api.gateio.ws/api/v4/wallet/total_balance?currency=USDT');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, undefined);
    assert.equal(init.signal, controller.signal);
    const headers = new Headers(init.headers);
    assert.deepEqual([...headers.keys()].sort(), ['accept', 'content-type', 'key', 'sign', 'timestamp']);
    assert.equal(headers.get('Accept'), 'application/json');
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(headers.get('KEY'), credential.apiKey);
    assert.equal(headers.get('Timestamp'), '1791840123');
    const signingInput = `GET\n${url.pathname}\n${url.search.slice(1)}\n${emptyHash}\n1791840123`;
    assert.equal(headers.get('SIGN'), createHmac('sha512', credential.apiSecret).update(signingInput).digest('hex'));
    assert.match(headers.get('SIGN')!, /^[a-f0-9]{128}$/);
    for (const secret of Object.values(credential)) assert.equal(url.href.includes(secret), false);
    return valuation();
  }));
  assert.equal(calls.length, 1);
  assert.deepEqual(timeoutCalls, [12000, 12000]);
  assert.equal(result.total, 120.5);
  assert.deepEqual(result.details.map(row => row.value), [100, 25.5, -5]);
  assert.ok(result.details.every(row => row.coin === 'USDT' && row.quantity === row.value && row.price === 1));
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
  assert.equal(result.details[0].account, '全仓杠杆账户（USDT 估值）');
  assert.equal(result.details[9].account, 'Alpha 账户（USDT 估值）');
  assert.equal(result.details[11].account, '支付账户（USDT 估值）');
  assert.deepEqual(result.details.slice(12).map(row => row.account), [1, 2, 3, 4, 5].map(i => `其他账户 ${i}（USDT 估值）`));
  for (const unsafe of unsafeNames) assert.equal(JSON.stringify(result).includes(unsafe), false);
});

test('Gate uses validated account retrieval time when it precedes the quote, ignoring undocumented upstream timestamps', async t => {
  const now = 1791840123000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const result = await syncGate(credential, async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.gateio.ws') {
      publicRequest(url, init);
      return Response.json(quote(1, (now + 7000) / 1000));
    }
    const response = Response.json(valuation());
    response.json = async () => { t.mock.timers.setTime(now + 6000); return { ...valuation(), ts: '1', updated_at: 'invalid' }; };
    return response;
  });
  assert.equal(result.updatedAt, new Date(now + 6000).toISOString());
});

test('Gate converts the official USDT total and each detail with a non-parity USD rate and preserves the older quote time', async t => {
  const now = 1791840123000, quotedAt = now - 120000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const calls: string[] = [];
  const result = await syncGate(credential, quotedResponse({
    total: { ...account('100'), unrealised_pnl: '15', borrowed: '30' },
    details: { spot: account('900'), futures: { ...account('200'), unrealised_pnl: '80' }, margin: account('-5') },
  }, url => {
    calls.push(url.href);
    return Response.json(quote(0.98, quotedAt / 1000));
  }));
  assert.deepEqual(calls, [primaryQuoteUrl]);
  assert.equal(result.total, 98, 'Convert total.amount once; never sum account details or add P&L');
  assert.deepEqual(result.details.map(row => [row.coin, row.quantity, row.price, row.value]),
    [900, 200, -5].map(quantity => ['USDT', quantity, 0.98, quantity * 0.98]));
  assert.equal(result.updatedAt, new Date(quotedAt).toISOString());
});

test('Gate accepts only fresh positive numeric primary prices and does not manufacture a one-dollar rate', async t => {
  const now = 1791840123000;
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const at of [now - 900000, now + 60000]) {
    const result = await syncGate(credential, quotedResponse(valuation(), url => {
      assert.equal(url.href, primaryQuoteUrl, 'Valid freshness boundaries need no fallback');
      return Response.json(quote(0.98, at / 1000));
    }));
    assert.equal(result.total, 120.5 * 0.98);
    assert.equal(result.updatedAt, new Date(Math.min(now, at)).toISOString());
  }
  const invalid = [
    null, [], {}, { tether: null },
    ...[0, -1, Infinity, NaN, '1', null, false].map(price => quote(price, now / 1000)),
    ...[undefined, null, '1791840123', 0, NaN, (now - 900001) / 1000, (now + 60001) / 1000]
      .map(at => ({ tether: { usd: 0.98, last_updated_at: at } })),
  ];
  for (const primary of invalid) {
    const calls: string[] = [];
    await assert.rejects(syncGate(credential, quotedResponse(valuation(), url => {
      calls.push(url.href);
      return url.href === primaryQuoteUrl ? Response.json(primary) : new Response(sensitive, { status: 503 });
    })), quoteDiagnostic);
    assert.deepEqual(calls, [primaryQuoteUrl, fallbackQuoteUrl]);
  }
});

test('Gate falls back once to Coinbase USDT-to-USD multiplication and keeps the account retrieval time', async t => {
  const now = 1791840123000;
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const invalidPrimary of [new Response(sensitive, { status: 503 }), Response.json(quote(1, (now - 901000) / 1000))]) {
    t.mock.timers.setTime(now);
    const calls: string[] = [];
    const result = await syncGate(credential, quotedResponse(valuation(), url => {
      calls.push(url.href);
      if (url.href === primaryQuoteUrl) return invalidPrimary;
      t.mock.timers.setTime(now + 5000);
      return Response.json({ data: { currency: 'USDT', rates: { USD: '1.02' } } });
    }));
    assert.deepEqual(calls, [primaryQuoteUrl, fallbackQuoteUrl]);
    assert.equal(result.total, 120.5 * 1.02);
    assert.ok(result.details.every(row => row.price === 1.02 && row.value === row.quantity * 1.02));
    assert.equal(result.updatedAt, new Date(now).toISOString());
  }
  const invalidFallbacks = [
    null, [], {}, { data: { currency: 'USD', rates: { USD: '1.02' } } },
    { data: { currency: 'USDT ', rates: { USD: '1.02' } } },
    ...[undefined, null, 1, '', ' ', ' 1.02', '1.02 ', '-1', '0', '0x1', '+1', '1e3', 'Infinity', 'NaN', '9'.repeat(400), '0.' + '0'.repeat(400) + '1']
      .map(rate => ({ data: { currency: 'USDT', rates: { USD: rate } } })),
  ];
  for (const fallback of invalidFallbacks) {
    await assert.rejects(syncGate(credential, quotedResponse(valuation(), url =>
      url.href === primaryQuoteUrl ? new Response(sensitive, { status: 503 }) : Response.json(fallback))), quoteDiagnostic);
  }
});

test('Gate validates every account currency and amount before requesting a public quote', async () => {
  for (const payload of [
    { ...valuation(), total: account('10', 'USD') },
    { ...valuation(), details: { spot: account('10'), futures: account('1', 'USD') } },
    { ...valuation(), details: { spot: account('10'), futures: account('bad') } },
  ]) {
    let quoteCalls = 0;
    await assert.rejects(syncGate(credential, quotedResponse(payload, () => {
      quoteCalls++;
      return Response.json(quote());
    })), /币种不是 USDT|不是有效数值/);
    assert.equal(quoteCalls, 0);
  }
});

test('Gate bounds public quote bodies at 128 KiB and cancels declared or streamed excess', async () => {
  const limit = 128 * 1024;
  const base = { ...quote(0.98), padding: '' };
  const body = Buffer.from(JSON.stringify({ ...base, padding: 'x'.repeat(limit - Buffer.byteLength(JSON.stringify(base))) }));
  assert.equal(body.byteLength, limit);
  const exact = streamedResponse([body], { 'content-length': String(limit) }, 200);
  const result = await syncGate(credential, quotedResponse(valuation(), url => {
    assert.equal(url.href, primaryQuoteUrl);
    return exact.response;
  }));
  assert.equal(result.total, 120.5 * 0.98);
  assert.equal(exact.canceled(), false);
  for (const declared of [true, false]) {
    const oversized = streamedResponse([body, Buffer.from(' '), Buffer.from(sensitive)],
      declared ? { 'content-length': String(limit + 1) } : { 'content-length': '1' }, 200);
    await assert.rejects(syncGate(credential, quotedResponse(valuation(), url =>
      url.href === primaryQuoteUrl ? oversized.response : new Response(sensitive, { status: 503 }))), quoteDiagnostic);
    assert.equal(oversized.reads(), declared ? 0 : 2);
    assert.equal(oversized.canceled(), true);
  }
});

test('Gate never follows public price redirects or exposes malformed and failed quote responses', async () => {
  let bodyReads = 0;
  const calls: string[] = [];
  await assert.rejects(syncGate(credential, quotedResponse(valuation(), url => {
    calls.push(url.href);
    return new Response(new ReadableStream({ pull() { bodyReads++; } }, { highWaterMark: 0 }),
      { status: 302, headers: { location: 'https://evil.example/' + credential.apiSecret } });
  })), quoteDiagnostic);
  assert.deepEqual(calls, [primaryQuoteUrl, fallbackQuoteUrl]);
  assert.equal(bodyReads, 0);
  for (const makeResponse of [
    () => new Response('<html>' + sensitive),
    () => new Response('{"broken":' + sensitive),
    () => Response.json({ ...quote(), message: sensitive, tether: { usd: sensitive, last_updated_at: 1 } }),
    () => { const result = Response.json(quote()); Object.defineProperty(result, 'redirected', { value: true }); return result; },
  ]) {
    await assert.rejects(syncGate(credential, quotedResponse(valuation(), () => makeResponse())), quoteDiagnostic);
  }
  await assert.rejects(syncGate(credential, quotedResponse(valuation(), () => {
    throw new Error('network timeout aborted ' + sensitive, { cause: { code: 'ENOTFOUND', message: sensitive } });
  })), quoteDiagnostic);
});

test('Gate gives each public quote request a 12-second abort signal and sanitizes aborted stream failures', async t => {
  const controllers: AbortController[] = [];
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    timeouts.push(milliseconds);
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  });
  const calls: string[] = [];
  await assert.rejects(syncGate(credential, quotedResponse(valuation(), (url, init) => {
    calls.push(url.href);
    const controller = controllers.at(-1)!;
    assert.equal(init.signal, controller.signal);
    return new Response(new ReadableStream({ pull(stream) {
      controller.abort(new Error(sensitive));
      stream.error(new Error(sensitive));
    } }, { highWaterMark: 0 }));
  })), quoteDiagnostic);
  assert.deepEqual(calls, [primaryQuoteUrl, fallbackQuoteUrl]);
  assert.deepEqual(timeouts, [12000, 12000, 12000]);
  assert.notEqual(controllers[1].signal, controllers[2].signal);
});

test('Gate rejects overflow and nonzero-to-zero underflow in both converted totals and details', async () => {
  for (const [amount, price] of [['9'.repeat(308), 2], ['0.' + '0'.repeat(199) + '1', 1e-200]] as const) {
    for (const payload of [
      { ...valuation(), total: account(amount) },
      { ...valuation(), details: { spot: account('1'), futures: account(amount) } },
    ]) {
      await assert.rejects(syncGate(credential, quotedResponse(payload, () => Response.json(quote(price)))), /Gate.*美元.*无效/);
    }
  }
});

test('Gate rejects incomplete wrappers, total objects and detail structures instead of treating them as zero', async () => {
  for (const invalid of [undefined, null, false, 0, '', [], {}, { data: valuation() }, { details: valuation().details }, { total: null, details: valuation().details }, { total: [], details: valuation().details }]) {
    await assert.rejects(syncGate(credential, response(invalid)), /数据不完整|读取失败/);
  }
  for (const invalid of [undefined, null, false, '', [], {}, { spot: null }, { spot: [] }, { spot: false }, { spot: '0' }, { spot: {} }]) {
    await assert.rejects(syncGate(credential, response({ total: account('0'), details: invalid })), /数据不完整|币种不是 USDT/);
  }
  await assert.rejects(syncGate(credential, response({ total: account('1'), details: { spot: account('1'), future_account: {} } })), /币种不是 USDT/);
});

test('Gate requires explicit USDT in the total and every account without silently converting other currencies', async () => {
  for (const currency of [undefined, null, false, 0, '', 'USDT ', 'usdt', 'USD', 'BTC', {}, ['USDT']]) {
    const invalid = { amount: '1', currency };
    await assert.rejects(syncGate(credential, response({ ...valuation(), total: invalid })), /币种不是 USDT/);
    for (const name of ['spot', 'unknown']) await assert.rejects(syncGate(credential, response({ ...valuation(), details: { [name]: invalid } })), /币种不是 USDT/);
  }
});

test('Gate rejects invalid, overflowing and underflowing monetary values in totals and all details', async () => {
  for (const invalid of [undefined, null, false, 0, 1, [], {}, '', ' ', ' 1', '1 ', 'NaN', 'Infinity', '-Infinity', '0x10', '1e3', '+1', '1,000', '.1', '1.', '9'.repeat(400), '0.' + '0'.repeat(400) + '1']) {
    const invalidAccount = { currency: 'USDT', amount: invalid };
    await assert.rejects(syncGate(credential, response({ ...valuation(), total: invalidAccount })), /不是有效数值/);
    for (const name of ['spot', 'unknown']) await assert.rejects(syncGate(credential, response({ ...valuation(), details: { [name]: invalidAccount } })), /不是有效数值/);
  }
});

test('Gate rejects all paths except the balance endpoint and rejects empty credentials before network access', async () => {
  let calls = 0;
  const never = mock(() => { calls++; return {}; });
  for (const path of ['/api/v4/spot/orders', '/api/v4/wallet/transfers', '/api/v4/withdrawals', '/api/v4/account/detail', '/api/v4/account/main_keys', '/api/v4/spot/accounts', 'constructor', 'https://evil.example' + balancePath, balancePath + '?currency=USDT', balancePath + '?currency=BTC', balancePath + '/../transfers', balancePath + '#anything']) {
    await assert.rejects(gateGet(credential, path, never), /只读账户接口/);
  }
  for (const key of ['apiKey', 'apiSecret']) {
    for (const value of ['', ' ', null, undefined, 1, {}]) await assert.rejects(gateGet({ ...credential, [key]: value } as GateCredential, balancePath, never), /不能为空/);
  }
  assert.equal(calls, 0);
});

test('Gate maps known authentication labels to safe actionable diagnostics with the actual HTTP status', async () => {
  const cases = [
    ['INVALID_CREDENTIALS', [/凭据|密钥/, /Key|Secret|重新/]],
    ['INVALID_KEY', [/Key|密钥/, /无效|失效|识别/]],
    ['IP_FORBIDDEN', [/服务器.*出口/, /IPv4/, /白名单/]],
    ['READ_ONLY', [/只读/, /账户|API/]],
    ['INVALID_SIGNATURE', [/签名/, /同一组|配对/, /Key.*Secret/]],
    ['MISSING_REQUIRED_HEADER', [/请求头|认证头/]],
    ['REQUEST_EXPIRED', [/时间|时钟/, /同步/, /60/]],
    ['ACCOUNT_LOCKED', [/锁定/, /账户/]],
    ['FORBIDDEN', [/钱包.*读取/, /权限/]],
  ] as const;
  for (const [label, checks] of cases) {
    await assert.rejects(syncGate(credential, async () => Response.json({ label, message: sensitive, detail: sensitive }, { status: 403 })), error => {
      diagnostic(error, [/HTTP 403/, new RegExp(label), ...checks]);
      if (label === 'READ_ONLY') assert.doesNotMatch((error as Error).message, /请.{0,12}(开启|启用).{0,8}(写入|交易|提现)/);
      return true;
    });
  }
});

test('Gate maps known rate and server labels without reflecting provider explanations', async () => {
  for (const [label, status, reason] of [
    ['TOO_MANY_REQUESTS', 429, /频率|限流/], ['TOO_BUSY', 503, /繁忙/],
    ['INTERNAL', 500, /服务/], ['SERVER_ERROR', 502, /服务/], ['INTERNAL_SERVER_ERROR', 503, /服务/],
  ] as const) {
    await assert.rejects(syncGate(credential, async () => Response.json({ label, message: sensitive, detail: sensitive }, { status })),
      error => diagnostic(error, [new RegExp(`HTTP ${status}`), new RegExp(label), reason, /稍后|重试/]));
  }
});

test('Gate maps official request, currency and account labels on HTTP 400 without leaking provider details', async () => {
  const cases = [
    ['INVALID_PARAM_VALUE', /参数/], ['INVALID_PROTOCOL', /协议|请求格式/], ['INVALID_ARGUMENT', /参数/],
    ['INVALID_REQUEST_BODY', /请求体|请求格式|请求正文/], ['MISSING_REQUIRED_PARAM', /参数/], ['BAD_REQUEST', /请求/],
    ['INVALID_CONTENT_TYPE', /Content-Type|内容类型/], ['NOT_ACCEPTABLE', /响应格式|Accept|接受/],
    ['METHOD_NOT_ALLOWED', /请求方法|GET/], ['NOT_FOUND', /接口|路径/], ['INVALID_CURRENCY', /币种|USDT/],
    ['ACCOUNT_EXCEPTION', /账户/], ['MARGIN_BALANCE_EXCEPTION', /杠杆|余额/],
  ] as const;
  for (const [label, reason] of cases) {
    await assert.rejects(syncGate(credential, async () => Response.json({ label, message: sensitive, detail: sensitive }, { status: 400 })),
      error => diagnostic(error, [/HTTP 400/, new RegExp(label), reason]));
  }
});

test('Gate distinguishes unknown codes from absent or malformed JSON labels using fixed safe diagnostics', async () => {
  for (const label of ['FUTURE_GATE_ERROR', 'constructor', '__proto__', 'toString', 'forbidden', 'FORBIDDEN ', 'INVALID_SIGNATURE\n', sensitive]) {
    await assert.rejects(syncGate(credential, async () => Response.json({ label, message: sensitive, detail: sensitive }, { status: 400 })), error => {
      diagnostic(error, [/HTTP 400/, /API_CODE_UNKNOWN/, /错误码/]);
      assert.equal((error as Error).message.includes(label), false);
      return true;
    });
  }
  for (const label of ['', ' \t ', null, 1, false, {}, []]) {
    await assert.rejects(syncGate(credential, async () => Response.json({ label, message: sensitive, detail: sensitive }, { status: 400 })),
      error => diagnostic(error, [/HTTP 400/, /API_CODE_MISSING/, /错误码/]));
  }
  for (const body of [JSON.stringify({ message: sensitive }), 'null', '[]', '"FORBIDDEN"', '0', 'true']) {
    await assert.rejects(syncGate(credential, async () => new Response(body, { status: 400 })),
      error => diagnostic(error, [/HTTP 400/, /API_CODE_MISSING/]));
  }
});

test('Gate recognizes known JSON error labels even when the response media type is absent, incorrect or malicious', async () => {
  for (const mediaType of [null, 'text/plain', 'text/html; charset=utf-8', 'application/json; charset=' + sensitive, sensitive]) {
    const headers = new Headers();
    if (mediaType !== null) headers.set('content-type', mediaType);
    const result = new Response(Buffer.from(JSON.stringify({ label: 'INVALID_CONTENT_TYPE', message: sensitive, detail: sensitive })), { status: 400, headers });
    if (mediaType === null) assert.equal(result.headers.get('content-type'), null);
    await assert.rejects(syncGate(credential, async () => result), error => diagnostic(error, [/HTTP 400/, /INVALID_CONTENT_TYPE/]));
  }
});

test('Gate gives fixed safe diagnostics for empty, HTML and non-JSON error bodies', async () => {
  for (const body of [null, '', ' \r\n\t ']) {
    await assert.rejects(syncGate(credential, async () => new Response(body, { status: 400 })),
      error => diagnostic(error, [/HTTP 400/, /RESPONSE_EMPTY/]));
  }
  for (const body of ['<!DOCTYPE html>', '  <HTML>', '\n<head>', '\t<body>']) {
    await assert.rejects(syncGate(credential, async () => new Response(body + sensitive, { status: 400 })),
      error => diagnostic(error, [/HTTP 400/, /RESPONSE_HTML/]));
  }
  for (const mediaType of ['text/html; charset=' + sensitive, 'TEXT/HTML; charset=' + sensitive]) {
    await assert.rejects(syncGate(credential, async () => new Response(sensitive, { status: 400, headers: { 'content-type': mediaType } })),
      error => diagnostic(error, [/HTTP 400/, /RESPONSE_HTML/]));
  }
  for (const body of [sensitive, '{"label":"FORBIDDEN",broken:' + sensitive]) {
    await assert.rejects(syncGate(credential, async () => new Response(body, { status: 400, headers: { 'content-type': sensitive } })),
      error => diagnostic(error, [/HTTP 400/, /RESPONSE_NON_JSON/]));
  }
  for (const [status, reason] of [[401, /认证/], [403, /访问被拒绝/], [429, /频率|限流/], [500, /服务/], [502, /服务/], [503, /服务/]] as const) {
    await assert.rejects(syncGate(credential, async () => new Response(sensitive, { status })),
      error => diagnostic(error, [new RegExp(`HTTP ${status}`), /RESPONSE_NON_JSON/, reason]));
  }
});

test('Gate never treats a 2xx error label or invalid JSON as a successful balance', async () => {
  for (const label of ['FORBIDDEN', 'INVALID_SIGNATURE', 'INVALID_CONTENT_TYPE', sensitive, null, {}, '']) {
    await assert.rejects(syncGate(credential, response({ ...valuation(), label, message: sensitive, detail: sensitive })), error => {
      const code = label === sensitive ? 'API_CODE_UNKNOWN' : (typeof label !== 'string' || label === '') ? 'API_CODE_MISSING' : label;
      diagnostic(error, [/HTTP 200/, new RegExp(code)]);
      if (label === 'FORBIDDEN') assert.match((error as Error).message, /FORBIDDEN.*钱包|钱包.*读取/);
      return true;
    });
  }
  await assert.rejects(syncGate(credential, async () => new Response(sensitive, { status: 200 })), error => diagnostic(error));
});

test('Gate limits error bodies to 16 KiB of declared and actual bytes and cancels oversized streams', async () => {
  const limit = 16 * 1024;
  const wrapperSize = Buffer.byteLength(JSON.stringify({ label: 'FORBIDDEN', message: '' }));
  const boundary = Buffer.from(JSON.stringify({ label: 'FORBIDDEN', message: 'x'.repeat(limit - wrapperSize) }));
  assert.equal(boundary.byteLength, limit);
  const exact = streamedResponse([boundary], { 'content-length': String(limit) });
  await assert.rejects(syncGate(credential, async () => exact.response), error => diagnostic(error, [/FORBIDDEN/, /钱包.*读取/]));
  assert.equal(exact.canceled(), false);

  const declared = streamedResponse([boundary], { 'content-length': String(limit + 1) });
  await assert.rejects(syncGate(credential, async () => declared.response), error => diagnostic(error, [/HTTP 403/, /RESPONSE_TOO_LARGE/]));
  assert.equal(declared.reads(), 0, 'An oversized declared body must not be read');
  assert.equal(declared.canceled(), true);

  for (const headers of [new Headers(), new Headers({ 'content-length': '1' })]) {
    const oversized = streamedResponse([boundary, Buffer.from(' '), Buffer.from(sensitive)], headers);
    await assert.rejects(syncGate(credential, async () => oversized.response), error => {
      diagnostic(error, [/HTTP 403/, /RESPONSE_TOO_LARGE/]);
      assert.doesNotMatch((error as Error).message, /FORBIDDEN/);
      return true;
    });
    assert.equal(oversized.reads(), 2, 'Stop as soon as the first excess byte arrives');
    assert.equal(oversized.canceled(), true);
  }
  const unicode = JSON.stringify({ label: 'FORBIDDEN', message: '中'.repeat(6000) });
  assert.ok(unicode.length < limit && Buffer.byteLength(unicode) > limit);
  const multibyte = streamedResponse([Buffer.from(unicode)]);
  await assert.rejects(syncGate(credential, async () => multibyte.response), error => diagnostic(error, [/RESPONSE_TOO_LARGE/]));
  assert.equal(multibyte.canceled(), true, 'The cap is measured in UTF-8 bytes, not characters');
});

test('Gate retains safe status diagnostics when the error response stream fails', async () => {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(Buffer.from('{"label":"FORBIDDEN","message":"'));
      else controller.error(new Error(sensitive));
    },
  }, { highWaterMark: 0 });
  await assert.rejects(syncGate(credential, async () => new Response(body, { status: 403 })),
    error => diagnostic(error, [/HTTP 403/, /RESPONSE_READ_FAILED/]));
});

test('Gate classifies known transport causes without exposing causes, codes, signed requests or URLs', async () => {
  const cases = [
    ['ENOTFOUND', /DNS.*解析|解析.*DNS/], ['EAI_AGAIN', /DNS.*解析|解析.*DNS/],
    ['CERT_HAS_EXPIRED', /证书/], ['DEPTH_ZERO_SELF_SIGNED_CERT', /证书/], ['ERR_TLS_CERT_ALTNAME_INVALID', /证书/],
    ['ECONNREFUSED', /无法.*连接|连接.*失败/], ['ENETUNREACH', /无法.*连接|连接.*失败/], ['EHOSTUNREACH', /无法.*连接|连接.*失败/],
    ['ECONNRESET', /连接.*中断/], ['UND_ERR_SOCKET', /连接.*中断/],
    ['ETIMEDOUT', /超时/], ['UND_ERR_CONNECT_TIMEOUT', /超时/],
  ] as const;
  for (const [code, reason] of cases) {
    const error = new Error(sensitive, { cause: { code, message: sensitive, hostname: 'evil.example' } });
    await assert.rejects(syncGate(credential, async () => { throw error; }), failure => {
      diagnostic(failure, [reason, /检查|重试|稍后/]);
      assert.doesNotMatch((failure as Error).message, /HTTP|12\s*秒/);
      assert.equal((failure as Error).message.includes(code), false);
      return true;
    });
  }
  for (const error of [new Error(sensitive), Object.assign(new Error('timeout network aborted ' + sensitive), { name: 'AbortError' }), new Error(sensitive, { cause: { code: sensitive } })]) {
    await assert.rejects(syncGate(credential, async () => { throw error; }), failure => {
      diagnostic(failure, [/网络/]);
      assert.doesNotMatch((failure as Error).message, /HTTP|超时|timeout|network|aborted/i);
      return true;
    });
  }
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
  await assert.rejects(result, error => diagnostic(error, [/超时/, /12\s*秒/, /检查|重试/]));
  assert.equal(calls, 1);
});

test('Gate identifies a timeout while reading either a success or error body without exposing the stream error', async t => {
  for (const status of [200, 403]) {
    const controller = new AbortController();
    t.mock.method(AbortSignal, 'timeout', () => controller.signal);
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        controller.abort(new Error(sensitive));
        stream.error(new Error(sensitive));
      },
    }, { highWaterMark: 0 });
    await assert.rejects(syncGate(credential, async () => new Response(body, { status })), error => {
      diagnostic(error, [new RegExp(`HTTP ${status}`), /超时/, /12\s*秒/]);
      assert.doesNotMatch((error as Error).message, /RESPONSE_READ_FAILED/);
      return true;
    });
  }
});

test('Gate refuses redirects without forwarding authenticated headers to another host', async () => {
  let calls = 0;
  let bodyReads = 0;
  const redirect = (async (_url: unknown, init: RequestInit) => {
    calls++;
    assert.equal(init.redirect, 'manual');
    return new Response(new ReadableStream({ pull() { bodyReads++; assert.fail('Redirect bodies must not be read'); } }, { highWaterMark: 0 }),
      { status: 302, headers: { location: 'https://evil.example/' + credential.apiSecret } });
  }) as typeof fetch;
  await assert.rejects(syncGate(credential, redirect), error => diagnostic(error, [/HTTP 302/, /重定向/]));
  assert.equal(calls, 1);
  assert.equal(bodyReads, 0);
  const followed = (async () => {
    const result = Response.json(valuation());
    Object.defineProperty(result, 'redirected', { value: true });
    return result;
  }) as typeof fetch;
  await assert.rejects(syncGate(credential, followed), /读取失败/);
});
