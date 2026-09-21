import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createPortal, HUB_HOST, PORTAL_COOKIE } from '../server/portal.mjs';

async function fixture(t, options = {}) {
  const upgradedSockets = new Set();
  let upstreamCalls = 0; let ledgerReads = 0; let validSession = true; let revision = 'revision-one'; let time = Date.now();
  const upstream = http.createServer((req, res) => {
    upstreamCalls++;
    if (req.url === '/api/ledger' && options.assetLedger) { ledgerReads++; res.writeHead(req.headers.cookie?.includes('asset_session=valid') ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.headers.cookie?.includes('asset_session=valid') ? { assets: [{ id: 'real-browser-ledger', value: 123 }], history: [], version: options.ledgerVersion?.() || 0 } : { error: '请先登录原资产项目' })); return; }
    if (req.url === '/nested/start') { res.writeHead(302, { Location: '../done?relative=1' }); res.end(); return; }
    if (req.url === '/slow-header') { const timer = setTimeout(() => res.end('completed'), 130); res.on('close', () => clearTimeout(timer)); return; }
    if (req.url === '/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${upstream.address().port}/done?view=1` }); res.end(); return; }
    if (req.url === '/away') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/metadata' }); res.end(); return; }
    if (req.url === '/cookies') {
      res.writeHead(200, { 'Set-Cookie': ['asset_session=upstream-login; Domain=.hub.localhost; Path=/; HttpOnly; Secure; SameSite=None', 'hub_session=forged; Domain=.hub.localhost', 'hub_portal=forged; Path=/', '__Host-hub_portal=forged; Path=/; Secure'], 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; connect-src 'self'", 'X-Frame-Options': 'DENY', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Credentials': 'true' }); res.end('cookie-page'); return;
    }
    if (req.url === '/binary') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.alloc(2 * 1024 * 1024, 0xab)); return; }
    if (req.url === '/sse') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: first\n\n'); const timer = setTimeout(() => res.end('data: second\n\n'), 140); res.on('close', () => clearTimeout(timer)); return; }
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => { const body = Buffer.concat(chunks); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body: body.length < 1000 ? body.toString() : '', length: body.length, digest: createHash('sha256').update(body).digest('hex') })); });
  });
  upstream.on('upgrade', (req, socket) => {
    upstreamCalls++;
    upgradedSockets.add(socket); socket.on('close', () => upgradedSockets.delete(socket));
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('error', () => {});
    socket.on('data', frame => { if (frame.length < 6) return; const length = frame[1] & 127; const mask = frame.subarray(2, 6); const data = Buffer.from(frame.subarray(6, 6 + length)); for (let index = 0; index < data.length; index++) data[index] ^= mask[index % 4]; const response = Buffer.from(`echo:${data}`); socket.write(Buffer.concat([Buffer.from([0x81, response.length]), response])); });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const projects = [{ id: 'asset', enabled: true, ...(options.assetLedger ? { adapter: 'asset', autoSync: true, hasCredentials: true } : {}), apiUrl: `http://127.0.0.1:${upstream.address().port}`, url: 'http://127.0.0.1:5678/?view=ledger', authOrigin: '' }, { id: 'monitor', enabled: true, apiUrl: `http://127.0.0.1:${upstream.address().port}`, url: 'http://127.0.0.1:3000/?monitor=oil', authOrigin: '' }];
  let portal;
  const server = http.createServer(async (req, res) => {
    if (await portal.handle(req, res)) return;
    if (req.url.startsWith('/launch')) {
      try { const result = portal.createLaunch({ projectId: new URL(req.url, 'http://local').searchParams.get('id') || 'asset', sessionId: 'hashed-session-id', req }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); }
      catch (error) { res.writeHead(error.status || 500); res.end(error.message); }
    } else { res.writeHead(200); res.end('hub'); }
  });
  portal = createPortal({ getProjects: () => projects, getProjectRevision: () => revision, isSessionValid: id => validSession && id === 'hashed-session-id', now: () => time, ...options });
  server.on('upgrade', async (req, socket, head) => { if (!await portal.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const host = id => `${id ? portal.projectHost(id) : HUB_HOST}:${port}`;
  function request(path = '/', { id = 'asset', method = 'GET', cookie, headers = {}, body, hostname = host(id) } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: hostname, ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); res.on('error', reject); });
      req.on('error', reject); if (body) req.write(body); req.end();
    });
  }
  async function launch(id = 'asset') { const result = await request(`/launch?id=${id}`, { id: null }); assert.equal(result.status, 200, result.body.toString()); return JSON.parse(result.body); }
  async function authorize(id = 'asset') { const launched = await launch(id); const result = await request(new URL(launched.url).pathname + new URL(launched.url).search, { id, headers: { Origin: `http://${host(null)}`, 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' } }); assert.equal(result.status, 302, result.body.toString()); return { cookie: result.headers['set-cookie'][0].split(';')[0], launched, result }; }
  t.after(async () => { portal.close(); for (const socket of upgradedSockets) socket.destroy(); server.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]); });
  return { portal, projects, request, launch, authorize, host, port, upstream, get calls() { return upstreamCalls; }, get ledgerReads() { return ledgerReads; }, revoke() { validSession = false; }, revise() { revision = 'revision-two'; }, advance(ms) { time += ms; } };
}

test('portal requires a grant and tickets are single-use, expire, and bind the project', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/private')).status, 401); assert.equal(f.calls, 0);
  const launch = await f.launch(); const url = new URL(launch.url);
  assert.equal((await f.request(url.pathname + url.search, { id: 'monitor' })).status, 401);
  const granted = await f.request(url.pathname + url.search);
  assert.equal(granted.status, 302); assert.equal(granted.headers.location, '/?view=ledger'); assert.match(granted.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/); assert.doesNotMatch(granted.headers['set-cookie'][0], /Domain=/i);
  assert.equal((await f.request(url.pathname + url.search)).status, 401);
  const expired = new URL((await f.launch()).url); f.advance(31000);
  assert.equal((await f.request(expired.pathname + expired.search)).status, 401);
});

