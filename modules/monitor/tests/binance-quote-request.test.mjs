import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BinanceQuoteError, createBinanceQuoteRequest, formatBinanceQuoteError } from '../lib/binance-quote-request.ts';

const NOW = Date.UTC(2026, 8, 14, 12);
const payload = { observed: 'upstream response' };
const networkError = () => new TypeError('private upstream URL?token=do-not-display');
const timeoutError = () => new DOMException('private timeout details', 'TimeoutError');
const socketError = () => Object.assign(new TypeError('private socket details'), { cause: { code: 'UND_ERR_SOCKET' } });
function harness(respond) {
  let now = NOW;
  const calls = [], sleeps = [];
  const request = createBinanceQuoteRequest({ clock: () => now,
    sleep: async delay => { sleeps.push(delay); now += delay; },
    fetcher: async (input, options) => {
      const endpoint = new URL(input).pathname.split('/').at(-1);
      calls.push({ endpoint, input, options });
      return respond(endpoint, calls.length);
    },
  });
  return { request, calls, sleeps, setNow: value => { now = value; } };
}
function failure(endpoint, kind, status) {
  return error => {
    assert.ok(error instanceof BinanceQuoteError);
    assert.equal(error.endpoint, endpoint); assert.equal(error.kind, kind);
    assert.equal(error.httpStatus, status);
    return true;
  };
}

test('required Binance reads recover once from transient transport and selected HTTP failures', async () => {
  const failures = [
    ...[networkError, timeoutError, socketError].map(create => () => { throw create(); }),
    ...[408, 500, 502, 503, 504].map(status => () => new Response('private gateway details', { status })),
  ];
  for (const endpoint of ['exchangeInfo', 'premiumIndex']) for (const firstResponse of failures) {
    const h = harness((_endpoint, attempt) => attempt === 1 ? firstResponse() : Response.json(payload));
    assert.deepEqual(await h.request(endpoint), payload);
    assert.equal(h.calls.length, 2); assert.deepEqual(h.sleeps, [300]);
    for (const call of h.calls) {
      assert.equal(call.input, `https://fapi.binance.com/fapi/v1/${endpoint}`);
      assert.equal(call.options.cache, 'no-store');
      assert.ok(call.options.signal instanceof AbortSignal);
    }
  }
});

test('persistent transient failures stop after two attempts and optional funding never retries', async () => {
  for (const [kind, respond, status] of [
    ['network', () => { throw networkError(); }, undefined],
    ['timeout', () => { throw timeoutError(); }, undefined],
    ['http', () => new Response('private upstream error', { status: 503 }), 503],
  ]) for (const endpoint of ['premiumIndex', 'fundingInfo']) {
    const h = harness(respond);
    await assert.rejects(h.request(endpoint), failure(endpoint, kind, status));
    assert.equal(h.calls.length, endpoint === 'fundingInfo' ? 1 : 2);
    assert.deepEqual(h.sleeps, endpoint === 'fundingInfo' ? [] : [300]);
  }
});

test('ordinary HTTP failures and invalid JSON fail without transient retries', async () => {
  for (const status of [400, 401, 403, 404, 451, 501]) {
    const h = harness(() => new Response('private provider error', { status }));
    await assert.rejects(h.request('exchangeInfo'), failure('exchangeInfo', 'http', status));
    assert.equal(h.calls.length, 1); assert.deepEqual(h.sleeps, []);
  }
  const h = harness(() => new Response('private invalid JSON'));
  await assert.rejects(h.request('premiumIndex'), failure('premiumIndex', 'invalid_json'));
  assert.equal(h.calls.length, 1); assert.deepEqual(h.sleeps, []);
});

test('a transient failure while reading the response body receives the same bounded recovery', async () => {
  const h = harness((_endpoint, attempt) => attempt === 1
    ? { ok: true, json: async () => { throw socketError(); } }
    : Response.json(payload));
  assert.deepEqual(await h.request('premiumIndex'), payload);
  assert.equal(h.calls.length, 2); assert.deepEqual(h.sleeps, [300]);
});

test('429 honors seconds or date Retry-After and only blocks the affected endpoint until expiry', async () => {
  for (const [header, delay] of [['180', 180_000], [new Date(NOW + 300_000).toUTCString(), 300_000]]) {
    const h = harness((_endpoint, attempt) => attempt === 1
      ? new Response('private rate limit details', { status: 429, headers: { 'Retry-After': header } })
      : Response.json(payload));
    await assert.rejects(h.request('premiumIndex'), error => {
      failure('premiumIndex', 'http', 429)(error); assert.equal(error.retryAt, NOW + delay); return true;
    });
    assert.deepEqual(await h.request('fundingInfo'), payload);
    h.setNow(NOW + delay - 1);
    await assert.rejects(h.request('premiumIndex'), failure('premiumIndex', 'http', 429));
    assert.equal(h.calls.length, 2); assert.deepEqual(h.sleeps, []);
    h.setNow(NOW + delay);
    assert.deepEqual(await h.request('premiumIndex'), payload);
    assert.equal(h.calls.length, 3);
  }
});

