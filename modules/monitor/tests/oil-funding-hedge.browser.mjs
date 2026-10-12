// Run with playwright-cli run-code --filename tests/oil-funding-hedge.browser.mjs.
// Uses the React SSR fixture tests/oil-exchanges-server.mjs on port 3192.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const hour = 3_600_000, day = 24 * hour, end = Math.floor(Date.now() / hour) * hour;
  const requests = [], errors = [];
  let mode = 'full';
  const at = () => mode === 'older' ? end - hour : Date.now();
  const funding = exchange => {
    const fetched = at(), to = Math.floor(fetched / hour) * hour, from = Math.ceil((fetched - 60 * day) / hour) * hour, fetchedAt = new Date(fetched).toISOString();
    const rows = Array.from({ length: Math.floor((to - from) / hour) + 1 }, (_, i) => ({ time: from + i * hour, leftRate: exchange === 'bybit' ? 0.0001 : 0.0003, rightRate: exchange === 'bybit' ? 0.0002 : 0.0004 }));
    if (exchange === 'bybit') rows.push({ time: to - hour + 17, leftRate: null, rightRate: 0 });
    return { exchange, monitorId: 'oil', currency: 'USDT', fetchedAt, status: 'live', availability: 'supported', reason: '', left: { symbol: 'BZUSDT', fetchedAt, error: '', coverage: { from, to } }, right: { symbol: 'CLUSDT', fetchedAt, error: '', coverage: { from, to } }, rows: mode === 'empty' ? [] : rows };
  };
  const prices = () => {
    const fetched = at(), to = Math.floor(fetched / hour) * hour, from = Math.ceil((fetched - 60 * day) / hour) * hour, fetchedAt = new Date(fetched).toISOString();
    return { monitorId: 'oil', currency: 'USDT', intervalMs: hour, priceBasis: 'hour-open-mark', fetchedAt, status: 'live', legs: [['bybit', 'BZUSDT', 100], ['bybit', 'CLUSDT', 80], ['binance', 'BZUSDT', 102], ['binance', 'CLUSDT', 81]].map(([exchange, symbol, price], i) => {
      const legEnd = mode === 'leg-stale' && i === 0 ? to - hour : to;
      const rows = Array.from({ length: Math.floor((legEnd - from) / hour) + 1 }, (_, index) => ({ time: from + index * hour, price }));
      return { exchange, symbol, fetchedAt: new Date(mode === 'leg-stale' && i === 0 ? legEnd : fetched).toISOString(), error: '', coverage: { from, to: legEnd }, rows: mode === 'missing-entry' ? rows.filter(row => row.time !== end - 7 * day) : mode === 'gap' && i === 0 ? rows.filter(row => row.time !== end - hour) : rows };
    }) };
  };
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/monitors/oil/exchanges/*/funding-history', route => {
    const exchange = route.request().url().match(/exchanges\/([^/]+)\//)[1];
    requests.push(exchange);
    if (mode === 'fail') return route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } });
    return route.fulfill({ json: funding(exchange) });
  });
  await page.route('**/api/monitors/oil/funding-hedge/prices', route => {
    requests.push('prices');
    return mode === 'fail' ? route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } }) : route.fulfill({ json: prices() });
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto('http://127.0.0.1:3192/?monitor=oil');
  const panel = page.locator('[data-oil-hedge="true"]');
  const metric = key => panel.locator(`[data-hedge-metric="${key}"] strong`);
  const metricText = async key => (await metric(key).innerText()).replace(/\s/g, '');
  const refresh = panel.getByRole('button', { name: '刷新四腿模拟历史', exact: true });
  await panel.getByText('所选区间数据可计算', { exact: true }).waitFor();
  await panel.locator('.recharts-surface').waitFor();
  check(await metricText('funding') === '+19.44USDT', 'Default seven-day history uses actual four-leg funding cashflows');
  check(await metricText('fundingNet') === '+17.44USDT' && await metricText('netPnl') === '+15.44USDT', 'Opening fee is deducted once, closing fee only in total P&L');
  check(await metricText('makerCost') === '+4.00USDT', 'Maker cost curve includes both opening and hypothetical closing fees');
  check(await panel.locator('[data-hedge-entry="bybit"]').innerText() === '+25.000%', 'Opening spread is tied to historical prices');
  check(await panel.locator('.recharts-responsive-container').count() === 1, 'Only one chart is mounted');
  const reads = requests.length;
  await panel.getByRole('button', { name: 'Bybit 空 BZ / 多 CL', exact: true }).click();
  check(await metricText('funding') === '−19.44USDT' && await metricText('makerCost') === '+4.00USDT', 'Reversing positions reverses cashflows without reversing fees');
  await panel.getByRole('button', { name: 'Bybit 多 BZ / 空 CL', exact: true }).click();
  await panel.locator('.oil-hedge-settings summary').click();
  await panel.getByLabel('Bybit Maker 费率（%）', { exact: true }).fill('-0.02');
  await panel.getByLabel('Binance Maker 费率（%）', { exact: true }).fill('-0.02');
  await panel.getByRole('button', { name: '应用模拟参数', exact: true }).click();
  check(await metricText('makerCost') === '−4.00USDT' && await metricText('netPnl') === '+23.44USDT', 'Negative maker rates produce rebates');
  check(new URL(page.url()).searchParams.get('hedgeBybitFee') === '-0.0002', 'URL preserves fee fractions');
  await panel.getByRole('button', { name: '恢复默认', exact: true }).click();
  for (const days of [30, 60, 7]) {
    await panel.getByRole('button', { name: `最近 ${days} 天`, exact: true }).click();
    check(await panel.getAttribute('data-hedge-status') === 'complete', `${days}-day shortcut has valid opening prices including the inward-rounded 60-day bound`);
  }
  check(requests.length === reads, 'Parameter changes reuse local histories');
  const start = panel.getByLabel('开仓（北京时间整点）', { exact: true });
  await start.fill(new Date(end - day + 8 * hour).toISOString().slice(0, 14) + '30');
  await panel.getByRole('button', { name: '应用模拟参数', exact: true }).click();
  await panel.getByRole('alert').waitFor();
  check(await metricText('funding') === '+19.44USDT', 'Invalid non-hour dates retain the applied result');
  await panel.getByRole('button', { name: '恢复默认', exact: true }).click();
  await panel.locator('.oil-hedge-settings summary').click();
  const legsDetails = panel.locator('details').filter({ has: page.locator('summary', { hasText: '各腿名义' }) });
  await legsDetails.locator('summary').click();
  check(await legsDetails.locator('tbody tr').count() === 4, 'Each leg exposes costs and direction');
  const valuesDetails = panel.locator('details').filter({ has: page.locator('summary', { hasText: '曲线数值明细' }) });
  await valuesDetails.locator('summary').click();
  check((await valuesDetails.locator('tbody').innerText()).includes('.017'), 'Asynchronous settlement milliseconds remain inspectable');
  await valuesDetails.getByRole('button', { name: '下一页', exact: true }).click();
  check((await valuesDetails.locator('nav').innerText()).includes('第 2 /'), 'Numerical history supports pagination');
  await panel.screenshot({ path: 'output/playwright/oil-funding-hedge-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile has no page overflow');
  const legRegion = legsDetails.getByRole('region');
  await legRegion.focus(); await page.keyboard.press('ArrowRight');
  check(await legRegion.evaluate(element => element.scrollWidth > element.clientWidth), 'Wide leg table is locally scrollable and keyboard focusable');
  await panel.screenshot({ path: 'output/playwright/oil-funding-hedge-mobile.png' });
  const savedFunding = await metricText('funding'), savedTime = await panel.locator('[data-hedge-updated]').getAttribute('data-hedge-updated');
  mode = 'fail'; await refresh.click();
  await panel.getByText('保留数据 · 待更新', { exact: true }).waitFor();
  check(await metricText('funding') === savedFunding && await panel.locator('[data-hedge-updated]').getAttribute('data-hedge-updated') === savedTime, 'Failures retain cashflows and source timestamps');
  mode = 'older'; await refresh.click();
  await panel.getByText(/返回较旧数据/).first().waitFor();
  check(await metricText('funding') === savedFunding, 'An older response cannot replace newer data');
  mode = 'leg-stale'; await refresh.click();
  await page.locator('[data-oil-hedge="true"][data-hedge-status="partial"]').waitFor();
  await panel.getByText('保留数据 · 待更新', { exact: true }).waitFor();
  check(await panel.getAttribute('data-hedge-status') === 'partial', 'An old individual price leg stays stale despite a fresh aggregate response');
  mode = 'gap'; await refresh.click();
  await panel.getByText(/结算时缺标记价/).first().waitFor();
  check(await metricText('funding') === '—USDT' && await metricText('netPnl') === '—USDT', 'Missing settlement price does not become zero cashflow');
  mode = 'missing-entry'; await refresh.click();
  await panel.getByText('所选区间暂无可用估值', { exact: true }).waitFor();
  check(await panel.getAttribute('data-hedge-status') === 'unavailable', 'Missing entry prices cannot be backfilled with current quotes');
  mode = 'empty'; await refresh.click();
  await panel.getByText(/区间内没有结算记录/).first().waitFor();
  check(await metricText('funding') === '—USDT', 'Empty history is not fabricated zero income');
  mode = 'full'; await refresh.click();
  await panel.getByText('所选区间数据可计算', { exact: true }).waitFor();
  await page.context().setOffline(true);
  await panel.getByText('离线 · 保留已得数据', { exact: true }).waitFor();
  check(await refresh.isDisabled(), 'Offline refresh is disabled');
  await page.context().setOffline(false);
  await panel.getByText('所选区间数据可计算', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '海力士 ADR', exact: true }).click();
  check(await panel.isHidden(), 'Oil simulation is not visible on Hynix');
  await page.goto('http://127.0.0.1:3192/?monitor=oil&hedgeNotional=invalid&hedgeDirection=unknown');
  await panel.getByText('链接中的无效模拟参数已回退为默认值；请检查当前参数。', { exact: true }).waitFor();
  await panel.getByText('所选区间数据可计算', { exact: true }).waitFor();
  check(errors.length === 0, errors.join('; '));
  return { passed: true, checked: ['four cashflow lines', 'direction', 'fee rebate', 'URL state', '7/30/60 day ranges', 'invalid input', 'per-leg table', 'exact timestamps', 'desktop/mobile', 'failure and older response retention', 'leg freshness', 'missing/empty data', 'offline', 'oil-only mounting'] };
}
