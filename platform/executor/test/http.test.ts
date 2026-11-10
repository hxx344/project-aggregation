import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createExecutorServer, sessionCookieName } from '../src/http.ts';
import { assertDedicatedDataDir, writeAccessUrl } from '../src/main.ts';
import { bindAccounts, createHarness, openIntent, settle } from './harness.ts';

const TOKEN = 'http-access-token-0001';
const SESSION = 'http-session-value-0001';

async function startServer(h: ReturnType<typeof createHarness>, accessToken = TOKEN, session = SESSION) {
  const server = createExecutorServer({ executor: h.ex, accessToken, session });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port, base: `http://127.0.0.1:${port}` };
}
/** Logs in through /login and returns the cookie pair the browser would send back. */
async function login(base: string, token = TOKEN): Promise<string> {
  const response = await fetch(`${base}/login?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  assert.equal(response.status, 303);
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}
async function withServer(run: (base: string, cookie: string, h: ReturnType<typeof createHarness>) => Promise<void>) {
  const h = createHarness();
  bindAccounts(h.ex);
  const { server, base } = await startServer(h);
  try { await run(base, await login(base), h); }
  finally { await new Promise(resolve => server.close(resolve)); h.dispose(); }
}
const post = (base: string, path: string, body: unknown, headers: Record<string, string>) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pa-executor': '1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('HTTP：无会话的页面请求返回 401 且不下发 cookie；错误或缺失令牌 401 且不回显', () => withServer(async base => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 401);
  assert.equal(page.headers.get('set-cookie'), null);
  assert.match(await page.text(), /access-url/);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  for (const path of ['/login', '/login?token=', '/login?token=wrong-guess-XYZ', `/login?token=${TOKEN}x`, `/login?token=${SESSION}`]) {
    const response = await fetch(base + path, { redirect: 'manual' });
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get('set-cookie'), null, path);
    assert.doesNotMatch(await response.text(), /wrong-guess|http-access|http-session/, path);
  }
  assert.equal((await fetch(base + '/', { headers: { cookie: `${sessionCookieName(Number(new URL(base).port))}=${TOKEN}` } })).status, 401, '令牌本身不是会话值');
}));

test('HTTP：正确令牌 303 下发按端口命名的会话 cookie；登录后可打开页面；缺请求标记、非本机 Host 均被拒绝', () => withServer(async (base, cookie) => {
  const port = Number(new URL(base).port);
  const loginResponse = await fetch(`${base}/login?token=${TOKEN}`, { redirect: 'manual' });
  assert.equal(loginResponse.status, 303);
  assert.equal(loginResponse.headers.get('location'), '/');
  assert.equal(loginResponse.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(loginResponse.headers.get('cache-control'), 'no-store');
  const setCookie = loginResponse.headers.get('set-cookie') ?? '';
  assert.ok(setCookie.startsWith(`pa_executor_session_${port}=${SESSION};`), setCookie);
  assert.match(setCookie, /; HttpOnly; SameSite=Strict; Path=\//);
  assert.doesNotMatch(setCookie, new RegExp(TOKEN));
  assert.equal(cookie, `pa_executor_session_${port}=${SESSION}`);
  const page = await fetch(base + '/', { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('set-cookie'), null);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(base + '/api/state', { headers: { cookie: `pa_executor_session=${SESSION}` } })).status, 401, '不带端口的旧名称不再通用');
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/preview', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/preview', { method: 'POST', headers: { cookie, 'x-pa-executor': '1', 'content-type': 'text/plain' }, body: '{}' })).status, 403);
  const status = await new Promise<number>((resolve, fail) => {
    const url = new URL(base);
    const req = httpRequest({ host: url.hostname, port: url.port, path: '/api/state', headers: { host: 'evil.example', cookie } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', fail); req.end();
  });
  assert.equal(status, 421);
  assert.equal((await post(base, '/api/preview', 'x'.repeat(17 * 1024), { cookie })).status, 413);
  assert.equal((await post(base, '/api/preview', '{bad', { cookie })).status, 400);
}));

test('HTTP：预览、确认、重复确认返回原任务；状态页只显示脱敏账户；ANT 仅 Binance 可读', () => withServer(async (base, cookie, h) => {
  const previewText = await (await post(base, '/api/preview', openIntent(), { cookie })).text();
  assert.doesNotMatch(previewText, /BN1001|BY2002|accountKey/);
  const preview = JSON.parse(previewText) as { id: string; legs: { accountId: string }[] };
  assert.ok(preview.legs.every(leg => leg.accountId.startsWith('***')));
  const body = { previewId: preview.id, requestId: randomUUID(), confirmLive: true };
  const first = await (await post(base, '/api/confirm', body, { cookie })).json() as { job: { id: string }; duplicate: boolean };
  const again = await (await post(base, '/api/confirm', body, { cookie })).json() as { job: { id: string }; duplicate: boolean };
  assert.equal(again.duplicate, true);
  assert.equal(again.job.id, first.job.id);
  await settle(h, first.job.id);
  const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json() as { jobs: { id: string; status: string }[]; accounts: { accountId: string }[] };
  assert.equal(state.jobs[0].status, 'completed');
  assert.ok(state.accounts.every(account => account.accountId.startsWith('***')));
  assert.doesNotMatch(JSON.stringify(state), /BN1001|BY2002/);
  assert.equal((await fetch(base + '/api/observe?venue=bybit&symbol=ANTHROPICUSDT', { headers: { cookie } })).status, 400);
  assert.equal((await fetch(base + '/api/observe?venue=binance&symbol=ANTHROPICUSDT', { headers: { cookie } })).status, 200);
  const stale = await post(base, '/api/confirm', { ...body, requestId: randomUUID() }, { cookie });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, 'preview_invalid');
}));

test('入口：拒绝相对路径与工作台数据目录', () => {
  const h = createHarness();
  try {
    assert.throws(() => assertDedicatedDataDir('relative/dir'), /绝对路径/);
    const legacy = join(h.dir, 'legacy');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'hub.sqlite'), '');
    assert.throws(() => assertDedicatedDataDir(legacy), /hub\.sqlite/);
    assert.throws(() => assertDedicatedDataDir(join(legacy, 'executor')), /hub\.sqlite/, '工作台数据目录的子目录也拒绝');
    assert.throws(() => assertDedicatedDataDir(join(legacy, 'a', 'b')), /hub\.sqlite/);
    const upper = join(h.dir, 'upper');
    mkdirSync(upper);
    writeFileSync(join(upper, 'Credentials.KEY'), '');
    assert.throws(() => assertDedicatedDataDir(upper), /Credentials\.KEY/, '名称不区分大小写');
    assert.equal(assertDedicatedDataDir(join(h.dir, 'fresh')), join(h.dir, 'fresh'));
  } finally { h.dispose(); }
});

test('HTTP：不同端口的实例 cookie 名不同，会话互不通用', async () => {
  const a = createHarness(), b = createHarness();
  bindAccounts(a.ex); bindAccounts(b.ex);
  const one = await startServer(a, 'token-instance-a', 'session-instance-a');
  const two = await startServer(b, 'token-instance-b', 'session-instance-b');
  try {
    const cookieA = await login(one.base, 'token-instance-a'), cookieB = await login(two.base, 'token-instance-b');
    assert.notEqual(cookieA.split('=')[0], cookieB.split('=')[0]);
    assert.equal(cookieA.split('=')[0], sessionCookieName(one.port));
    assert.equal((await fetch(one.base + '/api/state', { headers: { cookie: cookieA } })).status, 200);
    assert.equal((await fetch(two.base + '/api/state', { headers: { cookie: cookieA } })).status, 401);
    assert.equal((await fetch(two.base + '/', { headers: { cookie: cookieA } })).status, 401);
    assert.equal((await fetch(two.base + '/api/state', { headers: { cookie: `${sessionCookieName(two.port)}=session-instance-a` } })).status, 401);
    assert.equal((await fetch(`${two.base}/login?token=token-instance-a`, { redirect: 'manual' })).status, 401);
    assert.equal((await fetch(two.base + '/api/state', { headers: { cookie: `${cookieA}; ${cookieB}` } })).status, 200, '同一浏览器同时持有两个实例的 cookie 时各取各的');
  } finally {
    await new Promise(resolve => one.server.close(resolve)); await new Promise(resolve => two.server.close(resolve));
    a.dispose(); b.dispose();
  }
});

test('HTTP：会话值不能与访问令牌相同，访问令牌不能为空', () => {
  const h = createHarness();
  try {
    assert.throws(() => createExecutorServer({ executor: h.ex, accessToken: 'same-value', session: 'same-value' }), /不能与访问令牌相同/);
    assert.throws(() => createExecutorServer({ executor: h.ex, accessToken: '' }), /访问令牌/);
  } finally { h.dispose(); }
});

test('入口：登录链接写入 access-url，覆盖旧文件、不留临时文件、不经 stdout/stderr', () => {
  const h = createHarness();
  const dir = join(h.dir, 'data');
  mkdirSync(dir);
  writeFileSync(join(dir, 'access-url'), 'stale');
  const written: string[] = [];
  const out = process.stdout.write, err = process.stderr.write;
  const capture = ((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stdout.write = capture; process.stderr.write = capture;
  let path: string;
  try { path = writeAccessUrl(dir, 4711, 'tok_ABC-123'); }
  finally { process.stdout.write = out; process.stderr.write = err; }
  try {
    assert.equal(path, join(dir, 'access-url'));
    assert.equal(readFileSync(path, 'utf8'), 'http://127.0.0.1:4711/login?token=tok_ABC-123\n');
    assert.deepEqual(written, []);
    assert.deepEqual(readdirSync(dir), ['access-url']);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    writeAccessUrl(dir, 4711, 'tok_second');
    assert.equal(readFileSync(path, 'utf8'), 'http://127.0.0.1:4711/login?token=tok_second\n');
  } finally { h.dispose(); }
});
