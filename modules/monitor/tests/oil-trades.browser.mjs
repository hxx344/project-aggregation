// Start node --experimental-strip-types tests/oil-trades-server.mjs, then run using the existing Playwright CLI.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async (page, options = {}) => {
  const check = (value, message) => { if (!value) throw Error(message); }, errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(options.entryUrl ?? 'http://hub.localhost:39186/__host');
  const app = page.frameLocator('iframe'), markers = app.locator('.trade-marker'), details = app.locator('.trade-details');
  await markers.first().waitFor();
  check(await markers.count() === 4, 'all four event kinds render in the initial week');
  check((await markers.locator('text').allTextContents()).sort().join('') === [...'▲▼◆●'].sort().join(''), 'event symbols preserve types');
  await markers.last().focus();
  await details.waitFor();
  check((await details.innerText()).includes('<img src=x onerror=alert(1)>'), 'account labels remain literal text');
  check(await details.locator('img').count() === 0, 'account labels cannot inject markup');
  check((await details.innerText()).includes('图表价差'), 'a single leg falls back to the containing candle');
  await app.locator('.trade-list-item').first().click();
  check(await app.locator('.trade-list-item[aria-pressed="true"]').count() === 1, 'the list selects the matching marker');
  await app.getByRole('button', { name: '价格对比', exact: true }).click(); check(await markers.count() === 0, 'prices never show trade markers');
  check(await app.getByRole('button', { name: '百分比价差', exact: true }).count() === 0, 'oil has no percentage tab');
  await app.getByRole('button', { name: '价差', exact: true }).click(); check(await markers.count() === 4, 'spread restores markers without a price update');
  await page.locator('#fail').click();
  await app.getByText(/刷新失败，保留上次成功数据/).waitFor();
  check(await markers.count() === 4, 'failed refresh keeps old markers');
  await page.locator('#unsupported').click();
  await app.getByText(/工作台版本不支持成交读取/).waitFor();
  await page.locator('#success').click();
  await markers.first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const sizes = await app.locator('[data-monitor="oil"]').evaluate(node => ({ width: node.ownerDocument.documentElement.clientWidth, scroll: node.ownerDocument.documentElement.scrollWidth }));
  check(sizes.scroll <= sizes.width + 1, 'narrow layout stays within viewport');
  if (options.screenshot) await page.screenshot({ path: options.screenshot, fullPage: false });
  check(errors.length === 0, errors.join('\n'));
  return { markerCount: await markers.count(), sizes, errors };
};
