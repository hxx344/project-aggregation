import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp as createHub } from '../../server/app.mjs';
import { registerModuleTransport } from '../../server/modules/transport.mjs';
import { unavailableUpdateState } from '../../server/updates.mjs';
import { createApp as createCrossEx } from '../../modules/crossex/server/app.mjs';
import { createPublicClients, CATALOG_URL } from '../../modules/crossex/server/clients.mjs';
import { createPerpetualOpportunitiesV2 } from '../../modules/monitor/server/perpetual-opportunities-v2.mjs';
import { discoverMarkets } from '../../modules/monitor/modules/perpetual/exchanges.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const listen = (server, ...args) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(...args, () => { server.off('error', reject); resolve(); });
});
const pipe = (directory, id) => process.platform === 'win32'
  ? `\\\\.\\pipe\\embedded-funding-${id}-${randomUUID()}` : path.join(directory, `${id}.sock`);
function quote(exchange, now, mode, market, alias) {
  return { exchange, symbol: 'BTCUSDT', base: 'BTC', rawBase: 'BTC', quoteCurrency: 'USDT', multiplier: 1, ...market,
    bid: alias ? exchange === 'binance' ? 0.0499 : 0.051 : exchange === 'binance' ? 99 : 102,
    ask: alias ? exchange === 'binance' ? 0.05 : 0.0511 : exchange === 'binance' ? 100 : 103,
    mark: null, last: null, bidAskAt: now, sourceTime: now, receivedAt: now, transport: 'rest',
    // Equal raw rates with different periods prove normalization precedes direction selection.
    fundingRate: 0.0001, fundingIntervalHours: exchange === 'binance' ? 1 : 4,
    fundingAt: mode === 'expired' ? now - 300001 : now, nextFundingAt: now + 3600000 };
}

