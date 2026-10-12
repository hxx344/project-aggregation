// Windows-native production preview: node --experimental-strip-types tests/ssr-browser-server.mjs 3193
// playwright-cli -s=perpetual-chart run-code --filename tests/perpetual-chart.browser.mjs
// Public-market fixtures only. No live collectors, account access or order requests.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Evaluated by Playwright CLI.
async page => {
  const origin = 'http://127.0.0.1:3193', anchor = Date.UTC(2026, 9, 11, 12), hour = 3_600_000, day = 24 * hour;
  const venues = [{ id: 'binance', name: 'Binance' }, { id: 'aster', name: 'Aster' }];
  const failures = [], external = [], writes = [], calls = [];
  let now = anchor, historyMode = 'ready', priceMode = 'ready';
  const check = (value, message) => { if (!value) throw Error(message); };
  const hasPercent = async (locator, expected) => [...(await locator.innerText()).matchAll(/[+−-]?\d+(?:\.\d+)?%/g)].some(match => Math.abs(Number(match[0].replace('−', '-').replace('%', '')) - expected) < 1e-8);
  // The public feed deliberately omits collateralCurrency; current directory
  // identity still joins the independently enriched funding/price histories.
  const quote = (exchange, price) => ({ exchange, base: 'BTC', symbol: 'BTCUSDT', quoteCurrency: 'USDT', multiplier: 1,
    historyIdentity: JSON.stringify([exchange, 'BTCUSDT', 'BTC', 'USDT', null, 1, null, 'USDT']),
    bid: price, ask: price, mark: price, last: price, bidAskAt: now, markAt: now, sourceTime: now, receivedAt: now, transport: 'ws',
    fundingRate: exchange === 'aster' ? .0002 : .0001, fundingIntervalHours: 8, fundingAt: now, nextFundingAt: anchor + 8 * hour,
    comparable: true, assetClass: 'crypto', identityVerified: true, identitySource: 'chart fixture' });
  const snapshot = () => ({ schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: now, staleAfterMs: 30_000, streamId: 'chart-fixture', sequence: 0,
    quotes: [quote('binance', 100), quote('aster', 102)], exchanges: venues.map(venue => ({ ...venue, kind: 'cex', status: 'live', marketCount: 1, quoteCount: 1, lastMessageAt: now, error: null })) });
  const keys = pair => [pair.longKey, pair.shortKey];
  const funding = pairs => ({ schemaVersion: 1, generatedAt: now, legs: Object.fromEntries([...new Set(pairs.flatMap(keys))].map(key => {
    const [exchange, symbol] = key.split(':'), coveredDays = historyMode === 'partial' ? 4 : 32;
    return [key, { key, exchange, symbol, identity: JSON.stringify([exchange, symbol, 'BTC', 'USDT', null, 1, null, 'USDT']), status: 'ready', fetchedAt: now,
      coverage: { from: anchor - coveredDays * day, to: anchor }, error: '', backfillComplete: historyMode !== 'partial',
      records: Array.from({ length: coveredDays * 3 + 1 }, (_, index) => ({ time: anchor - index * 8 * hour, rate: exchange === 'aster' ? .0002 : .0001 })) }];
  })) });
  const prices = pair => ({ schemaVersion: 1, generatedAt: now, intervalMs: hour, legs: Object.fromEntries(keys(pair).map(key => {
    const [exchange, symbol] = key.split(':'), unsupported = priceMode === 'unsupported';
    return [key, { key, exchange, symbol, currency: 'USDT', identity: JSON.stringify([exchange, symbol, 'BTC', 'USDT', null, 1, null, 'USDT']),
      status: unsupported ? 'unsupported' : 'ready', fetchedAt: unsupported ? null : now, from: unsupported ? null : anchor - 30 * day,
      to: unsupported ? null : anchor, backfillComplete: !unsupported, error: unsupported ? '该平台暂无已核实的小时成交价历史接口' : '',
      points: unsupported ? [] : Array.from({ length: 720 }, (_, index) => ({ time: anchor - (719 - index) * hour, close: (100 + Math.sin(index / 12)) * (exchange === 'aster' ? 1.02 : 1) })).filter((_row, index) => index !== 620) }];
  })) });
  const tick = async milliseconds => { now += milliseconds; await page.clock.runFor(milliseconds); };
  const until = async (predicate, message, budget = 5000) => {
    for (let elapsed = 0; elapsed <= budget; elapsed += 100) { if (await predicate()) return; await tick(100); }
    throw Error(message);
  };
  const errors = error => failures.push(error.message);
  await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.clock.install({ time: new Date(anchor - 1000) }); await page.clock.pauseAt(new Date(anchor));
  await page.addInitScript(({ origin, initial }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('market-monitor:perpetual:v1', JSON.stringify({ version: 2, sortBy: 'gross', minSpreadPercent: 0, search: 'BTC' }));
    localStorage.removeItem('market-monitor:perpetual-scanner-ranges:v1');
    const fixture = window.chartFixture = { created: 0, initial };
    window.EventSource = class {
      constructor() {
        fixture.created++; this.onmessage = null; this.onerror = null;
        const emit = () => {
          const value = structuredClone(fixture.initial); value.generatedAt = Date.now(); value.sequence = Math.floor(Date.now() / 1000);
          for (const item of value.quotes) for (const key of ['bidAskAt', 'markAt', 'sourceTime', 'receivedAt', 'fundingAt']) item[key] = Date.now();
          this.onmessage?.({ data: JSON.stringify(value) });
        };
        this.first = setTimeout(emit, 0); this.timer = setInterval(emit, 1000);
      }
      close() { clearTimeout(this.first); clearInterval(this.timer); }
    };
  }, { origin, initial: snapshot() });
  page.on('pageerror', errors);
  try {
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin) { external.push(url.href); return route.abort(); }
      if (!path.startsWith('/api/')) return route.continue();
      calls.push({ path, body: request.postDataJSON() });
      if (!['GET', 'HEAD'].includes(request.method()) && !['funding-history', 'price-history', 'quality', 'metrics', 'scanner-data'].some(action => path.endsWith('/perpetual/' + action))) writes.push(path);
      if (path.endsWith('/perpetual/quote')) return route.fulfill({ json: snapshot() });
      if (path.endsWith('/perpetual/crossex-settings')) return route.fulfill({ json: { available: true, generatedAt: now, revision: 0, metadataRevision: 1,
        config: { requireSpotTransfer: false, blockedBases: [] }, error: '', spotTransferPairs: [], venues: [{ exchange: 'binance', state: 'live', checkedAt: now, error: '' }] } });
      if (path.endsWith('/perpetual/funding-history')) return route.fulfill({ json: funding(request.postDataJSON().pairs) });
      if (path.endsWith('/perpetual/price-history')) return route.fulfill({ json: prices(request.postDataJSON().pair) });
      if (path.endsWith('/perpetual/quality')) return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, pairs: {}, assets: {}, assetErrors: {}, positioning: {}, positioningErrors: {} } });
      if (path.endsWith('/perpetual/metrics')) return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, legs: {} } });
      return route.fulfill({ status: 503, json: { error: 'Fixture detail unavailable' } });
    });
    await page.goto(origin + '/?monitor=perpetual');
    const entry = page.getByRole('button', { name: /^创建价差图表：BTC/ });
    await until(() => entry.isVisible(), 'The selected BTC combination must be available');
    const starred = page.getByRole('button', { name: /^收藏组合：BTC/ });
    await starred.click();
    check(!new URL(page.url()).searchParams.has('perpView'), 'Favorite actions must not navigate');
    await page.getByRole('button', { name: /^多腿24h 成交额/ }).click();
    const evidence = page.getByRole('dialog', { name: '多腿24h 成交额来源', exact: true });
    await evidence.getByText(/^来源：/).click();
    check(!new URL(page.url()).searchParams.has('perpView'), 'Clicking portalled evidence text must not navigate');
    if (await evidence.isVisible()) await evidence.getByRole('button', { name: '收起指标来源', exact: true }).click();
    await entry.click();
    const heading = page.getByRole('heading', { name: '创建价差图表', exact: true });
    await until(() => heading.isVisible(), 'Clicking a combination opens the chart workspace');
    await until(() => heading.evaluate(element => element === document.activeElement), 'The lazily loaded chart receives focus after entry');
    let params = new URL(page.url()).searchParams;
    check(params.get('chartLong') === 'binance:BTCUSDT' && params.get('chartShort') === 'aster:BTCUSDT', 'Chart direction and exact contracts match the selected pair');
    const period = days => page.getByRole('button', { name: '查看 ' + days + ' 天资金费稳定度', exact: true });
    await until(() => hasPercent(period(30), .9), 'Thirty-day actual net funding is 0.900%');
    for (const [days, total] of [[3, .09], [7, .21], [30, .9]]) {
      await period(days).click(); check(new URL(page.url()).searchParams.get('chartDays') === String(days), 'The window is shareable');
      check(await hasPercent(period(days), total), days + 'd settlement sum is correct');
      check(await period(days).getAttribute('aria-pressed') === 'true', 'The selected period is announced');
    }
    const slider = page.getByRole('slider', { name: '图表查看时间', exact: true });
    await slider.focus(); await slider.press('Home'); await slider.press('ArrowRight');
    check(await slider.inputValue() !== await slider.getAttribute('max'), 'Keyboard can inspect older timestamps');
    await page.screenshot({ path: 'output/playwright/perpetual-chart-desktop.png', fullPage: true });
    const chartUrl = page.url();
    await page.getByRole('button', { name: '交换多空', exact: true }).click();
    await until(() => hasPercent(period(30), -.9), 'Reversed historical data loads');
    params = new URL(page.url()).searchParams;
    check(params.get('chartLong') === 'aster:BTCUSDT' && params.get('chartShort') === 'binance:BTCUSDT', 'Direction swaps explicitly');
    check(await hasPercent(period(30), -.9), 'Reversing direction negates settled carry');
    await page.goBack(); await until(async () => new URL(page.url()).searchParams.get('chartLong') === 'binance:BTCUSDT' && await hasPercent(period(30), .9), 'Browser back restores the former direction');
    const positionsTab = page.getByRole('button', { name: '持仓跟踪', exact: true });
    await positionsTab.click();
    check(new URL(page.url()).searchParams.get('perpView') === 'positions', 'Positions workspace has a restorable URL');
    await page.goBack(); await until(() => heading.isVisible(), 'Back from positions restores the chart');
    await page.goForward(); await until(async () => await positionsTab.getAttribute('aria-current') === 'page', 'Forward restores positions instead of the opportunity list');
    await page.goBack(); await until(() => heading.isVisible(), 'Chart can be restored again');
    await page.getByRole('button', { name: '返回机会', exact: true }).click();
    await until(() => entry.isVisible(), 'Return restores the scanner');
    check(await page.getByRole('textbox', { name: '搜索币种', exact: true }).inputValue() === 'BTC', 'Returning retains the scanner filter');
    await page.goto(chartUrl); await until(() => heading.isVisible(), 'A direct link restores the chart');
    await until(() => hasPercent(period(30), .9), 'Reload restores thirty-day evidence');
    check(await page.evaluate(() => window.chartFixture.created) === 1, 'Opening a chart retains one quote connection');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'output/playwright/perpetual-chart-mobile.png', fullPage: true });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile layout does not overflow horizontally');

    historyMode = 'partial'; priceMode = 'unsupported';
    await page.reload(); await until(() => heading.isVisible(), 'Partial-history scenario opens');
    await until(() => hasPercent(period(3), .09), 'Three covered days remain usable during deeper backfill');
    check(!await hasPercent(period(30), .9), 'Incomplete thirty-day history is not labelled a complete return');
    await until(async () => (await page.locator('body').innerText()).includes('小时成交价历史接口'), 'Unsupported price history is explained');
    historyMode = 'ready';
    await until(() => hasPercent(period(30), .9), 'Backfill completion automatically updates the same chart', 5000);
    check(failures.length === 0 && external.length === 0 && writes.length === 0, JSON.stringify({ failures, external, writes }));
    return { passed: true, requests: calls.length, checks: ['exact pair entry', 'favorite and evidence do not navigate', '3/7/30 settlements', 'explicit reverse', 'URL reload and workspace back/forward', 'retained scanner filter', 'keyboard cursor', '390px layout', 'partial funding backfill', 'unsupported prices do not block funding'], screenshots: ['output/playwright/perpetual-chart-desktop.png', 'output/playwright/perpetual-chart-mobile.png'] };
  } finally { page.off('pageerror', errors); await page.clock.resume(); }
}
