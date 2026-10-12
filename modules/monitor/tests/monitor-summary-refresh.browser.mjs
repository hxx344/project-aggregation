// Start tests/ssr-browser-server.mjs on 3189, then run in a Playwright CLI session:
// playwright-cli run-code --filename tests/monitor-summary-refresh.browser.mjs
// API fixtures and a controlled clock keep this regression independent of live markets.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3189';
  const counts = new Map();
  let now = Date.UTC(2026, 8, 24), failQuote = false, snapshot = false;
  const count = action => counts.get(`/api/monitors/hynix/${action}`) ?? 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.clock.install({ time: new Date(now - 1000) });
  await page.clock.pauseAt(new Date(now));
  try {
    await page.route('**/api/**', async route => {
      const path = '/' + route.request().url().split('/').slice(3).join('/').split('?')[0];
      counts.set(path, (counts.get(path) ?? 0) + 1);
      const fetchedAt = new Date(now).toISOString();
      if (path === '/api/monitors/hynix/quote' && !failQuote) {
        return route.fulfill({ json: { status: snapshot ? 'snapshot' : 'live', fetchedAt,
          ordinary: 1000, adr: 120 + count('quote'), equivalent: 100, spread: 20 + count('quote'), premium: 20 + count('quote'),
          funding: { fetchedAt, annualizedRate: count('quote') / 100 } } });
      }
      if (path === '/api/monitors/hynix/history') {
        return route.fulfill({ json: { status: 'live', fetchedAt, interval: '1h', firstAvailable: '2026-09-23T00:00:00.000Z', warnings: [],
          points: [0, 1, 2].map(index => ({ time: Date.UTC(2026, 8, 23, index), ordinary: 1000, adr: 120 + index, equivalent: 100, spread: 20 + index, premium: 20 + index })) } });
      }
      // Unrelated panels are deliberately unavailable; they must not block Hynix.
      return route.fulfill({ status: 503, json: { error: 'Controlled unavailable response' } });
    });
    const card = page.getByRole('region', { name: '市场行情概览' }).getByRole('button', { name: /^海力士 ADR/ });
    const reading = () => card.locator('strong').first().textContent();
    const stamp = () => card.locator('time').getAttribute('datetime');
    const waitReading = value => page.waitForFunction(expected => {
      const card = [...document.querySelectorAll('.hub-summary-card')].find(node => node.textContent.includes('海力士 ADR'));
      return card?.querySelector('strong')?.textContent === expected;
    }, value);
    const tick = async () => { now += 10_000; await page.clock.runFor(10_000); };
    await page.goto(`${origin}/?monitor=oil`);
    await waitReading('+21.00%');
    check(count('quote') === 1, 'Oil startup must request Hynix once without opening its detail');
    for (let cycle = 0; cycle < 6; cycle++) { await tick(); await waitReading(`+${22 + cycle}.00%`); }
    check(count('quote') === 7 && count('history') === 2, 'One quote per 10s and one history read per 60s');
    check(count('funding') === 0, 'Hidden Hynix detail must not request funding history');
    check((await card.innerText()).includes('实时'), 'The visible card must remain live beyond the stale threshold');
    check(await stamp() === new Date(now).toISOString(), 'Show the actual latest quote time');

    const fundingOpened = page.waitForRequest('**/api/monitors/hynix/funding', { timeout: 10_000 });
    await page.getByRole('tab', { name: '海力士 ADR', exact: true }).click();
    // Let React's lazy chart boundary commit before switching back.
    now += 1000; await page.clock.runFor(1000);
    await fundingOpened;
    await page.getByRole('tabpanel', { name: '海力士 ADR', exact: true }).waitFor();
    await page.getByRole('tab', { name: '原油价差', exact: true }).click();
    check(count('quote') === 7, 'Switching details must not restart or duplicate the shared quote feed');
    const fundingReads = count('funding');
    await tick(); await waitReading('+28.00%');
    check(count('quote') === 8 && count('funding') === fundingReads, 'Returning to oil must retain one Hynix quote poller');

    const retainedReading = await reading(), retainedTime = await stamp();
    failQuote = true;
    await tick(); await card.getByText('更新中断 · 保留数据', { exact: true }).waitFor();
    check(await reading() === retainedReading && await stamp() === retainedTime, 'A failed read must retain values and source time');
    failQuote = false;
    await tick(); await waitReading('+30.00%');
    snapshot = true;
    await tick(); await waitReading('+31.00%');
    check((await card.innerText()).includes('更新中断'), 'A retained server snapshot must not be labelled live');
    snapshot = false;
    await tick(); await waitReading('+32.00%');

    await page.context().setOffline(true);
    const beforeOffline = count('quote');
    await tick(); await tick(); await tick();
    check(count('quote') === beforeOffline, 'Offline must pause quote requests');
    await page.context().setOffline(false);
    await waitReading('+33.00%');
    check(count('quote') === beforeOffline + 1, 'Reconnect must refresh immediately and exactly once');

    // Dispatch browser visibility transitions deterministically in the actual UI.
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const beforeHidden = count('quote');
    await tick(); await tick(); await tick();
    check(count('quote') === beforeHidden + 1, 'Hidden pages must retain one card read per 30 seconds');
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await waitReading('+35.00%');
    check(count('quote') === beforeHidden + 2, 'Showing the page must refresh immediately');

    await page.setViewportSize({ width: 390, height: 844 });
    await tick(); await waitReading('+36.00%');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile overview must fit its viewport');
    return { passed: true, requests: Object.fromEntries(counts), lastQuoteTime: await stamp(), value: await reading() };
  } finally {
    await page.context().setOffline(false);
    // CLI captures page state after execution, which also needs animation frames.
    await page.clock.resume();
  }
}