test('logout, configuration changes, and project disablement revoke granted reads', async t => {
  const f = await fixture(t); const { cookie } = await f.authorize();
  assert.equal((await f.request('/private', { cookie })).status, 200);
  f.revise(); assert.equal((await f.request('/private', { cookie })).status, 401);
  const next = await f.authorize(); f.projects[0].enabled = false;
  assert.equal((await f.request('/private', { cookie: next.cookie })).status, 401);
  f.projects[0].enabled = true; const third = await f.authorize(); f.revoke();
  assert.equal((await f.request('/private', { cookie: third.cookie })).status, 401);
});

test('portal strips hub credentials and spoofed forwarding headers while preserving original login cookies and POST', async t => {
  const f = await fixture(t); const { cookie } = await f.authorize();
  f.projects[0].authOrigin = 'https://asset.example.com';
  const result = await f.request('/api/login', { method: 'POST', cookie: `${cookie}; hub_session=top-secret; asset_session=original; __Host-hub_session=also-secret`, headers: { Origin: `http://${f.host('asset')}`, 'Content-Type': 'application/json', Forwarded: 'host=evil.example', 'X-Forwarded-For': '1.2.3.4', 'X-Forwarded-Host': 'evil.example', 'X-Real-IP': '1.2.3.4' }, body: '{"password":"manual-original-login"}' });
  assert.equal(result.status, 200); const echo = JSON.parse(result.body);
  assert.equal(echo.headers.cookie, 'asset_session=original'); assert.equal(echo.headers.origin, 'https://asset.example.com'); assert.equal(echo.headers.host, `127.0.0.1:${f.upstream.address().port}`); assert.equal(echo.headers.forwarded, undefined); assert.equal(echo.headers['x-forwarded-for'], undefined); assert.equal(echo.headers['x-forwarded-host'], undefined); assert.equal(echo.headers['x-real-ip'], undefined); assert.equal(echo.method, 'POST'); assert.match(echo.body, /manual-original-login/);
});

