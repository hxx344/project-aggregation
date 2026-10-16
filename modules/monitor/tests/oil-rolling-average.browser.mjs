// Real Hub fixture: MONITOR_BROWSER_FIXTURE=oil node --import ./tests/fixtures/monitor-loading-workbench.mjs server/index.mjs
// Run from the repository root after production builds:
// playwright-cli run-code --filename modules/monitor/tests/oil-rolling-average.browser.mjs
// Optional wrapper arguments: { entryUrl, password, desktopScreenshot, mobileScreenshot }.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async (page, options = {}) => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const entryUrl = options.entryUrl ?? 'http://hub.localhost:39154/?view=project&id=monitor';
  const entry = new URL(entryUrl), interval = 900_000, day = 86_400_000;
  const labels = { '1d': '1 天滚动均值', '1w': '1 周滚动均值', '1m': '1 月滚动均值', all: '历史累计均值' };
  const errors = [], writes = [], external = [], reports = [], launches = [];
  let app, snapshot, historyReads = 0;
  const eventually = async (predicate, message) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await predicate()) return;
      await page.waitForTimeout(25);
    }
    throw Error(message);
  };
  // Oracle uses the raw paired prices and an explicit prefix at the selected
  // timestamp, independently of the production rollingAverages helper/cache.
  const cutoff = (end, range) => {
    if (range === 'all') return -Infinity;
    if (range !== '1m') return end - (range === '1d' ? 1 : 7) * day;
    const date = new Date(end), monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0));
    const lastDay = monthEnd.getUTCDate();
    monthEnd.setUTCDate(Math.min(date.getUTCDate(), lastDay));
    monthEnd.setUTCHours(date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds());
    return monthEnd.getTime();
  };
  const validRows = source => source.data.filter(row => row.brent !== null && row.wti !== null);
  const visibleRows = (source, range) => {
    const rows = validRows(source), start = cutoff(rows.at(-1).time + interval, range);
    return rows.filter(row => row.time >= start);
  };
  const expectedAt = (source, range, time) => {
    const start = cutoff(time + interval, range);
    const rows = validRows(source).filter(row => row.time >= start && row.time <= time);
    const count = range === 'all' ? rows.length : (time + interval - start) / interval;
    return rows.length !== count ? null : rows.reduce((sum, row) => sum + (row.brent - row.wti) / row.wti * 100, 0) / rows.length;
  };
  const onError = error => errors.push(error.message);
  const onRequest = request => { if (new URL(request.url()).pathname === '/api/projects/monitor/launch') launches.push(request.url()); };
  const routeHandler = async route => {
    const request = route.request(), url = new URL(request.url());
    const local = url.origin === entry.origin || url.port === entry.port && /^p-[a-f0-9]+\.hub\.localhost$/.test(url.hostname);
    if (!local) { external.push(url.href); return route.abort('blockedbyclient'); }
    // Login and the Hub launch/proxy remain real; all module business writes are forbidden.
    if (url.origin === entry.origin) return route.fallback();
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 405, json: { error: 'Business writes are forbidden in this fixture' } });
    }
    if (url.pathname === '/api/monitors/oil/candles/15m') {
      historyReads++;
      if (snapshot) return route.fulfill({ json: snapshot });
    }
    return route.fallback();
  };
  page.on('pageerror', onError); page.on('request', onRequest);
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.route('**/*', routeHandler);
  try {
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
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
    }, 'The real monitor SSR document did not load');
    check(launches.length > 0, 'The real Hub launch endpoint must be exercised');
    const fetchFixture = async pathname => app.evaluate(async pathname => {
      const response = await fetch(pathname);
      if (!response.ok) throw Error(`Fixture HTTP ${response.status}`);
      return response.json();
    }, pathname);
    const seed = await fetchFixture('/__fixture');
    check(seed.kind === 'oil' && seed.candles.data.length === 72 * 96, 'Start the workbench with MONITOR_BROWSER_FIXTURE=oil');
    const initial = JSON.parse(await app.locator('#market-initial-data').textContent()).initial.oil;
    check(initial.candles.data.length === seed.candles.data.length && initial.quote.brent.coin === 'BZUSDT',
      'The complete oil history and quote must arrive through real SSR');
    await app.getByRole('tab', { name: '原油价差', exact: true }).click();
    const panel = app.getByRole('tabpanel', { name: '原油价差', exact: true }).locator('.oil-panel');
    const chart = panel.locator('#main-chart'), cursor = panel.locator('#chart-cursor'), tooltip = panel.locator('#chart-tooltip');
    const average = panel.locator('#average-spread'), paths = chart.locator('path[data-series="average"]');
    await chart.waitFor({ state: 'visible' });
    await eventually(async () => await paths.count() > 0, 'The initial rolling average did not render');
    const select = async range => {
      await panel.locator(`[data-range="${range}"]`).click();
      await eventually(async () => await panel.locator('#average-label').innerText() === `最新 · ${labels[range]}`,
        `The ${range} summary label did not update`);
    };
    const assertPoint = async (source, range, index) => {
      const rows = visibleRows(source, range), expected = expectedAt(source, range, rows[index].time);
      await cursor.evaluate((node, index) => { node.value = String(index); node.dispatchEvent(new Event('input', { bubbles: true })); }, index);
      const reading = await cursor.getAttribute('aria-valuetext');
      const cell = tooltip.locator('.tooltip-row').filter({ hasText: labels[range] }).locator('strong');
      const text = expected === null ? '—' : expected.toFixed(3);
      check(await cell.innerText() === `${text}${expected === null ? '' : '%'}`, `${range} point ${index} must use only its prefix: ${text}`);
      check(reading.includes(`${labels[range]} ${text}%`), `${range} keyboard reading must include the same point mean`);
      return text;
    };
    const assertLatest = async (source, range) => {
      const rows = visibleRows(source, range), expected = expectedAt(source, range, rows.at(-1).time);
      const text = expected === null ? '—' : expected.toFixed(3);
      await eventually(async () => await average.innerText() === text, `${range} summary must equal its latest rolling point: ${text}`);
      check(Number(await cursor.getAttribute('max')) === rows.length - 1, `${range} cursor must cover every valid visible sample`);
    };
    for (const range of ['1d', '1w', '1m', 'all']) {
      await select(range); await assertLatest(seed.candles, range);
      const rows = visibleRows(seed.candles, range);
      const coordinates = await paths.evaluateAll(nodes => nodes.flatMap(node => [...node.getAttribute('d').matchAll(/[ML]([\d.-]+),([\d.-]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }))));
      check(coordinates.length === rows.length, `${range} must draw one average point per visible candle, including left-edge warmup`);
      check(new Set(coordinates.map(point => point.y)).size > 3, `${range} mean must be a changing curve`);
      for (const index of new Set([0, 1, Math.floor(rows.length / 2), rows.length - 2, rows.length - 1])) await assertPoint(seed.candles, range, index);
      await cursor.focus(); await cursor.press('Home');
      check(await cursor.inputValue() === '0', `${range} Home selects the first visible sample`);
      const firstText = await assertPoint(seed.candles, range, 0);
      await cursor.press('ArrowRight');
      check(await cursor.inputValue() === '1', `${range} ArrowRight advances one 15-minute sample`);
      await cursor.press('End');
      check(await cursor.inputValue() === String(rows.length - 1), `${range} End selects the latest sample`);
      check((await panel.locator('#average-coverage').innerText()).includes('截至该时点'), `${range} coverage explains the reference time`);
      reports.push({ range, visiblePoints: rows.length, firstAverage: firstText, latestAverage: await average.innerText() });
    }
    await select('1d');
    await panel.locator('[data-view="prices"]').click();
    check(await paths.count() === 0 && await chart.locator('path[data-series="brent"]').count() > 0
      && await chart.locator('path[data-series="wti"]').count() > 0, 'Price view shows the two oil prices without an average curve');
    await cursor.focus(); await cursor.press('End');
    check(!(await tooltip.innerText()).includes('滚动均值') && !(await cursor.getAttribute('aria-valuetext')).includes('均值'), 'Price tooltip and keyboard description use price units only');
    check(await panel.locator('#average-method').isHidden(), 'Price view hides the rolling-average method');
    await panel.locator('[data-view="spread"]').click();
    const assertHiddenCrosshair = async reason => {
      check(await tooltip.isHidden(), `${reason} hides the tooltip`);
      const hidden = await chart.locator('g[aria-hidden="true"] circle').evaluateAll(nodes => nodes.length > 0
        && nodes.every(node => getComputedStyle(node).visibility === 'hidden'));
      check(hidden, `${reason} hides every crosshair dot through the parent group`);
    };
    await cursor.focus(); await cursor.press('End');
    await chart.dispatchEvent('pointerleave'); await assertHiddenCrosshair('Pointer leave');
    await cursor.press('ArrowLeft'); await cursor.press('Escape'); await assertHiddenCrosshair('Escape');
    await cursor.press('ArrowRight');
    await panel.locator('[data-range="1d"]').focus(); await assertHiddenCrosshair('Cursor blur');
    const refreshScenario = async scenario => {
      snapshot = await fetchFixture(`/__chart-fixture?scenario=${scenario}`);
      const before = historyReads;
      await panel.locator('#refresh-data').click();
      await eventually(async () => historyReads > before && await panel.locator('#refresh-data').isEnabled(), `${scenario} snapshot refresh did not complete`);
      return snapshot;
    };
    const gap = await refreshScenario('gap'); await assertLatest(gap, '1d');
    check((await panel.locator('#average-coverage').innerText()).includes('缺口'), 'An incomplete latest window explains its missing mean');
    await assertPoint(gap, '1d', visibleRows(gap, '1d').length - 1);
    const gapPoints = await paths.evaluateAll(nodes => nodes.reduce((count, node) => count + [...node.getAttribute('d').matchAll(/[ML]/g)].length, 0));
    check(gapPoints === 48, 'The average line stops before the gap and does not bridge an incomplete rolling window');
    await select('all'); await assertLatest(gap, 'all');
    await assertPoint(gap, 'all', visibleRows(gap, 'all').length - 1);
    check(await paths.count() === 2, 'Cumulative means exclude the missing candle and keep the visual gap');
    await select('1d');
    const repaired = await refreshScenario('complete'); await assertLatest(repaired, '1d');
    check(await paths.count() === 1, 'A repaired historical candle restores the continuous average');
    const oldPoint = await assertPoint(repaired, '1d', 20), oldLatest = await average.innerText();
    const revised = await refreshScenario('revised'); await assertLatest(revised, '1d');
    check(await average.innerText() !== oldLatest, 'Refreshing changed prices invalidates the mean cache');
    check(await assertPoint(revised, '1d', 20) === oldPoint, 'A future candle correction must not alter an earlier tooltip mean');
    const short = await refreshScenario('short'); await assertLatest(short, '1d');
    check(await paths.count() === 0, 'Insufficient 12-hour history must not display a 24-hour average');
    await assertPoint(short, '1d', 47);
    await refreshScenario('complete'); await assertLatest(seed.candles, '1d');
    await chart.dispatchEvent('pointerleave');
    // Capture the actual viewport: element screenshots larger than the embedded
    // iframe can include clipped regions or unrelated parent-page content.
    await page.evaluate(() => window.scrollTo(0, 0));
    await panel.locator('.chart-panel').evaluate(node => node.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: options.desktopScreenshot ?? 'output/playwright/oil-rolling-average-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await eventually(async () => await chart.evaluate(node => node.clientWidth < 500), 'The chart did not resize for mobile');
    check(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The embedded module fits the mobile viewport');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The Hub fits the mobile viewport');
    const dimensions = await panel.locator('.chart-panel').evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }));
    check(dimensions.scrollWidth <= dimensions.width + 1, 'The chart controls, method text and summary do not overflow on mobile');
    await page.evaluate(() => window.scrollTo(0, 0));
    await panel.locator('.chart-panel').evaluate(node => node.scrollIntoView({ block: 'start' }));
    await chart.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: await chart.evaluate(node => node.getBoundingClientRect().x + 100) });
    await eventually(() => tooltip.isVisible(), 'Touch must display a point tooltip');
    check((await tooltip.innerText()).includes(labels['1d']), 'Mobile touch displays the rolling mean');
    await page.screenshot({ path: options.mobileScreenshot ?? 'output/playwright/oil-rolling-average-mobile.png' });
    check(errors.length === 0 && writes.length === 0 && external.length === 0, JSON.stringify({ errors, writes, external }));
    return { passed: true, embedded: true, seededDays: 72, reports, historyReads, launches: launches.length,
      checked: ['four non-horizontal means', 'left-edge warmup', 'prefix-only tooltip and keyboard', 'latest summary', 'price view', 'hidden crosshair', 'gap and repair', 'cache refresh', 'short history', 'mobile layout and touch'], errors };
  } catch (error) {
    throw Error(JSON.stringify({ message: error.message, stack: error.stack, errors, writes, external, reports, historyReads }, null, 2));
  } finally {
    await page.unroute('**/*', routeHandler);
    page.off('pageerror', onError); page.off('request', onRequest);
  }
}
