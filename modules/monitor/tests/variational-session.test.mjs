import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createVariationalSession, openVariationalSessionStore } from '../server/variational-session.mjs';
import { createMonitorServices } from '../server/monitor-services.mjs';
import { createHandler } from '../server/http.mjs';
import { requestVariational, variationalTokenExpiry } from '../lib/variational-api.ts';

const NOW = Date.UTC(2026, 9, 9, 8);
const token = (exp = NOW / 1000 + 7200, id = 'fixture') => `e30.${Buffer.from(JSON.stringify({ exp, id })).toString('base64url')}.testSignature`;
const memory = () => {
  let state = { version: 1, revision: 0, token: '', updatedAt: null };
  return { get: () => structuredClone(state), save: async value => { state = structuredClone(value); } };
};
const confirmed = () => Response.json({ token: token() });

test('token validation rejects cookie/header injection, invalid JWTs and nonnumeric expiration', () => {
  assert.equal(variationalTokenExpiry(token()), NOW + 7200_000);
  for (const value of [null, '', 'vr-token=' + token(), token() + '; second=value', token() + '\r\nX: value', 'x.'.repeat(9000), token('1800000000'), token(null), token(Infinity)]) {
    assert.throws(() => variationalTokenExpiry(value), /格式无效/);
  }
});

test('verification is bounded, fixed-origin, no-redirect and never returns upstream secrets', async () => {
  let calls = 0;
  const candidate = token();
  const fetcher = async (url, init) => {
    calls++;
    assert.equal(url, 'https://omni.variational.io/api/me');
    assert.equal(init.method, 'GET'); assert.equal(init.headers.Cookie, `vr-token=${candidate}`);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    assert.equal(init.body, undefined); assert.ok(init.signal instanceof AbortSignal);
    assert.match(init.headers['User-Agent'], /Chrome\/140/); assert.equal(init.headers.Referer, 'https://omni.variational.io/');
    return confirmed();
  };
  await requestVariational('/me', candidate, { fetcher });
  await assert.rejects(requestVariational('/orders', candidate, { fetcher }));
  assert.equal(calls, 1);
  for (const fetcher of [
    async () => new Response(candidate, { status: 401 }),
    async () => new Response(candidate, { status: 403 }),
    async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid/' } }),
    async () => { throw Error(candidate); },
    async () => new Response(candidate),
    async () => new Response(' '.repeat(2_000_001)),
  ]) {
    await assert.rejects(requestVariational('/me', candidate, { fetcher }), error => !error.message.includes(candidate));
  }
});

test('only explicit venue authentication rejection disables a token; challenges and unknown failures remain retryable', async () => {
  const candidate = token();
  for (const [status, headers, rejected] of [
    [401, { 'Content-Type': 'application/json', 'x-omni-auth': 'r' }, true],
    [401, { 'Content-Type': 'application/json' }, false],
    [403, { 'Content-Type': 'application/json' }, false],
    [403, { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge' }, false],
    [401, { 'Content-Type': 'text/html', 'x-omni-auth': 'r' }, false],
    [200, { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge' }, false],
    [429, { 'Content-Type': 'application/json' }, false],
    [503, { 'Content-Type': 'application/json' }, false],
  ]) {
    await assert.rejects(requestVariational('/me', candidate, { fetcher: async () => new Response(candidate, { status, headers }) }), error => {
      assert.equal(error.rejected, rejected); assert.equal(error.status, rejected ? 400 : 502);
      assert.equal(error.message.includes(candidate), false);
      return true;
    });
  }
});

test('validated rotations persist privately across restart and GET contains no token or account data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'var-session-'));
  try {
    const store = await openVariationalSessionStore(directory);
    assert.deepEqual(await readdir(directory), []);
    const session = createVariationalSession(store, { clock: () => NOW, fetcher: confirmed });
    assert.equal(session.view().status, 'missing');
    const candidate = token();
    const result = await session.update({ revision: 0, token: ` ${candidate} ` });
    assert.equal(result.revision, 1); assert.equal(result.status, 'ready'); assert.equal(result.configured, true);
    assert.equal(JSON.stringify(result).includes(candidate), false);
    assert.deepEqual(Object.keys(result).sort(), ['available', 'configured', 'revision', 'expiresAt', 'updatedAt', 'status', 'error'].sort());
    assert.equal(session.current().token, candidate);
    const reopened = createVariationalSession(await openVariationalSessionStore(directory), { clock: () => NOW });
    assert.equal(reopened.current().token, candidate); assert.equal(reopened.view().revision, 1);
    assert.deepEqual(await readdir(directory), ['variational-session.json']);
    if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'variational-session.json'))).mode & 0o777, 0o600);
    const expired = createVariationalSession(store, { clock: () => NOW + 7200_000 });
    assert.equal(expired.view().status, 'expired'); assert.equal(expired.current().token, null); assert.equal(expired.current().status, 'expired');
    await writeFile(join(directory, 'variational-session.json'), '{invalid');
    await assert.rejects(openVariationalSessionStore(directory), /无法读取/);
    assert.equal(await readFile(join(directory, 'variational-session.json'), 'utf8'), '{invalid');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bad candidate, unconfirmed login and storage failure leave working session intact', async () => {
  const store = memory(); let now = NOW, upstream = confirmed;
  const session = createVariationalSession(store, { clock: () => now, fetcher: (...args) => upstream(...args) });
  const previous = await session.update({ revision: 0, token: token() });
  for (const candidate of [token(NOW / 1000 - 1), token(NOW / 1000 + 30), 'Cookie: vr-token=x', undefined]) {
    await assert.rejects(session.update({ revision: 1, token: candidate }));
    assert.deepEqual(session.view(), previous);
  }
  for (const response of [() => new Response('secret body', { status: 401 }), () => new Response('private challenge', { status: 403, headers: { 'cf-mitigated': 'challenge', 'Content-Type': 'text/html' } }), () => new Response(null, { status: 503 }), () => Response.json({ token: '' }), () => Response.json({ user: 'anonymous' }), () => Response.json({ token: token(NOW / 1000 - 10) })]) {
    now += 3001; upstream = response;
    await assert.rejects(session.update({ revision: 1, token: token(NOW / 1000 + 9000, 'replacement') }));
    assert.deepEqual(session.view(), previous);
  }
  now += 3001; upstream = confirmed;
  store.save = async () => { throw Error('private-path and secret'); };
  await assert.rejects(session.update({ revision: 1, token: token(NOW / 1000 + 9000) }), error => error.status === 503 && !error.message.includes('private-path'));
  assert.equal(session.current().token, token()); assert.deepEqual(session.view(), previous);
});

