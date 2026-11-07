// Start the production SSR fixture on 3189, then use the existing Playwright CLI session:
// playwright-cli run-code --filename tests/monitor-overview-cadence.browser.mjs
// The fixture is local; API responses and the browser clock never depend on live markets.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3189', base = Date.UTC(2026, 8, 24);
  const counts = new Map(), errors = [], scenarios = [];
  const ids = ['oil', 'hynix', 'perpetual'];
  let now = base + 29_000, failOil = true, failHistory = true, failPerpetual = false;
  let frozenOil = null;
  const count = action => counts.get(`/api/monitors/${action}`) ?? 0;
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const until = async (condition, message) => {
    const deadline = Date.now() + 10_000;
    while (!await condition()) {
      if (Date.now() >= deadline) throw Error(message);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const iso = time => new Date(time).toISOString();
  const sourceAt = () => base + Math.floor((now - base) / 30_000) * 30_000;
  const generation = time => (time - base) / 30_000;
  // Advance in 5-second steps so each interval's routed response settles before the next one fires (in-flight reads are deduplicated).
  const advance = async duration => {
    for (let left = duration; left > 0; left -= 5_000) {
      const step = Math.min(5_000, left);
      now += step; await page.clock.runFor(step); await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const pageError = error => errors.push(error.message);
  const unavailable = { status: 503, json: { error: 'Controlled unavailable response' } };
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  const response = await page.request.get(`${origin}/oil/data/binance-15m.json`);
  check(response.ok(), 'The checked-in Binance candle fixture must be available');
  const candles = await response.json();
  await page.clock.install({ time: new Date(now - 1000) });
  await page.clock.pauseAt(new Date(now));
  page.on('pageerror', pageError);
  try {
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (path === '/api/monitors') return route.fulfill({ json: { schemaVersion: 1, monitors: ids.map(id => ({ id,
        runtime: { available: true, monitorId: id, enabled: true, running: true, revision: 0 } })) } });
      if (path === '/api/monitors/oil/quote') {
        if (failOil) return route.fulfill(unavailable);
        const source = frozenOil ?? sourceAt(), fetchedAt = iso(source);
        const leg = (coin, markPx) => ({ coin, markPx, fundingRate: 0, fundingIntervalHours: 4, nextFundingAt: iso(source + 3_600_000) });
        return route.fulfill({ json: { source: 'Binance', currency: 'USDT', status: 'live', fetchedAt,
          brent: leg('BZUSDT', 102 + generation(source)), wti: leg('CLUSDT', 80), collection: { maxAgeMs: 75_000 } } });
      }
      if (path === '/api/monitors/oil/candles/15m') return route.fulfill(failHistory ? unavailable : {
        json: { ...candles, status: 'live', metadata: { ...candles.metadata, fetchedAt: iso(now) } } });
      if (path === '/api/monitors/hynix/quote') return route.fulfill({ json: { status: 'live', fetchedAt: iso(now),
        ordinary: 1000, adr: 120, equivalent: 100, spread: 20, premium: 20, funding: null, collection: { maxAgeMs: 35_000 } } });
      if (path === '/api/monitors/perpetual/summary') {
        if (failPerpetual) return route.fulfill(unavailable);
        return route.fulfill({ json: { schemaVersion: 1, monitorId: 'perpetual', available: true, status: 'live', state: 'online',
          quoteUpdatedAt: now, updatedAt: now, staleAfterMs: 30_000, baseCount: 100 + count('perpetual/summary'), quoteCount: 2000,
          exchangeCount: 7, onlineExchangeCount: 7, liveExchangeCount: 7, message: '' } });
      }
      // Detail funding/history and unrelated comparison APIs may fail without affecting fresh quote cards.
      return route.fulfill(unavailable);
    });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(`${origin}/?monitor=oil`);
    const overview = page.getByRole('region', { name: '市场行情概览' });
    const oil = overview.getByRole('button', { name: /^原油价差/ });
    const perpetual = overview.getByRole('button', { name: /^合约价差/ });
    const reading = card => card.locator('strong').first().textContent();
    const stamp = card => card.locator('time').getAttribute('datetime');
    const status = card => card.locator('.hub-card-status > span').textContent();
    const waitReading = (card, value) => until(async () => await reading(card) === value, `Expected card reading ${value}`);
    const waitStatus = (card, value) => until(async () => await status(card) === value, `Expected card status ${value}`);
    const oilValue = () => `+${(22 + generation(frozenOil ?? sourceAt())).toFixed(3)}`;
    const tick = async () => {
      const previous = count('oil/quote');
      await advance(10_000);
      await until(() => count('oil/quote') === previous + 1, 'Oil must issue exactly one quote read each 10 seconds');
      if (!failOil) await waitReading(oil, oilValue());
    };
    const readCounts = () => ['oil/quote', 'perpetual/summary'].map(count);
    const sameCounts = expected => readCounts().every((value, index) => value === expected[index]);
    const verifyResume = async (previous, reason) => {
      const expected = previous.map(value => value + 1), resumedAt = now, resumedSource = sourceAt();
      await until(() => readCounts().every((value, index) => value >= expected[index]), `${reason} must immediately refresh each overview feed`);
      await until(async () => await stamp(oil) === iso(resumedSource) && await stamp(perpetual) === iso(resumedAt), `${reason} must apply the resumed responses`);
      await waitStatus(oil, '实时'); await waitStatus(perpetual, '实时');
      // Flush visibility-driven React effects without reaching the next 5-second poll.
      await advance(100);
      check(sameCounts(expected), `${reason} must refresh each overview feed exactly once`);
    };

    // The SSR fixture has no persisted quote. A failed first read must expose the empty/error state.
    const oilPanel = page.locator('[data-monitor="oil"]');
    await waitStatus(oil, '行情暂不可用');
    await waitReading(oil, '—');
    await oilPanel.locator('.data-status').filter({ hasText: '实时报价暂不可用' }).waitFor();
    check(count('oil/quote') === 1, 'A failed first visit must issue only one quote request');
    failOil = false; failHistory = false;
    await oilPanel.getByRole('button', { name: '刷新行情' }).click();

    // A 30-second collector last ran at source t=0; page polling starts at t=29s.
    await waitReading(oil, '+22.000');
    await waitReading(perpetual, '101');
    await until(async () => await oilPanel.locator('.primary-metric .metric-value').textContent() === '+22.000', 'The detail must show the absolute 22 USDT/barrel spread');
    check(/USDT\s*\/\s*桶/.test(await oil.innerText()), 'The overview must identify the absolute spread unit');
    check(/USDT\s*\/\s*桶/.test(await oilPanel.locator('.primary-metric').innerText()), 'The detail must identify the absolute spread unit');
    check(!(await oil.innerText()).includes('+27.500%'), 'The overview primary reading must not use the percentage premium');
    check(count('oil/quote') === 2, 'One explicit oil retry must recover without creating another feed');
    scenarios.push('An uncached oil quote/history failure exposes the connection error; the detail retry recovers the quote');
    await tick(); await tick();
    await waitReading(perpetual, '105');
    check(count('perpetual/summary') === 5, 'The unopened perpetual card must update every five seconds');
    check(count('perpetual/quote') === 0 && count('perpetual/stream') === 0, 'Overview must not start full perpetual quotes or SSE');
    scenarios.push('The unopened perpetual summary refreshes every five seconds without detail feeds');

    await page.getByRole('tab', { name: '海力士 ADR', exact: true }).click();
    const oilDetails = [count('oil/candles/15m'), count('oil/funding')], quoteBeforeSwitch = count('oil/quote');
    for (let cycle = 0; cycle < 31; cycle++) await tick();
    check(count('oil/quote') === quoteBeforeSwitch + 31, 'Inactive oil detail must retain its single 10-second overview feed');
    check(count('oil/candles/15m') === oilDetails[0] && count('oil/funding') === oilDetails[1], 'Inactive oil must stop history and funding reads for more than five minutes');
    failHistory = true;
    const beforeReturn = count('oil/quote');
    await page.getByRole('tab', { name: '原油价差', exact: true }).click();
    await until(() => count('oil/candles/15m') === oilDetails[0] + 1, 'Returning must resume only the due detail history');
    await page.locator('[data-monitor="oil"]').locator('.notice').filter({ hasText: '历史更新中断' }).waitFor();
    check(count('oil/quote') === beforeReturn, 'Switching back must not restart the overview quote feed');
    await waitStatus(oil, '实时');
    scenarios.push('Oil keeps 10s overview quotes while inactive; 60s history and 300s funding stop; history failure cannot stale a fresh quote');

    await until(async () => await stamp(perpetual) === iso(now), 'The latest perpetual summary must finish before simulating its failure');
    const retainedOil = [await reading(oil), await stamp(oil)], retainedPerpetual = [await reading(perpetual), await stamp(perpetual)];
    failOil = true; failPerpetual = true;
    await tick();
    await waitStatus(oil, '更新中断 · 保留数据');
    await waitStatus(perpetual, '更新中断 · 保留数据');
    check(await reading(oil) === retainedOil[0] && await stamp(oil) === retainedOil[1], 'Oil failures must preserve the last value and source time');
    check(await reading(perpetual) === retainedPerpetual[0] && await stamp(perpetual) === retainedPerpetual[1], 'Perpetual summary failures must preserve values and quote time');
    failOil = false; failPerpetual = false;
    await tick();
    await waitStatus(oil, '实时'); await waitStatus(perpetual, '实时');
    check(await stamp(oil) !== retainedOil[1] && await stamp(perpetual) !== retainedPerpetual[1], 'A fresh success must clear failures and advance the real source time');

    frozenOil = Date.parse(await stamp(oil));
    const frozenValue = await reading(oil), beforeFrozen = count('oil/quote');
    for (let cycle = 0; cycle < 9; cycle++) await tick();
    await waitStatus(oil, '行情待更新');
    check(count('oil/quote') === beforeFrozen + 9, 'Repeated HTTP 200 reads must continue while their unchanged source data ages');
    check(await stamp(oil) === iso(frozenOil), 'HTTP receipt times must never replace frozen source timestamps');
    check(await reading(oil) === frozenValue, 'Real expiration must retain the last value');
    frozenOil = null;
    await tick();
    await waitStatus(oil, '实时');
    scenarios.push('Oil and perpetual failures preserve values and recover; repeated 200s with an old oil source time still expire after 75s');

    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const hiddenCounts = readCounts();
    await advance(60_000);
    check(readCounts().every((value, index) => value > hiddenCounts[index] && value <= hiddenCounts[index] + 2), 'Hidden overview feeds must keep reading at most twice per minute');
    const beforeVisible = readCounts();
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await verifyResume(beforeVisible, 'Showing the page');
    await page.context().setOffline(true);
    const offlineCounts = readCounts();
    await advance(60_000);
    check(sameCounts(offlineCounts), 'Offline pages must suspend every overview feed');
    await page.context().setOffline(false);
    await verifyResume(offlineCounts, 'Reconnection');
    check(count('perpetual/quote') === 0 && count('perpetual/stream') === 0, 'No detail quote or SSE request is allowed while the perpetual detail remains unopened');
    scenarios.push('Hidden overview feeds retain bounded polling; offline feeds pause and each resumes immediately');

    check(errors.length === 0, `Unexpected browser errors: ${errors.join('; ')}`);
    await page.screenshot({ path: 'output/playwright/overview-cadence.png', fullPage: false });
    return { passed: true, scenarios, requests: Object.fromEntries(counts), pageErrors: errors, screenshot: 'output/playwright/overview-cadence.png' };
  } finally {
    await page.context().setOffline(false);
    await page.evaluate(() => { if (Object.hasOwn(document, 'hidden')) { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); } });
    page.off('pageerror', pageError);
    await page.clock.resume();
  }
}
