// Standalone: tests/gold-oil-loading-server.mjs on 127.0.0.1:3190 after a production build.
// Real Hub: open http://hub.localhost:39154/?view=project&id=monitor, then run this file.
// Run: playwright-cli run-code --filename modules/monitor/tests/gold-oil-loading.browser.mjs
// A wrapper can call this function with { entryUrl, fixtureUrl?, chartFixtureUrl?, password?, screenshotPath? }.
// Detail responses are gated; Hub login, launch, proxy, SSR and bridge remain real.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async (page, options = {}) => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const hubEntry = 'http://hub.localhost:39154/?view=project&id=monitor';
  const entryUrl = options.entryUrl ?? (page.url().startsWith('http://hub.localhost:39154') ? hubEntry
    : 'http://127.0.0.1:3190/?monitor=oil&goldOil=cl&goldOilExchange=binance');
  const embedded = new URL(entryUrl).searchParams.get('view') === 'project';
  const variants = ['binance/cl', 'binance/bz', 'bybit/cl', 'bybit/bz'];
  const counts = Object.fromEntries(variants.map(key => [key, { quote: 0, chart: 0, history: 0, funding: 0 }]));
  const errors = [], writes = [], pending = [], launches = [], external = [], modes = new Map(), reports = new Map();
  const chartRequests = [], chartResponses = [], aborted = [];
  let app, seed, moduleOrigin, resolveSeed;
  const seedReady = new Promise(resolve => { resolveSeed = resolve; });
  const onError = error => errors.push({ message: error.message, stack: error.stack });
  const onRequest = request => { if (/\/api\/projects\/monitor\/launch$/.test(new URL(request.url()).pathname)) launches.push(request.url()); };
  const onRequestFailed = request => { if (/\/cl-xau\/.*chart\?/.test(request.url()) && /abort|cancel/i.test(request.failure()?.errorText ?? '')) aborted.push(request.url()); };
  const eventually = async (predicate, message) => {
    for (let i = 0; i < 150; i++) { if (await predicate()) return; await page.waitForTimeout(20); }
    throw Error(message);
  };
  const advance = async ms => {
    // Bounded virtual-clock steps let real Hub responses settle before deadlines.
    for (let left = ms; left > 0; left -= 5000) { await page.clock.runFor(Math.min(left, 5000)); await page.waitForTimeout(20); }
  };
  const market = key => { const source = key.startsWith('bybit/') ? seed.bybit : seed; return key.endsWith('/bz') ? source.bz : source; };
  const release = async (key, range, result = 'success') => {
    modes.set(`${key}/${range}`, result);
    const selected = pending.filter(item => !item.released && item.key === key && item.range === range);
    check(selected.length > 0, `No held ${key}/${range} request to release`);
    for (const item of selected) { item.released = true; item.resolve(result); }
    await Promise.all(selected.map(item => item.finished));
  };
  const routeHandler = async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, entry = new URL(entryUrl);
    const local = url.origin === entry.origin || embedded && url.port === entry.port && /^p-[a-f0-9]+\.hub\.localhost$/.test(url.hostname);
    if (!local) { external.push(url.href); return route.abort('blockedbyclient'); }
    if (embedded && url.origin === entry.origin) return route.fallback();
    if (!path.startsWith('/api/')) return route.fallback();
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(`${request.method()} ${url.href}`);
      return route.fulfill({ status: 405, json: { error: 'Fixture rejects market/config writes' } });
    }
    const match = path.match(/^\/api\/monitors\/cl-xau\/(bybit\/)?(bz\/)?(quote|chart|history|funding)$/);
    if (!match) return embedded ? route.fallback() : route.fulfill({ status: 503, json: { error: 'unrelated fixture' } });
    const key = `${match[1] ? 'bybit' : 'binance'}/${match[2] ? 'bz' : 'cl'}`, action = match[3];
    counts[key][action]++;
    if (action === 'history' || action === 'funding') return route.fulfill({ status: 410, json: { error: 'Full source reads are forbidden from the chart UI' } });
    await seedReady;
    if (action === 'quote') return route.fulfill({ json: market(key).quote }).catch(() => {});
    const range = url.searchParams.get('range');
    chartRequests.push({ key, range });
    if (!['1d', '7d', '1m', 'all'].includes(range)) return route.fulfill({ status: 400, json: { error: 'An explicit supported chart range is required' } });
    let outcome = modes.get(`${key}/${range}`) ?? 'hold', finish;
    if (outcome === 'hold') {
      const finished = new Promise(resolve => { finish = resolve; });
      outcome = await new Promise(resolve => pending.push({ key, range, resolve, finished, released: false }));
    }
    try {
      if (outcome === 'fail') return await route.fulfill({ status: 503, json: { error: 'fixture outage' } });
      // Exercise the production projector in the fixture server, never copy its window logic here.
      const fixtureUrl = new URL(options.chartFixtureUrl ?? `${moduleOrigin}/__chart-fixture`);
      fixtureUrl.search = new URLSearchParams({ exchange: key.split('/')[0], oilType: key.split('/')[1], range, scenario: outcome }).toString();
      // Chromium resolves the Hub's *.localhost module hosts; Node's APIRequest
      // client does not resolve those synthetic hosts on every Windows setup.
      const response = await app.evaluate(async url => {
        const value = await fetch(url), body = await value.text();
        return { ok: value.ok, status: value.status, body, bytes: new TextEncoder().encode(body).length };
      }, fixtureUrl.href);
      check(response.ok, `Chart fixture failed: ${response.status} ${fixtureUrl.href}`);
      const report = JSON.parse(response.body);
      reports.set(`${key}/${range}`, report);
      chartResponses.push({ key, range, scenario: outcome, bytes: response.bytes, points: report.history?.points.length ?? 0 });
      await route.fulfill({ contentType: 'application/json', body: response.body });
    }
    catch { /* Switching variants can cancel a deliberately held old read. */ }
    finally { finish?.(); }
  };
  page.on('pageerror', onError); page.on('request', onRequest); page.on('requestfailed', onRequestFailed);
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.clock.install({ time: new Date() });
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.addInitScript(() => {
    localStorage.removeItem('market-monitor.goldOil');
    localStorage.removeItem('market-monitor.goldOilExchange');
  });
  await page.route('**/*', routeHandler);
  try {
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
    if (embedded) {
      await eventually(async () => await page.locator('input[type=password]').isVisible()
        || await page.locator('iframe[title="Market Monitor模块"]').count() > 0, 'Hub did not show login or the monitor iframe');
      if (await page.locator('input[type=password]').isVisible()) {
        await page.getByLabel('工作台密码').fill(options.password ?? 'monitor-loading-browser-fixture');
        await page.getByRole('button', { name: '登录', exact: true }).click();
      }
      const iframe = page.locator('iframe[title="Market Monitor模块"]');
      await iframe.waitFor();
      await eventually(async () => {
        app = await (await iframe.elementHandle())?.contentFrame();
        return app && await app.locator('#market-initial-data').count() === 1;
      }, 'the real monitor document did not load');
      moduleOrigin = new URL(app.url()).origin;
      check(launches.length > 0, 'the real Hub launch endpoint must be exercised');
    } else { app = page.mainFrame(); moduleOrigin = new URL(entryUrl).origin; }
    const fixtureResponse = await app.evaluate(async url => {
      const response = await fetch(url);
      return { ok: response.ok, value: response.ok ? await response.json() : null };
    }, options.fixtureUrl ?? `${moduleOrigin}/__fixture`);
    check(fixtureResponse.ok, 'the test source fixture must be readable through the module origin');
    seed = fixtureResponse.value; resolveSeed();
    await page.clock.setSystemTime(new Date(seed.quote.fetchedAt));
    const props = JSON.parse(await app.locator('#market-initial-data').textContent()), initial = props.initial['cl-xau'];
    const initialMarkets = { 'binance/cl': initial, 'binance/bz': initial.bz, 'bybit/cl': initial.bybit, 'bybit/bz': initial.bybit.bz };
    for (const key of variants) {
      const value = initialMarkets[key];
      check(value.quote && value.history === null && value.funding === null && value.trend?.points.length > 0,
        `${key} SSR must carry quote and bounded overview trend without full history/funding`);
    }
    check(props.initialMonitor === 'oil', 'initial page must be an unrelated market before any gold/oil detail visit');
    const overview = app.getByRole('article', { name: '金油比', exact: true });
    const spark = overview.locator('.size-spark'), sparkLines = overview.locator('.spark-line');
    const panel = app.getByRole('tabpanel', { name: '金油比', exact: true, includeHidden: true }).locator('.oil-panel');
    const price = panel.locator('.gold-chart .gold-chart-svg'), fees = panel.locator('.gold-funding-chart .gold-chart-svg');
    const summaryAverage = panel.locator('.summary-average > div');
    const fullSummary = panel.locator('.metrics .metric').nth(3);
    const totalDetails = () => Object.values(counts).reduce((sum, count) => sum + count.chart + count.history + count.funding, 0);
    const held = (key, range) => pending.some(item => !item.released && item.key === key && item.range === range);
    const expectPending = async () => {
      await panel.getByText(/^(正在读取所选区间历史…|历史数据尚未就绪，后台采集中…)$/).waitFor();
      check(await price.count() === 0 && await fees.count() === 0, 'overview seed must not masquerade as full price/funding charts');
      check(await summaryAverage.innerText() === '—', 'pending detail statistics must stay unknown');
      check((await panel.locator('.data-details .table-count').innerText()).trim() === '0 条', 'overview points must not populate the full detail table');
      check((await panel.locator('.funding-history-status').innerText()).includes('等待资金费数据'), 'funding coverage must stay unknown while waiting');
    };
    const expectStatistics = async (key, range) => {
      await eventually(() => reports.get(`${key}/${range}`)?.history, `${key}/${range} did not deliver price history`);
      const rows = reports.get(`${key}/${range}`).history.points, valid = rows.filter(row => row.ratio !== null);
      const average = valid.reduce((sum, row) => sum + row.ratio, 0) / valid.length;
      await price.waitFor();
      await eventually(async () => await summaryAverage.innerText() === average.toFixed(3), `${key}/${range} statistics did not replace the pending state`);
      check((await panel.locator('.data-details .table-count').innerText()).trim() === `${rows.length} 条`, `${key}/${range} details must use every record from the selected window`);
      check((await panel.locator('.gold-chart').getAttribute('aria-label')).includes(`${valid.length} 个有效样本`), `${key}/${range} statistics must count all valid selected records`);
    };
    await spark.waitFor();
    const initialLines = await sparkLines.evaluateAll(nodes => nodes.map(node => node.getAttribute('d')));
    await advance(1000);
    check(totalDetails() === 0, 'initial unrelated market must not fetch any of the four gold/oil detail histories');
    await app.getByRole('tab', { name: '海力士 ADR', exact: true }).click(); await advance(1000);
    check(totalDetails() === 0, 'switching between unrelated markets must not start gold/oil detail reads');
    await app.getByRole('tab', { name: '金油比', exact: true }).click();
    await eventually(() => held('binance/cl', '7d'), 'selected seven-day chart request did not start');
    await expectPending();
    await advance(10_000);
    check((await panel.locator('.metric.featured').innerText()).includes('50.000'), 'current quote remains visible from its lightweight seed');
    check(JSON.stringify(await sparkLines.evaluateAll(nodes => nodes.map(node => node.getAttribute('d')))) === JSON.stringify(initialLines),
      'held detail reads must preserve the existing overview trend');
    check(counts['binance/cl'].chart === 1 && variants.slice(1).every(key => counts[key].chart === 0), 'only the selected combination may start a chart read');
    check(chartRequests.every(request => request.range === '7d'), 'initial detail reads must explicitly request seven days');
    // Empty persisted sources are pending, then recover on the bounded short poll.
    await release('binance/cl', '7d', 'pending'); await expectPending();
    modes.set('binance/cl/7d', 'hold');
    const beforeRetry = counts['binance/cl'].chart;
    await advance(2000);
    check(counts['binance/cl'].chart === beforeRetry, 'pending sources must not trigger a tight retry loop');
    await advance(1100);
    await eventually(() => held('binance/cl', '7d'), 'pending sources must retry after approximately three seconds');
    await release('binance/cl', '7d', 'price-only'); await expectStatistics('binance/cl', '7d');
    check(await fees.count() === 0, 'missing funding must not block the available price chart');
    check(reports.get('binance/cl/7d').history.points.length === 672, 'default details use 672 candles despite the 20,000-candle source');
    const partialSummary = await fullSummary.innerText();
    // Reactivating an incomplete cache must read immediately instead of waiting
    // for the full one-minute interval after its short retry was cancelled.
    modes.set('binance/cl/7d', 'hold');
    await app.getByRole('tab', { name: '海力士 ADR', exact: true }).click();
    await app.getByRole('tab', { name: '金油比', exact: true }).click();
    await eventually(() => held('binance/cl', '7d'), 'reactivating a partial cache must immediately read the missing dataset');
    await release('binance/cl', '7d');
    await fees.waitFor(); await expectStatistics('binance/cl', '7d');
    check(await fullSummary.innerText() === partialSummary, 'funding recovery must not alter the full-history price summary');
    check((await panel.locator('.gold-line[data-series=ratio]').getAttribute('d')).split('M').length === 3, 'missing price period produces two separate subpaths');
    const sevenDayReport = reports.get('binance/cl/7d'), fullSummaryText = await fullSummary.innerText();
    const sevenDayResponse = chartResponses.find(response => response.key === 'binance/cl' && response.range === '7d' && response.scenario === 'success');
    check(sevenDayResponse.bytes < 250_000, 'default chart response stays below 250 KB with a long source history');

    // A cancelled one-day response must not populate the currently selected month.
    await panel.getByRole('button', { name: '1 天', exact: true }).click();
    await eventually(() => held('binance/cl', '1d'), 'one-day selection must request its own chart');
    await expectPending();
    await panel.getByRole('button', { name: '1 月', exact: true }).click();
    await eventually(() => held('binance/cl', '1m'), 'monthly selection must request its own chart');
    await release('binance/cl', '1d'); await expectPending();
    await release('binance/cl', '1m'); await expectStatistics('binance/cl', '1m');
    check(await fullSummary.innerText() === fullSummaryText, 'full-history summary stays stable when the selected window changes');
    const beforeCachedSwitch = totalDetails();
    await panel.getByRole('button', { name: '1 周', exact: true }).click();
    await expectStatistics('binance/cl', '7d'); await advance(100);
    check(totalDetails() === beforeCachedSwitch, 'returning to an unexpired range reuses its own cached report');
    check(!chartRequests.some(request => request.range === 'all'), 'full history must not be requested before selecting all');
    await panel.getByRole('button', { name: '全部', exact: true }).click();
    await eventually(() => held('binance/cl', 'all'), 'all-history selection must start its own request');
    await release('binance/cl', 'all'); await expectStatistics('binance/cl', 'all');
    const allReport = reports.get('binance/cl/all');
    const allResponse = chartResponses.find(response => response.key === 'binance/cl' && response.range === 'all');
    check(allReport.history.points.length === 20_000 && allResponse.bytes > sevenDayResponse.bytes * 20, 'only all-history selection transfers the large source window');
    check(JSON.stringify(allReport.fullHistory) === JSON.stringify(sevenDayReport.fullHistory), 'full-history summary is independent of response range');
    check(await fullSummary.innerText() === fullSummaryText, 'all-history selection preserves the same global summary in the UI');
    await panel.getByRole('button', { name: '1 天', exact: true }).click();
    await expectStatistics('binance/cl', '1d'); await fees.waitFor();
    await price.evaluate(node => { node.dataset.retained = 'original'; });
    await fees.evaluate(node => { node.dataset.retained = 'original'; });
    await panel.getByRole('button', { name: '黄金 / 原油价格', exact: true }).click();
    await panel.getByRole('slider', { name: '按15分钟查看图表数值' }).press('Home');
    const reading = await panel.locator('.gold-cursor-reading').innerText(), beforeHidden = totalDetails();
    modes.set('binance/cl/1d', 'hold');
    await app.getByRole('tab', { name: '海力士 ADR', exact: true }).click(); await advance(61_000);
    check(totalDetails() === beforeHidden, 'inactive charts must not fetch selected histories for any combination');
    await app.getByRole('tab', { name: '金油比', exact: true }).click();
    await eventually(() => held('binance/cl', '1d'), 'returning must refresh the expired selected report');
    check(await price.getAttribute('data-retained') === 'original' && await fees.getAttribute('data-retained') === 'original', 'market switches retain both actual SVG nodes');
    check(await panel.getByRole('button', { name: '1 天', exact: true }).getAttribute('aria-pressed') === 'true', 'selected range is retained');
    check(await panel.locator('.gold-cursor-reading').innerText() === reading, 'full-record cursor is retained');
    await release('binance/cl', '1d', 'fail'); await panel.getByText(/价格历史待更新/).waitFor();
    check(await price.isVisible() && await price.getAttribute('data-retained') === 'original', 'failed refresh preserves the chart and exposes stale state');
    check(await fees.getAttribute('data-retained') === 'original', 'HTTP failure also retains the selected funding curve');
    check((await panel.locator('.funding-history-status').innerText()).includes('更新中断'), 'retained funding is marked stale after an HTTP failure');
    modes.set('binance/cl/1d', 'success');
    await panel.getByRole('button', { name: '刷新数据 ↻', exact: true }).click();
    await panel.getByText(/价格历史待更新/).waitFor({ state: 'hidden' });
    check(await price.getAttribute('data-retained') === 'original', 'recovery updates the existing chart in place');
    await price.focus(); await price.press('End');
    check((await panel.locator('.gold-chart-tooltip').first().innerText()).includes('USDT/盎司'), 'keyboard query preserves explicit price units');
    await fees.focus(); await fees.press('End');
    check((await panel.locator('.gold-funding-chart .gold-chart-tooltip').innerText()).includes('% / 年'), 'funding values retain annual percent units');
    // Leave Binance BZ in flight, then select Bybit BZ before it resolves.
    await panel.getByRole('button', { name: 'BZ · 布伦特原油', exact: true }).click();
    await eventually(() => held('binance/bz', '1d'), 'Binance BZ chart read did not start');
    await panel.getByRole('button', { name: 'Bybit', exact: true }).click();
    await eventually(() => held('bybit/bz', '1d'), 'Bybit BZ chart read did not start');
    await expectPending();
    check((await panel.locator('.metric.featured').innerText()).includes('48.000'), 'Bybit BZ immediately selects its own quote seed');
    check((await overview.locator('.hub-card-heading').innerText()).includes('BZ · Bybit'), 'overview identity follows the Bybit BZ seed');
    check(await spark.isVisible(), 'Bybit BZ retains its seeded overview trend while details wait');
    await release('binance/bz', '1d'); await expectPending();
    check((await panel.locator('.metric.featured').innerText()).includes('48.000'), 'late Binance BZ replies cannot replace the selected Bybit BZ quote');
    await release('bybit/bz', '1d', 'funding-only'); await fees.waitFor();
    check(await price.count() === 0, 'available funding does not display another variant\'s prices');
    modes.set('bybit/bz/1d', 'success');
    await panel.getByRole('button', { name: '刷新数据 ↻', exact: true }).click();
    await expectStatistics('bybit/bz', '1d');
    check((await price.getAttribute('aria-label')).startsWith('Bybit'), 'the completed chart identifies its actual exchange');
    await panel.locator('.data-details summary').click();
    const latest = seed.bybit.bz.history.points.at(-1);
    check((await panel.locator('tbody tr').first().innerText()).includes(latest.xau.toFixed(2)), 'Bybit BZ details contain its own gold prices');
    check((await panel.locator('tbody tr').first().innerText()).includes('100.000'), 'Bybit BZ details contain BZ prices, not earlier CL prices');
    const caption = await panel.locator('table caption').innerText();
    check(caption.includes('Bybit ·') && caption.includes('原油 USDT/BZ，比值及变化为报价比'), 'Bybit BZ retains its distinct quote units');
    const selected = new URL(app.url());
    check(selected.searchParams.get('goldOil') === 'bz' && selected.searchParams.get('goldOilExchange') === 'bybit', 'selection persists in the actual module URL');
    check(counts['bybit/cl'].chart === 0, 'unvisited Bybit CL must never fetch chart details');
    check(variants.every(key => counts[key].history === 0 && counts[key].funding === 0), 'the UI must never fetch either full source endpoint');
    check(aborted.some(url => /\/cl-xau\/chart\?range=1d/.test(url)) && aborted.some(url => /\/cl-xau\/bz\/chart\?range=1d/.test(url)), 'changing range or variant aborts its superseded chart request');
    await page.setViewportSize({ width: 390, height: 844 }); await advance(100);
    check(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'two-axis chart fits the actual mobile module viewport');
    if (embedded) check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the host also fits the mobile viewport');
    await price.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: await price.evaluate(node => node.getBoundingClientRect().x + 100) });
    check(await panel.locator('.gold-chart .gold-chart-tooltip').isVisible(), 'touch query works on mobile');
    await price.screenshot({ path: options.screenshotPath ?? 'output/playwright/gold-oil-loading-mobile.png' });
    check(errors.length === 0 && writes.length === 0 && external.length === 0, JSON.stringify({ pageerrors: errors, writes, external }));
    return { passed: true, embedded, initialDetailReads: 0, initialLightweightVariants: 4, retainedSvgNodes: 2,
      defaultRange: '7d', defaultPoints: sevenDayResponse.points, defaultBytes: sevenDayResponse.bytes,
      allPoints: allResponse.points, allBytes: allResponse.bytes, abortedReads: aborted.length, counts, chartRequests, pageerrors: errors };
  } catch (error) {
    throw Error(JSON.stringify({ message: error.message, stack: error.stack, pageerrors: errors, counts, chartRequests, chartResponses, aborted, writes, external }, null, 2));
  } finally {
    resolveSeed();
    for (const item of pending) if (!item.released) { item.released = true; item.resolve('fail'); }
    await Promise.all(pending.map(item => item.finished));
    await page.unroute('**/*', routeHandler);
    page.off('pageerror', onError); page.off('request', onRequest); page.off('requestfailed', onRequestFailed);
    await page.clock.resume();
  }
}
