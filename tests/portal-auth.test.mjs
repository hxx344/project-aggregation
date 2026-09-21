import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loginForPortal } from '../server/portal-auth.mjs';
import { UpstreamError } from '../server/adapters.mjs';

const password = 'fixture-password-not-a-real-secret';
const project = (adapter = 'asset', overrides = {}) => ({
  adapter, apiUrl: 'http://127.0.0.1:5678/prefix', authOrigin: '', ...overrides,
});

async function upstream(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    handler(req, res, requests.at(-1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base: 'http://127.0.0.1:' + server.address().port, requests };
}

test('missing saved passwords and unsupported adapters do not contact an upstream', async () => {
  let calls = 0;
  const options = { request: async () => { calls++; throw new Error('Unexpected network request'); } };
  for (const credentials of [undefined, null, {}, { password: '' }]) {
    assert.equal(await loginForPortal(project(), credentials, options), null);
  }
  for (const adapter of ['link', 'unknown']) {
    assert.equal(await loginForPortal(project(adapter), { password }, options), null);
  }
  assert.equal(calls, 0);
});

test('Asset and ASTER use only their login route and return only their own safe cookie value', async () => {
  for (const adapter of ['asset', 'aster']) {
    const source = project(adapter, { authOrigin: 'https://' + adapter + '.example.com' });
    const controller = new AbortController();
    const deadline = Date.now() + 2000;
    const calls = [];
    const result = await loginForPortal(source, { username: 'ignored', password }, {
      deadline, signal: controller.signal,
      request: async (base, route, options) => {
        calls.push({ base, route, options });
        return { data: { password: 'must-not-return-body' }, cookies: [
          'unrelated=ignore-me; HttpOnly',
          adapter + '_session=fixture-token_123.abc=; Domain=upstream.invalid; Path=/private; Secure; HttpOnly; SameSite=Lax',
        ] };
      },
    });
    assert.deepEqual(result, { cookie: { name: adapter + '_session', value: 'fixture-token_123.abc=', maxAge: 43200 } });
    assert.deepEqual(calls, [{ base: source.apiUrl, route: '/api/login', options: {
      method: 'POST', body: { password }, headers: { Origin: source.authOrigin }, deadline, signal: controller.signal,
    } }]);
    assert.ok(!JSON.stringify(result).includes(password));
    assert.ok(!JSON.stringify(result).includes('must-not-return-body'));
    assert.ok(!JSON.stringify(result).includes('Domain'));
    assert.ok(calls.every(call => !call.base.includes('fixture-token') && !call.route.includes('fixture-token')));
  }
});

test('every page open establishes a distinct session without sharing a login flight or cookie cache', async () => {
  let calls = 0;
  const options = { request: async (_base, route, { headers }) => {
    const number = ++calls;
    assert.equal(route, '/api/login');
    assert.equal(headers.Cookie, undefined);
    await Promise.resolve();
    return { cookies: ['aster_session=independent-' + number] };
  } };
  const source = project('aster');
  const results = await Promise.all([
    loginForPortal(source, { password }, options), loginForPortal(source, { password }, options),
  ]);
  results.push(await loginForPortal(source, { password }, options));
  assert.equal(calls, 3);
  assert.deepEqual(results.map(result => result.cookie.value), ['independent-1', 'independent-2', 'independent-3']);
});

test('missing, empty, duplicate, and malformed application session cookies are rejected without disclosure', async () => {
  const invalid = [
    undefined, [], ['aster_session=wrong-project'], ['asset_session='],
    ['asset_session=one', 'asset_session=two'],
    ['asset_session=one', 'asset_session=; Max-Age=0'],
    ['asset_session=private token'], ['asset_session="private-token"'],
    ['asset_session=private,token'], ['asset_session=private\\token'],
    ['asset_session=token\r\nX-Injected: secret'], ['asset_session=中文'],
    [' asset_session=token'], ['asset_session =token'],
    ['asset_session=' + 'x'.repeat(4097)],
  ];
  for (const cookies of invalid) {
    await assert.rejects(loginForPortal(project(), { password }, { request: async () => ({ cookies }) }), error =>
      error instanceof UpstreamError && error.code === 'unauthorized' &&
      error.message === '上游没有返回有效的登录会话');
  }
  const result = await loginForPortal(project(), { password }, {
    request: async () => ({ cookies: ['asset_session=safe-token'] }),
  });
  assert.deepEqual(result, { cookie: { name: 'asset_session', value: 'safe-token', maxAge: 43200 } });
});

test('monitor and standard preflight only their fixed read route with correctly encoded Basic credentials', async () => {
  for (const [adapter, route, username] of [['monitor', '/api/monitors', 'reader'], ['standard', '/api/hub/summary', '']]) {
    const calls = [];
    const source = project(adapter);
    const secret = 'päss:word';
    const before = Date.now();
    const expected = 'Basic ' + Buffer.from(username + ':' + secret).toString('base64');
    const result = await loginForPortal(source, { ...(username ? { username } : {}), password: secret }, {
      request: async (base, requestedRoute, options) => { calls.push({ base, route: requestedRoute, options }); return { data: {} }; },
    });
    assert.deepEqual(result, { authorization: expected });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].base, source.apiUrl);
    assert.equal(calls[0].route, route);
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.body, undefined);
    assert.deepEqual(calls[0].options.headers, { Origin: 'http://127.0.0.1:5678', Authorization: expected });
    assert.ok(calls[0].options.deadline >= before + 10000);
    assert.ok(calls[0].options.deadline <= Date.now() + 10000);
  }
});

