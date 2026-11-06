// Start tests/oil-window-server.mjs on 3197 (after npm run build), then run in a Playwright CLI session:
// playwright-cli run-code --filename tests/oil-window.browser.mjs
// The oil detail first reads only the selected range plus indicator warmup; the hidden Hynix detail reads no full history.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3197';
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const reads = [];
  const releases = [];
  const record = request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/monitors/')) reads.push(url.pathname.slice(14) + url.search); };
  const candleReads = () => reads.filter(path => path.startsWith('oil/candles/15m'));
  const waitRead = async (path, count) => {
    for (let i = 0; i < 200 && reads.filter(item => item === path).length < count; i++) await page.waitForTimeout(25);
    check(reads.filter(item => item === path).length >= count, `Expected ${count} reads of ${path}: ${reads}`);
  };
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.setExtraHTTPHeaders({ Authorization: `Basic ${btoa('admin:oil-window-fixture')}` });
  page.on('request', record);
  try {
    // Hold the complete-history read so its pending state is observable.
    await page.route('**/api/monitors/oil/candles/15m', async route => { await new Promise(resolve => releases.push(resolve)); await route.continue().catch(() => {}); });
    await page.goto(`${origin}/?monitor=oil`);
    const embedded = JSON.parse(await page.locator('#market-initial-data').textContent()).initial;
    check(embedded.hynix.trend?.points.length > 0, 'The first render embeds the Hynix overview trend');
    const detail = page.locator('[data-monitor="oil"]');
    const chart = detail.locator('.chart-panel').first();
    const pending = () => chart.getByText('正在载入 15 分钟 K 线').count();
    // The spread chart is the detail's first chart panel; the funding panel below has its own empty states.
    const drawn = () => page.waitForFunction(() => { const panel = document.querySelector('[data-monitor="oil"] .chart-panel'); return panel?.querySelector('.chart-container svg') && !panel.querySelector('.empty-chart'); });
    await drawn();
    check(JSON.stringify(candleReads()) === JSON.stringify(['oil/candles/15m?days=28']), `The one-week detail first reads 7 + 21 days: ${candleReads()}`);
    await page.waitForTimeout(1500);
    check(!reads.includes('hynix/history'), `The hidden Hynix detail does not compete with the oil chart: ${reads}`);
    await detail.locator('.source-toggle').click();
    check((await detail.locator('.source-content').innerText()).includes('共 5,760 根'), 'Coverage still describes the complete history');
    const mean = detail.locator('.metric').filter({ hasText: '区间平均价差' });
    const alert = detail.locator('.notice.error').filter({ hasText: '历史更新中断' });

    // A failed wider read must not present the shorter window as the selected range.
    const month = url => url.pathname.endsWith('/candles/15m') && url.searchParams.get('days') === '51';
    await page.route(month, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"监控服务暂不可用"}' }));
    await chart.getByRole('button', { name: '1 月', exact: true }).click();
    await alert.waitFor();
    check(await chart.getByText('暂无可用行情').count() === 1 && await pending() === 0, 'A failed one-month read shows no chart rather than one week of it');
    check(await mean.getByText('等待行情数据').count() === 1, 'The one-month mean is not computed from the one-week window');
    check(!(await alert.innerText()).includes('保留上次'), 'The notice does not claim retained data for the failed range');
    await page.unroute(month);
    // Hold the next one-week read so the retained-data notice is observable before it succeeds.
    const week = url => url.pathname.endsWith('/candles/15m') && url.searchParams.get('days') === '28';
    await page.route(week, async route => { await new Promise(resolve => releases.push(resolve)); await route.continue().catch(() => {}); });
    await chart.getByRole('button', { name: '1 周', exact: true }).click();
    check(await pending() === 0 && await chart.locator('.empty-chart').count() === 0, 'The loaded window still covers one week');
    check((await alert.innerText()).includes('保留上次'), 'The covered range is the retained data');
    await waitRead('oil/candles/15m?days=28', 2);
    releases.splice(0).forEach(release => release());
    await alert.waitFor({ state: 'detached' });
    await page.unroute(week);

    await chart.getByRole('button', { name: '全部', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-monitor="oil"] .chart-panel')?.textContent.includes('正在载入 15 分钟 K 线'));
    check(candleReads().at(-1) === 'oil/candles/15m', 'All history reads the complete candles');
    check(await mean.getByText('等待行情数据').count() === 1, 'A window is not summarised as the complete range');
    releases.splice(0).forEach(release => release());
    await drawn();
    await page.unroute('**/api/monitors/oil/candles/15m');

    await chart.getByRole('button', { name: '1 月', exact: true }).click();
    check(await pending() === 0, 'Loaded complete candles cover one month immediately');
    await waitRead('oil/candles/15m?days=51', 2);
    await chart.getByRole('button', { name: '1 周', exact: true }).click();
    check(await pending() === 0, 'A shorter range needs no new read before drawing');
    await waitRead('oil/candles/15m?days=28', 3);
    await page.waitForTimeout(300);
    check(await pending() === 0, 'The narrower window replaces the wider data without a pending state');

    const opened = page.waitForRequest(request => request.url().endsWith('/api/monitors/hynix/history'), { timeout: 5_000 });
    await page.getByRole('tab', { name: '海力士 ADR', exact: true }).click();
    await opened;
    return { passed: true, reads };
  } finally {
    releases.splice(0).forEach(release => release());
    page.off('request', record);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.setExtraHTTPHeaders({});
  }
}
