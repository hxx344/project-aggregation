import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddedFundingFixture } from './fixtures/embedded-funding.mjs';

test('Hub-launched embedded CrossEx receives normalized funding opportunities from the real Monitor projection', async t => {
  const f = await createEmbeddedFundingFixture(); t.after(() => f.close());
  assert.equal((await f.request('/api/projects')).status, 401);
  await f.login();
  const project = (await f.request('/api/projects')).data.projects.find(row => row.id === 'crossex');
  assert.equal(project.embedded, true);
  const module = await f.launch();
  assert.equal((await f.request('/api/state', { host: module.host, auth: false })).status, 401);
  const response = await module.request('/api/state');
  assert.equal(response.status, 200, response.text);
  assert.equal(f.feed.schemaVersion, 2);
  assert.equal(f.feed.signals.length, 1);
  assert.equal(f.feed.signals[0].long.exchange, 'binance');
  assert.equal(f.feed.signals[0].short.exchange, 'bybit');
  assert.equal(response.data.opportunities.length, 1);
  assert.equal(response.data.fundingOpportunities.length, 1);
  const row = response.data.fundingOpportunities[0];
  assert.equal(row.long.symbol, 'BYBIT_FUTURE_BTC_USDT');
  assert.equal(row.short.symbol, 'BINANCE_FUTURE_BTC_USDT');
  assert.equal(row.long.normalized8hBps, 2);
  assert.equal(row.short.normalized8hBps, 8);
  assert.equal(row.equivalent8hBps, 6);
  assert.equal(row.long.intervalHours, 4);
  assert.equal(row.short.intervalHours, 1);
  assert.equal(row.eligible, true, row.reason);
  assert.ok(row.grossBps < 0, 'negative entry spreads must not remove positive funding carry');
  assert.ok(row.expiresAt > response.data.now);
  assert.equal(response.data.live.connection.connected, false);

  const light = await module.request('/api/state?opportunities=0');
  assert.equal(light.status, 200);
  assert.deepEqual(light.data.opportunities, []);
  assert.deepEqual(light.data.fundingOpportunities, []);

  // Fetch the actual HTML entry and its referenced build artifact through the
  // launch portal, catching delivery of an older embedded frontend.
  const html = await module.request('/'); assert.equal(html.status, 200, html.text);
  const asset = html.text.match(/<script[^>]*\bsrc="([^"]+\.js)"/);
  assert.ok(asset, 'embedded HTML must reference its built JavaScript');
  const javascript = await module.request(new URL(asset[1], module.origin).pathname);
  assert.equal(javascript.status, 200);
  assert.match(javascript.headers['content-type'], /javascript/);
  assert.match(javascript.text, /资金费机会/);
  assert.match(javascript.text, /价差机会/);

  assert.ok(f.stats.monitor.some(call => call.path === '/api/monitors/perpetual/opportunities-v2'));
  assert.ok(f.stats.monitor.every(call => call.method === 'GET' && call.host === 'monitor.workspace.internal' && call.workspaceAuthorized && !call.authorization));
  assert.ok(f.stats.crossex.some(call => call.path === '/api/state' && call.workspaceAuthorized));
  assert.ok(f.stats.crossex.every(call => call.method === 'GET' || call.path === '/__workspace/maintenance'));
  assert.ok(f.stats.publicHttp.every(call => call.method === 'GET'));
  assert.deepEqual(f.stats.privateClients, []);
  assert.equal(f.crossex.store.prepare('SELECT count(*) AS count FROM live_orders').get().count, 0);
});

test('embedded funding rows become read-only when rate data expires or required transfer evidence disappears', async t => {
  const f = await createEmbeddedFundingFixture(); t.after(() => f.close());
  await f.login(); const module = await f.launch();
  for (const [mode, reason] of [['expired', /资金费数据过期/], ['missing-evidence', /证据缺失|充提/]]) {
    await f.setMode(mode);
    const response = await module.request('/api/state');
    assert.equal(response.status, 200, response.text);
    assert.equal(response.data.source.state, 'live', 'fresh BBO must not renew expired funding data');
    assert.equal(response.data.fundingOpportunities.length, 1);
    const row = response.data.fundingOpportunities[0];
    assert.equal(row.equivalent8hBps, 6);
    assert.equal(row.eligible, false);
    assert.match(row.reason, reason);
    if (mode === 'missing-evidence') assert.deepEqual(f.feed.signals, []);
  }
  await f.setMode('live');
  assert.equal((await module.request('/api/state')).data.fundingOpportunities[0].eligible, true);
  assert.ok(f.stats.crossex.every(call => call.method === 'GET' || call.path === '/__workspace/maintenance'));
  assert.ok(f.stats.publicHttp.every(call => call.method === 'GET'));
  assert.deepEqual(f.stats.privateClients, []);
  assert.equal(f.crossex.store.prepare('SELECT count(*) AS count FROM live_orders').get().count, 0);
});
