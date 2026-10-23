// Run: playwright-cli -s=<session> open about:blank then
// playwright-cli -s=<session> run-code --filename tests/monitor-related-positions.browser.mjs
// Requires the root production preview at 127.0.0.1:4175 and the Monitor SSR fixture
// (modules/monitor: node --experimental-strip-types tests/ssr-browser-server.mjs 3189).
// The Monitor build is served on a proxy-style subdomain so the real bridge connects;
// every API is a fixture and no account or order endpoint is contacted.
async (page) => {
  const origin = 'http://hub.localhost:4175';
  const moduleOrigin = 'http://p-0123456789abcdef01234567.hub.localhost:4175';
  const monitorBuild = 'http://127.0.0.1:3189';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const stamp = () => new Date().toISOString();
  const project = { id: 'monitor', name: 'monitor', description: '', category: 'other', adapter: 'monitor', enabled: true, embedded: true, accessMode: 'proxy',
    apiUrl: 'http://127.0.0.1:9000', url: '', mode: 'embed', hasCredentials: true, revision: 'related-fixture', staleAfterSeconds: 120, order: 0 };
  const overview = () => ({ generatedAt: stamp(), projects: [{ project, state: 'online', freshness: 'static', message: '', checkedAt: null, updatedAt: null, latencyMs: 1, diagnostics: [], metrics: [] }] });
  const position = (symbol, side, entryPrice, unrealizedPnl, cycle) => ({ id: `fixture-${symbol}`, symbol, instrumentId: symbol, side, quantity: '10', quantityUnit: 'contracts',
    contractSize: '1', entryPrice, markPrice: null, notional: null, unrealizedPnl, leverage: '3', liquidationPrice: null,
    priceCurrency: 'USDT', notionalCurrency: 'USDT', pnlCurrency: 'USDT', marginMode: 'cross', sourceUpdatedAt: stamp(), ...(cycle ? { cycle } : {}) });
  const closed = () => ({ status: 'complete', since: new Date(Date.now() - 86_400_000).toISOString(), closedQuantity: '4', closePrice: '63.1', realizedPnl: '8.75', fees: '-0.42', funding: '0.11', net: '8.44', currency: 'USDT', note: null, updatedAt: stamp() });
  const failed = () => ({ status: 'unavailable', since: null, closedQuantity: null, closePrice: null, realizedPnl: null, fees: null, funding: null, net: null, currency: null, note: '本轮成交读取失败，稍后重试', updatedAt: stamp() });
  let matchingCount = null, positionsUnavailable = false, sourceUnavailable = false;
  const positionsState = () => {
    const state = { generatedAt: stamp(), sources: [{ projectId: 'asset-fixture', name: 'Asset', status: 'ready', error: null, checkedAt: stamp(), data: { schemaVersion: 1, generatedAt: stamp(), exchanges: [
    { id: 'binance', name: 'Binance', accounts: [{ id: 'account-fixture', name: '账户', configured: true, revision: 'r1', scopes: [{ id: 'usdm', label: 'U 本位合约', status: 'live', refreshing: false, fetchedAt: stamp(), error: null,
      positions: [position('CLUSDT', 'long', '62', '12.5', closed()), position('BZUSDT', 'short', '66', '-3.25', failed()), position('XAUUSDT', 'long', '4000', '1')] }] }] }] } }] };
    if (matchingCount !== null) {
      const exchange = state.sources[0].data.exchanges[0];
      const extra = structuredClone(exchange); extra.id = 'bybit'; extra.name = 'Bybit';
      extra.accounts[0].scopes[0].positions = Array.from({ length: matchingCount - 3 }, () => position('CLUSDT', 'long', '62', '0'));
      exchange.accounts[0].scopes[0].positions = exchange.accounts[0].scopes[0].positions.slice(0, 2);
      const hiddenDuplicate = structuredClone(exchange);
      hiddenDuplicate.accounts[0].scopes[0].positions = [position('CLUSDT', 'long', '62', '0')];
      state.sources[0].data.exchanges.push(extra, hiddenDuplicate);
    }
    if (sourceUnavailable) state.sources.push({ projectId: 'asset-missing', name: 'Asset 备用账本', status: 'unavailable', error: '来源不可用', checkedAt: stamp(), data: null });
    return state;
  };
  const errors = [], unexpected = [], external = [];
  let positionReads = 0;
  page.on('pageerror', error => errors.push(error.message));
  const candles = await (await page.request.get(`${monitorBuild}/oil/data/binance-15m.json`)).json();
  const monitorApi = (path, send) => {
    const now = Date.now(), iso = t => new Date(t).toISOString();
    if (path === '/api/monitors') return send({ schemaVersion: 1, monitors: ['oil', 'cl-xau', 'hynix', 'perpetual'].map(id => ({ id, runtime: { available: true, monitorId: id, enabled: true, running: true, revision: 0 } })) });
    if (path === '/api/monitors/oil/quote') { const leg = (coin, markPx) => ({ coin, markPx, fundingRate: 0.0001, fundingIntervalHours: 4, nextFundingAt: iso(now + 3_600_000) }); return send({ source: 'Binance', currency: 'USDT', status: 'live', fetchedAt: iso(now - 2000), brent: leg('BZUSDT', 66.42), wti: leg('CLUSDT', 62.85), collection: { maxAgeMs: 75_000 } }); }
    if (path === '/api/monitors/oil/candles/15m') return send({ ...candles, status: 'live', metadata: { ...candles.metadata, fetchedAt: iso(now) } });
    return send({ error: 'Controlled unavailable response' }, 503);
  };
  const handler = async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin === moduleOrigin) {
      if (request.method() !== 'GET') { unexpected.push(`module ${request.method()} ${path}`); return send({ error: 'Fixture rejects writes' }, 405); }
      if (path.startsWith('/api/')) return monitorApi(path, send);
      return route.fulfill({ response: await route.fetch({ url: monitorBuild + path + url.search }) });
    }
    if (url.origin !== origin) { external.push(url.href); return route.abort('blockedbyclient'); }
    if (request.method() !== 'GET' && !(request.method() === 'POST' && path === '/api/projects/monitor/launch')) { unexpected.push(`${request.method()} ${path}`); return send({ error: 'Fixture rejects writes' }, 405); }
    if (path === '/api/projects/monitor/launch') return send({ url: `${moduleOrigin}/?monitor=oil` });
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'related-fixture-only' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/overview/events' || path === '/api/system/updates/events') return route.abort();
    if (path === '/api/overview') return send(overview());
    if (path === '/api/system/updates') return send({ enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null });
    if (path === '/api/trading/positions') { positionReads += 1; return positionsUnavailable ? send({ error: 'Fixture positions unavailable' }, 503) : send(positionsState()); }
    if (path.startsWith('/api/')) { unexpected.push(`${request.method()} ${path}`); return send({ error: `Unexpected API ${path}` }, 404); }
    return route.continue();
  };
  await page.route('**/*', handler);
  await page.setViewportSize({ width: 1440, height: 900 });
  try {
    await page.goto(`${origin}/?view=project&id=monitor`);
    const frame = page.frameLocator('iframe[title="monitor模块"]');
    const panel = frame.locator('[data-related-positions="oil"][data-status="ok"]');
    await panel.waitFor({ timeout: 20_000 });
    await frame.locator('.hub-header').waitFor({ state: 'hidden' });
    const text = await panel.innerText();
    assert(text.includes('CLUSDT') && text.includes('BZUSDT') && !text.includes('XAUUSDT'), `oil panel lists only CL and BZ positions: ${text}`);
    const pair = panel.locator('[data-pair-status="paired"]');
    assert(await pair.count() === 1, 'one Binance CL/BZ pair is recognised');
    const pairText = await pair.innerText();
    assert(/开仓价差\s*\+6\.452%/.test(pairText), `opening spread from entry prices: ${pairText}`);
    assert(text.includes('+12.50 USDT') && text.includes('−3.25 USDT'), `PnL is shown to cents: ${text}`);
    const totals = await pair.locator('[data-pair-totals="unavailable"]').innerText();
    assert(/未实现盈亏\s*\+9\.25 USDT/.test(totals) && /总盈亏\s*—/.test(totals) && totals.includes('已实现部分暂不可用'), `pair totals add the open legs and explain the missing realized half: ${totals}`);
    assert(/平仓价差\s*—/.test(pairText) && /价差变化\s*[+−]\d+\.\d{3} 百分点/.test(pairText), `closing spread needs both legs closed; change uses the live spread: ${pairText}`);
    const cycle = await panel.locator('[data-cycle-status="complete"]').innerText();
    assert(/平仓数量\s*4 contracts/.test(cycle) && /平仓均价\s*63\.1/.test(cycle) && /已实现盈亏\s*\+8\.75 USDT/.test(cycle)
      && /手续费\s*−0\.42 USDT/.test(cycle) && /资金费\s*\+0\.11 USDT/.test(cycle) && /净额\s*\+8\.44 USDT/.test(cycle), `closed-trade summary per leg: ${cycle}`);
    assert(text.includes('本轮平仓：本轮成交读取失败，稍后重试'), `an unavailable summary explains itself: ${text}`);
    assert(await frame.locator('[data-detail-alerts]').count() === 1, 'alert digest is in the side column');
    const reads = positionReads;
    await panel.getByRole('button', { name: '在交易中心查看' }).click();
    await page.getByRole('heading', { name: '交易所仓位', exact: true }).waitFor();
    const target = new URL(page.url()).searchParams;
    assert(target.get('view') === 'trading' && target.get('tradingSection') === 'positions', `open-trading url ${page.url()}`);
    assert(reads >= 1, 'positions were read through the host');

    for (const count of [49, 50, 51, 60]) {
      matchingCount = count;
      await page.goto(`${origin}/?view=project&id=monitor`);
      await panel.waitFor({ timeout: 20_000 });
      assert(await panel.locator('.related-positions-list > li').count() === Math.min(count, 50), `the ${count}-match list keeps the 50-item cap`);
      const text = await panel.innerText();
      assert(!await panel.locator('[data-pair-status="paired"]').count(), 'a hidden or visible duplicate cannot confirm a unique pair');
      if (count > 50) {
        assert(text.includes(`仅显示前 50 条（共 ${count} 条匹配）`), `the range is explicit: ${text}`);
        assert(text.includes('持仓列表不完整，暂不确认配对'), 'the missing pairing conclusion is explained');
      } else {
        assert(!text.includes('仅显示前') && !text.includes('持仓列表不完整'), 'an uncapped list does not claim truncation');
      }
    }
    sourceUnavailable = true;
    await page.goto(`${origin}/?view=project&id=monitor`);
    await panel.waitFor({ timeout: 20_000 });
    const mixedText = await panel.innerText();
    assert(mixedText.includes('部分数据源不可用，列表可能不完整') && mixedText.includes('仅显示前 50 条（已读取部分中共 60 条匹配）'), `source failure and truncation are both explained: ${mixedText}`);
    assert(!await panel.locator('[data-pair-status="paired"]').count(), 'mixed source failure and truncation cannot confirm a pair');
    positionsUnavailable = true;
    await page.clock.install();
    await page.clock.fastForward(61_000);
    const kept = frame.locator('[data-related-positions="oil"][data-status="unavailable"]');
    await kept.waitFor({ timeout: 20_000 });
    const keptText = await kept.innerText();
    assert(keptText.includes('仅显示前 50 条（已读取部分中共 60 条匹配）') && keptText.includes('部分数据源不可用') && keptText.includes('保留 ') && keptText.includes('持仓列表不完整，暂不确认配对'), `a failed refresh preserves source completeness and range metadata: ${keptText}`);
    assert(!await kept.locator('[data-pair-status="paired"]').count(), 'kept truncated data still cannot confirm a pair');
    assert(await kept.locator('.related-positions-list > li').count() === 50, 'the previous capped list remains visible');
    assert(!unexpected.length && !external.length && !errors.length, JSON.stringify({ unexpected, external, errors }));
    return { passed: true, positionReads, scenarios: ['real Monitor connects through the bridge', 'oil positions filtered to CL/BZ', 'opening spread paired by exchange', 'PnL rounded to cents', 'pair totals and closing spread', 'closed-trade summary per leg', 'alert digest beside chart', 'open-trading to positions', '49/50/51/60-match range boundaries', 'truncated lists cannot confirm unique pairs', 'source failure and truncation are both visible', 'failed refresh retains truncation metadata'] };
  } finally {
    await page.goto('about:blank').catch(() => {});
    await page.unroute('**/*', handler);
  }
}
