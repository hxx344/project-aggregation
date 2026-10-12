import test from 'node:test';
import assert from 'node:assert/strict';
import { createVariationalDiagnosticGate, diagnoseVariational } from '../lib/variational-diagnostics.ts';

const credential = { vrToken: 'synthetic.diagnostic.input' };
const returnedToken = 'synthetic.diagnostic.returned';
const privateValue = '928174.625';
const paths = ['/api/me', '/api/portfolio?compute_margin=true'];
type Report = Awaited<ReturnType<typeof diagnoseVariational>>;
const good = (url: string) => Response.json(url.endsWith('/api/me')
  ? { token: returnedToken, account: 'PRIVATE_ACCOUNT' }
  : { balance: privateValue, position: 'PRIVATE_POSITION' });
const both = (response: () => Response): typeof fetch => (async () => response()) as typeof fetch;
const resultFor = (report: Report, endpoint: 'session' | 'portfolio') => {
  const result = report.results.find(item => item.endpoint === endpoint);
  assert.ok(result);
  return result;
};
function assertSafe(report: Report) {
  assert.deepEqual(Object.keys(report).sort(), ['checkedAt', 'client', 'results']);
  assert.equal(report.client, 'asset-node');
  assert.ok(Number.isFinite(Date.parse(report.checkedAt)));
  assert.deepEqual(report.results.map(result => result.endpoint), ['session', 'portfolio']);
  assert.deepEqual(report.results.map(result => result.path), paths);
  for (const result of report.results) {
    assert.deepEqual(Object.keys(result).sort(), ['challenge', 'contentType', 'elapsedMs', 'endpoint', 'outcome', 'path', 'status', 'structureOk']);
    assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
  }
  const text = JSON.stringify(report);
  for (const secret of [credential.vrToken, returnedToken, privateValue, 'PRIVATE_ACCOUNT', 'PRIVATE_POSITION', 'PRIVATE_RESPONSE', 'PRIVATE_HEADER', 'PRIVATE_EXCEPTION']) {
    assert.equal(text.includes(secret), false, 'Only safe diagnostic metadata may leave the server');
  }
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Diagnostic did not settle after cancellation')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

test('diagnostics make only two fixed parallel GETs with the original cookie and sync headers', async () => {
  const calls: string[] = [];
  let releaseSession!: () => void;
  const sessionGate = new Promise<void>(resolve => { releaseSession = resolve; });
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    assert.equal(url.origin, 'https://omni.variational.io');
    assert.ok(paths.includes(url.pathname + url.search), 'No trading, quote or other provider call is allowed');
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    assert.equal(init.body, undefined); assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(Object.fromEntries(new Headers(init.headers)), {
      accept: 'application/json', 'cache-control': 'no-cache', cookie: 'vr-token=' + credential.vrToken,
      referer: 'https://omni.variational.io/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
    });
    if (url.pathname === '/api/me') await sessionGate;
    else releaseSession();
    return good(url.href);
  }) as typeof fetch;
  const report = await within(diagnoseVariational(credential, fetcher));
  assert.deepEqual(calls, paths);
  assert.deepEqual(report.results.map(({ outcome, status, structureOk }) => ({ outcome, status, structureOk })), [
    { outcome: 'ok', status: 200, structureOk: true }, { outcome: 'ok', status: 200, structureOk: true },
  ]);
  assertSafe(report);
});

test('a token returned by me is never used for the independent portfolio request', async () => {
  const cookies: string[] = [];
  const report = await diagnoseVariational(credential, (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    cookies.push(new Headers(init.headers).get('cookie')!);
    return good(String(input));
  }) as typeof fetch);
  assert.deepEqual(cookies, ['vr-token=' + credential.vrToken, 'vr-token=' + credential.vrToken]);
  assertSafe(report);
});

test('one endpoint failing does not hide or cancel a successful independent result', async () => {
  for (const broken of ['session', 'portfolio']) {
    const report = await diagnoseVariational(credential, (async (input: RequestInfo | URL) => {
      const endpoint = String(input).endsWith('/api/me') ? 'session' : 'portfolio';
      if (endpoint === broken) throw new Error('PRIVATE_EXCEPTION ' + credential.vrToken);
      return good(String(input));
    }) as typeof fetch);
    assert.equal(resultFor(report, broken as 'session' | 'portfolio').outcome, 'network_error');
    assert.equal(resultFor(report, broken === 'session' ? 'portfolio' : 'session').outcome, 'ok');
    assertSafe(report);
  }
});

