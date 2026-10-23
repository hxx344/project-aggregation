// Start node --experimental-strip-types tests/oil-trades-server.mjs, then run using the existing Playwright CLI.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async (page, options = {}) => {
  const check = (value, message) => { if (!value) throw Error(message); }, errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(options.entryUrl ?? 'http://hub.localhost:39186/__host');
  const app = page.frameLocator('iframe'), markers = app.locator('.oil-trade-marker');
  await markers.first().waitFor();
  check(await markers.count() === 4, 'all four event kinds render in the initial week');
  check((await markers.locator('text').allTextContents()).join('') === '▲▼◆●', 'event symbols preserve types');
  await app.locator('[data-range="1d"]').click();
  check(await markers.count() === 3, 'events outside the range disappear');
  await markers.last().focus();
  const tooltip = app.locator('#trade-tooltip');
  check((await tooltip.innerText()).includes('图表价差'), 'a single leg falls back to the nearby candle');
  check((await tooltip.innerText()).includes('<img src=x onerror=alert(1)>'), 'account labels remain literal text');
  check(await tooltip.locator('img').count() === 0, 'account labels cannot inject markup');
  await markers.last().press('Escape'); check(await tooltip.isHidden(), 'Escape hides details');
  await app.locator('.oil-trade-list-item').first().click();
  check(await tooltip.isVisible(), 'the list focuses and opens the matching marker');
  await app.locator('[data-view="prices"]').click(); check(await markers.count() === 0, 'prices never show trade markers');
  await app.locator('[data-view="spread"]').click(); check(await markers.count() === 3, 'spread restores markers without a price update');
  await page.locator('#fail').click();
  await app.getByText(/刷新失败，保留上次成功数据/).waitFor();
  check(await markers.count() === 3, 'failed refresh keeps old markers');
  await page.locator('#unsupported').click();
  await app.getByText(/工作台版本不支持成交读取/).waitFor();
  await page.locator('#success').click();
  await markers.first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await markers.first().focus();
  const sizes = await app.locator('.oil-panel').evaluate(node => {
    const tooltip = node.querySelector('#trade-tooltip').getBoundingClientRect();
    return { width: node.ownerDocument.documentElement.clientWidth, scroll: node.ownerDocument.documentElement.scrollWidth, tooltipLeft: tooltip.left, tooltipRight: tooltip.right };
  });
  check(sizes.scroll <= sizes.width + 1 && sizes.tooltipLeft >= 0 && sizes.tooltipRight <= sizes.width + 1, 'narrow layout and tooltip stay within viewport');
  if (options.screenshot) await page.screenshot({ path: options.screenshot, fullPage: false });
  check(errors.length === 0, errors.join('\n'));
  return { markerCount: await markers.count(), sizes, errors };
};
