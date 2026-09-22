import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validateUrl, blockedAddress, standardSummary, requestJson, readSummary, normalizeMonitorQuote, UpstreamError } from '../server/adapters.mjs';

test('URL validation allows intentional private services and blocks metadata addresses', () => {
  assert.equal(validateUrl('http://127.0.0.1:3000/?monitor=oil'), 'http://127.0.0.1:3000/?monitor=oil');
  assert.equal(validateUrl('http://10.0.0.5:3100/', { api: true }), 'http://10.0.0.5:3100');
  for (const value of ['http://169.254.169.254', 'http://[fe80::1]', 'http://[::ffff:a9fe:a9fe]', 'http://0xA9FEA9FE', 'http://metadata.google.internal']) assert.throws(() => validateUrl(value));
  assert.equal(blockedAddress('::ffff:169.254.1.1'), true);
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

test('monitor reads Basic auth and selected module, marks upstream snapshots stale', async () => {
  let authorization;
  const result = await readLegacySummary({ adapter: 'monitor', apiUrl: 'http://127.0.0.1:3000', url: 'http://127.0.0.1:3000/?monitor=oil' }, { username: 'reader', password: 'mock-pass' }, { request: async (_base, route, options) => {
    authorization = options.headers.Authorization;
    return route === '/api/monitors' ? { data: { schemaVersion: 1, monitors: [{ id: 'oil', title: '原油' }] } } : { data: { brent: { markPx: 80 }, wti: { markPx: 75 }, fetchedAt: '2026-09-01T00:00:00Z', status: 'snapshot', collection: { stale: true } } };
  } });
  assert.equal(authorization, `Basic ${Buffer.from('reader:mock-pass').toString('base64')}`); assert.equal(result.metrics.find(item => item.key === 'spread').value, 5); assert.equal(result.stale, true);
  const hynix = normalizeMonitorQuote({ premium: 2.1, spread: 3, funding: { annualizedRate: 0.1 }, fetchedAt: new Date().toISOString() }, { id: 'hynix' }, 3);
  assert.equal(hynix.metrics.find(item => item.key === 'funding').value, 10);
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
