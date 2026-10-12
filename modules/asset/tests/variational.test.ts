import test from 'node:test';
import assert from 'node:assert/strict';
import { syncVariational } from '../lib/variational.ts';
import { VARIATIONAL_ERRORS } from '../lib/variational-shared.ts';
import { connectionSchema } from '../lib/validation.ts';

const credential = { vrToken: 'synthetic.var.session' };
type PortfolioReader = NonNullable<Parameters<typeof syncVariational>[2]>;

function fixture(balance: unknown = '125', options: { price?: number; quoteAt?: number; fallback?: unknown; primaryFailure?: boolean } = {}): [typeof fetch, PortfolioReader] {
  let portfolioCalls = 0;
  const portfolioReader: PortfolioReader = async c => {
    assert.deepEqual(c, credential);
    assert.equal(++portfolioCalls, 1, 'Read the portfolio once without a session preflight or retry');
    return balance as number | string;
  };
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    assert.equal(portfolioCalls, 1, 'Read account balance before fetching its conversion rate');
    assert.notEqual(url.hostname, 'omni.variational.io', 'Node fetch is only used for USDC/USD pricing');
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    assert.equal(init.body, undefined); assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(Object.fromEntries(new Headers(init.headers)), { accept: 'application/json' });
    assert.equal(JSON.stringify(init).includes(credential.vrToken), false);
    if (url.hostname === 'api.coingecko.com') {
      assert.equal(url.href, 'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd&include_last_updated_at=true');
      return options.primaryFailure ? new Response('', { status: 503 }) : Response.json({ 'usd-coin': { usd: options.price ?? 0.99, last_updated_at: (options.quoteAt ?? Math.floor(Date.now() / 1000) * 1000) / 1000 } });
    }
    assert.equal(url.href, 'https://api.coinbase.com/v2/exchange-rates?currency=USDC');
    return Response.json(options.fallback ?? {});
  }) as typeof fetch;
  return [fetcher, portfolioReader];
}

test('Var reads portfolio once through the injected Python boundary and converts only its balance', async () => {
  const quoteAt = Math.floor((Date.now() - 60000) / 1000) * 1000;
  const result = await syncVariational(credential, ...fixture('125', { quoteAt }));
  assert.equal(result.total, 123.75);
  assert.equal(result.details.length, 1); assert.equal(result.details[0].quantity, 125); assert.equal(result.details[0].price, 0.99);
  assert.equal(result.details[0].coin, 'USDC'); assert.equal(result.updatedAt, new Date(quoteAt).toISOString());
});

test('Var accepts genuine zero and negative equity without rounding malformed values to zero', async () => {
  for (const [balance, total] of [['0', 0], ['-0.000', 0], ['-100', -99], [100, 99]] as const) {
    assert.equal((await syncVariational(credential, ...fixture(balance))).total, total);
  }
  for (const balance of [null, false, '', ' ', 'NaN', 'Infinity', '1e9', '123junk', '9'.repeat(309), '0.' + '0'.repeat(400) + '1', {}, [], NaN, Infinity]) {
    await assert.rejects(syncVariational(credential, ...fixture(balance)), /Var /);
  }
  const neverFetch = (async () => assert.fail('Invalid balance cannot trigger pricing')) as typeof fetch;
  await assert.rejects(syncVariational(credential, neverFetch, async () => undefined as unknown as string), /Var /);
});

test('Var uses independent USDC pricing and a correctly directed Coinbase fallback', async () => {
  const result = await syncVariational(credential, ...fixture('100', { primaryFailure: true, fallback: { data: { currency: 'USDC', rates: { USD: '1.02' } } } }));
  assert.equal(result.total, 102);
  assert.ok(Date.now() - Date.parse(result.updatedAt) < 2000);
  for (const quoteAt of [0, Date.now() - 901000, Date.now() + 61000, NaN]) await assert.rejects(syncVariational(credential, ...fixture('125', { quoteAt })), /USDC\/USD/);
  for (const price of [0, -1, Infinity, NaN]) await assert.rejects(syncVariational(credential, ...fixture('125', { price })), /USDC\/USD/);
  for (const fallback of [{ data: { currency: 'USD', rates: { USD: '1' } } }, { data: { currency: 'USDC', rates: { USD: '0' } } }, { data: { currency: 'USDC', rates: { USD: '' } } }]) {
    await assert.rejects(syncVariational(credential, ...fixture('125', { primaryFailure: true, fallback })), /USDC\/USD/);
  }
});

