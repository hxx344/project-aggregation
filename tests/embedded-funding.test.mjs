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
  const heldAt = Date.now();
  // Seed the read-only position snapshot without creating a private account client.
  f.crossex.store.prepare('INSERT INTO live_cache(singleton,json) VALUES (1,?)').run(JSON.stringify({
    account: null, openOrders: [], asOf: heldAt, error: null,
    positions: ['BINANCE', 'BYBIT'].map((exchange, i) => ({ position_id: `held-${i}`, symbol: `${exchange}_FUTURE_BTC_USDT`, position_side: i ? 'SHORT' : 'LONG', position_qty: '1', create_time: String(heldAt - 86400000), update_time: String(heldAt) })),
  }));
  const portfolio = await module.request('/api/state?opportunities=0&funding=1');
  assert.equal(portfolio.status, 200);
  assert.deepEqual(portfolio.data.opportunities, []);
  assert.deepEqual(portfolio.data.fundingOpportunities, []);
  assert.equal(portfolio.data.positionFundingRates.length, 2, 'positions receive exact held rates without evaluating opportunity rankings');
  assert.equal(portfolio.data.positionFundingRates.find(item => item.exchange === 'binance').normalized8hBps, 8);
  assert.equal(portfolio.data.positionFundingRates.find(item => item.exchange === 'bybit').normalized8hBps, 2);
  assert.equal(portfolio.data.live.positions[0].openedAt, heldAt - 86400000);

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

test('embedded funding aliases preserve native contracts through discovery and read-only pair preview', async t => {
  const f = await createEmbeddedFundingFixture({ alias: true }); t.after(() => f.close());
  await f.login(); const module = await f.launch();
  const response = await module.request('/api/state');
  assert.equal(response.status, 200, response.text);
  assert.equal(response.data.fundingOpportunities.length, 1);
  const row = response.data.fundingOpportunities[0];
  assert.equal(row.base, 'LUNA2');
  assert.equal(row.long.exchange, 'gate');
  assert.equal(row.long.symbol, 'GATE_FUTURE_LUNA_USDT');
  assert.equal(row.short.exchange, 'binance');
  assert.equal(row.short.symbol, 'BINANCE_FUTURE_LUNA2_USDT');
  assert.equal(row.long.normalized8hBps, 2);
  assert.equal(row.short.normalized8hBps, 8);
  assert.equal(row.equivalent8hBps, 6);
  assert.equal(row.eligible, true, row.reason);
  assert.ok(row.grossBps < 0);
  assert.equal(f.feed.signals.length, 1);
  assert.equal(f.feed.signals[0].base, 'LUNA2');
  assert.equal(f.feed.signals[0].long.exchange, 'binance');
  assert.equal(f.feed.signals[0].short.exchange, 'gate');
  assert.deepEqual(f.feed.quotes.map(q => ({ exchange: q.exchange, base: q.base, rawBase: q.rawBase,
    symbol: q.symbol, crossexSymbol: q.crossexSymbol, multiplier: q.multiplier })), [
    { exchange: 'binance', base: 'LUNA2', rawBase: 'LUNA2', symbol: 'LUNA2USDT', crossexSymbol: 'BINANCE_FUTURE_LUNA2_USDT', multiplier: 1 },
    { exchange: 'gate', base: 'LUNA2', rawBase: 'LUNA', symbol: 'LUNA_USDT', crossexSymbol: 'GATE_FUTURE_LUNA_USDT', multiplier: 1 },
  ]);

  // Use the exact symbols returned to the workbench for prefill. The market
  // preview is read-only and requires no private account connection.
  const plan = await f.crossex.market.previewPair({ longSymbol: row.long.symbol, shortSymbol: row.short.symbol, quantity: '200' });
  assert.equal(plan.source, 'pair');
  assert.equal(plan.base, 'LUNA2');
  assert.deepEqual(plan.legs.map(leg => ({ symbol: leg.symbol, side: leg.side, quantity: leg.quantity,
    nativeSymbol: leg.quote.symbol, rawBase: leg.quote.rawBase, base: leg.quote.base,
    multiplier: leg.quote.multiplier, nativeUnit: leg.quote.nativeUnit, referencePrice: leg.referencePrice })), [
    { symbol: 'GATE_FUTURE_LUNA_USDT', side: 'BUY', quantity: '200', nativeSymbol: 'LUNA_USDT', rawBase: 'LUNA',
      base: 'LUNA2', multiplier: 1, nativeUnit: '1', referencePrice: '0.0511' },
    { symbol: 'BINANCE_FUTURE_LUNA2_USDT', side: 'SELL', quantity: '200', nativeSymbol: 'LUNA2USDT', rawBase: 'LUNA2',
      base: 'LUNA2', multiplier: 1, nativeUnit: '1', referencePrice: '0.0499' },
  ]);
  assert.ok(f.stats.publicHttp.some(call => new URL(call.url).pathname === '/api/v4/futures/usdt/contracts'));
  assert.ok(f.stats.publicHttp.some(call => new URL(call.url).pathname === '/api/v4/futures/usdt/contracts/LUNA_USDT'));
  assert.ok(f.stats.publicHttp.some(call => new URL(call.url).searchParams.get('contract') === 'LUNA_USDT'));
  assert.ok(f.stats.publicHttp.some(call => new URL(call.url).searchParams.get('symbol') === 'LUNA2USDT'));
  assert.ok(f.stats.publicHttp.every(call => call.method === 'GET'));
  assert.ok(f.stats.crossex.every(call => call.method === 'GET' || call.path === '/__workspace/maintenance'));
  assert.deepEqual(f.stats.privateClients, []);
  assert.equal(f.crossex.store.prepare('SELECT count(*) AS count FROM live_orders').get().count, 0);
});
