import test from 'node:test';
import assert from 'node:assert/strict';
import { getJson, createPublicClients } from '../server/clients.mjs';
test('outbound reader only uses GET, bounded responses, deadlines and no redirects', async () => {
  let init; assert.deepEqual(await getJson('http://localhost', { fetcher: async (_url, value) => { init = value; return new Response('{"ok":true}'); } }), { ok: true });
  assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
  await assert.rejects(getJson('http://localhost', { fetcher: async () => new Response('x'.repeat(20)), maxBytes: 10 }), /过大/);
  await assert.rejects(getJson('http://localhost', { fetcher: async () => new Response('not json') }), /JSON/);
  await assert.rejects(getJson('http://localhost', { fetcher: async () => new Response('{}', { status: 401 }) }), /认证/);
});
test('Monitor credentials remain on the loopback v2 GET; no downgrade to the old endpoint', async () => {
  const requests = [], clients = createPublicClients({ fetcher: async (url, init) => { requests.push({ url, init }); return new Response('{}'); } });
  await clients.loadFeed({ monitorUrl: 'http://127.0.0.1:3000', monitorUsername: 'admin' }, 'fixture-secret');
  await clients.loadCatalog();
  assert.equal(requests[0].url, 'http://127.0.0.1:3000/api/monitors/perpetual/opportunities-v2'); assert.equal(requests[0].init.method, 'GET'); assert.match(requests[0].init.headers.Authorization, /^Basic /);
  assert.equal(requests[1].init.headers.Authorization, undefined);
  await assert.rejects(clients.loadFeed({ monitorUrl: 'https://example.com', monitorUsername: 'admin' }, 'fixture-secret'), /同机/); assert.equal(requests.length, 2);
  const old = createPublicClients({ fetcher: async url => { assert.ok(url.endsWith('/opportunities-v2')); return new Response('{}', { status: 404 }); } });
  await assert.rejects(old.loadFeed({ monitorUrl: 'http://localhost:3000', monitorUsername: 'admin' }), /先升级 Monitor/);
});