test('portal rejects forged hosts, cross-origin writes and cross-project GET subresources', async t => {
  const f = await fixture(t); const { cookie } = await f.authorize();
  assert.equal((await f.request('/', { cookie, hostname: `evil.example:${f.port}` })).status, 421);
  assert.equal((await f.request('/', { cookie, hostname: `${f.portal.projectHost('asset')}:1234` })).status, 421);
  for (const origin of ['https://evil.example', `http://${f.host(null)}`, `http://${f.host('monitor')}`, 'null']) assert.equal((await f.request('/api/save', { method: 'POST', cookie, headers: { Origin: origin }, body: '{}' })).status, 403);
  assert.equal((await f.request('/api/save', { method: 'POST', cookie, body: '{}' })).status, 403);
  assert.equal((await f.request('/private', { cookie, headers: { Origin: `http://${f.host(null)}` } })).status, 403);
  assert.equal((await f.request('/private', { cookie, headers: { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } })).status, 403);
  assert.equal((await f.request('/private', { cookie, headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' } })).status, 403);
  assert.equal(f.calls, 0);
});

test('proxy sanitizes application cookies, preserves CSP except framing, and rewrites only its own redirects', async t => {
  const f = await fixture(t); const { cookie } = await f.authorize();
  const page = await f.request('/cookies', { cookie });
  assert.equal(page.status, 200); assert.equal(page.headers['set-cookie'].length, 1); assert.match(page.headers['set-cookie'][0], /^asset_session=upstream-login;/); assert.doesNotMatch(page.headers['set-cookie'][0], /Domain=|; Secure/i); assert.match(page.headers['set-cookie'][0], /SameSite=Lax/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/); assert.match(page.headers['content-security-policy'], /connect-src 'self'/); assert.match(page.headers['content-security-policy'], new RegExp(`frame-ancestors http://hub\\.localhost:${f.port}`)); assert.equal(page.headers['x-frame-options'], undefined); assert.equal(page.headers['access-control-allow-origin'], undefined);
  const redirect = await f.request('/redirect', { cookie }); assert.equal(redirect.status, 302); assert.equal(redirect.headers.location, `http://${f.host('asset')}/done?view=1`);
  assert.equal((await f.request('/away', { cookie })).status, 502);
});

test('proxy refuses path escape and DNS metadata answers without reaching the upstream', async t => {
  const f = await fixture(t); const { cookie } = await f.authorize();
  for (const path of ['http://169.254.169.254/x', '//169.254.169.254/x', '/%2e%2e/private', '/%252e%252e/private', '/%2f%2f169.254.169.254', '/%5c%5cevil.example', '/a/../private']) assert.equal((await f.request(path, { cookie })).status, 400, path);
  assert.equal(f.calls, 0);
  const blocked = await fixture(t, { dnsLookup: async () => [{ address: '169.254.169.254', family: 4 }] }); const grant = await blocked.authorize();
  assert.equal((await blocked.request('/private', { cookie: grant.cookie })).status, 502); assert.equal(blocked.calls, 0);
});

test('binary responses, eight-megabyte uploads and long-lived SSE stream transparently', async t => {
  const f = await fixture(t, { connectTimeoutMs: 80 }); const { cookie } = await f.authorize();
  const binary = await f.request('/binary', { cookie }); assert.equal(binary.body.length, 2 * 1024 * 1024); assert.ok(binary.body.every(value => value === 0xab));
  const body = Buffer.alloc(8 * 1024 * 1024, 0xcd);
  const uploaded = await f.request('/upload', { method: 'POST', cookie, headers: { Origin: `http://${f.host('asset')}`, 'Content-Type': 'application/octet-stream' }, body });
  assert.equal(uploaded.status, 200); const echo = JSON.parse(uploaded.body); assert.equal(echo.length, body.length); assert.equal(echo.digest, createHash('sha256').update(body).digest('hex'));
  const stream = await f.request('/sse', { cookie }); assert.equal(stream.status, 200); assert.equal(stream.body.toString(), 'data: first\n\ndata: second\n\n');
});

test('WebSocket handshake and frames proxy with a valid grant and exact project Origin', async t => {
  const f = await fixture(t); const { cookie } = await f.authorize();
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.port, path: '/ws', headers: { Host: f.host('asset'), Cookie: cookie, Origin: `http://${f.host('asset')}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } });
    req.on('error', reject); req.on('response', res => reject(new Error(`Unexpected response ${res.statusCode}`)));
    req.on('upgrade', (res, socket, head) => { t.after(() => socket.destroy()); assert.equal(res.statusCode, 101); assert.equal(head.length, 0); socket.once('error', reject); socket.once('data', frame => { resolve(frame.subarray(2).toString()); socket.destroy(); }); const payload = Buffer.from('hello'); const mask = Buffer.from([1, 2, 3, 4]); const data = Buffer.from(payload); for (let index = 0; index < data.length; index++) data[index] ^= mask[index % 4]; socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | data.length]), mask, data])); }); req.end();
  });
  assert.equal(result, 'echo:hello');
});



test('connected upstream requests can finish after the connect deadline and relative redirects use the current URL', async t => {
  const f = await fixture(t, { connectTimeoutMs: 50, responseHeaderTimeoutMs: 500 }); const { cookie } = await f.authorize();
  const response = await f.request('/slow-header', { cookie }); assert.equal(response.status, 200); assert.equal(response.body.toString(), 'completed');
  const redirect = await f.request('/nested/start', { cookie }); assert.equal(redirect.status, 302); assert.equal(redirect.headers.location, `http://${f.host('asset')}/done?relative=1`);
});

test('oversized uploads are rejected without retrying the business request', async t => {
  const f = await fixture(t, { maxRequestBytes: 1024 }); const { cookie } = await f.authorize();
  const response = await f.request('/upload', { method: 'POST', cookie, headers: { Origin: `http://${f.host('asset')}` }, body: Buffer.alloc(2048) });
  assert.equal(response.status, 413); assert.ok(f.calls <= 1);
});

test('WebSockets reject missing grants and sibling Origins, and close after logout', async t => {
  const f = await fixture(t); const { cookie } = await f.authorize();
  const headers = { Origin: `http://${f.host('asset')}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' };
  assert.equal((await f.request('/ws', { headers })).status, 401);
  assert.equal((await f.request('/ws', { cookie, headers: { ...headers, Origin: `http://${f.host('monitor')}` } })).status, 403);
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.port, path: '/ws', headers: { Host: f.host('asset'), Cookie: cookie, ...headers } });
    req.on('error', reject); req.on('response', res => reject(new Error(`Unexpected response ${res.statusCode}`)));
    req.on('upgrade', (_res, socket) => { t.after(() => socket.destroy()); const timer = setTimeout(() => { socket.destroy(); reject(new Error('Revoked WebSocket remained open')); }, 2500); socket.once('close', () => { clearTimeout(timer); resolve(); }); socket.on('error', () => {}); f.revoke(); }); req.end();
  });
});


test('asset page sync verifies its browser login and merges concurrent worker runs before returning real ledger', async t => {
  let calls = 0; let version = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { assetLedger: true, ledgerVersion: () => version, coordinateAssetSync: async ({ projectId, revision }) => { calls++; assert.equal(projectId, 'asset'); assert.equal(revision, 'revision-one'); await gate; version++; return { state: 'success', message: '同步成功' }; } });
  const { cookie } = await f.authorize();
  const params = { method: 'POST', cookie: `${cookie}; asset_session=valid`, headers: { Origin: `http://${f.host('asset')}`, 'Content-Type': 'application/json' }, body: '{}' };
  const first = f.request('/api/sync', params); const second = f.request('/api/sync?from=page', params);
  while (f.ledgerReads < 2 || calls < 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(calls, 1); release();
  const results = await Promise.all([first, second]);
  for (const result of results) { assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body), { assets: [{ id: 'real-browser-ledger', value: 123 }], history: [], version: 1 }); }
  assert.equal(calls, 1); assert.equal(f.ledgerReads, 4); assert.equal(f.calls, 4);
});

