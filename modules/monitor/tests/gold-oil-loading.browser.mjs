// Requires tests/gold-oil-loading-server.mjs on localhost:3190.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const seed = await (await page.request.get('http://127.0.0.1:3190/__fixture')).json();
  const errors = [], counts = { quote: 0, history: 0, funding: 0 }, pending = [];
  let mode = 'hold';
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' });
  await page.clock.install({ time: new Date() });
  await page.route('**/api/**', async route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (!route.request().url().includes('/cl-xau/') || !seed[action]) return route.fulfill({ status: 503, json: { error: 'unrelated fixture' } });
    const source = route.request().url().includes('/cl-xau/bybit/') ? seed.bybit : seed;
    const market = route.request().url().includes('/bz/') ? source.bz : source;
    counts[action]++;
    if (action === 'quote') return route.fulfill({ json: market.quote });
    if (mode === 'hold') await new Promise(resolve => pending.push(resolve));
    return route.fulfill(mode === 'fail' ? { status: 503, json: { error: 'fixture outage' } } : { json: market[action] }).catch(() => {});
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto('http://127.0.0.1:3190/?monitor=cl-xau&goldOil=cl&goldOilExchange=binance');
    const panel = page.getByRole('tabpanel', { name: '金油比', exact: true }).locator('.oil-panel');
    const price = panel.locator('.gold-chart .gold-chart-svg'), fees = panel.locator('.gold-funding-chart .gold-chart-svg');
    await price.waitFor(); await fees.waitFor();
    check(counts.history === 0 && counts.funding === 0, 'Both seeded charts render without a duplicate initial API read');
    await page.goto('http://127.0.0.1:3190/?monitor=cl-xau&goldOil=bz&goldOilExchange=binance');
    await price.waitFor(); await fees.waitFor();
    check(await panel.getByRole('button', { name: 'BZ · 布伦特原油', exact: true }).getAttribute('aria-pressed') === 'true', 'SSR URL selects BZ');
    check((await panel.locator('.metric.featured').innerText()).includes('40.000'), 'SSR BZ quote is rendered from its own seed');
    check(counts.history === 0 && counts.funding === 0, 'Both BZ seeded charts render without duplicate reads');
    for (const oilType of ['cl', 'bz']) {
      await page.goto(`http://127.0.0.1:3190/?monitor=cl-xau&goldOil=${oilType}&goldOilExchange=bybit`);
      await price.waitFor(); await fees.waitFor();
      check(await panel.getByRole('button', { name: 'Bybit', exact: true }).getAttribute('aria-pressed') === 'true', 'SSR URL selects Bybit');
      check((await panel.locator('.metric.featured').innerText()).includes(oilType === 'cl' ? '60.000' : '48.000'), 'Bybit SSR quote uses its own source and oil seed');
      check(Object.values(counts).every(count => count === 0), 'Bybit first paint reuses all three seeded payloads without initial requests');
    }
    await page.goto('http://127.0.0.1:3190/?monitor=cl-xau&goldOil=cl&goldOilExchange=binance');
    await price.waitFor(); await fees.waitFor();
    check((await panel.locator('.gold-line[data-series=ratio]').getAttribute('d')).split('M').length === 3, 'Missing price period produces two separate subpaths');
    await page.clock.pauseAt(new Date());
    await price.evaluate(node => { node.dataset.retained = 'original'; });
    await fees.evaluate(node => { node.dataset.retained = 'original'; });
    await panel.getByRole('button', { name: '1 天', exact: true }).click();
    await panel.getByRole('button', { name: '黄金 / 原油价格', exact: true }).click();
    await panel.getByRole('slider', { name: '按15分钟查看图表数值' }).press('Home');
    const reading = await panel.locator('.gold-cursor-reading').innerText();
    await page.getByRole('tab', { name: '海力士 ADR', exact: true }).click();
    await page.clock.runFor(61000);
    check(counts.history === 0 && counts.funding === 0, 'Inactive chart does not fetch history');
    await page.getByRole('tab', { name: '金油比', exact: true }).click();
    check(await price.getAttribute('data-retained') === 'original' && await fees.getAttribute('data-retained') === 'original', 'Switching markets retains both actual SVG nodes');
    check(await panel.getByRole('button', { name: '1 天', exact: true }).getAttribute('aria-pressed') === 'true', 'Range retained');
    check(await panel.locator('.gold-cursor-reading').innerText() === reading, 'Full-record cursor retained');
    await page.clock.runFor(50);
    check(counts.history === 1 && counts.funding === 0, 'Returning refreshes expired history and reuses funding within its five-minute cadence');
    check(await price.isVisible() && await fees.isVisible(), 'Old charts remain visible while the expired history read is held');
    mode = 'fail'; pending.splice(0).forEach(resolve => resolve());
    await panel.getByText(/价格历史待更新/).waitFor();
    check(await price.isVisible() && await price.getAttribute('data-retained') === 'original', 'Failure preserves chart and exposes stale state');
    mode = 'success'; await panel.getByRole('button', { name: '刷新数据 ↻', exact: true }).click();
    await panel.getByText(/价格历史待更新/).waitFor({ state: 'hidden' });
    check(await price.getAttribute('data-retained') === 'original', 'Recovery updates in place');
    await price.focus(); await price.press('End');
    check((await panel.locator('.gold-chart-tooltip').first().innerText()).includes('USDT/盎司'), 'Keyboard query preserves explicit price units');
    await fees.focus(); await fees.press('End');
    check((await panel.locator('.gold-funding-chart .gold-chart-tooltip').innerText()).includes('% / 年'), 'Funding values retain annual percent units');
    await page.setViewportSize({ width: 390, height: 844 }); await page.clock.runFor(100);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Two-axis chart fits mobile');
    await price.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: (await price.boundingBox()).x + 100 });
    check(await panel.locator('.gold-chart .gold-chart-tooltip').isVisible(), 'Touch query works on mobile');
    await price.screenshot({ path: 'output/playwright/gold-oil-loading-mobile.png' });
    check(errors.length === 0, errors.join('; '));
    return { passed: true, initialHistoryReads: 0, initialFundingReads: 0, retainedSvgNodes: 2, counts };
  } finally { mode = 'success'; pending.splice(0).forEach(resolve => resolve()); await page.clock.resume(); }
}
