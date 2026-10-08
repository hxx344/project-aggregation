import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validateUrl, blockedAddress, loopbackAddress, standardSummary, requestJson, requestAuthenticatedJson, readSummary, normalizeMonitorQuote, UpstreamError } from '../server/adapters.mjs';

test('URL validation allows intentional private services and blocks metadata addresses', () => {
  assert.equal(validateUrl('http://127.0.0.1:3000/?monitor=oil'), 'http://127.0.0.1:3000/?monitor=oil');
  assert.equal(validateUrl('http://10.0.0.5:3100/', { api: true }), 'http://10.0.0.5:3100');
  for (const value of ['http://169.254.169.254', 'http://[fe80::1]', 'http://[::ffff:a9fe:a9fe]', 'http://0xA9FEA9FE', 'http://metadata.google.internal']) assert.throws(() => validateUrl(value));
  assert.equal(blockedAddress('::ffff:169.254.1.1'), true);
});

test('credential imports require TLS or a pinned loopback destination before sending a request', async t => {
  for (const address of ['127.0.0.1', '127.2.3.4', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1']) assert.equal(loopbackAddress(address), true, address);
  for (const address of ['10.0.0.1', '192.168.1.2', '8.8.8.8', '::ffff:c0a8:102', '::2', 'localhost', 'invalid']) assert.equal(loopbackAddress(address), false, address);
  let calls = 0;
  const server = http.createServer((_req, res) => { calls++; res.end('{"ok":true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  assert.deepEqual((await requestJson(`http://127.0.0.1:${server.address().port}`, '/', { deadline: Date.now() + 1000, requireSecureTransport: true })).data, { ok: true });
  assert.equal(calls, 1);
  for (const base of ['http://10.0.0.1', 'http://192.168.1.2', 'http://[::ffff:a00:1]']) await assert.rejects(requestJson(base, '/api/login', { method: 'POST', body: { password: 'fixture_password' }, deadline: Date.now() + 1000, requireSecureTransport: true }), error => error.code === 'insecure_transport');
});

test('sensitive authentication does not reuse a default login flight or its transport', async () => {
  const project = { adapter: 'asset', apiUrl: 'http://127.0.0.1:19981' }, credentials = { password: 'fixture_scoped_password' };
  const calls = [];
  const request = scope => async (_base, path) => { calls.push([scope, path]); return path === '/api/login' ? { cookies: [`asset_session=${scope}; Path=/`], data: {} } : { data: { scope } }; };
  await Promise.all([
    requestAuthenticatedJson(project, credentials, '/ordinary', { request: request('ordinary') }),
    requestAuthenticatedJson(project, credentials, '/sensitive', { request: request('sensitive'), sessionScope: 'trading-import' }),
  ]);
  assert.equal(calls.filter(([scope, path]) => scope === 'sensitive' && path === '/api/login').length, 1);
  assert.equal(calls.filter(([scope, path]) => scope === 'ordinary' && path === '/api/login').length, 1);
});

test('standard protocol validates finite metrics, timestamps, limits and unknown fields', () => {
  const data = { updatedAt: new Date().toISOString(), metrics: [{ key: 'count', label: '数量', value: 2, unit: '个' }], trend: [{ at: new Date().toISOString(), value: 2 }] };
  assert.equal(standardSummary({ schemaVersion: 1, data }).metrics[0].value, 2);
  for (const raw of [{ schemaVersion: 2, data }, { schemaVersion: 1, data: { ...data, updatedAt: 'not-a-date' } }, { schemaVersion: 1, data: { ...data, secret: 'leak' } }, { schemaVersion: 1, data: { ...data, metrics: [{ ...data.metrics[0], value: Infinity }] } }, { schemaVersion: 1, data: { ...data, metrics: Array(25).fill(data.metrics[0]) } }, { schemaVersion: 1, data: { ...data, metrics: [{ ...data.metrics[0], password: 'no' }] } }]) assert.throws(() => standardSummary(raw));
});

test('upstream transport enforces deadline, redirect prohibition, body cap and sanitized errors', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254' }); res.end(); }
    else if (req.url === '/large') { res.writeHead(200); res.end(JSON.stringify({ data: 'x'.repeat(2048) })); }
    else if (req.url === '/private') { res.writeHead(401); res.end('secret-upstream-password'); }
    else if (req.url === '/slow') { const timer = setTimeout(() => res.end('{}'), 500); res.on('close', () => clearTimeout(timer)); }
    else { res.writeHead(200); res.end('{"ok":true}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await requestJson(base, '/ok', { deadline: Date.now() + 1000 })).data, { ok: true });
  await assert.rejects(requestJson(base, '/redirect', { deadline: Date.now() + 1000 }), /重定向/);
  await assert.rejects(requestJson(base, '/large', { deadline: Date.now() + 1000, limit: 1024 }), /大小限制/);
  await assert.rejects(requestJson(base, '/private', { deadline: Date.now() + 1000 }), error => error.code === 'unauthorized' && error.statusCode === 401 && !error.message.includes('secret'));
  const start = Date.now(); await assert.rejects(requestJson(base, '/slow', { deadline: start + 60 }), /超时/); assert.ok(Date.now() - start < 450);
});

test('asset adapter uses cookie login, keeps USD totals separate from withdrawn and ignores extra accounts', async () => {
  const calls = []; const at = new Date().toISOString();
  const result = await readLegacySummary({ adapter: 'asset', apiUrl: 'http://127.0.0.1:5678' }, { password: 'mock-password' }, { request: async (base, route, options) => {
    calls.push({ base, route, options });
    if (route === '/api/login') return { data: { ok: true }, cookies: ['asset_session=mock-cookie; Path=/; HttpOnly'] };
    return { data: { dataKind: 'personal', assets: [{ id: 'exchange', project: '持仓', mode: 'bybit', status: '只读同步', value: 100, updatedAt: at }, { id: 'withdrawn', project: '出金', mode: 'manual', status: '手工录入', value: 20, updatedAt: at }], asterAccounts: [{ equity: 1000 }], history: [{ id: 'old', date: '2025-01-01', total: 5 }, { id: 'daily-x', date: '2025-01-01', total: 10 }, { id: 'late', date: '2025-01-01', total: 15 }, { id: 'future', date: '2030-01-01', total: 200, future: true }], fx: 7, fxStatus: { rateDate: '2025-01-01' } } };
  } });
  assert.equal(calls[0].options.headers.Origin, 'http://127.0.0.1:5678'); assert.equal(calls[1].options.headers.Cookie, 'asset_session=mock-cookie');
  assert.equal(result.metrics.find(item => item.key === 'ledger_total').value, 120); assert.equal(result.metrics.find(item => item.key === 'holdings').value, 100); assert.equal(result.trend.length, 1); assert.equal(result.trend[0].value, 10);
});

test('aster adapter uses snapshot timestamps, leaves missing values null and reports USD1 units', async () => {
  const result = await readLegacySummary({ adapter: 'aster', apiUrl: 'http://127.0.0.1:8765' }, null, { request: async () => ({ data: { ready: true, updated_at: Date.now() / 1000, accounts: [{ enabled: true, mode: 'live', snapshot: { occupied_margin: '12.3', timestamp: 1600000000 }, cycle_state: { daily_volume: { volume: null } } }] } }) });
  assert.equal(result.updatedAt, new Date(1600000000000).toISOString()); assert.equal(result.metrics.find(item => item.key === 'occupied_margin').unit, 'USD1'); assert.equal(result.metrics.find(item => item.key === 'daily_volume').value, null);
});

test('legacy ASTER describes each missing source and report failure without extra requests', async () => {
  const utcDate = new Date().toISOString().slice(0, 10);
  const healthy = { name: '账户 A', enabled: true, mode: 'live', snapshot: { timestamp: Date.now() / 1000, occupied_margin: '12.3' }, cycle_state: { daily_volume: { utc_date: utcDate, volume: '42' }, report_status: { status: 'ready' } } };
  const read = async data => {
    const calls = [];
    const result = await readLegacySummary({ adapter: 'aster', apiUrl: 'http://127.0.0.1:8765' }, null, { request: async (_base, route) => { calls.push(route); return { data }; } });
    assert.deepEqual(calls, ['/api/state?compact=true']); return result;
  };
  assert.equal((await read({ ready: true, accounts: [healthy] })).partial, false);
  const cases = [
    [{ ...healthy, snapshot: null }, /账户 A：缺少账户快照/],
    [{ ...healthy, snapshot: { timestamp: null, occupied_margin: null } }, /账户 A：快照缺少有效更新时间.*账户 A：保证金数据缺失或无效/],
    [{ ...healthy, cycle_state: {} }, /账户 A：成交统计尚未就绪/],
    [{ ...healthy, cycle_state: { report_status: { status: 'error', error: '统计缓存读取失败' } } }, /账户 A：成交统计读取失败：统计缓存读取失败/],
    [{ ...healthy, cycle_state: { report_status: { status: 'stale' } } }, /账户 A：成交统计已过期/],
    [{ ...healthy, cycle_state: { ...healthy.cycle_state, daily_volume: { utc_date: '2000-01-01', volume: 42 } } }, /账户 A：成交统计缺少当日 UTC 数据/],
    [{ ...healthy, cycle_state: { ...healthy.cycle_state, daily_volume: { utc_date: utcDate, volume: null } } }, /账户 A：今日成交量缺失或无效/],
  ];
  for (const [account, expected] of cases) {
    const result = await read({ ready: true, accounts: [account] }); assert.equal(result.partial, true); assert.match(result.message, expected);
  }
  const failed = await read({ ready: false, error: '交易规则加载失败', accounts: [healthy] });
  assert.match(failed.message, /交易服务异常：交易规则加载失败.*交易服务尚未就绪/);
  const noLive = await read({ ready: true, accounts: [{ ...healthy, enabled: false, snapshot: null }, { ...healthy, mode: 'paper', snapshot: null }] });
  assert.equal(noLive.partial, false); assert.equal(noLive.metrics.find(item => item.key === 'occupied_margin').value, null);
  const many = await read({ ready: true, accounts: Array.from({ length: 200 }, (_, i) => ({ ...healthy, name: `账户 ${i}`, snapshot: null })) });
  assert.ok(many.message.length <= 500); assert.match(many.message, /另有 \d+ 项异常/);
  const objectError = await read({ ready: false, error: { secret: 'never-serialize' }, accounts: [] });
  assert.match(objectError.message, /上游未提供具体原因/); assert.ok(!objectError.message.includes('never-serialize'));
});

function pairedAsterFixture() {
  const now = Date.now() / 1000;
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const data = { ready: true, accounts: ['long', 'short'].map(id => ({ id, name: id, enabled: false, mode: 'live',
    cycle_state: { daily_volume: { utc_date: day, volume: '999999' }, report_status: { status: 'ready' } } })),
    pairs: [{ id: 'gold', enabled: true, long_account_id: 'long', short_account_id: 'short', state: {
      updated_at: now, snapshots: { long: { timestamp: now - 10, occupied_margin: '12.5' }, short: { timestamp: now - 5, occupied_margin: '7.5' } },
      daily_volume: { [day]: { long: '100', short: '120' } }, pending: null,
    } }] };
  const read = async () => {
    const calls = [];
    const result = await readLegacySummary({ adapter: 'aster', apiUrl: 'http://127.0.0.1:8765' }, null, { request: async (_base, route) => { calls.push(route); return { data }; } });
    assert.deepEqual(calls, ['/api/state?compact=true']);
    return { ...result, values: Object.fromEntries(result.metrics.map(item => [item.key, item.value])) };
  };
  return { data, state: data.pairs[0].state, now, day, read };
}

test('legacy ASTER counts enabled pair members and reads their own snapshots and confirmed volume', async () => {
  const f = pairedAsterFixture();
  const result = await f.read();
  assert.deepEqual(result.values, { accounts: 2, live_accounts: 2, occupied_margin: 20, daily_volume: 220 });
  assert.equal(result.partial, false);
  assert.equal(result.updatedAt, new Date((f.now - 10) * 1000).toISOString());
  f.data.accounts[0].enabled = true; // Union membership never counts one account twice.
  f.data.accounts.push({ id: 'single', enabled: true, mode: 'live', snapshot: { timestamp: f.now, occupied_margin: '2' },
    cycle_state: { daily_volume: { utc_date: f.day, volume: '30' }, report_status: { status: 'ready' } } });
  assert.deepEqual((await f.read()).values, { accounts: 3, live_accounts: 3, occupied_margin: 22, daily_volume: 250 });
});

test('legacy ASTER excludes paused pair members and paper pairs from live totals', async () => {
  const f = pairedAsterFixture();
  f.data.pairs[0].enabled = false;
  assert.deepEqual((await f.read()).values, { accounts: 0, live_accounts: 0, occupied_margin: null, daily_volume: null });
  f.data.pairs[0].enabled = true;
  f.data.accounts.forEach(account => { account.mode = 'paper'; });
  assert.deepEqual((await f.read()).values, { accounts: 2, live_accounts: 0, occupied_margin: null, daily_volume: null });
});

test('legacy ASTER pair freshness comes from all member snapshots, never the response time', async () => {
  const f = pairedAsterFixture();
  f.data.updated_at = f.now;
  f.data.accounts[0].snapshot = { timestamp: f.now - 2, occupied_margin: '15' };
  let result = await f.read();
  assert.equal(result.updatedAt, new Date((f.now - 5) * 1000).toISOString());
  assert.equal(result.values.occupied_margin, 22.5);
  f.state.snapshots.short.timestamp = f.now + 3600;
  result = await f.read();
  assert.equal(result.updatedAt, null); assert.equal(result.partial, true);
  assert.equal(result.values.occupied_margin, null);
  f.state.snapshots.short.timestamp = f.now - 121;
  assert.equal((await f.read()).updatedAt, new Date((f.now - 121) * 1000).toISOString());
});

test('legacy ASTER distinguishes confirmed zero pair volume from missing or uncertain data', async t => {
  const f = pairedAsterFixture();
  f.state.daily_volume = {};
  assert.equal((await f.read()).values.daily_volume, 0);
  const cases = [
    [{ updated_at: null }, /运行记录缺少有效更新时间/],
    [{ updated_at: f.now + 3600 }, /运行记录缺少有效更新时间/],
    [{ updated_at: f.now - 120 }, /运行记录已过期/],
    [{ daily_volume: null }, /今日成交量缺失或无效/],
    [{ daily_volume: { [f.day]: { long: '100' } } }, /今日成交量缺失或无效/],
    [{ daily_volume: { [f.day]: { long: '-1', short: '0' } } }, /今日成交量缺失或无效/],
    [{ daily_volume: { [f.day]: { long: false, short: '0' } } }, /今日成交量缺失或无效/],
    [{ volume_unknown: true }, /成交时间或金额尚未核实/],
    [{ volume_unknown: true, volume_unknown_until_utc: f.day }, /成交时间或金额尚未核实/],
    [{ volume_unknown: true, volume_unknown_until_utc: '2000-99-00' }, /未知日期无效/],
    [{ pending: { kind: 'cycle' } }, /订单尚待核对/],
    [{ recovery_watch: { batches: ['old'] } }, /订单尚待核对/],
  ];
  for (const [changes, reason] of cases) await t.test(JSON.stringify(changes), async () => {
    const current = pairedAsterFixture(); Object.assign(current.state, changes);
    const result = await current.read();
    assert.equal(result.values.daily_volume, null); assert.equal(result.partial, true); assert.match(result.message, reason);
  });
  f.state.volume_unknown = true; f.state.volume_unknown_until_utc = '2000-01-01';
  assert.equal((await f.read()).values.daily_volume, 0);
  f.data.pairs[0].state = undefined;
  assert.equal((await f.read()).values.daily_volume, null);
});

test('legacy ASTER keeps confirmed volume during normal submissions and leverage changes', async () => {
  const f = pairedAsterFixture();
  f.state.phase = 'submitting';
  f.state.pending = { kind: 'cycle', phase: 'open', legs: [{ receipt: null, dispatch: 'sending' }, { receipt: { status: 'FILLED' } }], repairs: [] };
  let result = await f.read();
  assert.equal(result.partial, false); assert.equal(result.values.daily_volume, 220);
  assert.match(result.metrics.find(metric => metric.key === 'daily_volume').detail, /配对仅统计已核对成交/);
  for (const phase of ['attention', 'reconciling', 'repairing']) {
    f.state.phase = phase;
    assert.equal((await f.read()).values.daily_volume, null);
  }
  f.state.phase = 'submitting'; f.state.pending.legs[0].submit_evidence = 'ambiguous';
  assert.equal((await f.read()).values.daily_volume, null);
  f.state.phase = 'leverage'; f.state.pending = { kind: 'leverage', results: {} };
  result = await f.read();
  assert.equal(result.partial, false); assert.equal(result.values.daily_volume, 220);
  f.state.pending.results.long = { unknown: true };
  assert.equal((await f.read()).values.daily_volume, null);
});

test('legacy ASTER starts a new UTC day at zero only with a fresh confirmed runtime', async t => {
  const f = pairedAsterFixture();
  const nextDay = (Math.floor(f.now / 86400) + 1) * 86400;
  t.mock.method(Date, 'now', () => (nextDay + 2) * 1000);
  f.state.updated_at = nextDay + 1;
  f.state.snapshots.long.timestamp = nextDay + 1; f.state.snapshots.short.timestamp = nextDay + 1;
  assert.equal((await f.read()).values.daily_volume, 0);
  f.state.volume_unknown = true; f.state.volume_unknown_until_utc = f.day;
  assert.equal((await f.read()).values.daily_volume, 0);
  f.state.updated_at = nextDay - 121;
  assert.equal((await f.read()).values.daily_volume, null);
});

test('monitor reads Basic auth and selected module, marks upstream snapshots stale', async () => {
  let authorization;
  const result = await readLegacySummary({ adapter: 'monitor', apiUrl: 'http://127.0.0.1:3000', url: 'http://127.0.0.1:3000/?monitor=oil' }, { username: 'reader', password: 'mock-pass' }, { request: async (_base, route, options) => {
    authorization = options.headers.Authorization;
    return route === '/api/monitors' ? { data: { schemaVersion: 1, monitors: [{ id: 'oil', title: '原油' }] } } : { data: { brent: { markPx: 80 }, wti: { markPx: 75 }, fetchedAt: '2026-09-01T00:00:00Z', status: 'snapshot', collection: { stale: true } } };
  } });
  assert.equal(authorization, `Basic ${Buffer.from('reader:mock-pass').toString('base64')}`); assert.equal(result.metrics.find(item => item.key === 'spread').value, 5 / 75 * 100); assert.equal(result.metrics.find(item => item.key === 'spread').unit, '%'); assert.equal(result.stale, true);
  const hynix = normalizeMonitorQuote({ premium: 2.1, spread: 3, funding: { annualizedRate: 0.1 }, fetchedAt: new Date().toISOString() }, { id: 'hynix' }, 3);
  assert.equal(hynix.metrics.find(item => item.key === 'funding').value, 10);
});

test('oil fallback retains signed percentages and never divides by an invalid WTI price', () => {
  for (const [brent, wti, expected] of [[80, 80, 0], [75, 80, -6.25], [105, 100, 5], [80, 0, null], [80, -1, null], [Number.MAX_VALUE, Number.MIN_VALUE, null]]) {
    const result = normalizeMonitorQuote({ brent: { markPx: brent }, wti: { markPx: wti } }, { id: 'oil' }, 3);
    assert.equal(result.metrics.find(item => item.key === 'spread').value, expected);
    assert.equal(result.metrics.find(item => item.key === 'spread').unit, '%');
    assert.equal(result.partial, expected === null);
    assert.equal(result.metrics[1].unit, 'USDT/桶');
  }
});

test('upstream sessions are reused and invalidated after an unauthorized response', async () => {
  let logins = 0; let expired = false;
  const project = { adapter: 'asset', apiUrl: 'http://127.0.0.1:5978' };
  const credentials = { password: 'unique-cache-test-password' };
  const request = async (_base, route) => {
    if (route === '/api/login') { logins++; return { data: { ok: true }, cookies: ['asset_session=mock; Path=/'] }; }
    if (expired) { const error = new Error('expired'); error.code = 'unauthorized'; throw error; }
    return { data: { dataKind: 'personal', assets: [], history: [], fx: 7, fxStatus: {} } };
  };
  await readLegacySummary(project, credentials, { request }); await readLegacySummary(project, credentials, { request });
  assert.equal(logins, 1); expired = true;
  await assert.rejects(readLegacySummary(project, credentials, { request })); expired = false;
  await readLegacySummary(project, credentials, { request }); assert.equal(logins, 2);
});


test('public authOrigin is sent to a loopback target and partitions cached sessions', async () => {
  const calls = []; const project = { adapter: 'aster', apiUrl: 'http://127.0.0.1:18999', authOrigin: 'https://aster.example.com' };
  const request = async (base, route, options) => { calls.push({ base, route, options }); return route === '/api/login' ? { data: { ok: true }, cookies: ['aster_session=origin-test; Path=/'] } : { data: { ready: true, accounts: [] } }; };
  const credentials = { password: 'origin-cache-password' };
  await readLegacySummary(project, credentials, { request }); await readLegacySummary(project, credentials, { request });
  await readLegacySummary({ ...project, authOrigin: 'https://other.example.com' }, credentials, { request });
  assert.equal(calls.filter(call => call.route === '/api/login').length, 2);
  assert.ok(calls.every(call => call.base === project.apiUrl));
  assert.ok(calls.slice(0, 3).every(call => call.options.headers.Origin === project.authOrigin));
  assert.ok(calls.slice(3).every(call => call.options.headers.Origin === 'https://other.example.com'));
});

test('asset freshness follows dynamic mode rows and preserves manual valuation dates', async () => {
  const now = new Date().toISOString(); const old = '2020-01-02T00:00:00.000Z';
  const manual = { id: 'manual', project: '手工估值', mode: 'manual', quantity: 1, price: 50, value: 50, updatedAt: old, status: '手工录入' };
  const dynamic = { id: 'bybit', project: 'Bybit', mode: 'bybit', quantity: 100, price: 1, value: 100, updatedAt: now, status: '只读同步' };
  const read = assets => readLegacySummary({ adapter: 'asset', apiUrl: 'http://127.0.0.1:5678' }, null, { request: async () => ({ data: { dataKind: 'personal', assets, history: [], fx: 7, fxStatus: { source: 'Coinbase', fetchedAt: now, rateDate: now.slice(0, 10), error: null } } }) });
  const mixed = await read([manual, dynamic]);
  assert.equal(mixed.updatedAt, now); assert.equal(mixed.freshness, undefined); assert.equal(mixed.partial, false);
  assert.equal(mixed.metrics.find(metric => metric.key === 'manual_valuation_at').value, old);
  const binance = await read([manual, { ...dynamic, id: 'binance', project: 'binance', mode: 'binance' }]);
  assert.equal(binance.partial, false); assert.equal(binance.updatedAt, now); assert.equal(binance.freshness, undefined);
  assert.equal(binance.metrics.find(metric => metric.key === 'ledger_total').value, 150);
  const oldBinance = await read([{ ...dynamic, mode: 'binance', updatedAt: old }]);
  assert.equal(oldBinance.updatedAt, old); assert.equal(oldBinance.freshness, undefined);
  const failedBinance = await read([{ ...dynamic, mode: 'binance', error: '同步失败' }]);
  assert.equal(failedBinance.partial, true); assert.doesNotMatch(failedBinance.message, /未识别/);
  const okx = await read([manual, { ...dynamic, id: 'okx', project: 'OKX', mode: 'okx' }]);
  assert.equal(okx.partial, false); assert.equal(okx.updatedAt, now); assert.equal(okx.freshness, undefined);
  assert.equal(okx.metrics.find(metric => metric.key === 'ledger_total').value, 150);
  const oldOkx = await read([{ ...dynamic, mode: 'okx', updatedAt: old }]);
  assert.equal(oldOkx.updatedAt, old); assert.equal(oldOkx.freshness, undefined);
  const failedOkx = await read([{ ...dynamic, mode: 'okx', error: '同步失败' }]);
  assert.equal(failedOkx.partial, true); assert.doesNotMatch(failedOkx.message, /未识别/);
  const staticOnly = await read([manual]);
  assert.equal(staticOnly.freshness, 'static'); assert.equal(staticOnly.updatedAt, old); assert.match(staticOnly.message, /静态估值/);
  const unknown = await read([{ ...manual, mode: 'new-source' }]);
  assert.equal(unknown.freshness, undefined); assert.equal(unknown.partial, true); assert.equal(unknown.updatedAt, old);
  const missing = await read([{ ...manual, mode: undefined, updatedAt: undefined }]);
  assert.equal(missing.freshness, undefined); assert.equal(missing.updatedAt, null); assert.equal(missing.partial, true);
  const empty = await read([]); assert.equal(empty.freshness, undefined);
});

// Model an unupgraded module explicitly: only a missing summary route permits fallback.
function readLegacySummary(project, credentials, options) {
  return readSummary(project, credentials, { ...options, request: (...args) => {
    if (args[1].startsWith('/api/hub/summary?schemaVersion=2')) throw new UpstreamError('offline', 'Not found', 404);
    return options.request(...args);
  } });
}

test('standard v2 diagnostics are optional, bounded, unique and cannot inject hub timing or identity', () => {
  const data = { updatedAt: new Date().toISOString(), metrics: [], health: { state: 'partial', message: '统计延迟', staleAfterSeconds: 120 } };
  const read = diagnostics => standardSummary({ schemaVersion: 2, data: { ...data, diagnostics } });
  assert.equal(Object.hasOwn(standardSummary({ schemaVersion: 2, data }), 'diagnostics'), false);
  assert.deepEqual(read([]).diagnostics, []);
  const entry = { id: 'pair:gold', kind: 'notice', message: '统计延迟' };
  assert.deepEqual(read([entry]).diagnostics, [entry]);
  for (const diagnostics of [null, {}, [null], ['fault'], [entry, entry], Array.from({ length: 257 }, (_, i) => ({ ...entry, id: `a:${i}` })),
    [{ ...entry, id: '' }], [{ ...entry, id: 'a'.repeat(129) }], [{ ...entry, id: 'hub:connection' }], [{ ...entry, kind: 'warning' }],
    [{ ...entry, message: ' ' }], [{ ...entry, message: 'a'.repeat(501) }], [{ ...entry, firstSeenAt: '2000-01-01T00:00:00Z' }], [{ ...entry, secret: 'hidden' }]]) {
    assert.throws(() => read(diagnostics), error => error.code === 'invalid');
  }
  assert.throws(() => standardSummary({ schemaVersion: 1, data: { updatedAt: data.updatedAt, metrics: [], diagnostics: [] } }));
});

test('only ASTER opts in to diagnostics and unchanged standard v2 sources remain compatible', async () => {
  for (const adapter of ['aster', 'asset', 'standard', 'monitor']) {
    const calls = [];
    const result = await readSummary({ adapter, apiUrl: 'http://127.0.0.1:9876', url: 'http://127.0.0.1:9876/?monitor=oil' }, null, { request: async (_base, route) => {
      calls.push(route);
      return { data: { schemaVersion: 2, data: { updatedAt: new Date().toISOString(), metrics: [{ key: 'unknown', label: '未知', value: null }], health: { state: 'partial', message: '旧源兼容', staleAfterSeconds: 120 } } } };
    } });
    assert.deepEqual(calls, [`/api/hub/summary?schemaVersion=2${adapter === 'aster' ? '&diagnostics=1' : adapter === 'monitor' ? '&monitor=oil' : ''}`]);
    assert.equal(Object.hasOwn(result, 'diagnostics'), false); assert.equal(result.metrics[0].value, null);
  }
});

test('legacy ASTER merges pair diagnostics by stable ID and uses runtime evidence rather than message matching', async () => {
  const f = pairedAsterFixture();
  f.state.phase = 'attention'; f.state.attention = '人工核对'; f.state.reason = '成交统计尚未就绪';
  let result = await f.read();
  assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0].kind, 'action');
  const id = result.diagnostics[0].id;
  f.data.pairs[0].name = '改名'; f.state.reason = '新文案';
  result = await f.read(); assert.equal(result.diagnostics[0].id, id);
  f.state.phase = 'holding'; delete f.state.attention; f.state.recovery_watch = { batches: ['old'] };
  result = await f.read(); assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0].kind, 'fault');
  delete f.state.recovery_watch; f.state.volume_unknown = true;
  result = await f.read(); assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0].kind, 'notice');
  assert.equal(result.values.daily_volume, null);
  f.state.volume_unknown = false;
  result = await f.read(); assert.deepEqual(result.diagnostics, []); assert.equal(result.values.daily_volume, 220);
});

