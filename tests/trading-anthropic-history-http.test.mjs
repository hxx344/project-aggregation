import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';

const TIME = Date.UTC(2026, 10, 7, 8), PASSWORD = 'native-history-http-fixture';
const OWNER = '0x' + 'ab'.repeat(20), PREFIX = '/api/trading/execution';
const ROUTE = '/api/trading/fills?market=anthropic';
const nativeScope = response => response.data.sources.find(source => source.projectId === 'anthropic-history').data.exchanges.find(row => row.id === 'rh-lighter').accounts[0].scopes[0];

test('real fills HTTP entry appends bounded native history asynchronously and rejects unauthenticated or mutation requests', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hub-native-history-http-'));
  let session = null, release, reads = 0, time = TIME;
  const calls = [];
  const app = await createApp({ dataDir, initialPassword: PASSWORD, refreshInterval: 0, assetSyncIntervalMs: 0,
    tradingRefreshIntervalMs: 0, executionIntervalMs: 0, executionNow: () => time, tradingNow: () => time,
    executionClientFactory: exchange => ({
      verify: async () => ({ identity: OWNER, keyLabel: '12345#5' }),
      account: async () => ({ identity: OWNER, modes: { ANTHROPIC: 'one-way' }, positions: [], openOrders: [], strategies: [], leverage: { ANTHROPIC: { type: 'cross', value: 10 } } }),
      history: async (_credentials, options) => { reads++; calls.push({ exchange, options }); return new Promise(resolve => { release = resolve; }); },
      create: async () => { assert.fail('history must not create orders'); }, stop: async () => { assert.fail('history must not cancel orders'); },
    }), secureCookies: false, publicOrigin: '', logger: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    const target = path.resolve(dataDir);
    assert.equal(path.dirname(target), path.resolve(tmpdir())); assert.ok(path.basename(target).startsWith('hub-native-history-http-'));
    await rm(target, { recursive: true, force: true });
  });
  async function request(route, method = 'GET', body) {
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(2000), headers: {
      ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), Origin: origin,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  assert.equal((await request(ROUTE)).status, 401); assert.equal(reads, 0);
  const login = await request('/api/login', 'POST', { password: PASSWORD }); assert.equal(login.status, 200);
  session = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.data.csrfToken };
  assert.equal((await request(ROUTE, 'POST', {})).status, 405); assert.equal(reads, 0);
  for (const market of ['oil', 'hynix']) assert.ok((await request('/api/trading/fills?market=' + market)).data.sources.every(source => source.projectId !== 'anthropic-history'));
  assert.equal(nativeScope(await request(ROUTE)).status, 'unconfigured'); assert.equal(reads, 0);
  const connected = await request(`${PREFIX}/accounts/rh-lighter`, 'PUT', { revision: 0, accountMode: 'api-key', address: OWNER,
    accountIndex: 12345, apiKeyIndex: 5, apiKey: 'ab'.repeat(40) });
  assert.equal(connected.status, 200, JSON.stringify(connected.data));
  const loading = await request(ROUTE);
  assert.equal(loading.status, 200); assert.equal(nativeScope(loading).status, 'loading'); assert.equal(loading.data.pending, true);
  assert.equal(reads, 1); await request(ROUTE); assert.equal(reads, 1);
  const fill = { id: 'native-manual', base: 'ANTHROPIC', symbol: 'ANTHROPIC', time: new Date(TIME - 1000).toISOString(), side: 'buy', positionSide: 'net',
    quantity: '1', quantityUnit: 'ANTHROPIC', price: '100', priceCurrency: 'USDG', fee: null, feeCurrency: null, realizedPnl: null, positionBefore: '0', positionAfter: '1' };
  const data = { accountId: '12345', fills: [fill], coverageStart: new Date(TIME - 1000).toISOString(), coverageEnd: new Date(TIME).toISOString(), truncated: false };
  release(data); await new Promise(resolve => setImmediate(resolve));
  const live = await request(ROUTE); assert.equal(nativeScope(live).status, 'live'); assert.deepEqual(nativeScope(live).fills, [fill]);
  assert.equal(JSON.stringify(live.data).includes(OWNER), false);
  for (let i = 0; i < 10; i += 1) { time += 30_000; await app.execution.tick(); }
  await request(ROUTE); assert.equal(reads, 2);
  assert.equal((await request(`${PREFIX}/accounts/rh-lighter`, 'DELETE', { revision: 1 })).status, 200);
  release(data); await new Promise(resolve => setImmediate(resolve));
  const disconnected = nativeScope(await request(ROUTE)); assert.equal(disconnected.status, 'unconfigured'); assert.equal(disconnected.fills.length, 0);
  assert.equal(reads, 2); assert.equal(calls.at(-1).options.signal.aborted, true);
});
