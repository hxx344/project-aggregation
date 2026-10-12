// Requires tests/gold-oil-loading-server.mjs on localhost:3190 after a production build.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const seed = await (await page.request.get('http://127.0.0.1:3190/__fixture')).json();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' });
  await page.clock.install({ time: new Date(seed.quote.fetchedAt) });
  await page.clock.pauseAt(new Date(seed.quote.fetchedAt));
  await page.addInitScript(targetTime => {
    const original = Date.prototype.toISOString;
    window.detailTimeFormats = 0;
    Date.prototype.toISOString = function () {
      if (this.getTime() === targetTime) window.detailTimeFormats++;
      return original.call(this);
    };
  }, seed.history.points.at(-100).time);
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname, action = path.split('/').at(-1);
    const source = path.includes('/bybit/') ? seed.bybit : seed;
    const market = path.includes('/bz/') ? source.bz : source;
    return route.fulfill(path.includes('/cl-xau/') && market[action]
      ? { json: market[action] } : { status: 503, json: { error: 'unrelated fixture' } });
  });
  try {
    await page.goto('http://127.0.0.1:3190/?monitor=cl-xau&goldOil=cl&goldOilExchange=binance');
    const panel = page.getByRole('tabpanel', { name: '金油比', exact: true }).locator('.oil-panel');
    await panel.locator('.gold-chart .gold-chart-svg').waitFor();
    await panel.locator('.data-details summary').click();
    check(await panel.locator('tbody tr').count() === 200, 'Details render 200 historical rows');
    check(await page.evaluate(() => window.detailTimeFormats) > 0, 'Counter observes a visible historical row');
    await page.evaluate(() => { window.detailTimeFormats = 0; });
    const slider = panel.getByRole('slider', { name: '按15分钟查看图表数值' });
    const previousReading = await panel.locator('.gold-cursor-reading').innerText();
    await slider.press('ArrowLeft');
    check(await panel.locator('.gold-cursor-reading').innerText() !== previousReading, 'Cursor value updates');
    await page.clock.runFor(10000);
    check(await page.evaluate(() => window.detailTimeFormats) === 0, 'Cursor and freshness tick skip historical row formatting');
    await panel.getByRole('button', { name: '下一页', exact: true }).click();
    check((await panel.locator('.table-pagination').innerText()).includes('第 2 / 4 页'), 'Pagination updates');
    await panel.getByRole('button', { name: '上一页', exact: true }).click();
    check(await page.evaluate(() => window.detailTimeFormats) > 0, 'Pagination renders the historical row again');
    seed.history.points.at(-1).xau = 7777.77;
    seed.funding.points.push({ time: seed.history.points.at(-1).time, cl: 0.0002, xau: 0.0008 });
    await panel.getByRole('button', { name: '刷新数据 ↻', exact: true }).click();
    await panel.locator('tbody tr').first().getByText('7777.77', { exact: true }).waitFor();
    await panel.locator('tbody tr').first().getByText('+0.0300%', { exact: true }).waitFor();
    check((await panel.locator('tbody tr').first().innerText()).includes('XAU 1 次 / CL 1 次'), 'New settlements update both legs');
    seed.funding.points.pop();
    seed.funding.coverageEnd = seed.history.points.at(-1).time;
    await panel.getByRole('button', { name: '刷新数据 ↻', exact: true }).click();
    await panel.locator('tbody tr').first().getByText('未查询覆盖', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '下一页', exact: true }).click();
    await panel.getByRole('button', { name: 'BZ · 布伦特原油', exact: true }).click();
    check((await panel.locator('.table-pagination').innerText()).includes('第 1 / 4 页'), 'Market change resets page');
    check((await panel.locator('table caption').innerText()).includes('Binance'), 'Exchange caption remains accurate');
    check(await panel.getByRole('columnheader', { name: '布伦特原油', exact: true }).count() === 1, 'Market header updates');
    await panel.getByRole('button', { name: 'Bybit', exact: true }).click();
    check((await panel.locator('table caption').innerText()).includes('原油 USDT/BZ，比值及变化为报价比'), 'Exchange change updates units');
    await panel.getByRole('button', { name: '1 天', exact: true }).click();
    check(await panel.locator('tbody tr').count() === 96, 'Range change updates row count');
    check(errors.length === 0, `No browser exceptions: ${errors.join('; ')}`);
    return { passed: true, cursorAndFreshnessRowFormats: 0, pageSize: 200, changedPrice: 7777.77, changedShortFunding: '+0.0300%' };
  } finally { await page.clock.resume(); }
}
