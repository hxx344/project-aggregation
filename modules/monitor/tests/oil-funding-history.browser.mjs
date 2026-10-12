// Run with playwright-cli run-code --filename tests/oil-funding-history.browser.mjs.
// Requires the built app served by tests/oil-exchanges-server.mjs on port 3192.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const requests = [], errors = [];
  let mode = 'success';
  let releaseSlow, markSlowStarted, markSlowFinished;
  const slowStarted = new Promise(resolve => { markSlowStarted = resolve; });
  const slowFinished = new Promise(resolve => { markSlowFinished = resolve; });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.route('**/api/monitors/oil/exchanges/*/funding-history', async route => {
    const path = new URL(route.request().url()).pathname;
    const requestMode = mode;
    requests.push(path);
    if (requestMode === 'fail') return route.fulfill({ status: 503, json: { error: 'Fixture history outage' } });
    const data = await (await route.fetch()).json();
    if (requestMode === 'partial') {
      data.right.error = 'WTI 历史暂不可用。'; data.right.fetchedAt = null; data.right.coverage = null;
      data.rows = data.rows.filter(row => row.leftRate !== null).map(row => ({ ...row, rightRate: null }));
    }
    if (requestMode === 'older') {
      data.fetchedAt = new Date(Date.now() - 30_000).toISOString();
      data.left.fetchedAt = data.fetchedAt; data.right.fetchedAt = data.fetchedAt;
      for (const leg of [data.left, data.right]) leg.coverage = { from: Date.parse(data.fetchedAt) - 60 * 24 * 3_600_000, to: Date.parse(data.fetchedAt) };
      data.rows[0].rightRate = 0.5;
    }
    if (requestMode === 'empty') data.rows = [];
    if (requestMode === 'slow') {
      await new Promise(resolve => { releaseSlow = resolve; markSlowStarted(); });
      try { await route.fulfill({ json: data }); }
      catch { /* Changing sources aborts the previous request. */ }
      finally { markSlowFinished(); }
      return;
    }
    return route.fulfill({ json: data });
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto('http://127.0.0.1:3192/?monitor=oil');
  const oil = page.locator('[data-exchange-market="oil"]');
  const short = oil.getByRole('button', { name: '查看 Binance 做空价差的资金费结算历史', exact: true });
  await short.waitFor();
  check(requests.length === 0, 'Closed funding details issue no history requests');
  await short.focus(); await page.keyboard.press('Enter');
  const panel = oil.locator('[data-funding-exchange="binance"]');
  await panel.locator('.exchange-funding-table').first().waitFor();
  const left = panel.locator('[data-funding-leg="left"]'), right = panel.locator('[data-funding-leg="right"]');
  check(await short.getAttribute('aria-expanded') === 'true', 'History trigger announces expanded state');
  check(await left.locator('tbody tr').count() === 3 && await right.locator('tbody tr').count() === 3, 'Millisecond differences do not fabricate paired settlements');
  check((await left.locator('tbody tr').first().innerText()).includes('+0.01000%') && (await left.locator('tbody tr').first().innerText()).includes('收取'), 'Positive rate pays the short leg');
  check((await right.locator('tbody tr').first().innerText()).includes('−0.02000%') && (await right.locator('tbody tr').first().innerText()).includes('收取'), 'Negative rate pays the long leg');
  check((await left.locator('tbody tr').nth(1).innerText()).includes('0.00000%') && (await left.locator('tbody tr').nth(1).innerText()).includes('零费率'), 'Settled zero remains visible');
  const reads = requests.length;
  await oil.getByRole('button', { name: '查看 Binance 做多价差的资金费结算历史', exact: true }).click();
  await panel.getByRole('heading', { name: /^布伦特 · 做多/ }).waitFor();
  check(requests.length === reads, 'Changing direction reuses the same market history');
  check((await left.locator('tbody tr').first().innerText()).includes('+0.01000%') && (await left.locator('tbody tr').first().innerText()).includes('支付'), 'Changing position direction never changes source rate sign');
  await panel.getByRole('button', { name: '收起资金费历史', exact: true }).click();
  check(await oil.locator('[data-funding-exchange]').count() === 0, 'Closing hides the panel');
  check(await oil.getByRole('button', { name: '查看 Binance 做多价差的资金费结算历史', exact: true }).evaluate(element => document.activeElement === element), 'Closing restores focus to the trigger');
  await short.click(); await panel.waitFor();
  check(requests.length === reads, 'Reopening fresh history uses the cache');
  const retained = await left.locator('tbody').innerText();
  mode = 'fail';
  await panel.getByRole('button', { name: '刷新 Binance 资金费历史', exact: true }).click();
  await panel.getByText('历史结算读取失败，稍后重试。已有记录保留。', { exact: true }).waitFor();
  check(await left.locator('tbody').innerText() === retained, 'Failed refresh preserves history');
  mode = 'older';
  await panel.getByRole('button', { name: '刷新 Binance 资金费历史', exact: true }).click();
  await panel.getByText('收到较旧历史，保留已有记录。', { exact: true }).waitFor();
  check(await left.locator('tbody').innerText() === retained, 'Older responses cannot replace current history');
  mode = 'partial';
  await oil.getByRole('button', { name: '查看 OKX 做空价差的资金费结算历史', exact: true }).click();
  const partial = oil.locator('[data-funding-exchange="okx"]');
  await partial.getByText('WTI 历史暂不可用。', { exact: true }).waitFor();
  check(await partial.locator('[data-funding-leg="left"] tbody tr').count() === 3, 'One-leg outage retains the other leg');
  check(await partial.locator('[data-funding-leg="right"] tbody tr').count() === 0, 'Missing leg is not filled with zero');
  mode = 'fail';
  await oil.getByRole('button', { name: '查看 Hyperliquid 做空价差的资金费结算历史', exact: true }).click();
  const firstFailure = oil.locator('[data-funding-exchange="hyperliquid"]');
  await firstFailure.getByText('历史结算读取失败，稍后重试。已有记录保留。', { exact: true }).waitFor();
  mode = 'empty';
  await firstFailure.getByRole('button', { name: '刷新 Hyperliquid 资金费历史', exact: true }).click();
  await firstFailure.locator('[data-funding-leg="left"]').getByText('所选区间暂无可用结算记录。', { exact: true }).waitFor();
  check(await firstFailure.locator('tbody tr').count() === 0, 'Successful empty history does not create fake zero records');
  mode = 'slow';
  await oil.getByRole('button', { name: '查看 Bybit 做空价差的资金费结算历史', exact: true }).click();
  await slowStarted;
  mode = 'success';
  await oil.getByRole('button', { name: '查看 Bitget 做空价差的资金费结算历史', exact: true }).click();
  const switched = oil.locator('[data-funding-exchange="bitget"]');
  await switched.locator('.exchange-funding-table').first().waitFor();
  releaseSlow(); await slowFinished;
  check(await oil.locator('[data-funding-exchange="bybit"]').count() === 0 && await switched.locator('tbody tr').count() === 6, 'Late response from the previous exchange cannot replace selected history');
  mode = 'success';
  await oil.getByRole('button', { name: '查看 Variational 做空价差的资金费结算历史', exact: true }).click();
  const unavailable = oil.locator('[data-funding-exchange="variational"]');
  await unavailable.getByText('Variational 暂无公开的市场已结算资金费历史接口；当前统计不作为历史结算。', { exact: true }).waitFor();
  check(await unavailable.locator('table').count() === 0, 'Unsupported source shows an explanation without invented rows');
  await oil.getByRole('button', { name: '查看 Lighter 做空价差的资金费结算历史', exact: true }).click();
  const lighter = oil.locator('[data-funding-exchange="lighter"]');
  await lighter.locator('.exchange-funding-table').first().waitFor();
  check(await lighter.locator('tbody').getByText('−0.00307223%', { exact: true }).count() === 1, 'Funding rates preserve up to eight decimal percentage places');
  check(await lighter.locator('tbody').getByText('+1e-10%', { exact: true }).count() === 1, 'Small nonzero settlements never display as zero');
  check((await lighter.locator('[data-funding-leg="right"] tbody time').first().getAttribute('title')).endsWith('.017Z'), 'Original settlement milliseconds remain inspectable');
  await lighter.screenshot({ path: 'output/playwright/oil-funding-history-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'History panel fits mobile without horizontal page overflow');
  await lighter.screenshot({ path: 'output/playwright/oil-funding-history-mobile.png' });
  await page.getByRole('tab', { name: '海力士 ADR', exact: true }).click();
  const hynix = page.locator('[data-exchange-market="hynix"]');
  await hynix.waitFor({ state: 'visible' });
  check(await hynix.locator('.exchange-funding-trigger').count() === 0, 'Hynix comparison is unchanged');
  check(errors.length === 0, errors.join('; '));
  return { passed: true, requests: requests.length, checked: ['lazy loading', 'keyboard', 'signed rates', 'zero rate', 'direction reuse', 'close focus', 'cache reuse', 'failure retention', 'older response', 'partial history', 'first-load retry', 'empty history', 'fast switching', 'unsupported source', 'small-rate precision', 'millisecond source time', 'mobile', 'Hynix unchanged'] };
}