test('asset sync without original app login cannot invoke the worker and disabled coordination stays transparent', async t => {
  let calls = 0;
  const f = await fixture(t, { assetLedger: true, coordinateAssetSync: async () => { calls++; return { state: 'success' }; } });
  const { cookie } = await f.authorize();
  const params = { method: 'POST', cookie, headers: { Origin: `http://${f.host('asset')}` }, body: '{}' };
  const unauthorized = await f.request('/api/sync', params);
  assert.equal(unauthorized.status, 401); assert.deepEqual(JSON.parse(unauthorized.body), { error: '请先登录原资产项目' }); assert.equal(calls, 0);
  f.projects[0].autoSync = false;
  assert.equal(JSON.parse((await f.request('/api/sync', params)).body).method, 'POST');
  f.projects[0].autoSync = true; f.projects[0].hasCredentials = false;
  assert.equal(JSON.parse((await f.request('/api/sync', params)).body).url, '/api/sync');
  f.projects[0].hasCredentials = true;
  assert.equal(JSON.parse((await f.request('/api/withdrawals', params)).body).method, 'POST');
  assert.equal(calls, 0); assert.equal(f.ledgerReads, 1);
});

test('asset coordination failures and timeouts are JSON errors and never masquerade as a successful ledger', async t => {
  const failed = await fixture(t, { assetLedger: true, coordinateAssetSync: async () => ({ state: 'error', message: '上游同步失败' }) });
  const failedGrant = await failed.authorize();
  const result = await failed.request('/api/sync', { method: 'POST', cookie: `${failedGrant.cookie}; asset_session=valid`, headers: { Origin: `http://${failed.host('asset')}` }, body: '{}' });
  assert.equal(result.status, 502); assert.deepEqual(JSON.parse(result.body), { error: '上游同步失败' }); assert.equal(failed.ledgerReads, 1);
  const timed = await fixture(t, { assetLedger: true, responseHeaderTimeoutMs: 60, coordinateAssetSync: () => new Promise(() => {}) });
  const timedGrant = await timed.authorize();
  const timeout = await timed.request('/api/sync', { method: 'POST', cookie: `${timedGrant.cookie}; asset_session=valid`, headers: { Origin: `http://${timed.host('asset')}` }, body: '{}' });
  assert.equal(timeout.status, 504); assert.match(JSON.parse(timeout.body).error, /超时/); assert.equal(timed.ledgerReads, 1);
});