test('Var rejects cookie/header injection before any Python or pricing call', async () => {
  let calls = 0;
  const neverFetch = (async () => { calls++; assert.fail('must not fetch with invalid credentials'); }) as typeof fetch;
  const neverPortfolio: PortfolioReader = async () => { calls++; assert.fail('must not launch Python with invalid credentials'); };
  for (const vrToken of ['', 'abc', 'x; other=token', 'a\r\nb', 'vr-token=abcdef', 'Bearer abcdef', '令牌token', 'a'.repeat(4097)]) {
    assert.equal(connectionSchema.safeParse({ exchange: 'variational', vrToken }).success, false);
    await assert.rejects(syncVariational({ vrToken }, neverFetch, neverPortfolio), /Var /);
  }
  assert.equal(calls, 0);
  assert.deepEqual(connectionSchema.parse({ exchange: 'variational', vrToken: '  ' + credential.vrToken + '  ' }), { exchange: 'variational', ...credential });
  for (const extra of [{ url: 'https://example.test' }, { apiKey: 'unexpected' }, { apiSecret: 'unexpected' }]) assert.equal(connectionSchema.safeParse({ exchange: 'variational', ...credential, ...extra }).success, false);
});

test('Var preserves safe Python failure diagnoses and never falls back to a Node account request', async () => {
  let fetchCalls = 0;
  const neverFetch = (async () => { fetchCalls++; assert.fail('No pricing request or Node fallback after Python failure'); }) as typeof fetch;
  for (const message of Object.values(VARIATIONAL_ERRORS)) {
    let portfolioCalls = 0;
    await assert.rejects(syncVariational(credential, neverFetch, async () => { portfolioCalls++; throw new Error(message); }), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, message); return true;
    });
    assert.equal(portfolioCalls, 1);
  }
  assert.equal(fetchCalls, 0);
});

test('Var replaces unexpected Python exceptions with a fixed error without credentials or raw output', async () => {
  const sensitive = credential.vrToken + ' PRIVATE_RESPONSE';
  const neverFetch = (async () => assert.fail('No pricing request after a Python failure')) as typeof fetch;
  for (const failure of [new Error(sensitive), new Error('Var ' + sensitive), sensitive, new DOMException(sensitive, 'TimeoutError')]) {
    await assert.rejects(syncVariational(credential, neverFetch, async () => { throw failure; }), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, VARIATIONAL_ERRORS.network_error);
      assert.equal(error.message.includes(credential.vrToken), false); return true;
    });
  }
});

test('Var pricing failures remain bounded and do not expose HTTP, JSON or transport content', async () => {
  const sensitive = credential.vrToken + ' PRIVATE_RESPONSE';
  const responses = [
    ...[302, 401, 403, 429, 500].map(status => async () => new Response(sensitive, { status, headers: { location: 'https://example.test' } })),
    async () => { throw new Error(sensitive); },
    async () => { throw new DOMException(sensitive, 'TimeoutError'); },
    async () => { throw new DOMException(sensitive, 'AbortError'); },
    async () => new Response(sensitive),
    async () => { const response = Response.json({}); Object.defineProperty(response, 'redirected', { value: true }); return response; },
    async () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
  ];
  for (const response of responses) {
    let portfolioCalls = 0, fetchCalls = 0;
    const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      fetchCalls++;
      assert.notEqual(new URL(String(input)).hostname, 'omni.variational.io');
      assert.equal(new Headers(init.headers).has('cookie'), false);
      return response();
    }) as typeof fetch;
    await assert.rejects(syncVariational(credential, fetcher, async () => { portfolioCalls++; return '125'; }), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /Var USDC\/USD/);
      assert.equal(error.message.includes(credential.vrToken), false); assert.equal(error.message.includes('PRIVATE_RESPONSE'), false);
      return true;
    });
    assert.equal(portfolioCalls, 1); assert.equal(fetchCalls, 2, 'One primary FX request and one fallback, without retries');
  }
});

test('Var rejects overflow and nonzero balances rounded to zero during USD conversion', async () => {
  await assert.rejects(syncVariational(credential, ...fixture(Number.MAX_VALUE, { price: 2 })), /Var /);
  await assert.rejects(syncVariational(credential, ...fixture(1e-200, { price: 1e-200 })), /Var /);
});