test('missing or invalid Retry-After uses a bounded default cooldown for rate limits and bans', async () => {
  for (const status of [429, 418]) for (const header of [null, 'unparseable', '-1', new Date(NOW - 1000).toUTCString()]) {
    const delay = status === 429 ? 60_000 : 120_000;
    const h = harness((_endpoint, attempt) => attempt === 1
      ? new Response('private limited body', { status, headers: header === null ? {} : { 'Retry-After': header } })
      : Response.json(payload));
    await assert.rejects(h.request('premiumIndex'), error => {
      failure('premiumIndex', 'http', status)(error); assert.equal(error.retryAt, NOW + delay); return true;
    });
    h.setNow(NOW + delay - 1);
    await assert.rejects(h.request('premiumIndex'), failure('premiumIndex', 'http', status));
    assert.equal(h.calls.length, 1); assert.deepEqual(h.sleeps, []);
    h.setNow(NOW + delay);
    assert.deepEqual(await h.request('premiumIndex'), payload);
    assert.equal(h.calls.length, 2);
  }
});

test('418 blocks every Binance endpoint and preserves a longer server cooldown', async () => {
  for (const header of ['240', new Date(NOW + 240_000).toUTCString()]) {
    const h = harness((_endpoint, attempt) => attempt === 1
      ? new Response('private ban details', { status: 418, headers: { 'Retry-After': header } })
      : Response.json(payload));
    await assert.rejects(h.request('fundingInfo'), failure('fundingInfo', 'http', 418));
    h.setNow(NOW + 239_999);
    for (const endpoint of ['exchangeInfo', 'premiumIndex', 'fundingInfo']) {
      await assert.rejects(h.request(endpoint), error => {
        failure(endpoint, 'http', 418)(error); assert.equal(error.retryAt, NOW + 240_000); return true;
      });
    }
    assert.equal(h.calls.length, 1); assert.deepEqual(h.sleeps, []);
    h.setNow(NOW + 240_000);
    assert.deepEqual(await h.request('premiumIndex'), payload);
    assert.equal(h.calls.length, 2);
  }
});

test('concurrent rate-limit responses cannot shorten an existing cooldown', async () => {
  for (const status of [429, 418]) {
    const h = harness((_endpoint, attempt) => new Response('private throttle details', {
      status, headers: { 'Retry-After': attempt === 1 ? '180' : '30' },
    }));
    const results = await Promise.allSettled([h.request('premiumIndex'), h.request(status === 418 ? 'exchangeInfo' : 'premiumIndex')]);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.equal(h.calls.length, 2);
    h.setNow(NOW + 30_000);
    await assert.rejects(h.request('premiumIndex'), error => {
      failure('premiumIndex', 'http', status)(error); assert.equal(error.retryAt, NOW + 180_000); return true;
    });
    assert.equal(h.calls.length, 2);
  }
});

test('a ban received during retry delay prevents the next network attempt', async () => {
  const calls = [], sleeps = [];
  const request = createBinanceQuoteRequest({ clock: () => NOW,
    sleep: async delay => {
      sleeps.push(delay);
      await assert.rejects(request('fundingInfo'), failure('fundingInfo', 'http', 418));
    },
    fetcher: async input => {
      const endpoint = new URL(input).pathname.split('/').at(-1); calls.push(endpoint);
      return new Response('private failure details', { status: endpoint === 'fundingInfo' ? 418 : 503 });
    },
  });
  await assert.rejects(request('premiumIndex'), failure('premiumIndex', 'http', 418));
  assert.deepEqual(calls, ['premiumIndex', 'fundingInfo']); assert.deepEqual(sleeps, [300]);
});

test('HTTP failures release their bodies without reading or exposing provider content', async () => {
  let cancelled = 0, decoded = 0;
  const h = harness(() => ({ ok: false, status: 403, headers: new Headers(),
    body: { cancel: async () => { cancelled++; } },
    json: async () => { decoded++; return { secret: 'do-not-display' }; },
  }));
  await assert.rejects(h.request('premiumIndex'), error => {
    const diagnostic = formatBinanceQuoteError(error);
    assert.match(diagnostic, /Binance/); assert.match(diagnostic, /403/);
    assert.doesNotMatch(diagnostic, /do-not-display|secret|https?:|token=/);
    return true;
  });
  assert.equal(cancelled, 1); assert.equal(decoded, 0);
});

test('diagnostics use fixed endpoint and failure labels instead of arbitrary error text', () => {
  const diagnostics = [];
  for (const kind of ['timeout', 'network', 'http', 'invalid_json', 'invalid_data']) {
    const error = new BinanceQuoteError(kind === 'invalid_data' ? 'quote' : 'premiumIndex', kind, { httpStatus: kind === 'http' ? 502 : undefined });
    error.message = 'private-provider-body https://private.example/?token=do-not-display';
    error.cause = new Error('private-cause');
    const diagnostic = formatBinanceQuoteError(error);
    assert.match(diagnostic, /Binance/);
    assert.doesNotMatch(diagnostic, /private|https?:|token=/);
    diagnostics.push(diagnostic);
  }
  assert.equal(new Set(diagnostics).size, diagnostics.length);
  assert.equal(formatBinanceQuoteError(new Error('private unrelated error')), null);
  assert.equal(formatBinanceQuoteError({ endpoint: 'premiumIndex', kind: 'timeout' }), null);
  assert.equal(formatBinanceQuoteError(null), null);
});
