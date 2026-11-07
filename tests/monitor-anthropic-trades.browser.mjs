// Root production preview on 4182; Monitor ssr-browser-server.mjs on 3192.
// Run with playwright-cli run-code --filename. Every API is isolated; no account services are contacted.
async page => {
  const origin = 'http://hub.localhost:4182', moduleOrigin = 'http://p-0123456789abcdef01234567.hub.localhost:4182';
  const monitorBuild = 'http://127.0.0.1:3192', day = 86_400_000, step = 900_000;
  const now = Date.now(), end = Math.floor(now / step) * step - step, stamp = new Date(now).toISOString();
  const iso = time => new Date(time).toISOString(), check = (value, message) => { if (!value) throw new Error(message); };
  const project = { id: 'monitor', name: 'monitor', description: '', category: 'other', adapter: 'monitor', enabled: true, embedded: true, accessMode: 'proxy', apiUrl: 'http://127.0.0.1:9000', url: '', mode: 'embed', hasCredentials: true, revision: 'ant-trades-fixture', staleAfterSeconds: 120, order: 0 };
  const overview = { generatedAt: stamp, projects: [{ project, state: 'online', freshness: 'static', message: '', checkedAt: null, updatedAt: null, latencyMs: 1, diagnostics: [], metrics: [] }] };
  const samples = Array.from({ length: 40 * 96 }, (_, index) => ({ time: end - (40 * 96 - 1 - index) * step, binance: 1270, xyz: 80, io: 1670, rh: 835 }));
  const candles = { status: 'live', metadata: { source: 'Binance + Hyperliquid + rh-Lighter', symbols: ['ANTHROPICUSDT', 'xyz:ANT', 'io:ANTH', 'ANTHROPIC'], interval: '15m', timezone: 'UTC', priceBasis: 'Completed 15-minute candle closes', fetchedAt: stamp, firstObservation: iso(samples[0].time), lastObservation: iso(end), rows: samples.length, errors: {} }, data: samples };
  const quote = { fetchedAt: stamp, errors: {}, binance: { markPx: 1270, fundingRate: 0, nextFundingTime: null }, xyz: { markPx: 80, fundingRate: 0, oraclePx: 80 }, io: { markPx: 1670, fundingRate: 0, oraclePx: 1670 }, rh: { markPx: 835, fundingRate: null, indexPx: 835 } };
  const cycle = (overrides = {}) => ({ status: 'complete', since: iso(end - 3 * day), closedQuantity: '0', closePrice: null, realizedPnl: '0', fees: '-14.77', funding: '3.28', net: '-11.49', currency: 'USDT', note: null, updatedAt: stamp, ...overrides });
  const position = (symbol, unrealizedPnl, pnlCurrency, extra = {}) => ({ symbol, instrumentId: symbol, side: 'long', quantity: '2', quantityUnit: 'ANTHROPIC', entryPrice: '1200', markPrice: '1210', unrealizedPnl, pnlCurrency, ...extra });
  const exchange = (id, name, positions) => ({ id, name, accounts: [{ id: 'main', name: '主账户', scopes: [{ id: 'perp', status: 'live', fetchedAt: stamp, positions }] }] });
  const positions = { generatedAt: stamp, sources: [{ projectId: 'asset', name: 'Asset', status: 'ready', data: { exchanges: [
    exchange('binance', 'Binance', [position('ANTHROPICUSDT', '-1298.80', 'USDT', { side: 'short', quantity: '33.84', entryPrice: '1349.8098', cycle: cycle() })]),
    exchange('rh-lighter', 'Lighter RH', [position('ANTHROPIC', '1705.13', 'USDG', { quantity: '24.73130', entryPrice: '1530.9' })]),
  ] } }] };
  const legs = { sources: [{ exchange: 'hyperliquid', connected: true, state: 'live', fetchedAt: stamp, positions: [] }] };
  const lookbackStart = iso(now - 85 * day);
  const fill = (id, time, close, venue = 'binance') => ({ id, symbol: venue === 'okx' ? 'ANTHROPIC-USDT-SWAP' : 'ANTHROPICUSDT', base: 'ANTHROPIC', time: iso(time), side: close ? 'sell' : 'buy', positionSide: 'net', quantity: '2', quantityUnit: venue === 'okx' ? '张' : 'ANTHROPIC', price: venue === 'okx' ? '127' : '1270', priceCurrency: 'USDT', fee: '-0.1', feeCurrency: 'USDT', realizedPnl: close ? '4' : '0', positionBefore: close ? '2' : '0', positionAfter: close ? '0' : '2' });
  const fills = { generatedAt: stamp, sources: [{ projectId: 'asset', name: 'Asset', status: 'ready', data: { schemaVersion: 1, generatedAt: stamp, lookbackStart, exchanges: ['binance', 'okx'].map(venue => ({ id: venue, name: venue === 'binance' ? 'Binance' : 'OKX', accounts: [{ id: 'main', name: '主账户', scopes: [{ id: venue === 'binance' ? 'um' : 'swap', status: 'live', refreshing: false, fetchedAt: stamp, coverageStart: lookbackStart, coverageEnd: stamp, truncated: false, fills: [fill('entry', end - 2 * day + 60_000, false, venue), fill('exit', end - day + 60_000, true, venue), fill('old', end - 20 * day + 60_000, false, venue)] }] }] })) } }] };
  const native = structuredClone(fills.sources[0]); native.projectId = 'anthropic-history'; native.name = 'ANT原生成交';
  native.data.exchanges = [{ id: 'rh-lighter', name: 'Lighter RH', accounts: [{ id: '22163', name: '当前实盘连接账户', scopes: [{ id: 'perpetual', status: 'live', refreshing: false, fetchedAt: stamp, coverageStart: lookbackStart, coverageEnd: stamp, truncated: false,
    fills: [fill('rh-entry', end - 2 * day + 60_000, false), fill('rh-exit', end - day + 60_000, true), fill('rh-old', end - 20 * day + 60_000, false)].map(row => ({ ...row, symbol: 'ANTHROPIC', price: '1530.9', priceCurrency: 'USDG', fee: null, feeCurrency: null, realizedPnl: null })) }] }] },
    { id: 'hyperliquid', name: 'Hyperliquid', accounts: [{ id: 'main', name: '当前实盘连接主账户', scopes: [{ id: 'perpetual', status: 'live', refreshing: false, fetchedAt: stamp, coverageStart: lookbackStart, coverageEnd: stamp, truncated: true, fills: [] }] }] }];
  fills.sources.push(native);
  const errors = [], requests = [], listener = error => errors.push(error.stack ?? error.message);
  let failReads = false;
  let launchMonitor = 'anthropic';
  const handler = async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (url.origin === moduleOrigin) {
      if (request.method() !== 'GET') throw new Error(`Unexpected module write: ${path}`);
      if (path === '/api/monitors') return send({ schemaVersion: 1, monitors: ['oil', 'hynix', 'anthropic', 'perpetual'].map(id => ({ id, runtime: { available: true, monitorId: id, enabled: true, running: true, revision: 0 } })) });
      if (path === '/api/monitors/anthropic/candles/15m') return send(candles);
      if (path === '/api/monitors/anthropic/quote') return send(quote);
      if (path.startsWith('/api/')) return send({ error: 'Controlled unavailable fixture' }, 503);
      return route.fulfill({ response: await route.fetch({ url: monitorBuild + path + url.search }) });
    }
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (path === '/api/projects/monitor/launch' && request.method() === 'POST') return send({ url: `${moduleOrigin}/${launchMonitor ? `?monitor=${launchMonitor}` : ''}` });
    if (request.method() !== 'GET') throw new Error(`Unexpected host write: ${path}`);
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'ant-fixture-only' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/overview/events' || path === '/api/system/updates/events') return route.abort();
    if (path === '/api/overview') return send(overview);
    if (path === '/api/system/updates') return send({ enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null });
    if (path === '/api/trading/fills') { requests.push(url.searchParams.get('market') ?? 'oil'); return failReads ? send({ error: 'Fixture unavailable' }, 503) : send(url.searchParams.get('market') === 'anthropic' ? fills : { generatedAt: stamp, sources: [] }); }
    if (path === '/api/trading/positions') return failReads ? send({ error: 'Fixture unavailable' }, 503) : send(positions);
    if (path === '/api/trading/anthropic') return send(legs);
    if (path.startsWith('/api/')) return send({ error: 'Controlled unavailable fixture' }, 503);
    return route.continue();
  };
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.clock.install({ time: new Date(now) });
  page.on('pageerror', listener);
  await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?view=project&id=monitor`);
    await page.frameLocator('iframe[title="monitor模块"]').locator('body').evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('monitor:')) localStorage.removeItem(key); });
    await page.reload();
    const frame = page.frameLocator('iframe[title="monitor模块"]'), panel = frame.getByRole('tabpanel', { name: 'Anthropic 价差', exact: true });
    await panel.getByRole('button', { name: 'Lighter RH', exact: true }).click();
    const entry = panel.locator('.trade-marker[data-trade-type="entry"]'), exit = panel.locator('.trade-marker[data-trade-type="exit"]');
    await entry.first().waitFor(); await exit.first().waitFor();
    check(await entry.count() === 1 && await exit.count() === 1, 'one entry and exit event in the one-week chart');
    check((await entry.getAttribute('aria-label')).includes('Lighter RH 入场') && (await entry.getAttribute('aria-label')).includes('100.000%'), 'RH entry names its native venue and uses only RH chart premium');
    await entry.focus(); await page.keyboard.press('Enter');
    const details = panel.getByLabel('套利成交明细');
    await details.waitFor();
    check((await details.innerText()).includes('2 ANTHROPIC @ 1530.9 USDG'), 'RH keeps its native trade price');
    check((await details.innerText()).includes('手续费合计 未知'), 'missing RH fee is never zero');
    check((await panel.locator('.trade-status').innerText()).includes('当前实盘连接账户'), 'history account scope is explicit');
    const side = frame.locator('[data-related-positions="anthropic"]'), pair = side.locator('[data-ant-pair="rh"]');
    await pair.waitFor();
    check((await pair.innerText()).includes('Binance ↔ Lighter RH'), 'current actual pair is identified');
    check((await pair.locator('.related-pair-estimate').innerText()).includes('+394.84 USD'), 'reported known net combines both actual legs');
    check((await pair.innerText()).includes('+406.33 USD'), 'unrealized combines USDT and USDG under explicit assumption');
    check((await pair.innerText()).includes('1:1 估算') && (await pair.innerText()).includes('Lighter RH：已实现、手续费、资金费'), 'estimate assumption and missing components stay visible');
    check(await side.locator('.related-positions-list li').count() === 2, 'both original currency legs remain visible');
    for (const name of ['io:ANTH', 'xyz:ANT']) {
      await panel.getByRole('button', { name, exact: true }).click();
      await panel.locator('.trade-panel').waitFor();
      check(await panel.locator('.trade-marker').count() === 0, `${name} has no RH or ambiguous Binance marker`);
      check((await panel.locator('.trade-list-item').first().innerText()).includes('未关联组合的 CEX'), 'unassigned CEX trade remains in the list only');
      check(!(await panel.locator('.trade-list-item').allInnerTexts()).some(text => text.includes('Lighter RH 入场')), 'RH history never leaks into another comparison');
      check((await pair.innerText()).includes('+394.84 USD'), 'current pair remains RH, not retroactively reassigned by chart selection');
    }
    await panel.getByRole('button', { name: 'Lighter RH', exact: true }).click(); await entry.first().waitFor();
    const chart = panel.getByRole('region', { name: '历史价差图表', exact: true });
    await chart.getByRole('button', { name: '1 月', exact: true }).click();
    await entry.nth(1).waitFor();
    await chart.getByRole('button', { name: '1 周', exact: true }).click();
    await entry.nth(1).waitFor({ state: 'hidden' });
    await chart.getByRole('button', { name: '每股价格', exact: true }).click();
    check(await panel.locator('.trade-marker').count() === 0, 'price mode uses the fill list without incompatible axis markers');
    check(await panel.locator('.trade-list-item').count() === 4, 'native and unassigned CEX fills stay accessible in price mode');
    await chart.getByRole('button', { name: '溢价率', exact: true }).click();
    await entry.first().waitFor();
    await entry.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.playwright-cli/ant-trades-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await side.scrollIntoViewIfNeeded();
    const sizes = await side.evaluate(node => { const document = node.ownerDocument, width = document.documentElement.clientWidth; return { width, scroll: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('main *')].filter(element => element.getBoundingClientRect().right > width + 1).slice(0, 8).map(element => element.className) }; });
    await page.screenshot({ path: '.playwright-cli/ant-trades-mobile.png' });
    check(sizes.scroll <= sizes.width + 1, `ANT totals and chart fit the narrow iframe: ${JSON.stringify(sizes)}`);
    await page.setViewportSize({ width: 1440, height: 1050 });
    // Personal chart choices survive a real host/iframe reload and remain isolated per market.
    await panel.getByRole('button', { name: 'Lighter RH', exact: true }).click();
    await chart.getByRole('button', { name: '1 月', exact: true }).click();
    await chart.getByRole('button', { name: '7 日均线', exact: true }).click();
    await chart.getByRole('button', { name: '每股价格', exact: true }).click();
    await panel.getByRole('button', { name: '数据来源与覆盖范围' }).click();
    await page.reload();
    await panel.getByRole('button', { name: 'Lighter RH', exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Lighter RH', exact: true }).evaluate(node => { if (node.getAttribute('aria-pressed') !== 'true') throw Error('ANT leg was not restored'); });
    check(await chart.getByRole('button', { name: '1 月', exact: true }).getAttribute('aria-pressed') === 'true', 'ANT range restores');
    check(await chart.getByRole('button', { name: '每股价格', exact: true }).getAttribute('aria-pressed') === 'true', 'ANT chart mode restores');
    await chart.getByRole('button', { name: '溢价率', exact: true }).click();
    check(await chart.getByRole('button', { name: '7 日均线', exact: true }).getAttribute('aria-pressed') === 'false', 'ANT indicators restore');
    await chart.getByRole('button', { name: '每股价格', exact: true }).click();
    check(await panel.getByRole('button', { name: '数据来源与覆盖范围' }).getAttribute('aria-expanded') === 'true', 'ANT disclosure restores');
    await frame.getByRole('tab', { name: '原油价差', exact: true }).click();
    const oilPanel = frame.getByRole('tabpanel', { name: '原油价差', exact: true });
    const oilChart = oilPanel.getByRole('region', { name: '历史价差图表', exact: true });
    await oilChart.getByRole('button', { name: '1 周', exact: true }).waitFor();
    check(await oilChart.getByRole('button', { name: '1 周', exact: true }).getAttribute('aria-pressed') === 'true', 'ANT range does not replace oil default');
    await oilChart.getByRole('button', { name: '全部', exact: true }).click();
    await frame.getByRole('tab', { name: 'Anthropic 价差', exact: true }).click();
    check(await chart.getByRole('button', { name: '1 月', exact: true }).getAttribute('aria-pressed') === 'true', 'oil range does not replace ANT range');
    launchMonitor = '';
    await page.reload(); await panel.waitFor();
    check(await frame.getByRole('tab', { name: 'Anthropic 价差', exact: true }).getAttribute('data-state') === 'active', 'saved monitor restores without a URL selection');
    launchMonitor = 'oil';
    await page.reload(); await oilPanel.waitFor();
    check(await frame.getByRole('tab', { name: '原油价差', exact: true }).getAttribute('data-state') === 'active', 'explicit monitor URL overrides saved selection');
    check(await oilChart.getByRole('button', { name: '全部', exact: true }).getAttribute('aria-pressed') === 'true', 'oil all-history null restores independently');
    launchMonitor = 'anthropic';
    await page.reload(); await panel.waitFor();
    // Restore the earlier view so the failure-retention assertions still address its exact chart.
    await panel.getByRole('button', { name: 'Lighter RH', exact: true }).click();
    await chart.getByRole('button', { name: '1 周', exact: true }).click();
    await chart.getByRole('button', { name: '溢价率', exact: true }).click();
    await entry.first().waitFor(); await exit.first().waitFor();
    failReads = true;
    await page.clock.fastForward(301_000);
    await panel.locator('.trade-status').filter({ hasText: '刷新失败，保留上次成功数据' }).waitFor();
    await side.getByText(/保留 .* 的持仓数据/).waitFor();
    check((await pair.innerText()).includes('+394.84 USD'), 'failed refresh retains the previous nonzero estimate');
    check((await pair.innerText()).includes('保留旧数据'), 'retained estimate is visibly marked');
    check(await entry.count() === 1 && await exit.count() === 1, 'failed fill refresh retains markers');
    await frame.getByRole('tab', { name: '原油价差', exact: true }).click();
    const before = requests.filter(market => market === 'anthropic').length;
    await page.clock.fastForward(301_000);
    check(requests.filter(market => market === 'anthropic').length === before, 'inactive ANT chart stops fill reads');
    check(errors.length === 0, errors.join('\n'));
    return { passed: true, errors, markets: [...new Set(requests)], checks: ['real host bridge', 'RH entry/exit keyboard details', 'native prices', 'no RH or ambiguous CEX markers on xyz/io', 'actual pair and screenshot PnL', 'explicit 1:1 estimate and missing cycle', 'range and price modes', 'refresh failure retention', 'foreground-only reads', '390px layout', 'reload preferences', 'market isolation', 'monitor URL priority'] };
  } finally {
    page.off('pageerror', listener);
    await page.unroute('**/*', handler);
    await page.clock.resume();
    await page.setViewportSize({ width: 1440, height: 1050 });
  }
}