test('asset coordination rechecks session and revision after waiting and does not expose another ledger', async t => {
  for (const action of ['revoke', 'revise']) {
    let release; let started;
    const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { started = resolve; });
    const f = await fixture(t, { assetLedger: true, coordinateAssetSync: async () => { started(); await gate; return { state: 'partial', message: '部分完成' }; } });
    const { cookie } = await f.authorize();
    const pending = f.request('/api/sync', { method: 'POST', cookie: `${cookie}; asset_session=valid`, headers: { Origin: `http://${f.host('asset')}` }, body: '{}' });
    await ready; f[action](); release();
    const result = await pending; assert.equal(result.status, 401); assert.equal(f.ledgerReads, 1); assert.equal(JSON.parse(result.body).assets, undefined);
  }
});

test('disconnecting an asset page does not cancel its shared worker or trigger the final browser read', async t => {
  let release; let started; let completed = false;
  const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { assetLedger: true, coordinateAssetSync: async () => { started(); await gate; completed = true; return { state: 'success' }; } });
  const { cookie } = await f.authorize();
  const req = http.request({ host: '127.0.0.1', port: f.port, path: '/api/sync', method: 'POST', headers: { Host: f.host('asset'), Cookie: `${cookie}; asset_session=valid`, Origin: `http://${f.host('asset')}` } });
  req.on('error', () => {}); req.end('{}'); await ready;
  const closed = new Promise(resolve => req.once('close', resolve)); req.destroy(); await closed;
  release(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(completed, true); assert.equal(f.ledgerReads, 1);
});

test('closing the portal or disconnecting while DNS waits cannot create a late upstream request', async t => {
  for (const action of ['close', 'disconnect']) {
    let release; let started;
    const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { started = resolve; });
    const f = await fixture(t, { dnsLookup: async () => { started(); await gate; return [{ address: '127.0.0.1', family: 4 }]; } });
    const { cookie } = await f.authorize();
    if (action === 'close') {
      const pending = f.request('/private', { cookie }); await ready; f.portal.close(); release(); assert.equal((await pending).status, 401);
    } else {
      const req = http.request({ host: '127.0.0.1', port: f.port, path: '/private', headers: { Host: f.host('asset'), Cookie: cookie } });
      req.on('error', () => {}); req.end(); await ready;
      const closed = new Promise(resolve => req.once('close', resolve)); req.destroy(); await closed; release(); await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(f.calls, 0);
  }
});

test('a WebSocket awaiting DNS cannot connect after portal shutdown', async t => {
  let release; let started;
  const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { dnsLookup: async () => { started(); await gate; return [{ address: '127.0.0.1', family: 4 }]; } });
  const { cookie } = await f.authorize();
  const pending = f.request('/ws', { cookie, headers: { Origin: `http://${f.host('asset')}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } });
  await ready; f.portal.close(); release(); assert.equal((await pending).status, 401); assert.equal(f.calls, 0);
});

test('asset partial completion returns a real ledger, absent hooks stay transparent, and large bodies cannot start sync', async t => {
  const partial = await fixture(t, { assetLedger: true, coordinateAssetSync: async () => ({ state: 'partial', message: '部分来源未更新' }) });
  const granted = await partial.authorize();
  const response = await partial.request('/api/sync', { method: 'POST', cookie: `${granted.cookie}; asset_session=valid`, headers: { Origin: `http://${partial.host('asset')}` }, body: '{}' });
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).assets[0].id, 'real-browser-ledger'); assert.equal(partial.ledgerReads, 2);
  const plain = await fixture(t, { assetLedger: true }); const plainGrant = await plain.authorize();
  const passed = await plain.request('/api/sync', { method: 'POST', cookie: plainGrant.cookie, headers: { Origin: `http://${plain.host('asset')}` }, body: '{}' });
  assert.equal(JSON.parse(passed.body).method, 'POST'); assert.equal(plain.ledgerReads, 0);
  let calls = 0;
  const limited = await fixture(t, { assetLedger: true, maxRequestBytes: 1024, coordinateAssetSync: async () => { calls++; return { state: 'success' }; } });
  const limitedGrant = await limited.authorize();
  const rejected = await limited.request('/api/sync', { method: 'POST', cookie: `${limitedGrant.cookie}; asset_session=valid`, headers: { Origin: `http://${limited.host('asset')}` }, body: Buffer.alloc(2048) });
  assert.equal(rejected.status, 413); assert.equal(limited.ledgerReads, 0); assert.equal(calls, 0);
});