test('legacy ASTER ordinary statistics delays stay notices while report and margin faults remain faults', async () => {
  const data = { ready: true, accounts: [{ id: 'a', name: 'A', enabled: true, mode: 'live', snapshot: { timestamp: Date.now() / 1000, occupied_margin: '1' }, cycle_state: { report_status: { status: 'stale' } } }] };
  const read = () => readLegacySummary({ adapter: 'aster', apiUrl: 'http://127.0.0.1:8765' }, null, { request: async () => ({ data }) });
  assert.equal((await read()).diagnostics[0].kind, 'notice');
  data.accounts[0].cycle_state.report_status = { status: 'error', error: '读取失败' };
  assert.equal((await read()).diagnostics[0].kind, 'fault');
  data.accounts[0].cycle_state.report_status = { status: 'stale' }; data.accounts[0].snapshot.occupied_margin = null;
  const result = await read(); assert.equal(result.diagnostics[0].kind, 'fault'); assert.equal(result.metrics.find(row => row.key === 'occupied_margin').value, null);
});

test('legacy ASTER retains actions for fault-paused pairs and merges paused member evidence without counting their metrics', async () => {
  const f = pairedAsterFixture();
  f.data.pairs[0].pause_reason = '账户模式需要人工核对'; f.state.phase = 'attention';
  const active = await f.read(); assert.equal(active.diagnostics[0].kind, 'action');
  f.data.pairs[0].enabled = false;
  f.data.accounts[0].pause_reason = '账户暂停等待核对'; f.data.accounts[1].status = 'attention';
  const paused = await f.read();
  assert.equal(paused.diagnostics.length, 1); assert.equal(paused.diagnostics[0].kind, 'action'); assert.equal(paused.diagnostics[0].id, active.diagnostics[0].id);
  assert.deepEqual(paused.values, { accounts: 0, live_accounts: 0, occupied_margin: null, daily_volume: null });
  delete f.data.pairs[0].pause_reason; delete f.data.accounts[0].pause_reason; delete f.data.accounts[1].status;
  f.state.phase = 'paused'; f.state.reason = '用户手动暂停，保持现有仓位';
  assert.deepEqual((await f.read()).diagnostics, []);
});

test('legacy ASTER identifies disabled single-account actions from explicit runtime evidence, never pause wording', async t => {
  const read = async account => readLegacySummary({ adapter: 'aster', apiUrl: 'http://127.0.0.1:8765' }, null, { request: async () => ({ data: { ready: true, accounts: [account] } }) });
  const base = { id: 'paused', mode: 'live', enabled: false, status: 'paused', reason: '用户暂停后可人工检查' };
  const normal = await read({ ...base, cycle_state: { phase: 'paused', reason: '等待用户恢复' } });
  assert.deepEqual(normal.diagnostics, []);
  for (const evidence of [{ pause_reason: '账户模式错误' }, { status: 'attention' }, { cycle_state: { phase: 'attention', reason: '订单待核对' } }, { migration_state: { phase: 'attention', reason: '迁移待核对' } }]) await t.test(JSON.stringify(evidence), async () => {
    const result = await read({ ...base, ...evidence });
    assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0].kind, 'action');
    assert.deepEqual(Object.fromEntries(result.metrics.map(row => [row.key, row.value])), { accounts: 0, live_accounts: 0, occupied_margin: null, daily_volume: null });
  });
});
