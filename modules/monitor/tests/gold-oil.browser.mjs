// Production Next server: localhost:3189. Playwright CLI run-code --filename.
// Deterministic public-market fixtures; never sends notifications or real trades.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- CLI evaluates this function.
async page => {
  const check = (value, message) => { if (!value) throw Error(message); };
  let now = Date.UTC(2026, 8, 30, 12), fail = false, quoteReads = 0, historyReads = 0;
  const start = now - 6500 * 900000, errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const runtime = Object.fromEntries(['oil', 'cl-xau', 'hynix', 'perpetual'].map(id => [id, { available: true, monitorId: id, enabled: true, running: true, revision: 0, error: '' }]));
  const common = () => ({ source: 'Binance', currency: 'USDT', priceBasis: 'mark', status: 'live', fetchedAt: new Date(now).toISOString() });
  const history = Array.from({ length: 6500 }, (_, index) => {
    const cl = 80 + Math.sin(index / 140) * 8, xau = index === 6488 ? null : 3900 + index / 20 + Math.sin(index / 60) * 35;
    return { time: start + index * 900000, cl, xau, ratio: xau === null ? null : xau / cl };
  });
  const events = [];
  for (let time = start + 4 * 3600000; time < now; time += 4 * 3600000) {
    events.push({ time, cl: 0.0001, xau: null });
    if ((time - start) % (8 * 3600000) === 0) events.push({ time: time + 1, cl: null, xau: 0.0004 });
  }
  await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' });
  await page.clock.install({ time: new Date(now - 1000) }); await page.clock.pauseAt(new Date(now));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/monitors') return route.fulfill({ json: { schemaVersion: 1, monitors: Object.entries(runtime).map(([id, value]) => ({ id, runtime: value })) } });
    if (path === '/api/monitors/cl-xau/runtime') {
      const input = route.request().postDataJSON(); runtime['cl-xau'] = { ...runtime['cl-xau'], enabled: input.enabled, running: input.enabled, revision: input.revision + 1 };
      return route.fulfill({ json: runtime['cl-xau'] });
    }
    if (path === '/api/monitors/cl-xau/quote') {
      quoteReads++;
      if (fail) return route.fulfill({ status: 503, json: { error: 'fixture outage' } });
      const terms = hours => ({ rate: hours === 4 ? 0.0004 : 0.0016, intervalHours: hours, nextFundingAt: new Date(now + hours * 3600000).toISOString() });
      return route.fulfill({ json: { ...common(), cl: { symbol: 'CLUSDT', price: 80, updatedAt: common().fetchedAt }, xau: { symbol: 'XAUUSDT', price: 4000, updatedAt: common().fetchedAt }, ratio: 50, funding: { cl: terms(4), xau: terms(8) } } });
    }
    if (path === '/api/monitors/cl-xau/history') {
      historyReads++;
      if (fail) return route.fulfill({ status: 503, json: { error: 'fixture outage' } });
      return route.fulfill({ json: { ...common(), interval: '15m', coverageStart: start, points: history } });
    }
    if (path === '/api/monitors/cl-xau/funding') {
      if (fail) return route.fulfill({ status: 503, json: { error: 'fixture outage' } });
      return route.fulfill({ json: { source: 'Binance', status: 'live', fetchedAt: common().fetchedAt, coverageStart: start, coverageEnd: now, points: events } });
    }
    return route.fulfill({ status: 503, json: { error: 'unrelated module unavailable' } });
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto('http://127.0.0.1:3189/?monitor=cl-xau&goldOil=cl&goldOilExchange=binance');
    const tab = page.getByRole('tabpanel', { name: '金油比', exact: true }), panel = tab.locator('.oil-panel');
    const metric = panel.getByRole('region', { name: '金油比报价' });
    await metric.locator('.metric-number').filter({ hasText: '50.000' }).waitFor();
    await page.clock.runFor(1000);
    await panel.locator('.gold-chart .gold-line').first().waitFor();
    await panel.locator('.gold-funding-chart .gold-line').first().waitFor();
    check(await panel.getByRole('button', { name: '1 周', exact: true }).getAttribute('aria-pressed') === 'true', 'Default one-week range');
    check((await panel.innerText()).includes('671 / 672'), 'Missing leg is counted honestly');
    check(await panel.locator('.metric').count() === 4, 'Same four-card layout as oil');
    check(await page.getByRole('article', { name: '金油比', exact: true }).locator('.spark-line').count() === 2, 'Overview sparkline preserves the missing-data gap');
    check((await panel.locator('.funding-metrics').innerText()).includes('+43.80%'), 'Current fees honor different settlement periods');
    check(await panel.locator('.metric.featured').evaluate(node => getComputedStyle(node).backgroundColor) === 'rgb(16, 45, 64)', 'Shared dark oil stylesheet loaded in shadow root');
    await panel.getByRole('button', { name: '1 天', exact: true }).click();
    check((await panel.innerText()).includes('95 / 96'), 'One-day range uses completed periods');
    await panel.getByRole('button', { name: '1 月', exact: true }).click();
    check((await panel.innerText()).includes('2975 / 2976'), 'Calendar month includes 31 days for September 30');
    await panel.getByRole('button', { name: '全部', exact: true }).click();
    check((await panel.innerText()).includes('6499 / 6500'), 'All history exceeds seven days');
    check(await panel.getByRole('listitem').count() === 3, 'Monthly bars cover July through September');
    await panel.getByRole('button', { name: '黄金 / 原油价格', exact: true }).click();
    check(await panel.locator('.gold-chart .gold-line').count() === 2, 'Two price series with independent axes');
    check((await panel.innerText()).includes('黄金 · 左轴 USDT/盎司'), 'Gold axis unit visible');
    await panel.getByRole('button', { name: '金油比走势', exact: true }).click();
    await panel.getByRole('button', { name: '日均小时率', exact: true }).click();
    check(await panel.getByRole('button', { name: '日均小时率', exact: true }).getAttribute('aria-pressed') === 'true', 'Funding metric switch');
    await panel.getByRole('button', { name: '累计年化', exact: true }).click();
    const slider = panel.getByRole('slider', { name: '按15分钟查看图表数值' });
    await slider.focus(); await slider.press('Home');
    check((await panel.locator('.gold-cursor-reading').innerText()).includes('2026/07/25'), 'Keyboard cursor reaches full history in Beijing time');
    await panel.locator('.data-details summary').click();
    check(await panel.locator('tbody tr').count() === 200, 'Details paginated at 200 rows');
    await panel.getByRole('button', { name: '下一页', exact: true }).click();
    check((await panel.locator('.table-pagination').innerText()).includes('第 2 / 33 页'), 'Details move to next page');
    await panel.locator('.data-details summary').click();
    await page.screenshot({ path: 'output/playwright/gold-oil-desktop.png', fullPage: true });
    const oldReads = quoteReads, oldHistory = historyReads;
    await page.getByRole('tab', { name: '海力士 ADR', exact: true }).click();
    now += 30000; await page.clock.runFor(30000);
    check(quoteReads === oldReads + 1 && historyReads === oldHistory, 'Hidden chart pauses while overview keeps a single quote poller');
    await page.getByRole('tab', { name: '金油比', exact: true }).click();
    check(await panel.getByRole('button', { name: '全部', exact: true }).getAttribute('aria-pressed') === 'true', 'Tab switch preserves range');
    fail = true; await panel.getByRole('button', { name: '刷新数据 ↻', exact: true }).click();
    await panel.getByText('更新中断 · 保留数据', { exact: true }).waitFor();
    check((await panel.locator('.funding-history-status').innerText()).includes('更新中断'), 'Funding outage explicitly marked');
    check(await metric.locator('.metric-number').filter({ hasText: '50.000' }).count() === 1, 'Failed refresh retains price');
    fail = false; await panel.getByRole('button', { name: '刷新数据 ↻', exact: true }).click();
    await panel.getByText('实时 · 每 30 秒更新', { exact: true }).waitFor();
    const toggle = page.getByRole('switch', { name: '金油比监控开关' });
    await toggle.click(); await tab.getByText(/金油比监控已关闭/).waitFor();
    const paused = quoteReads; now += 60000; await page.clock.runFor(60000);
    check(quoteReads === paused, 'Disabled module stops reads');
    await toggle.click(); await metric.locator('.metric-number').filter({ hasText: '50.000' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); await page.clock.runFor(1000);
    await panel.locator('.gold-chart .gold-line').first().waitFor();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile fits viewport');
    await panel.getByRole('button', { name: '全部', exact: true }).click();
    await panel.locator('.data-details summary').click();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Wide detail table scrolls within mobile panel');
    await panel.locator('.data-details summary').click();
    await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: 'output/playwright/gold-oil-mobile.png', fullPage: true });
    check(errors.length === 0, `No browser exceptions: ${errors.join('; ')}`);
    return { passed: true, quoteReads, historyReads, monthlyBars: 3, allHistoryRows: 6500 };
  } finally { await page.clock.resume(); }
}
