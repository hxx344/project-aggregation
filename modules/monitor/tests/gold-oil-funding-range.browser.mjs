// Run against the isolated local Next preview on port 3191 with Playwright CLI run-code --filename.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- CLI evaluates this function.
async page => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const now = Date.UTC(2026, 9, 7, 17, 15), start = now - 30 * 86400000, errors = [];
  let complete = false, fail = false;
  const common = { oilType: 'bz', source: 'Binance', status: 'live', fetchedAt: new Date(now).toISOString() };
  const history = { ...common, currency: 'USDT', priceBasis: 'mark', interval: '15m', coverageStart: start,
    points: Array.from({ length: 2880 }, (_, i) => ({ time: start + i * 900000, oil: 100, xau: 4000 + Math.sin(i / 40) * 50, ratio: 40 + Math.sin(i / 40) * 0.5 })) };
  const funding = () => ({ ...common, coverageStart: Date.UTC(2026, 3, 1, 9, 15), coverageEnd: complete ? now : now - 127000,
    points: Array.from({ length: 180 }, (_, i) => ({ time: Date.UTC(2026, 8, 7, 20) + i * 14400000 + 1, oil: -0.0003, xau: 0.00002 })) });
  const quote = { ...common, currency: 'USDT', priceBasis: 'mark', ratio: 40, funding: null,
    oil: { symbol: 'BZUSDT', price: 100, updatedAt: common.fetchedAt }, xau: { symbol: 'XAUUSDT', price: 4000, updatedAt: common.fetchedAt } };
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' });
  await page.clock.install({ time: new Date(now - 1000) }); await page.clock.pauseAt(new Date(now));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/monitors') return route.fulfill({ json: { schemaVersion: 1, monitors: ['oil', 'cl-xau', 'hynix', 'perpetual'].map(id => ({ id, runtime: { available: false } })) } });
    const action = path.replace('/api/monitors/cl-xau/bz/', '');
    if (action === 'status') return route.fulfill({ json: { available: false, reason: 'isolated fixture' } });
    if (!['quote', 'history', 'funding'].includes(action)) return route.fulfill({ status: 503, json: { error: 'unrelated fixture' } });
    return route.fulfill(fail && action === 'funding' ? { status: 503, json: { error: 'fixture outage' } } : { json: action === 'quote' ? quote : action === 'history' ? history : funding() });
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('http://127.0.0.1:3191/?monitor=cl-xau&goldOil=bz&goldOilExchange=binance');
    const panel = page.getByRole('tabpanel', { name: '金油比', exact: true }).locator('.oil-panel');
    await panel.locator('.gold-chart .gold-line').first().waitFor();
    await panel.getByRole('button', { name: '1 月', exact: true }).click();
    const section = panel.locator('.funding-history-section'), chart = section.locator('.gold-chart-svg');
    await chart.waitFor();
    check((await section.locator('.chart-footer').innerText()).includes('XAU 180 次 · BZ 180 次'), 'All actual settlements are retained');
    check((await section.locator('.funding-history-period').innerText()).includes('2026/10/08 01:12:53'), 'Actual queried cutoff is shown');
    check((await section.locator('.funding-history-period').innerText()).includes('尾部待更新'), 'Unqueried tail is explicit');
    check((await section.locator('.funding-history-status').innerText()).includes('所选区间未完全覆盖'), 'Partial coverage is not relabeled complete');
    check(await section.getByText('已查询区间年化', { exact: true }).count() === 2, 'Annualized cards identify the available period');
    check((await section.locator('.funding-history-returns').innerText()).includes('+35.04%'), 'Annualization uses the queried duration');
    const cumulative = await section.locator('.funding-history-returns b').allTextContents();
    check(JSON.stringify(cumulative) === JSON.stringify(['-2.8800%', '+2.8800%']), 'Equal-notional cumulative rates are unchanged');
    check((await chart.locator('[data-series="shortAnnualized"]').getAttribute('d')).includes('L'), 'Cumulative annualized history remains visible');
    await chart.focus(); await chart.press('End');
    check((await section.locator('.gold-chart-tooltip').innerText()).includes('% / 年'), 'Annualized tooltip keeps correct units');
    await section.getByRole('button', { name: '日均小时率', exact: true }).click();
    check((await chart.locator('[data-series="shortRate"]').getAttribute('d')).includes('L'), 'Hourly history remains visible');
    await chart.focus(); await chart.press('End');
    check((await section.locator('.gold-chart-tooltip').innerText()).includes('% / 小时'), 'Hourly tooltip keeps correct units');
    await section.getByRole('button', { name: '累计年化', exact: true }).click();
    await section.screenshot({ path: 'output/playwright/bz-funding-tail-lag.png' });
    fail = true; await panel.getByRole('button', { name: '刷新数据 ↻', exact: true }).click();
    await panel.getByText('资金费历史更新失败，保留已有记录。', { exact: false }).waitFor();
    check(await chart.count() === 1, 'Failed refresh keeps the available curve');
    check((await section.locator('.funding-history-status').innerText()).includes('更新中断'), 'Failed refresh remains marked stale');
    fail = false; complete = true;
    await panel.getByRole('button', { name: '刷新数据 ↻', exact: true }).click();
    await section.getByText(/API 查询覆盖：.*已覆盖所选区间。/).waitFor();
    check(await section.getByText('区间累计年化', { exact: true }).count() === 2, 'Catch-up restores the complete-period label');
    check(JSON.stringify(await section.locator('.funding-history-returns b').allTextContents()) === JSON.stringify(cumulative), 'Catch-up never duplicates settlements');
    check(!(await section.locator('.funding-history-period').innerText()).includes('尾部待更新'), 'Catch-up clears the lag notice');
    await page.setViewportSize({ width: 390, height: 844 }); await page.clock.runFor(100);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Actual period label fits narrow screens');
    check(errors.length === 0, errors.join('; '));
    return { passed: true, settlementsPerLeg: 180, lagSeconds: 127, coveredScenarios: ['partial tail', 'both indicators', 'failed refresh', 'coverage catch-up', 'narrow layout'] };
  } finally { await page.clock.resume(); }
}
