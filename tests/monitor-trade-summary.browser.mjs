// Production workbench preview on 4175 and Monitor ssr-browser-server.mjs on 3189.
// Run via playwright-cli run-code --filename tests/monitor-trade-summary.browser.mjs.
// All APIs are isolated fixtures; no account or notification services are contacted.
async page => {
  const origin = 'http://hub.localhost:4175', moduleOrigin = 'http://p-0123456789abcdef01234567.hub.localhost:4175';
  const monitorBuild = 'http://127.0.0.1:3189', day = 86_400_000, hour = 3_600_000;
  const now = Date.now(), end = Math.floor(now / hour) * hour - hour, stamp = new Date(now).toISOString();
  const iso = time => new Date(time).toISOString();
  const check = (value, message) => { if (!value) throw new Error(message); };
  const project = { id: 'monitor', name: 'monitor', description: '', category: 'other', adapter: 'monitor', enabled: true, embedded: true, accessMode: 'proxy', apiUrl: 'http://127.0.0.1:9000', url: '', mode: 'embed', hasCredentials: true, revision: 'trade-summary-fixture', staleAfterSeconds: 120, order: 0 };
  const overview = { generatedAt: stamp, projects: [{ project, state: 'online', freshness: 'static', message: '', checkedAt: null, updatedAt: null, latencyMs: 1, diagnostics: [], metrics: [] }] };
  const samples = Array.from({ length: 40 * 96 }, (_, index) => ({ time: end - (40 * 96 - 1 - index) * 900_000, brent: 110, wti: 100 }));
  const candles = { status: 'live', metadata: { source: 'Binance', currency: 'USDT', symbols: ['BZUSDT', 'CLUSDT'], interval: '15m', timezone: 'UTC', priceBasis: 'Paired completed 15-minute trade candle closes', fetchedAt: stamp, firstCommonObservation: iso(samples[0].time), lastCommonObservation: iso(end), pairedObservationRows: samples.length, expectedObservationRows: samples.length, missingObservationRows: 0 }, data: samples };
  const points = samples.filter(item => item.time % hour === 0).map(item => ({ time: item.time, adr: 45, ordinary: 400, equivalent: 40, spread: 5, premium: 12.5 }));
  function fills(market) {
    const rows = [], bases = market === 'oil' ? ['BZ', 'CL'] : ['SKHY', 'SKHYNIX'];
    const batch = (id, time, qty, close, prices, before = close ? qty : 0) => bases.forEach((base, index) => {
      const side = (index === 0) !== close ? 'sell' : 'buy', quantity = String(qty);
      const sign = index === 0 ? -1 : 1, after = before + (close ? -qty : qty);
      rows.push({ id: `${id}-${base}`, symbol: `${base}USDT`, base, time: iso(time), side, positionSide: 'net', quantity, quantityUnit: base, price: String(prices[index]), priceCurrency: 'USDT', fee: '-0.1', feeCurrency: 'USDT', realizedPnl: '0', positionBefore: String(sign * before), positionAfter: String(sign * after) });
    });
    const oil = market === 'oil', morning = Math.floor((end + 8 * hour) / day) * day - 8 * hour + 2 * hour;
    batch('entry-a', morning - 3 * day, 1, false, oil ? [110, 100] : [42, 400]);
    batch('entry-b', morning - 3 * day + hour, 3, false, oil ? [130, 105] : [46, 400], 1);
    batch('exit-a', morning - day, 1, true, oil ? [120, 110] : [44, 400], 4);
    batch('exit-b', morning - day + hour, 1, true, oil ? [100, 95] : [42, 400], 3);
    batch('old-entry', morning - 20 * day, 1, false, oil ? [120, 100] : [44, 400]);
    const lookbackStart = iso(now - 85 * day);
    return { generatedAt: stamp, sources: [{ projectId: 'asset', name: 'Asset 账本', status: 'ready', checkedAt: stamp, error: null, data: { schemaVersion: 1, generatedAt: stamp, lookbackStart, exchanges: [{ id: 'binance', name: 'Binance', accounts: [{ id: 'main', name: '主账户', configured: true, revision: 'fixture', scopes: [{ id: 'um', label: 'U 本位', status: 'live', refreshing: false, fetchedAt: stamp, coverageStart: lookbackStart, coverageEnd: stamp, truncated: false, error: null, fills: rows }] }] }] } }] };
  }
  const errors = [], markets = [], listener = error => errors.push(error.stack ?? error.message);
  const handler = async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (url.origin === moduleOrigin) {
      if (request.method() !== 'GET') throw new Error(`Unexpected module write: ${path}`);
      if (path === '/api/monitors') return send({ schemaVersion: 1, monitors: ['oil', 'hynix', 'perpetual'].map(id => ({ id, runtime: { available: true, monitorId: id, enabled: true, running: true, revision: 0 } })) });
      if (path === '/api/monitors/oil/candles/15m') return send(candles);
      if (path === '/api/monitors/hynix/history') return send({ points, status: 'live', fetchedAt: stamp, interval: '1h', firstAvailable: iso(points[0].time), warnings: [] });
      if (path.startsWith('/api/')) return send({ error: 'Controlled unavailable fixture' }, 503);
      return route.fulfill({ response: await route.fetch({ url: monitorBuild + path + url.search }) });
    }
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (path === '/api/projects/monitor/launch' && request.method() === 'POST') return send({ url: `${moduleOrigin}/?monitor=oil` });
    if (request.method() !== 'GET') throw new Error(`Unexpected host write: ${path}`);
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'trade-summary-fixture-only' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/overview/events' || path === '/api/system/updates/events') return route.abort();
    if (path === '/api/overview') return send(overview);
    if (path === '/api/system/updates') return send({ enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null });
    if (path === '/api/trading/fills') { const market = url.searchParams.get('market') ?? 'oil'; markets.push(market); return send(fills(market)); }
    if (path === '/api/trading/positions') return send({ generatedAt: stamp, sources: [] });
    if (path.startsWith('/api/')) return send({ error: 'Controlled unavailable fixture' }, 503);
    return route.continue();
  };
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1050 });
  page.on('pageerror', listener);
  await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?view=project&id=monitor`);
    const frame = page.frameLocator('iframe[title="monitor模块"]');
    await frame.locator('.trade-summary').first().waitFor();
    // #224: the first embedded hydration must not fall back to a client re-render.
    check(errors.length === 0, errors.join('\n'));
    for (const [market, title, expected] of [['oil', '原油价差', '21.250 USDT/桶'], ['hynix', '海力士 ADR', '12.500%']]) {
      await frame.getByRole('tab', { name: title, exact: true }).click();
      const panel = frame.getByRole('tabpanel', { name: title, exact: true }), entries = panel.locator('.trade-summary[data-trade-type="entry"]'), entry = entries.first(), exit = panel.locator('.trade-summary[data-trade-type="exit"]');
      await panel.getByRole('region', { name: '历史价差图表', exact: true }).getByRole('button', { name: '1 周', exact: true }).click();
      await entry.locator('summary').filter({ hasText: '4 笔' }).waitFor();
      check(await entries.count() === 1, `${market} same-day entries form one summary`);
      check((await entry.locator('summary').innerText()).includes(expected), `${market} shows weighted spread in collapsed summary`);
      check((await exit.locator('summary').innerText()).includes('4 笔'), `${market} exits aggregate independently`);
      const side = frame.locator('.monitor-detail-side');
      check((await side.locator(':scope > section').first().getAttribute('data-related-positions')) === market, `${market} related trades precede alerts`);
      check(await side.locator(':scope > section').nth(1).getAttribute('data-detail-alerts') !== null, `${market} alerts follow related trades`);
      await entry.locator('summary').focus(); await page.keyboard.press('Enter');
      await entry.locator('.trade-list-item').first().click();
      check(await panel.locator('.trade-list-item[aria-pressed="true"]').count() === 1, `${market} drill-down selects one batch`);
      check(await panel.locator('.trade-marker[data-selected="true"]').count() === 1, `${market} batch remains linked to its chart marker`);
      check((await entry.innerText()).includes('数量 4'), `${market} quantities total across batches`);
      check((await panel.locator('.trade-details').innerText()).includes('手续费合计'), `${market} original details remain available`);
      await panel.getByRole('region', { name: '历史价差图表', exact: true }).getByRole('button', { name: '1 月', exact: true }).click();
      await entries.nth(1).waitFor();
      check(await entries.count() === 2, `${market} a different date remains a separate summary`);
      check((await entry.locator('summary').innerText()).includes('4 笔'), `${market} range expansion never merges separate dates`);
      await panel.getByRole('region', { name: '历史价差图表', exact: true }).getByRole('button', { name: '1 周', exact: true }).click();
      await entries.nth(1).waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 390, height: 844 });
      const sizes = await panel.evaluate(node => ({ width: node.ownerDocument.documentElement.clientWidth, scroll: node.ownerDocument.documentElement.scrollWidth }));
      check(sizes.scroll <= sizes.width + 1, `${market} summary fits narrow iframe`);
      await entry.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `.playwright-cli/trade-summary-${market}-mobile.png` });
      await page.setViewportSize({ width: 1440, height: 1050 });
      await entry.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `.playwright-cli/trade-summary-${market}-desktop.png` });
    }
    check(markets.includes('oil') && markets.includes('hynix'), 'both markets read fills through the real workbench bridge');
    check(errors.length === 0, errors.join('\n'));
    return { passed: true, markets: [...new Set(markets)], checks: ['same-day continuous entry and exit summaries', 'weighted prices', 'separate dates', 'native workbench bridge', 'batch and chart selection', 'range changes', 'card order', 'keyboard expansion', '390px layout'], errors };
  } finally {
    page.off('pageerror', listener);
    await page.unroute('**/*', handler);
    await page.setViewportSize({ width: 1440, height: 1050 });
  }
}
