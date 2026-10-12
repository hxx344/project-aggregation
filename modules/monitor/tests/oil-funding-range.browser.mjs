// Run with playwright-cli run-code --filename tests/oil-funding-range.browser.mjs.
// Requires the built app served by tests/oil-exchanges-server.mjs on port 3192.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const hour = 3_600_000, day = 24 * hour, anchor = Date.now();
  const settled = Math.floor(anchor / hour) * hour - hour;
  const localInput = time => new Date(time + 8 * hour).toISOString().slice(0, 16);
  const requests = [], errors = [];
  let mode = 'full';
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.route('**/api/monitors/oil/exchanges/*/funding-history', async route => {
    requests.push(route.request().url());
    const data = await (await route.fetch()).json();
    data.fetchedAt = new Date(anchor).toISOString();
    const coverage = { from: anchor - 60 * day, to: anchor };
    for (const leg of [data.left, data.right]) { leg.fetchedAt = data.fetchedAt; leg.coverage = coverage; }
    data.rows = [
      ...Array.from({ length: 1400 }, (_, index) => ({ time: settled - index * hour, leftRate: index === 0 ? 0 : index === 1 ? -0.0001 : 0.0001, rightRate: null })),
      ...Array.from({ length: 725 }, (_, index) => ({ time: settled - index * hour + 17, leftRate: null, rightRate: -0.0002 })),
    ].sort((a, b) => b.time - a.time);
    if (mode === 'partial') {
      const oldEnd = anchor - 2 * day;
      data.right.fetchedAt = new Date(oldEnd).toISOString();
      data.right.coverage = { from: coverage.from, to: oldEnd };
      data.right.error = 'WTI 更新失败，保留已取得记录。';
      data.rows = data.rows.filter(row => row.leftRate !== null || row.time <= oldEnd);
    }
    if (mode === 'unknown') { delete data.left.coverage; delete data.right.coverage; data.status = 'snapshot'; }
    return route.fulfill({ json: data });
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto('http://127.0.0.1:3192/?monitor=oil');
  const oil = page.locator('[data-exchange-market="oil"]');
  const trigger = oil.getByRole('button', { name: '查看 Binance 做空价差的资金费结算历史', exact: true });
  await trigger.click();
  const panel = oil.locator('[data-funding-exchange="binance"]');
  const left = panel.locator('[data-funding-leg="left"]'), right = panel.locator('[data-funding-leg="right"]');
  await left.locator('tbody tr').first().waitFor();
  const total = (leg, field) => leg.locator(`[data-funding-total="${field}"]`);
  check(await panel.getByRole('button', { name: '最近 60 天', exact: true }).getAttribute('aria-pressed') === 'true', 'Default range is the complete 60-day window');
  check(await total(left, 'count').innerText() === '1,400' && await total(right, 'count').innerText() === '725', 'All hourly records are counted beyond the display limit');
  check(await total(left, 'raw').innerText() === '+13.97000%' && await total(right, 'position').innerText() === '+14.50000%', 'Totals use the complete range and direction signs');
  check(await left.locator('tbody tr').count() === 200 && await right.locator('tbody tr').count() === 200, 'Each leg displays at most 200 rows per page');
  check(await panel.locator('[data-funding-coverage="queried"]').count() === 2, 'Minute-rounded default range is fully queried');
  const reads = requests.length;
  await left.getByRole('button', { name: '布伦特下一页', exact: true }).click();
  check((await left.getByRole('status').innerText()).includes('第 2 / 7 页') && (await right.getByRole('status').innerText()).includes('第 1 / 4 页'), 'Leg pages advance independently');
  check(await total(left, 'raw').innerText() === '+13.97000%', 'Pagination never changes the range total');
  check(await left.locator('tbody time').first().getAttribute('dateTime') === new Date(settled - 200 * hour).toISOString(), 'Second page starts at the next original settlement');
  await oil.getByRole('button', { name: '查看 Binance 做多价差的资金费结算历史', exact: true }).click();
  await panel.getByRole('heading', { name: /^布伦特 · 做多/ }).waitFor();
  check(await total(left, 'raw').innerText() === '+13.97000%' && await total(left, 'position').innerText() === '−13.97000%', 'Direction changes only signed position totals');
  check(requests.length === reads, 'Pagination and direction changes reuse fetched history');
  await panel.screenshot({ path: 'output/playwright/oil-funding-range-desktop.png' });
  const start = panel.getByLabel('开始（北京时间）', { exact: true });
  const end = panel.getByLabel('结束（北京时间，不含）', { exact: true });
  const apply = panel.getByRole('button', { name: '应用区间', exact: true });
  await start.fill(localInput(settled - 201 * hour)); await end.fill(localInput(settled - 200 * hour)); await apply.click();
  check(await total(left, 'count').innerText() === '1' && await total(right, 'count').innerText() === '1', 'Custom range includes start, excludes end, and preserves millisecond settlement offsets');
  check(await left.locator('tbody time').first().getAttribute('dateTime') === new Date(settled - 201 * hour).toISOString(), 'Beijing inputs resolve independently of browser timezone');
  check((await left.getByRole('status').innerText()).includes('第 1 / 1 页'), 'Changing range resets pagination');
  await start.fill(localInput(settled)); await end.fill(localInput(settled + hour)); await apply.click();
  check(await total(left, 'raw').innerText() === '0.00000%' && await total(left, 'count').innerText() === '1', 'An actual zero settlement has a zero total');
  await start.fill(localInput(anchor + day)); await end.fill(localInput(anchor + 2 * day)); await apply.click();
  check(await total(left, 'raw').innerText() === '—' && await total(left, 'count').innerText() === '0', 'No records remains unavailable rather than fabricated zero');
  check(await panel.locator('[data-funding-coverage="partial"]').count() === 2, 'Future ranges are marked as not fully covered');
  await start.fill(localInput(settled)); await end.fill(localInput(settled)); await apply.click();
  await panel.getByRole('alert').getByText('请输入有效的北京时间，结束时间需晚于开始时间。', { exact: true }).waitFor();
  check(await total(left, 'count').innerText() === '0', 'Invalid ranges retain the last applied result');
  await start.fill(localInput(anchor - 61 * day)); await end.fill(localInput(anchor)); await apply.click();
  await panel.getByRole('alert').getByText('区间最长为 60 天，请缩小起止范围。', { exact: true }).waitFor();
  for (const days of [7, 30, 60]) {
    await panel.getByRole('button', { name: `最近 ${days} 天`, exact: true }).click();
    const count = Number((await total(left, 'count').innerText()).replaceAll(',', ''));
    check(days === 60 ? count === 1400 : count <= days * 24 && count > (days - 1) * 24, `${days}-day shortcut filters the full history`);
  }
  check(requests.length === reads, 'Range selection stays local and sends no network requests');
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Range controls and totals fit mobile without page overflow');
  check(await left.locator('.exchange-funding-table-scroll').evaluate(element => element.clientHeight <= 360 && element.scrollHeight > element.clientHeight), 'Long tables use bounded scrolling');
  check(await panel.locator('button, input').evaluateAll(elements => elements.every(element => element.getBoundingClientRect().height >= 44)), 'Interactive controls retain 44-pixel touch targets');
  await panel.screenshot({ path: 'output/playwright/oil-funding-range-mobile.png' });
  mode = 'partial';
  await panel.getByRole('button', { name: '刷新 Binance 资金费历史', exact: true }).click();
  await right.getByText('WTI 更新失败，保留已取得记录。', { exact: true }).waitFor();
  check(await left.locator('[data-funding-coverage="queried"]').count() === 1 && await right.locator('[data-funding-coverage="partial"]').count() === 1, 'A failed retained leg exposes its own incomplete coverage');
  check(await total(right, 'raw').innerText() !== '—', 'Retained partial history still provides an explicitly partial total');
  mode = 'unknown';
  await panel.getByRole('button', { name: '刷新 Binance 资金费历史', exact: true }).click();
  await left.locator('[data-funding-coverage="unknown"]').waitFor();
  check(await right.locator('[data-funding-coverage="unknown"]').count() === 1 && await total(left, 'count').innerText() === '1,400', 'Legacy snapshots remain usable with unknown coverage');
  check(errors.length === 0, errors.join('; '));
  return { passed: true, requests: requests.length, checked: ['60-day default', '1400 records', '200-row pages', 'independent legs', 'full totals', 'direction signs', 'Beijing ranges', 'exclusive end', 'zero versus missing', 'range validation', '7/30/60 shortcuts', 'local interactions', 'mobile controls', 'bounded tables', 'partial coverage', 'legacy coverage'] };
}
