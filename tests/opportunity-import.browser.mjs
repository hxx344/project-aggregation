// Build all three frontends; start node scripts/preview-opportunity-import.mjs.
// playwright-cli -s=opportunity-import open about:blank
// playwright-cli -s=opportunity-import run-code --filename tests/opportunity-import.browser.mjs
// The real Hub and module frontends use local API fixtures only. Never confirms an order.
async page => {
  const origin = 'http://hub.localhost:4176';
  const monitorOrigin = 'http://p-111111111111111111111111.hub.localhost:4176';
  const crossexOrigin = 'http://p-222222222222222222222222.hub.localhost:4176';
  const allowed = new Set([origin, monitorOrigin, crossexOrigin]);
  const assert = (value, message) => { if (!value) throw Error(message); };
  const errors = [], unexpected = [], requests = [], previews = [], imports = [];
  const now = () => Date.now(), hour = 3_600_000;
  // Monitor's source clock differs from the browser clock; import freshness must use its feed clock.
  const monitorNow = () => now() - 24 * hour;
  const catalogWaiters = new Set(), stateWaiters = new Set();
  let holdCatalog = true, releasePreview, holdPreview = false, holdState = false, stateHoldStarted;
  const code = (exchange, base, quote) => `${exchange.toUpperCase()}_FUTURE_${base}_${quote}`;
  // USDT deliberately precedes USDC in the directory. ETH/USDC is deliberately absent.
  const instruments = [
    ['binance', 'BTC', 'USDT'], ['binance', 'BTC', 'USDC'], ['gate', 'BTC', 'USDT'],
    ['binance', 'ETH', 'USDT'], ['gate', 'ETH', 'USDT'],
  ].map(([exchange, base, quoteCurrency]) => ({ symbol: code(exchange, base, quoteCurrency), exchange, base, quoteCurrency,
    settlementCurrency: quoteCurrency, lot_size: '0.001', tick_size: '0.01', min_size: '0.001', min_notional: '0.1',
    max_limit_size: '100', max_market_size: '100', contract_size: '0.001', state: 'live' }));
  const quotes = () => ['BTC', 'ETH', 'XAU'].flatMap(base => ['binance', 'gate'].map(exchange => {
    const binance = exchange === 'binance', at = monitorNow();
    return { exchange, base, symbol: binance ? `${base}USDC` : `${base}_USDT`, quoteCurrency: binance ? 'USDC' : 'USDT',
      multiplier: 1, bid: binance ? 99 : 103, ask: binance ? 100 : 104, mark: binance ? 99.5 : 103.5, last: binance ? 100 : 104,
      bidAskAt: at, markAt: at, sourceTime: at, receivedAt: at, transport: 'rest',
      fundingRate: binance ? .0004 : .0002, fundingIntervalHours: binance ? 4 : 8, fundingAt: at, nextFundingAt: at + hour,
      comparable: true, assetClass: base === 'XAU' ? 'commodity' : 'crypto', identityVerified: true, identitySource: 'official fixture directory',
      delisting: false, delistingAt: null, collateralCurrency: binance ? 'USDC' : 'USDT' };
  }));
  const snapshot = () => ({ schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: monitorNow(), staleAfterMs: 30_000, quotes: quotes(),
    exchanges: ['binance', 'gate'].map(id => ({ id, name: id === 'gate' ? 'Gate' : 'Binance', kind: 'cex', status: 'live', marketCount: 3, quoteCount: 3, lastMessageAt: monitorNow(), error: null })) });
  const config = { entryPaused: false, monitorUrl: 'module://monitor', monitorUsername: '', hasMonitorPassword: false,
    notionalPerLeg: 500, maxOpen: 10, maxTotalNotional: 10000, feeBps: 5, feeSchedule: [], slippageBps: 5, minNetBps: 1, cooldownSeconds: 0 };
  const connection = { configured: true, connected: true, status: 'connected', accountId: 'fixture', keySuffix: 'TEST', version: 'opportunity-import-1',
    positionMode: 'DUAL', permissions: { read: 'allowed', trade: 'allowed' }, lastVerifiedAt: now(), error: null };
  const overview = { generatedAt: new Date().toISOString(), projects: [['monitor', 'Monitor'], ['crossex', 'Gate CrossEx']].map(([id, name], order) => ({
    project: { id, name, description: '隔离机会导入验收', category: 'trading', adapter: 'standard', url: `module://${id}/`, apiUrl: `module://${id}`,
      accessMode: 'proxy', mode: 'embed', enabled: true, embedded: true, staleAfterSeconds: 120, order, hasCredentials: true, revision: 'opportunity-import-fixture' },
    state: 'online', freshness: 'static', message: '', checkedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), latencyMs: 1, metrics: [],
  })) };
  const updates = { enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null };
  const state = () => ({ now: now(), csrfToken: 'opportunity-import-fixture', mode: 'live', config, venues: [], fx: [], opportunities: [], fundingOpportunities: [], positionFundingRates: [],
    source: { state: 'live', error: null, updatedAt: now(), generatedAt: now(), checkedAt: now(), quoteCount: 4 }, catalog: { state: 'ready', count: instruments.length, updatedAt: now(), error: null },
    live: { connection, status: 'live', freshnessState: 'fresh', stale: false, partial: false, asOf: now(), tradingAllowed: true, reasons: [],
      account: { account_mode: 'CROSS_EXCHANGE', available_margin: '10000', margin_balance: '10000', initial_margin: '0', maintenance_margin: '0' },
      balances: [], positions: [], orders: [], executions: [], alerts: [], recentTrades: [], accountBook: [], fees: [], adlAsOf: now(), adlError: null } });
  const historyFor = pairs => Object.fromEntries([...new Set(pairs.flatMap(pair => [pair.longKey, pair.shortKey]))].map(key => {
    const [exchange, symbol] = key.split(':');
    return [key, { key, exchange, symbol, identity: `${key}:fixture`, status: 'ready', fetchedAt: monitorNow(),
      coverage: { from: monitorNow() - 768 * hour, to: monitorNow() }, error: '', backfillComplete: true,
      records: Array.from({ length: 97 }, (_, index) => ({ time: monitorNow() - (96 - index) * 8 * hour, rate: exchange === 'binance' ? .0008 : .0002 })) }];
  }));
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.context().setOffline(false);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ origin, monitorOrigin, crossexOrigin, overview, updates, initial }) => {
    if (location.origin === monitorOrigin) {
      localStorage.setItem('market-monitor:perpetual:v1', JSON.stringify({ version: 2, sortBy: 'gross', crossCurrency: true, minSpreadPercent: 0 }));
      localStorage.removeItem('market-monitor:perpetual-scanner:v1');
      localStorage.setItem('market-monitor:perpetual-scanner-ranges:v1', '{}');
      localStorage.removeItem('market-monitor:perpetual-scanner-sort:v1');
    }
    if (location.origin === crossexOrigin) {
      window.opportunityImportMessages = [];
      addEventListener('message', event => {
        if (event.source === parent && event.origin === origin && event.data?.channel === 'project-hub' && event.data.type === 'navigate') {
          window.opportunityImportMessages.push(event.data.query?.importId);
        }
      });
    }
    window.EventSource = class {
      constructor(url) {
        this.url = String(url); this.readyState = 1;
        const emit = () => {
          if (this.readyState !== 1) return;
          let data;
          if (location.origin === origin) data = this.url.includes('/api/overview/events') ? overview : { type: 'snapshot', state: updates };
          else {
            const at = Date.now() - 86_400_000;
            data = structuredClone(initial); data.generatedAt = at; data.streamId = 'opportunity-import-fixture'; data.sequence = (this.sequence = (this.sequence || 0) + 1);
            for (const quote of data.quotes) for (const key of ['bidAskAt', 'markAt', 'sourceTime', 'receivedAt', 'fundingAt']) quote[key] = at;
          }
          this.onmessage?.({ data: JSON.stringify(data) });
        };
        this.timer = setInterval(emit, 1000); this.first = setTimeout(emit, 0);
      }
      close() { this.readyState = 2; clearInterval(this.timer); clearTimeout(this.first); }
    };
    window.WebSocket = class { constructor() { throw Error('WebSocket forbidden in isolated fixture'); } };
  }, { origin, monitorOrigin, crossexOrigin, overview, updates, initial: snapshot() });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (!allowed.has(url.origin)) { unexpected.push(`${method} ${url.href}`); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    requests.push({ origin: url.origin, path, method, query: url.search });
    const send = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (url.origin === origin) {
      const project = path.match(/^\/api\/projects\/(monitor|crossex)\/(launch|check)$/);
      if (project && method === 'POST') return send(project[2] === 'launch'
        ? { url: project[1] === 'monitor' ? `${monitorOrigin}/?monitor=perpetual` : `${crossexOrigin}/#positions` }
        : { snapshot: overview.projects.find(item => item.project.id === project[1]) });
      if (method === 'GET') {
        if (path === '/api/session') return send({ authenticated: true, csrfToken: 'hub-fixture' });
        if (path === '/api/overview') return send(overview);
        if (path === '/api/system/updates') return send(updates);
        if (path === '/api/health') return send({ status: 'ok' });
      }
    } else if (url.origin === monitorOrigin) {
      if (method === 'GET') {
        if (path.endsWith('/perpetual/quote')) return send(snapshot());
        if (path.endsWith('/perpetual/crossex-settings')) return send({ available: true, generatedAt: monitorNow(), revision: 0, metadataRevision: 1,
          config: { requireSpotTransfer: false, blockedBases: [] }, error: '', spotTransferPairs: [], venues: ['binance', 'gate'].map(exchange => ({ exchange, state: 'live', checkedAt: monitorNow(), error: '' })) });
        if (path.endsWith('/perpetual/fx')) return send({ baseCurrency: 'USDT', generatedAt: monitorNow(), staleAfterMs: 180_000, rates: { USDC: { bid: 1, ask: 1, at: monitorNow(), source: 'local fixture' } } });
        if (path === '/api/monitors') return send({ schemaVersion: 1, monitors: [] });
        if (['/api/monitors/oil/quote', '/api/monitors/cl-xau/quote', '/api/monitors/hynix/quote', '/api/monitors/hynix/history', '/api/monitors/perpetual/summary'].includes(path)) return send({ error: 'Inactive overview in import fixture' }, 503);
        if (path.endsWith('/perpetual/alerts')) return send({ available: false, revision: 0, config: { enabled: false, rules: [] }, events: [], error: '' });
        if (path === '/api/notifications/feishu') return send({ available: false, revision: 0, webhookConfigured: false, signingSecretConfigured: false, candidates: [], migratedFrom: [], reason: 'Fixture disabled' });
      }
      // These POST endpoints only read market data. Business mutation endpoints stay blocked.
      if (method === 'POST') {
        if (path.endsWith('/perpetual/funding-history')) return send({ schemaVersion: 1, generatedAt: monitorNow(), legs: historyFor(request.postDataJSON().pairs) });
        if (path.endsWith('/perpetual/metrics')) return send({ schemaVersion: 1, generatedAt: monitorNow(), legs: {} });
        if (path.endsWith('/perpetual/scanner-data')) return send({ schemaVersion: 1, generatedAt: monitorNow(), metrics: {}, history: {} });
        if (path.endsWith('/perpetual/quality')) return send({ schemaVersion: 1, generatedAt: monitorNow(), pairs: {}, assets: {}, fees: {} });
        if (path.endsWith('/perpetual/price-history')) return send({ error: 'No chart history in import fixture' }, 503);
        if (path.endsWith('/perpetual/depth')) return send({ error: 'No depth calculation in import fixture' }, 503);
      }
    } else if (url.origin === crossexOrigin) {
      if (method === 'GET') {
        if (path === '/api/bootstrap') return send({ now: now(), config, connection, csrfToken: 'opportunity-import-fixture' });
        if (path === '/api/state') {
          if (holdState) {
            stateHoldStarted?.();
            await new Promise(resolve => { stateWaiters.add(resolve); });
          }
          return send(state());
        }
        if (path === '/api/live/instruments') {
          if (holdCatalog) await new Promise(resolve => { catalogWaiters.add(resolve); });
          return send({ items: instruments });
        }
        if (path === '/api/live/market') {
          const item = instruments.find(item => item.symbol === url.searchParams.get('symbol'));
          assert(item, 'market reads must use an exact known contract');
          return send({ ...item, status: 'live', asOf: now(), tradingAvailable: true, error: null, interval: '5m',
            ticker: { lastPrice: '100', bidPrice: '99', askPrice: '100', markPrice: '100', fundingRate: '0.0001', nextFundingAt: now() + hour },
            book: { bids: [['99', '10']], asks: [['100', '10']], at: now(), quantityUnit: 'base' }, candles: [], trades: [] });
        }
      }
      if (path === '/api/live/open-capacity' && method === 'POST') return send({ error: 'Fixture capacity estimate unavailable' }, 503);
      if (path === '/api/live/preview' && method === 'POST') {
        const input = request.postDataJSON(); previews.push(input);
        assert(input.kind === 'open' && input.pair, 'only an explicit hedge preview is allowed');
        if (holdPreview) await new Promise(resolve => { releasePreview = resolve; });
        const legs = [input.pair.longSymbol, input.pair.shortSymbol].map((symbol, index) => {
          const item = instruments.find(item => item.symbol === symbol); assert(item, 'preview preserves exact contracts');
          return { exchange: item.exchange, symbol, side: index ? 'SELL' : 'BUY', positionSide: index ? 'SHORT' : 'LONG', quantity: input.pair.quantity,
            price: '100', referencePrice: '100', orderType: 'LIMIT', timeInForce: 'IOC', reduceOnly: false, baseCurrency: item.base, quoteCurrency: item.quoteCurrency,
            notionalUSDT: '20', singleLegBudgetUSDT: '500', budgetPrice: '100', budgetFxRate: '1' };
        });
        return send({ id: `import-preview-${previews.length}`, kind: 'open', createdAt: now(), expiresAt: now() + 30000,
          connectionVersion: connection.version, accountUid: 'fixture', warnings: [], canConfirm: true, legs });
      }
    }
    unexpected.push(`${method} ${url.href}`);
    return send({ error: 'Unexpected request; all business writes are forbidden' }, 405);
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/?view=project&id=monitor`);
    const monitorFrame = page.frameLocator('iframe[title="Monitor模块"]');
    const crossexFrame = page.frameLocator('iframe[title="Gate CrossEx模块"]');
    const rows = monitorFrame.locator('.perp-scanner-table > tbody > tr:not(.perp-detail-row)');
    const row = base => rows.filter({ has: monitorFrame.locator('.perp-base-cell strong', { hasText: base }) }).first();
    const importButton = base => row(base).getByRole('button', { name: /^导入 CrossEx：/ });
    const select = leg => crossexFrame.getByRole('combobox', { name: `${leg} 腿计价币`, exact: true });
    const quantity = () => crossexFrame.getByPlaceholder('输入基础币数量', { exact: true });
    const goMonitor = async () => { await page.locator('.project-nav').filter({ hasText: 'Monitor' }).click(); await importButton('BTC').waitFor(); };
    const captureImport = async (base, kind, longExchange, longQuote, shortExchange, shortQuote, button = importButton(base)) => {
      const previous = new URL(page.url()).searchParams.get('importId');
      const names = { binance: 'Binance', gate: 'Gate' };
      const native = (exchange, quote) => exchange === 'gate' ? `${base}_${quote}` : `${base}${quote}`;
      const expectedLabel = `导入 CrossEx：${base}，做多 ${names[longExchange]} ${native(longExchange, longQuote)}，做空 ${names[shortExchange]} ${native(shortExchange, shortQuote)}`;
      const frame = page.frames().find(frame => frame.url().startsWith(monitorOrigin));
      await frame.waitForFunction(label => [...document.querySelectorAll('[data-crossex-import] button')].some(button => button.getAttribute('aria-label') === label), expectedLabel);
      assert(await button.getAttribute('aria-label') === expectedLabel, 'selected Monitor row has the expected direction before import');
      await button.click();
      await page.waitForURL(url => url.searchParams.get('id') === 'crossex' && !!url.searchParams.get('importId') && url.searchParams.get('importId') !== previous);
      const query = Object.fromEntries(new URL(page.url()).searchParams);
      assert(query.symbol === base && query.opportunityKind === kind, 'host preserves base and opportunity kind');
      assert(query.longExchange === longExchange && query.shortExchange === shortExchange, 'host preserves the original long/short direction');
      assert(query.longContract === code(longExchange, base, longQuote) && query.shortContract === code(shortExchange, base, shortQuote), 'host preserves exact quote-currency contracts');
      assert(!imports.some(item => item.importId === query.importId), 'every user import gets a new identity'); imports.push(query);
      await crossexFrame.getByRole('heading', { name: '跨所手动对冲', exact: true }).waitFor();
      return query;
    };
    const expectPair = async (long, short) => {
      const frame = page.frames().find(frame => frame.url().startsWith(crossexOrigin));
      await frame.waitForFunction(({ long, short }) => document.querySelector('[aria-label="A 腿计价币"]')?.value === long && document.querySelector('[aria-label="B 腿计价币"]')?.value === short, { long, short });
      assert(await quantity().inputValue() === '', 'import requires a new explicit quantity');
      assert(await crossexFrame.getByRole('button', { name: /^(预览双腿委托|当前不可开仓)$/ }).isDisabled(), 'no quantity means no preview or order');
    };
    const expectRejected = async query => {
      const frame = page.frames().find(frame => frame.url().startsWith(crossexOrigin));
      await frame.waitForFunction(id => window.opportunityImportMessages.includes(id) && !new URL(location.href).searchParams.has('importId'), query.importId);
      await crossexFrame.getByText('当前操作尚未结束或结果待确认，本次机会未导入。请先核对原操作，再从 Monitor 重新导入。', { exact: true }).waitFor();
    };

    await importButton('BTC').waitFor();
    const monitor = page.frames().find(frame => frame.url().startsWith(monitorOrigin));
    const disabledImport = importButton('XAU'), disabledReason = row('XAU').locator('[data-column="crossexImport"] small');
    assert(await disabledImport.isDisabled() && (await disabledReason.innerText()).length > 0, 'unsupported asset keeps a visible disabled reason');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px Hub has no page overflow`);
      assert(await monitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px Monitor has no page overflow`);
      await importButton('BTC').scrollIntoViewIfNeeded();
      const bounds = await importButton('BTC').boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${width}px import button is reachable inside the table`);
      await page.screenshot({ path: `output/playwright/opportunity-import-monitor-${width}.png`, fullPage: true });
      await disabledReason.scrollIntoViewIfNeeded();
      assert(await disabledReason.isVisible() && await disabledImport.getAttribute('aria-describedby') === await disabledReason.getAttribute('id'), `${width}px disabled reason remains visible and associated`);
      if (width === 390) await page.screenshot({ path: 'output/playwright/opportunity-import-disabled-mobile.png', fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await captureImport('BTC', 'spread', 'binance', 'USDC', 'gate', 'USDT');
    assert(await select('A').inputValue() === '' && await select('B').inputValue() === '', 'late directory leaves both exact legs unselected');
    assert(previews.length === 0, 'import never creates a preview automatically');
    assert(requests.filter(item => item.path === '/api/live/market').length === 0, 'waiting for directory never reads an arbitrary fallback contract');
    holdCatalog = false; for (const release of catalogWaiters) release(); catalogWaiters.clear();
    await expectPair(code('binance', 'BTC', 'USDC'), code('gate', 'BTC', 'USDT'));
    assert(await select('A').locator('option').count() === 2, 'USDT and USDC coexist in the same venue directory');
    await quantity().fill('0.2');
    await crossexFrame.getByRole('button', { name: '预览双腿委托', exact: true }).click();
    await crossexFrame.getByRole('dialog', { name: '核对开仓委托', exact: true }).waitFor();
    assert(previews.length === 1 && previews[0].pair.longSymbol === code('binance', 'BTC', 'USDC'), 'explicit preview keeps the USDC leg');

    await goMonitor();
    await captureImport('BTC', 'spread', 'binance', 'USDC', 'gate', 'USDT');
    await expectPair(code('binance', 'BTC', 'USDC'), code('gate', 'BTC', 'USDT'));
    assert(await crossexFrame.getByRole('dialog').count() === 0, 'repeated identical import clears the previous preview');
    assert(previews.length === 1, 'repeated import never previews automatically');

    await goMonitor();
    await monitorFrame.getByRole('button', { name: '资金费套利', exact: true }).click();
    await row('BTC').getByRole('button', { name: '导入 CrossEx：BTC，做多 Gate BTC_USDT，做空 Binance BTCUSDC', exact: true }).waitFor();
    await row('BTC').getByRole('button', { name: /^展开 BTC，/ }).click();
    const detailImport = monitorFrame.locator('.perp-detail-row').getByRole('button', { name: /^导入 CrossEx：/ });
    await captureImport('BTC', 'funding', 'gate', 'USDT', 'binance', 'USDC', detailImport);
    await expectPair(code('gate', 'BTC', 'USDT'), code('binance', 'BTC', 'USDC'));
    await page.screenshot({ path: 'output/playwright/opportunity-import-funding.png', fullPage: true });

    // Reject an incoming import while an explicit preview request is still in flight.
    await quantity().fill('0.3'); holdPreview = true;
    const pendingPreview = page.waitForRequest(request => request.url() === `${crossexOrigin}/api/live/preview`);
    await crossexFrame.getByRole('button', { name: '预览双腿委托', exact: true }).click(); await pendingPreview;
    await goMonitor();
    await monitorFrame.getByRole('button', { name: '价格套利', exact: true }).click();
    const rejectedDuringPreview = await captureImport('ETH', 'spread', 'binance', 'USDC', 'gate', 'USDT');
    await expectRejected(rejectedDuringPreview);
    assert(await quantity().inputValue() === '0.3' && await select('A').inputValue() === code('gate', 'BTC', 'USDT'), 'in-flight preview prevents import from replacing the current form');
    holdState = true;
    const refreshPending = new Promise(resolve => { stateHoldStarted = resolve; });
    holdPreview = false; releasePreview?.(); releasePreview = null;
    await refreshPending;
    // Switching away cancels this read, which legitimately finishes the operation.
    // Keep CrossEx active and deliver through its real trusted host bridge instead.
    const rejectedDuringRefresh = Object.fromEntries(['symbol', 'longExchange', 'shortExchange', 'longContract', 'shortContract', 'opportunityKind']
      .map(key => [key, rejectedDuringPreview[key]]));
    rejectedDuringRefresh.importId = 'fixture-refresh-import'; imports.push(rejectedDuringRefresh);
    await page.evaluate(({ crossexOrigin, query }) => {
      document.querySelector('iframe[title="Gate CrossEx模块"]').contentWindow.postMessage({ channel: 'project-hub', version: 1, type: 'navigate', projectId: 'crossex', query }, crossexOrigin);
    }, { crossexOrigin, query: rejectedDuringRefresh });
    await expectRejected(rejectedDuringRefresh);
    assert(await quantity().inputValue() === '0.3' && await select('A').inputValue() === code('gate', 'BTC', 'USDT'), 'post-preview state refresh keeps the operation lock and original form');
    assert(await crossexFrame.getByRole('dialog').count() === 0, 'preview cannot arrive until its associated refresh finishes');
    holdState = false; for (const release of stateWaiters) release(); stateWaiters.clear();
    await crossexFrame.getByRole('dialog', { name: '核对开仓委托', exact: true }).waitFor();
    await crossexFrame.getByRole('button', { name: '关闭订单核对', exact: true }).click();

    await goMonitor();
    await captureImport('ETH', 'spread', 'binance', 'USDC', 'gate', 'USDT');
    await expectPair('', '');
    assert(await select('A').inputValue() !== code('binance', 'ETH', 'USDT'), 'missing exact ETH/USDC must not select available ETH/USDT');
    const crossex = page.frames().find(frame => frame.url().startsWith(crossexOrigin));
    assert(/合约|目录/.test(await crossex.locator('.inline-state.warning').first().innerText()), 'missing directory match has a visible reason');
    await page.screenshot({ path: 'output/playwright/opportunity-import-missing-contract.png', fullPage: true });

    // Restore a pending operation identity without creating or confirming an order.
    await crossex.evaluate(() => {
      sessionStorage.setItem('gate-crossex:pending:v1:/', JSON.stringify({ version: 1, kind: 'confirm', id: 'fixture-pending-import' }));
      location.reload();
    });
    await crossexFrame.getByText(/存在结果待确认的操作，新的交易暂不可用/).waitFor();
    await crossexFrame.getByRole('button', { name: '跨所对冲', exact: true }).click();
    await expectPair(code('binance', 'BTC', 'USDT'), code('gate', 'BTC', 'USDT'));
    await quantity().fill('0.4');
    await goMonitor();
    const rejectedPending = await captureImport('BTC', 'spread', 'binance', 'USDC', 'gate', 'USDT');
    await expectRejected(rejectedPending);
    assert(await quantity().inputValue() === '0.4' && await select('A').inputValue() === code('binance', 'BTC', 'USDT'), 'restored pending request protects the current form from import');
    assert(previews.length === 2, 'only the two explicit preview clicks reach the mock endpoint');
    assert(!requests.some(item => /\/api\/live\/(confirm|cancel|connection)$/.test(item.path)), 'no business writes or order confirmations occur');
    assert(unexpected.length === 0, `unexpected requests: ${unexpected.join('; ')}`);
    assert(errors.length === 0, `uncaught browser errors: ${errors.join('; ')}`);
    return { passed: true, monitorImports: imports.length - 1, refreshWindowHostMessages: 1, previews: previews.length, liveOrders: 0,
      scenarios: ['real Hub Monitor-to-CrossEx iframe bridge', '1440/390px import column and disabled reason', 'source clock differs from browser by 24 hours',
        'late directory', 'USDT/USDC exact match', 'repeated import clears quantity and review', 'funding reverse direction from detail',
        'in-flight preview rejects import', 'post-preview refresh rejects import', 'pending request rejects import', 'missing contract has no fallback'] };
  } finally {
    holdCatalog = false; holdState = false; holdPreview = false;
    for (const release of catalogWaiters) release(); for (const release of stateWaiters) release(); releasePreview?.();
    const frame = page.frames().find(frame => frame.url().startsWith(crossexOrigin));
    await frame?.evaluate(() => sessionStorage.removeItem('gate-crossex:pending:v1:/'));
  }
}