test('real upstream authentication failures are sanitized and redirects never produce an authorization result', async t => {
  let mode = 'reject';
  const f = await upstream(t, (_req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { Location: '/secret-redirect' }); res.end(); return; }
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Basic realm="fixture"' });
    res.end(JSON.stringify({ error: 'PRIVATE_UPSTREAM_SECRET' }));
  });
  for (const adapter of ['asset', 'aster', 'monitor', 'standard']) {
    await assert.rejects(loginForPortal(project(adapter, { apiUrl: f.base }), { password }), error =>
      error instanceof UpstreamError && error.code === 'unauthorized' && error.statusCode === 401 &&
      !error.message.includes('PRIVATE_UPSTREAM_SECRET'));
  }
  assert.equal(f.requests.length, 4);
  mode = 'redirect';
  await assert.rejects(loginForPortal(project('asset', { apiUrl: f.base }), { password }), error =>
    error instanceof UpstreamError && error.code === 'invalid' && /重定向/.test(error.message));
  assert.equal(f.requests.length, 5);
  assert.ok(f.requests.every(request => request.path !== '/secret-redirect'));
});

test('expired deadlines and pre-canceled opens never start login requests', async () => {
  let calls = 0;
  const request = async () => { calls++; return { cookies: ['asset_session=late-token'] }; };
  const controller = new AbortController(); controller.abort();
  for (const options of [{ deadline: Date.now() - 1 }, { signal: controller.signal }]) {
    await assert.rejects(loginForPortal(project(), { password }, { ...options, request }), error =>
      error instanceof UpstreamError && error.code === 'timeout');
  }
  assert.equal(calls, 0);
});

test('in-flight cancellation and deadline expiration end an isolated login without a reusable session', async t => {
  let arrived;
  const received = new Promise(resolve => { arrived = resolve; });
  const f = await upstream(t, () => { arrived(); });
  const source = project('asset', { apiUrl: f.base });
  const controller = new AbortController();
  const canceled = loginForPortal(source, { password }, { signal: controller.signal });
  const rejected = assert.rejects(canceled, error => error instanceof UpstreamError && error.code === 'timeout');
  await received;
  controller.abort();
  await rejected;
  await assert.rejects(loginForPortal(source, { password }, { deadline: Date.now() + 100 }), error =>
    error instanceof UpstreamError && error.code === 'timeout');
  assert.ok(f.requests.every(request => request.path === '/api/login'));
  let freshLogin = 0;
  const result = await loginForPortal(source, { password }, { request: async () => {
    freshLogin++; return { cookies: ['asset_session=fresh-after-cancel'] };
  } });
  assert.equal(freshLogin, 1);
  assert.equal(result.cookie.value, 'fresh-after-cancel');
});

test('a canceled caller cannot publish a late injected login response', async () => {
  const controller = new AbortController();
  await assert.rejects(loginForPortal(project(), { password }, {
    signal: controller.signal,
    request: async () => { controller.abort(); return { cookies: ['asset_session=late-token'] }; },
  }), error => error instanceof UpstreamError && error.code === 'timeout');
});
