// Start tests/ssr-browser-server.mjs on 3189, then run in a Playwright CLI session:
// playwright-cli run-code --filename tests/oil-history-timeout.browser.mjs
// A slow full-history read finishes within the history budget; only a read past that budget shows the timeout notice.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3189';
  let now = Date.UTC(2026, 8, 24), reads = 0;
  const releases = [];
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const until = async (condition, message) => {
    const deadline = Date.now() + 10_000;
    while (!await condition()) {
      if (Date.now() >= deadline) throw Error(message);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const advance = async duration => {
    for (let left = duration; left > 0; left -= 1_000) {
      const step = Math.min(1_000, left);
      now += step; await page.clock.runFor(step); await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const unavailable = { status: 503, json: { error: 'Controlled unavailable response' } };
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  const fixture = await page.request.get(`${origin}/oil/data/binance-15m.json`);
  check(fixture.ok(), 'The checked-in Binance candle fixture must be available');
  const candles = await fixture.json();
  await page.clock.install({ time: new Date(now - 1000) });
  await page.clock.pauseAt(new Date(now));
  try {
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/monitors/oil/candles/15m') {
        reads++;
        await new Promise(resolve => releases.push(resolve));
        // The page may already have abandoned this read; fulfilling it then is expected to fail.
        await route.fulfill({ json: { ...candles, status: 'live', metadata: { ...candles.metadata, fetchedAt: new Date(now).toISOString() } } }).catch(() => {});
        return;
      }
      if (path === '/api/monitors/oil/quote') {
        const fetchedAt = new Date(now).toISOString();
        const leg = (coin, markPx) => ({ coin, markPx, fundingRate: 0, fundingIntervalHours: 4, nextFundingAt: new Date(now + 3_600_000).toISOString() });
        return route.fulfill({ json: { source: 'Binance', currency: 'USDT', status: 'live', fetchedAt, brent: leg('BZUSDT', 102), wti: leg('CLUSDT', 100), collection: { maxAgeMs: 75_000 } } });
      }
      return route.fulfill(unavailable);
    });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(`${origin}/?monitor=oil`);
    const panel = page.locator('[data-monitor="oil"]');
    const notice = panel.locator('.notice').filter({ hasText: '历史更新中断' });
    const rows = panel.locator('.table-panel tbody tr');
    await until(() => reads === 1, 'Opening the oil detail must read the full history once');

    await advance(20_000);
    check(await notice.count() === 0, 'A history read still pending after 20 seconds must not be reported as timed out');
    releases.shift()();
    await until(async () => await rows.count() > 1, 'The slow history response must still be applied');
    check(await notice.count() === 0, 'A slow but successful history read must not leave an interruption notice');

    await advance(40_000);
    await until(() => reads === 2, 'The next history read must start on the 60-second cadence');
    await advance(25_000);
    check(await notice.count() === 0, 'A read within the 30-second history budget must not time out');
    await advance(6_000);
    await until(async () => await notice.count() === 1, 'A read past the history budget must surface the timeout');
    const text = await notice.innerText();
    check(text.includes('数据读取超时') && text.includes('当前保留上次成功加载的数据'), `Unexpected timeout notice: ${text}`);
    check(await rows.count() > 1, 'A timed-out refresh must keep the previously loaded history');
    releases.splice(0).forEach(release => release());
    return { passed: true, reads };
  } finally {
    releases.splice(0).forEach(release => release());
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.clock.resume();
  }
}
