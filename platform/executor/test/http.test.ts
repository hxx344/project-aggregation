import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createExecutorServer } from '../src/http.ts';
import { assertDedicatedDataDir } from '../src/main.ts';
import { bindAccounts, createHarness, openIntent, settle } from './harness.ts';

const SESSION = 'http-session-token-0001';

async function withServer(run: (base: string, cookie: string, h: ReturnType<typeof createHarness>) => Promise<void>) {
  const h = createHarness();
  bindAccounts(h.ex);
  const server = createExecutorServer({ executor: h.ex, session: SESSION });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await run(base, `pa_executor_session=${SESSION}`, h); }
  finally { await new Promise(resolve => server.close(resolve)); h.dispose(); }
}
const post = (base: string, path: string, body: unknown, headers: Record<string, string>) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pa-executor': '1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('HTTP：页面下发仅本站可用的会话 cookie；无 cookie、缺请求标记、非本机 Host 均被拒绝', () => withServer(async (base, cookie) => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
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
