// Run with playwright-cli run-code --filename tests/oil-exchanges.browser.mjs.
// Requires tests/oil-exchanges-server.mjs on port 3192.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const errors = [], paths = [];
  let mode = 'success';
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.route('**/api/monitors/*/exchanges/*/quote', async route => {
    const path = new URL(route.request().url()).pathname; paths.push(path);
    if (path.includes('/oil/exchanges/lighter/') && mode === 'fail') return route.fulfill({ status: 503, json: { error: 'Fixture outage' } });
    if (path.includes('/oil/exchanges/lighter/') && mode === 'older') {
      const data = await (await route.fetch()).json();
      data.fetchedAt = new Date(Date.now() - 30_000).toISOString(); data.left.price = 999;
      return route.fulfill({ json: data });
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto('http://127.0.0.1:3192/?monitor=oil');
  const oil = page.locator('[data-exchange-market="oil"]');
  await oil.getByText('BRENTOIL / WTI', { exact: true }).waitFor();
  check(await oil.locator('tbody [data-exchange]').count() === 7, 'Oil exposes all seven exchange comparisons');
  const lighter = oil.locator('[data-exchange="lighter"]'), variational = oil.locator('[data-exchange="variational"]');
  check((await lighter.innerText()).includes('USDC') && (await lighter.innerText()).includes('+4.000%'), 'Lighter quote unit and spread are correct');
  check((await oil.locator('[data-exchange="okx"]').innerText()).includes('BZ-USDT-SWAP / CL-USDT-SWAP'), 'OKX contracts are explicit');
  check((await variational.innerText()).includes('USDC') && (await variational.innerText()).includes('采集时间：'), 'Variational uses USDC and receipt time');
  check((await variational.locator('[data-label="做空价差年化"]').innerText()) !== '—', 'Public Variational funding is available before configuring a token');
  check(!(await variational.innerText()).includes('资金费缺失'), 'Public funding has no token prerequisite');
  await oil.locator('.exchange-details summary').click();
  const details = oil.locator('.exchange-details article').filter({ has: page.getByText('Lighter', { exact: true }) });
  check((await details.innerText()).includes('指数价格') && (await details.innerText()).includes('推算'), 'Lighter funding notional and estimated settlement are explicit');
  const retainedPrice = await lighter.locator('.exchange-prices').innerText();
  mode = 'fail';
  await oil.getByRole('button', { name: '刷新原油交易所报价' }).click();
  await lighter.getByText('保留数据 · 待更新', { exact: true }).waitFor();
  check(await lighter.locator('.exchange-prices').innerText() === retainedPrice, 'Failed source keeps its last successful prices');
  mode = 'older';
  await oil.getByRole('button', { name: '刷新原油交易所报价' }).click();
  await oil.getByText('收到较旧报价，保留已有数据', { exact: true }).waitFor();
  check(await lighter.locator('.exchange-prices').innerText() === retainedPrice, 'Late response cannot replace a newer quote');
  mode = 'success';
  await oil.getByRole('button', { name: '刷新原油交易所报价' }).click();
  await lighter.getByText('已更新', { exact: true }).waitFor();
  await oil.screenshot({ path: 'output/playwright/oil-exchanges-desktop.png' });
  await page.getByRole('tab', { name: '海力士 ADR', exact: true }).click();
  const hynix = page.locator('[data-exchange-market="hynix"]');
  await hynix.waitFor({ state: 'visible' });
  check(await hynix.locator('tbody [data-exchange]').count() === 3, 'Hynix remains at its original three exchanges');
  check(!paths.some(path => /hynix\/exchanges\/(lighter|variational|okx|bitget)/.test(path)), 'New oil sources never poll through Hynix');
  await page.getByRole('tab', { name: '原油价差', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await oil.waitFor({ state: 'visible' });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'New comparison rows fit the narrow viewport');
  await variational.screenshot({ path: 'output/playwright/oil-exchanges-mobile.png' });
  check(errors.length === 0, errors.join('; '));
  return { passed: true, oilExchanges: 7, hynixExchanges: 3, checked: ['source units', 'missing funding', 'estimated settlement', 'failure retention', 'older response', 'recovery', 'mobile'] };
}