test('explicit challenges override status and rejected bodies are cancelled without reading', async () => {
  for (const status of [200, 302, 401, 403, 429, 503]) {
    let cancelled = 0;
    const report = await within(diagnoseVariational(credential, both(() => new Response(new ReadableStream({
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), {
      status, headers: { 'cf-mitigated': ' Challenge ', 'content-type': 'text/html', 'set-cookie': 'vr-token=' + returnedToken, 'x-private': 'PRIVATE_HEADER' },
    }))));
    assert.equal(cancelled, 2);
    for (const result of report.results) {
      assert.equal(result.outcome, 'challenge'); assert.equal(result.challenge, true);
      assert.equal(result.status, status); assert.equal(result.structureOk, null); assert.equal(result.contentType, 'html');
    }
    assertSafe(report);
  }
});

test('HTTP access errors, redirects and HTML do not parse or misclassify response bodies', async () => {
  const cases = [
    { status: 401, type: 'application/json', outcome: 'unauthorized', contentType: 'json' },
    { status: 403, type: 'text/html', outcome: 'forbidden', contentType: 'html' },
    { status: 429, type: 'application/problem+json', outcome: 'rate_limited', contentType: 'json' },
    { status: 302, type: 'application/json', outcome: 'redirect', contentType: 'json' },
    { status: 200, type: 'text/html; charset=utf-8', outcome: 'html', contentType: 'html' },
    { status: 200, type: 'application/xhtml+xml', outcome: 'html', contentType: 'html' },
    { status: 200, type: 'text/plain', outcome: 'invalid_data', contentType: 'other' },
  ];
  for (const item of cases) {
    let cancelled = 0;
    const report = await within(diagnoseVariational(credential, both(() => new Response(new ReadableStream({
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { status: item.status, headers: { 'content-type': item.type, server: 'cloudflare', location: 'https://untrusted.example/PRIVATE_HEADER' } }))));
    assert.equal(cancelled, 2);
    for (const result of report.results) {
      assert.equal(result.outcome, item.outcome); assert.equal(result.contentType, item.contentType);
      assert.equal(result.challenge, false); assert.equal(result.structureOk, null);
    }
    assertSafe(report);
  }
  const redirected = await diagnoseVariational(credential, both(() => {
    const response = Response.json({ token: returnedToken, balance: '1' });
    Object.defineProperty(response, 'redirected', { value: true });
    return response;
  }));
  assert.ok(redirected.results.every(result => result.outcome === 'redirect'));
});

test('me validates only token shape and portfolio uses the existing decimal rules without exposing values', async () => {
  for (const token of ['opaque-token', 'x', 'x'.repeat(32768), 'eyJhbGciOiJub25lIn0.eyJleHAiOjF9.signature']) {
    const report = await diagnoseVariational(credential, (async (input: RequestInfo | URL) => String(input).endsWith('/api/me')
      ? Response.json({ token }) : good(String(input))) as typeof fetch);
    assert.equal(resultFor(report, 'session').outcome, 'ok', 'A syntactically present token is not a JWT lifetime verdict');
  }
  for (const data of [{}, null, [], { data: { token: returnedToken } }, { token: '' }, { token: 12 }, { token: 'x'.repeat(32769) }]) {
    const report = await diagnoseVariational(credential, (async (input: RequestInfo | URL) => String(input).endsWith('/api/me')
      ? Response.json(data) : good(String(input))) as typeof fetch);
    assert.equal(resultFor(report, 'session').outcome, 'invalid_data');
    assert.equal(resultFor(report, 'session').structureOk, false);
    assert.equal(resultFor(report, 'portfolio').outcome, 'ok');
  }
  for (const balance of ['0', '-0.000', '-125.5', 12.5, privateValue]) {
    const report = await diagnoseVariational(credential, (async (input: RequestInfo | URL) => String(input).endsWith('/api/me')
      ? good(String(input)) : Response.json({ balance })) as typeof fetch);
    assert.equal(resultFor(report, 'portfolio').outcome, 'ok'); assertSafe(report);
  }
  for (const balance of [null, false, '', ' ', '1e9', 'NaN', '123junk', '9'.repeat(129), '0.' + '0'.repeat(400) + '1', {}, []]) {
    const report = await diagnoseVariational(credential, (async (input: RequestInfo | URL) => String(input).endsWith('/api/me')
      ? good(String(input)) : Response.json({ balance })) as typeof fetch);
    assert.equal(resultFor(report, 'portfolio').outcome, 'invalid_data');
    assert.equal(resultFor(report, 'portfolio').structureOk, false);
  }
});

test('malformed JSON, nonobjects and oversized responses yield safe invalid-data results', async () => {
  for (const response of [
    () => new Response('PRIVATE_RESPONSE ' + credential.vrToken, { headers: { 'content-type': 'application/json' } }),
    () => Response.json(null), () => Response.json([]),
    () => new Response('PRIVATE_RESPONSE', { headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) } }),
    () => new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const report = await diagnoseVariational(credential, both(response));
    assert.ok(report.results.every(result => result.outcome === 'invalid_data'));
    assertSafe(report);
  }
  const report = await diagnoseVariational(credential, (async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith('/api/me')
    ? { token: returnedToken } : { balance: privateValue }), { headers: { 'content-type': 'application/vnd.omni+json' } })) as typeof fetch);
  assert.ok(report.results.every(result => result.outcome === 'ok' && result.contentType === 'json'));
  const missing = await diagnoseVariational(credential, both(() => new Response(new TextEncoder().encode('{}'))));
  assert.ok(missing.results.every(result => result.contentType === 'missing' && result.outcome === 'invalid_data'));
});

