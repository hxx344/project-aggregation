// Start tests/oil-initial-server.mjs on 3199 (after npm run build), then run in a Playwright CLI session:
// playwright-cli run-code --filename tests/oil-initial-fallback.browser.mjs
// The first render embeds only the oil overview trend; a failed full-candle read must keep it, never show an empty market.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3199', bar = 900_000;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  let candleReads = 0, fullCandles = null;
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.clock.install({ time: new Date() });
  try {
    await page.route('**/api/**', async route => {
      const path = '/' + route.request().url().split('/').slice(3).join('/').split('?')[0];
      const fetchedAt = new Date(await page.evaluate(() => Date.now())).toISOString();
      if (path === '/api/monitors/oil/candles/15m') {
        candleReads++;
        if (candleReads === 1) return route.fulfill({ status: 503, json: { error: 'Controlled candle outage' } });
        return route.fulfill({ json: { ...fullCandles, metadata: { ...fullCandles.metadata, fetchedAt } } });
      }
      if (path === '/api/monitors/oil/quote') {
        const leg = (coin, markPx) => ({ coin, markPx, fundingRate: 0, fundingIntervalHours: 4, nextFundingAt: new Date(Date.parse(fetchedAt) + 3_600_000).toISOString() });
        return route.fulfill({ json: { source: 'Binance', currency: 'USDT', status: 'live', fetchedAt, brent: leg('BZUSDT', 71), wti: leg('CLUSDT', 66), collection: { maxAgeMs: 75_000 } } });
      }
      return route.fulfill({ status: 503, json: { error: 'Controlled unavailable response' } });
    });
    await page.goto(`${origin}/?monitor=oil`);
    const embedded = JSON.parse(await page.locator('#market-initial-data').textContent()).initial.oil;
    check(embedded.trend?.points.length === 672 && !('candles' in embedded), 'The first render embeds only the seven-day oil trend');
    const initialLast = embedded.trend.points.at(-1);
    // A full candle snapshot ending at the same completed bar (a newer one may still be open), every spread 5.000.
    const times = Array.from({ length: 900 }, (_, index) => initialLast.time - (899 - index) * bar);
    fullCandles = { status: 'live', data: times.map(time => ({ time, brent: 71, wti: 66 })), metadata: { source: 'Binance', api: 'https://fapi.binance.com', currency: 'USDT', symbols: ['BZUSDT', 'CLUSDT'], interval: '15m', timezone: 'UTC',
      priceBasis: 'Paired completed 15-minute trade candle closes', firstCommonObservation: new Date(times[0]).toISOString(), lastCommonObservation: new Date(times.at(-1)).toISOString(), pairedObservationRows: times.length, expectedObservationRows: times.length, missingObservationRows: 0 } };
    const card = page.getByRole('region', { name: '市场行情概览' }).getByRole('button', { name: /^原油价差/ });
    const sparkline = card.locator('.hub-sparkline');
    const detail = page.locator('[data-monitor="oil"]');
    const closing = time => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(time + bar));

    await detail.getByText('历史更新中断：', { exact: false }).waitFor();
    check(candleReads === 1, 'The detail reads the full candles on mount');
    // The status label may be visually collapsed on narrow cards; the accessible description carries it too.
    await sparkline.getByText('保留历史', { exact: false }).waitFor({ state: 'attached' });
    const retained = await sparkline.getAttribute('title');
    check(retained.includes(`最后收盘 ${closing(initialLast.time)} 北京时间，${initialLast.value.toFixed(3)} USDT/桶`), `A failed read keeps the embedded trend and its real close time: ${retained}`);
    check(await card.locator('.hub-sparkline svg path.spark-line').count() > 0, 'The retained trend is still drawn');
    check(await detail.getByText('暂无可用行情').count() === 0 && await detail.getByText('暂无记录').count() === 0, 'A failed first read is not shown as an absent market');
    check(await detail.getByText('正在载入 15 分钟 K 线').count() === 1, 'The chart stays in its pending state');
    check(await detail.getByText('正在加载记录…').count() === 1, 'The recent table stays in its pending state');

    await page.clock.runFor(60_000);
    await page.waitForFunction(() => [...document.querySelectorAll('.hub-summary-card')].find(node => node.textContent.includes('原油价差'))?.querySelector('.hub-sparkline')?.getAttribute('title')?.includes('5.000 USDT/桶'));
    check(candleReads === 2, 'The next scheduled read loads the full candles');
    const loaded = await sparkline.getAttribute('title');
    check(!loaded.includes('保留历史') && loaded.includes(`最后收盘 ${closing(initialLast.time)} 北京时间，5.000 USDT/桶`), `The overview switches to the full candles: ${loaded}`);
    await detail.locator('tbody tr').filter({ hasText: '+5.000' }).first().waitFor();
    check(await detail.getByText('历史更新中断：', { exact: false }).count() === 0, 'A successful read clears the history error');
    check(await detail.locator('.metric').filter({ hasText: '区间平均价差' }).getByText('+5.000', { exact: true }).count() === 1, 'Detail statistics use the full candles');
    return { passed: true, candleReads, retained, loaded };
  } finally {
    await page.clock.resume();
  }
}