/** Real Hub -> private CrossEx -> private Monitor projection; all venue IO is fake. */
export async function createEmbeddedFundingFixture({ alias = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'embedded-funding-'));
  const password = 'embedded-funding-test-password';
  const venues = alias ? ['binance', 'gate'] : ['binance', 'bybit'];
  const binanceBase = alias ? 'LUNA2' : 'BTC', binanceSymbol = `${binanceBase}USDT`;
  const catalog = venues.map(exchange => ({ symbol: `${exchange.toUpperCase()}_FUTURE_${exchange === 'gate' ? 'LUNA' : binanceBase}_USDT`,
    exchange_type: exchange.toUpperCase(), business_type: 'FUTURE', state: 'live', delist_time: '0',
    min_size: alias ? '1' : '0.001', lot_size: alias ? '1' : '0.001', tick_size: alias ? '0.00001' : '0.01',
    min_notional: '5', max_market_size: '10000', max_limit_size: '10000' }));
  const gateInstrument = { name: 'LUNA_USDT', type: 'direct', contract_type: '', status: 'trading',
    in_delisting: false, is_pre_market: false, quanto_multiplier: '1', funding_interval: 14400 };
  const stats = { monitor: [], crossex: [], publicHttp: [], terminalWs: [], privateClients: [] };
  const removers = [];
  let mode = 'live', latestFeed, discoveredMarkets = [], hub, crossex, monitor, greeks, refreshTimer, closed = false, port, cookie, csrf;
  const monitorSecret = randomUUID(), crossexSecret = randomUUID();

  function project() {
    const now = Date.now(), quotes = venues.map(exchange => quote(exchange, now, mode, discoveredMarkets.find(row => row.exchange === exchange), alias));
    const snapshot = { schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: now, staleAfterMs: 30000, quotes,
      exchanges: venues.map(id => ({ id, name: id, kind: 'cex', status: 'live', marketCount: 1, quoteCount: 1, lastMessageAt: now, error: null })) };
    const market = (exchange, symbol) => {
      if (alias) return discoveredMarkets.find(row => row.exchange === exchange && row.symbol === symbol);
      const current = quotes.find(q => q.exchange === exchange && q.symbol === symbol);
      return current && { ...current, assetClass: 'crypto', comparable: true, identityVerified: true, crossexVerified: true,
        identitySource: 'isolated-official-directory', delisting: false, delistingAt: null };
    };
    return createPerpetualOpportunitiesV2(snapshot, now, market, null, {
      enabled: true, requireSpotTransfer: true, blockedBases: [], revision: 1,
      evaluate: () => mode === 'missing-evidence' ? null : { networks: ['ETH'], checkedAt: now, expiresAt: now + 10000 },
    });
  }

  // The production HTTP parser, identity reader and depth reader still run;
  // only their external network boundary is replaced by these finite responses.
  async function fetcher(input, init = {}) {
    const url = new URL(input), method = init.method || 'GET';
    stats.publicHttp.push({ url: url.href, method });
    assert.equal(method, 'GET', 'fixture does not allow venue writes');
    let value;
    if (url.href === CATALOG_URL) value = catalog;
    else if (url.origin === 'https://fapi.binance.com' && url.pathname === '/fapi/v1/exchangeInfo') value = { symbols: [{
      symbol: binanceSymbol, baseAsset: binanceBase, quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'PERPETUAL',
      status: 'TRADING', underlyingType: 'COIN', underlyingSubType: [],
    }] };
    else if (url.origin === 'https://fapi.binance.com' && url.pathname === '/fapi/v1/fundingInfo') value = [];
    else if (url.origin === 'https://api.bybit.com' && url.pathname === '/v5/market/instruments-info') value = {
      retCode: 0, result: { category: 'linear', list: [{ symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT',
        contractType: 'LinearPerpetual', status: 'Trading', isPreListing: false, deliveryTime: '0', symbolType: 'crypto' }] },
    };
    else if (alias && url.origin === 'https://api.gateio.ws' && url.pathname === '/api/v4/futures/usdt/contracts') value = [gateInstrument];
    else if (alias && url.origin === 'https://api.gateio.ws' && url.pathname === '/api/v4/futures/usdt/contracts/LUNA_USDT') value = gateInstrument;
    else if (url.origin === 'https://fapi.binance.com' && url.pathname === '/fapi/v1/depth') {
      assert.equal(url.searchParams.get('symbol'), binanceSymbol);
      value = { T: Date.now(), bids: [[alias ? '0.0499' : '99', alias ? '10000' : '100']], asks: [[alias ? '0.05' : '100', alias ? '10000' : '100']] };
    }
    else if (url.origin === 'https://api.bybit.com' && url.pathname === '/v5/market/orderbook') value = {
      retCode: 0, result: { s: 'BTCUSDT', cts: Date.now(), b: [['102', '100']], a: [['103', '100']] },
    };
    else if (alias && url.origin === 'https://api.gateio.ws' && url.pathname === '/api/v4/futures/usdt/order_book') {
      assert.equal(url.searchParams.get('contract'), 'LUNA_USDT');
      value = { update: Date.now() / 1000, bids: [{ p: '0.051', s: '10000' }], asks: [{ p: '0.0511', s: '10000' }] };
    }
    else throw new Error(`Unconfigured fixture HTTP source: ${url.href}`);
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  class FakeWebSocket extends EventEmitter {
    constructor(url) { super(); this.readyState = 0; stats.terminalWs.push({ event: 'connect', url }); queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.emit('open'); } }); }
    send(value) { const message = JSON.parse(value); assert.ok(['subscribe', 'unsubscribe'].includes(message.event)); stats.terminalWs.push(message); }
    ping() {}
    close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  }
  function noPrivateClient() { stats.privateClients.push({ at: Date.now() }); throw new Error('Private account access is disabled in this fixture'); }
  const noHubClient = () => new Proxy({}, { get: () => noPrivateClient });
  function record(req) { return { method: req.method, path: req.url, host: req.headers.host,
    workspaceAuthorized: req.headers['x-workspace-key'] === crossexSecret, authorization: req.headers.authorization }; }

  async function close() {
    if (closed) return;
    closed = true; clearInterval(refreshTimer);
    try { await hub?.close(); }
    finally {
      try { await crossex?.close(); }
      finally {
        for (const remove of removers) remove();
        if (monitor?.listening) await new Promise(resolve => monitor.close(resolve));
        if (greeks?.listening) await new Promise(resolve => greeks.close(resolve));
        const resolved = path.resolve(directory), parent = path.resolve(tmpdir()) + path.sep;
        assert.ok(resolved.startsWith(parent) && path.basename(resolved).startsWith('embedded-funding-'));
        await rm(resolved, { recursive: true, force: true });
      }
    }
  }

  try {
    // Alias inputs enter through the same native instrument discovery and
    // normalization as production, never through a pre-canonicalized fixture.
    if (alias) discoveredMarkets = (await Promise.all(venues.map(exchange => discoverMarkets(exchange, { fetchImpl: fetcher })))).flat();
    const monitorPath = pipe(directory, 'monitor');
    monitor = http.createServer((req, res) => {
      stats.monitor.push({ method: req.method, path: req.url, host: req.headers.host,
        workspaceAuthorized: req.headers['x-workspace-key'] === monitorSecret, authorization: req.headers.authorization });
      if (req.headers['x-workspace-key'] !== monitorSecret) { res.writeHead(401); res.end(); return; }
      if (req.method !== 'GET' || req.url !== '/api/monitors/perpetual/opportunities-v2') { res.writeHead(404); res.end(); return; }
      latestFeed = project();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(latestFeed));
    });
    await listen(monitor, monitorPath);
    const monitorTransport = { socketPath: monitorPath, secret: monitorSecret };
    removers.push(registerModuleTransport('monitor', monitorTransport));
    const clients = createPublicClients({ fetcher, WebSocketImpl: FakeWebSocket, monitorTransport });
    crossex = createCrossEx({ dataDir: path.join(directory, 'crossex'), distDir: path.join(root, 'modules/crossex/dist'),
      intervalMs: 0, sourceIntervalMs: 0, logger: () => {}, authorizeRequest: req => req.headers['x-workspace-key'] === crossexSecret,
      marketOptions: { feedReader: clients.loadFeed, catalogReader: clients.loadCatalog, depthReader: clients.loadDepth,
        manualDepthReader: clients.loadManualDepth, identityReader: clients.resolveCrossexQuote, manualIdentityReader: clients.resolveManualQuote,
        fxReader: clients.loadFx },
      liveOptions: { clientFactory: noPrivateClient },
      terminalOptions: { depthReader: clients.loadManualDepth, candleReader: async () => [], WebSocketImpl: FakeWebSocket },
    });
    crossex.server.prependListener('request', req => stats.crossex.push(record(req)));
    const crossexPath = pipe(directory, 'crossex');
    await listen(crossex.server, crossexPath);
    removers.push(registerModuleTransport('crossex', { socketPath: crossexPath, secret: crossexSecret }));
    await crossex.market.refresh();
    // Hub startup releases maintenance on every trading module. The unrelated
    // Greeks/Aster fixtures share only this local control, never an exchange client.
    const greeksPath = pipe(directory, 'greeks'), greeksSecret = randomUUID();
    greeks = http.createServer(async (req, res) => {
      if (req.headers['x-workspace-key'] !== greeksSecret) { res.writeHead(401); res.end(); return; }
      if (req.method !== 'POST' || req.url !== '/__workspace/maintenance') { res.writeHead(404); res.end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ active: body.active }));
    });
    await listen(greeks, greeksPath);
    removers.push(registerModuleTransport('greeks', { socketPath: greeksPath, secret: greeksSecret }));
    removers.push(registerModuleTransport('aster', { socketPath: greeksPath, secret: greeksSecret }));
    // Keep UI sessions fresh without account polling or any order operation.
    refreshTimer = setInterval(() => { if (!closed) void crossex.market.refreshSource(); }, 2000); refreshTimer.unref();
    hub = await createHub({ embeddedModules: true, dataDir: path.join(directory, 'hub'), distDir: path.join(root, 'dist'),
      initialPassword: password, publicOrigin: '', secureCookies: false, logger: () => {}, refreshInterval: 0,
      assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0, warmupEnabled: false,
      tradingClientFactory: noHubClient, executionClientFactory: noHubClient,
      updatesClient: { status: async () => unavailableUpdateState() },
    });
    await listen(hub.server, 0, '127.0.0.1'); port = hub.server.address().port;
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Embedded fixture initialization failed'); }
    throw error;
  }

  const origin = `http://hub.localhost:${port}`;
  function request(route, { method = 'GET', body, host = new URL(origin).host, headers = {}, auth = true } = {}) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port, method, path: route, agent: false,
        headers: { Host: host, Origin: `http://${host}`, ...(auth && cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
          ...(encoded ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => { const text = Buffer.concat(chunks).toString(); let data = null;
          try { data = JSON.parse(text); } catch { /* Built HTML/JS is intentionally not JSON. */ }
          resolve({ status: res.statusCode, headers: res.headers, text, data }); });
      }); req.on('error', reject); req.end(encoded);
    });
  }
  async function login() {
    const result = await request('/api/login', { method: 'POST', body: { password } });
    assert.equal(result.status, 200, result.text);
    cookie = result.headers['set-cookie'][0].split(';')[0]; csrf = result.data.csrfToken;
  }
  async function launch() {
    const result = await request('/api/projects/crossex/launch', { method: 'POST' });
    assert.equal(result.status, 200, result.text);
    const url = new URL(result.data.url); assert.equal(url.port, String(port));
    const authorized = await request(url.pathname + url.search, { host: url.host, auth: false, headers: { Origin: origin } });
    assert.equal(authorized.status, 302, authorized.text);
    const moduleCookie = authorized.headers['set-cookie'][0].split(';')[0];
    return { host: url.host, cookie: moduleCookie, origin: url.origin,
      request: (route, options = {}) => request(route, { ...options, host: url.host, auth: false, headers: { Cookie: moduleCookie, ...options.headers } }) };
  }
  return { origin, password, server: hub.server, hub, crossex, monitor, stats, request, login, launch, close,
    get feed() { return latestFeed; }, get mode() { return mode; },
    async setMode(value) {
      assert.ok(['live', 'expired', 'missing-evidence'].includes(value));
      // Drain a timer read before changing the source, so callers never receive
      // the preceding mode's response from the shared in-flight promise.
      await crossex.market.refreshSource(); mode = value;
      await crossex.market.refreshSource();
    },
  };
}