test('invalid cookies are rejected before any outbound request without echoing their input', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return Response.json({}); }) as typeof fetch;
  for (const vrToken of ['', 'abc', 'a; other=secret', 'a\r\nb', 'vr-token=abcdef', 'Bearer abcdef', '令牌token', 'a'.repeat(4097)]) {
    await assert.rejects(diagnoseVariational({ vrToken }, fetcher), error => {
      assert.ok(error instanceof Error);
      if (vrToken.length >= 5) assert.equal(error.message.includes(vrToken), false);
      return true;
    });
  }
  assert.equal(calls, 0);
});

test('12-second timeout aborts a stalled body and does not leak transport exceptions', async t => {
  const timeouts: AbortController[] = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 12000);
    const controller = new AbortController(); timeouts.push(controller); return controller.signal;
  });
  let bodies = 0, cancelled = 0;
  const pending = diagnoseVariational(credential, both(() => {
    bodies++;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } });
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bodies, 2);
  for (const controller of timeouts) controller.abort(new DOMException('PRIVATE_EXCEPTION ' + credential.vrToken, 'TimeoutError'));
  const report = await within(pending);
  assert.ok(report.results.every(result => result.outcome === 'timeout'));
  assert.equal(cancelled, 2); assertSafe(report);
});

test('request cancellation settles both active requests and is distinct from timeout', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = diagnoseVariational(credential, (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    calls++;
    return await new Promise<Response>((_, reject) => {
      const abort = () => reject(init.signal?.reason);
      if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
    });
  }) as typeof fetch, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  controller.abort(new Error('PRIVATE_EXCEPTION ' + credential.vrToken));
  const report = await within(pending);
  assert.ok(report.results.every(result => result.outcome === 'cancelled'));
  assertSafe(report);
  const alreadyCancelled = await within(diagnoseVariational(credential, (async () => {
    assert.fail('Do not start work for a disconnected request');
  }) as typeof fetch, controller.signal));
  assert.ok(alreadyCancelled.results.every(result => result.outcome === 'cancelled'));
});

test('diagnostic gate keeps active owners locked and measures cooldown from the original claim', () => {
  let now = 1000;
  const gate = createVariationalDiagnosticGate(() => now);
  const release = gate.claim('owner'); assert.ok(release);
  const otherRelease = gate.claim('other-owner'); assert.ok(otherRelease); otherRelease();
  assert.equal(gate.claim('owner'), null);
  now += 30000;
  assert.equal(gate.claim('owner'), null, 'Active requests stay locked beyond the cooldown');
  release();
  const second = gate.claim('owner'); assert.ok(second);
  release();
  assert.equal(gate.claim('owner'), null, 'A stale release cannot unlock a newer claim');
  second();
  now += 29999;
  assert.equal(gate.claim('owner'), null, 'Releasing even failed work does not remove cooldown');
  now++;
  const third = gate.claim('owner'); assert.ok(third); third();
});

test('diagnostic gate bounds owner state without evicting active or cooling-down claims', () => {
  let now = 0;
  const gate = createVariationalDiagnosticGate(() => now);
  const releases = Array.from({ length: 100 }, (_, index) => gate.claim('owner-' + index));
  assert.ok(releases.every(release => release !== null));
  assert.equal(gate.claim('overflow'), null);
  releases[0]!();
  assert.equal(gate.claim('overflow'), null, 'A cooling-down owner cannot be evicted to bypass the bound');
  now = 30000;
  const release = gate.claim('overflow'); assert.ok(release); release();
  assert.equal(gate.claim('owner-1'), null, 'Reclaiming expired state cannot evict active work');
  for (const done of releases) done!();
});