test('concurrent updates reject stale revision; validation throttles; stale reports cannot affect replacement', async () => {
  let now = NOW, calls = 0;
  const session = createVariationalSession(memory(), { clock: () => now, fetcher: () => { calls++; return confirmed(); } });
  const results = await Promise.allSettled([session.update({ revision: 0, token: token() }), session.update({ revision: 0, token: token() })]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.status, 409); assert.equal(calls, 1);
  await assert.rejects(session.update({ revision: 1, token: token() }), { status: 429 });
  session.report(1, 'rejected'); assert.equal(session.current().token, null); assert.equal(session.view().status, 'rejected'); assert.equal(session.current().status, 'rejected');
  now += 3001;
  await session.update({ revision: 1, token: token(NOW / 1000 + 10_000) });
  session.report(1, 'rejected'); assert.equal(session.view().status, 'ready');
  session.report(2, 'unavailable'); assert.equal(session.view().status, 'unavailable'); assert.ok(session.current().token);
  session.report(2, 'ready'); assert.equal(session.view().status, 'ready');
  await assert.rejects(session.update({ revision: 2, token: token(), url: 'https://elsewhere.invalid/' }));
});

test('resident oil session API authenticates, rejects cross-site writes, and uses the protected store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'var-session-http-'));
  let calls = 0, services, server;
  try {
    services = await createMonitorServices(directory, { marketOptions: { jobs: [] }, variationalSessionOptions: { clock: () => NOW, fetcher: () => { calls++; return confirmed(); } } });
    server = createServer(createHandler({ services, username: 'admin', password: 'fixture-password', nextHandler: (_req, res) => res.writeHead(404).end() }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, path = `${origin}/api/monitors/oil/exchanges/variational/session`;
    const headers = { Authorization: `Basic ${Buffer.from('admin:fixture-password').toString('base64')}`, 'Content-Type': 'application/json', Origin: origin };
    const input = { revision: 0, token: token() }, put = { method: 'PUT', headers, body: JSON.stringify(input) };
    assert.equal((await fetch(path)).status, 401);
    assert.equal((await fetch(path, { ...put, headers: { 'Content-Type': 'application/json' } })).status, 401);
    assert.equal((await fetch(path, { ...put, headers: { ...headers, Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await fetch(path, { ...put, headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(path, { ...put, headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await fetch(path, { method: 'DELETE', headers })).status, 405);
    const initial = await fetch(path, { headers });
    assert.equal(initial.headers.get('cache-control'), 'no-store'); assert.equal((await initial.json()).configured, false); assert.equal(calls, 0);
    const saved = await fetch(path, put), text = await saved.text();
    assert.equal(saved.status, 200); assert.equal(JSON.parse(text).revision, 1); assert.equal(text.includes(token()), false); assert.equal(calls, 1);
    assert.equal((await fetch(path, put)).status, 409); assert.equal(calls, 1);
    assert.equal((await fetch(path.replace('/oil/', '/hynix/'), { headers })).status, 404);
    assert.equal((await fetch(path, { headers })).status, 200); assert.equal(calls, 1, 'GET does not validate or fetch upstream');
    assert.equal(JSON.parse(await readFile(join(directory, 'variational-session.json'), 'utf8')).token, token());
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (services) { await Promise.all([...services.values()].map(service => service.stop())); await services.market.stop(); await services.notifications.stop(); }
    await rm(directory, { recursive: true, force: true });
  }
});
