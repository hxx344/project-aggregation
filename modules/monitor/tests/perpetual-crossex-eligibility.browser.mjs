// Start the built portable server on 3193, then run with an isolated Playwright CLI session:
// playwright-cli -s=scanner-crossex-20261008 run-code --filename tests/perpetual-crossex-eligibility.browser.mjs
// Only local fixtures are used; no authentication or exchange services are contacted.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3193';
  let now = Date.UTC(2026, 8, 24), revision = 0, metadataRevision = 1, required = true, qualifies = true, expiresAt = now + 179_000;
  const counts = new Map(), check = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const evidence = () => ({ base: 'BTC', exchanges: ['binance', 'gate'], networks: ['BTC'], checkedAt: expiresAt - 180_000, expiresAt });
  const settings = () => ({ available: true, generatedAt: now, revision, metadataRevision, config: { requireSpotTransfer: required, blockedBases: [] }, error: '',
    spotTransferPairs: required && qualifies ? [evidence()] : [], venues: ['binance', 'gate'].map(exchange => ({ exchange, state: 'live', checkedAt: evidence().checkedAt, error: '' })) });
  const quote = (exchange, base, n) => ({ exchange, base, symbol: `${base}USDT`, quoteCurrency: 'USDT', multiplier: 1, bid: 99 + n * (base === 'ETH' ? 10 : 3), ask: 100 + n * (base === 'ETH' ? 10 : 3), mark: 100 + n * 3, last: 100,
    bidAskAt: now, markAt: now, fundingAt: now, sourceTime: now, receivedAt: now, transport: 'rest', fundingRate: 0, fundingIntervalHours: 8, nextFundingAt: now + 3600_000,
    comparable: true, assetClass: 'crypto', identityVerified: true, identitySource: 'official fixture directory', delisting: false, delistingAt: null, collateralCurrency: 'USDT' });
  await page.goto('about:blank');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.unrouteAll({ behavior: 'wait' });
  await page.clock.install({ time: new Date(now - 1000) }); await page.clock.pauseAt(new Date(now));
  await page.addInitScript(localOrigin => {
    if (location.origin !== localOrigin) return;
    localStorage.setItem('market-monitor:perpetual:v1', JSON.stringify({ version: 2, sortBy: 'gross' }));
    localStorage.removeItem('market-monitor:perpetual-scanner:v1');
  }, origin);
  try {
    await page.route('**/api/**', async route => {
      const path = '/' + route.request().url().split('/').slice(3).join('/').split('?')[0];
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (path.endsWith('/perpetual/crossex-settings')) {
        if (route.request().method() === 'PUT') { const input = route.request().postDataJSON(); required = input.config.requireSpotTransfer; revision++; }
        return route.fulfill({ json: settings() });
      }
      if (path.endsWith('/perpetual/quote')) return route.fulfill({ json: { schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: now, staleAfterMs: 30_000,
        quotes: ['BTC', 'ETH'].flatMap(base => ['binance', 'gate', 'bybit'].map((exchange, i) => quote(exchange, base, i))),
        exchanges: ['binance', 'gate', 'bybit'].map(id => ({ id, name: id, kind: 'cex', status: 'live', marketCount: 2, quoteCount: 2, lastMessageAt: now, error: null })) } });
      if (path.endsWith('/perpetual/stream')) return route.fulfill({ status: 503, body: 'fixture polling only' });
      return route.fulfill({ status: 503, json: { error: 'Unavailable fixture detail' } });
    });
    const rowCount = () => page.locator('.perp-table tbody > tr:not(.perp-detail-row)').count();
    const tick = async ms => { now += ms; await page.clock.runFor(ms); };
    const waitCount = async expected => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await page.locator('.perp-base-cell').count() === expected) return;
        await tick(100);
      }
      throw new Error(`Expected ${expected} ranking rows; actual ${await page.locator('.perp-base-cell').count()}`);
    };
    await page.goto(`${origin}/?monitor=perpetual&goldOil=cl&goldOilExchange=binance`);
    await waitCount(1);
    check((await page.locator('.perp-base-cell').innerText()).includes('BTC'), 'Only the qualified base/pair enters the ranking');
    await page.clock.resume();
    await page.getByRole('button', { name: /^展开 BTC，/ }).click();
    await page.getByText('行情已暂停', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '各平台报价', exact: true }).click();
    now = await page.evaluate(() => Date.now()) + 100;
    await page.clock.pauseAt(new Date(now));
    await page.getByRole('tab', { name: '各平台报价', exact: true, selected: true }).waitFor();
    const cell = await page.locator('.scanner-detail-evidence').innerText();
    for (const text of ['双边现货', '双向充提正常', '共同网络 BTC', '核验', '到期']) check(cell.includes(text), `Missing evidence: ${text}`);
    check((await page.locator('.perp-pagination').innerText()).includes('/ 1 组合'), 'Pagination uses the qualified count');
    await page.screenshot({ path: '.sites-runtime/monitor-transfer-evidence-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Enabled evidence fits a 390px mobile viewport');
    check(await page.locator('.scanner-table-wrap').evaluate(element => element.scrollWidth > element.clientWidth), 'Mobile evidence stays in the horizontal table');
    await page.screenshot({ path: '.sites-runtime/monitor-transfer-evidence-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.perp-inspection-bar').getByRole('button', { name: '收起并恢复', exact: true }).click();
    await page.locator('.scanner-tools > summary').click();
    const toggle = page.getByRole('checkbox', { name: '仅显示并推送双边有现货且共同网络充提正常的机会' });
    await toggle.click(); await waitCount(6);
    await page.locator('.perp-expand-cell button').first().click();
    check(await page.locator('.scanner-detail-evidence').getByText('现货充提：未启用', { exact: true }).count() === 1, 'Disabled filter is explicitly unverified in the selected pair evidence');
    await page.locator('.perp-inspection-bar').getByRole('button', { name: '收起并恢复', exact: true }).click();
    await toggle.click(); await waitCount(1);
    await page.getByRole('button', { name: /^展开 BTC，/ }).click();
    await page.getByText('行情已暂停', { exact: true }).waitFor();
    qualifies = false; metadataRevision++;
    await tick(16_000); await waitCount(0);
    check(await page.getByText('行情已暂停', { exact: true }).count() === 0, 'Revoked eligibility releases frozen inspection');
    await page.getByRole('button', { name: /^全部报价/ }).click();
    check(await page.locator('.perp-quote-identity').count() === 6, 'Raw quotes stay available after qualification revocation');
    await page.getByRole('button', { name: '价格套利', exact: true }).click();
    qualifies = true; metadataRevision++; expiresAt = now + 20_000;
    await tick(16_000); await waitCount(1);
    await page.getByRole('button', { name: /^展开 BTC，/ }).click();
    await page.getByText('行情已暂停', { exact: true }).waitFor();
    await tick(Math.max(1, expiresAt - now)); await waitCount(0);
    check(await page.getByText('行情已暂停', { exact: true }).count() === 0, 'Expiry at equality removes a frozen row without a metadata request');
    check(counts.get('/api/monitors/perpetual/crossex-settings') < 10, 'Qualification is shared rather than fetched per row');
    await toggle.click(); await waitCount(6);
    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '390px mobile page has no horizontal overflow');
    await page.screenshot({ path: '.sites-runtime/monitor-transfer-mobile.png', fullPage: true });
    check(errors.length === 0, `Unexpected page errors: ${errors.join('; ')}`);
    return { passed: true, checks: ['enabled evidence and count', 'disabled unverified', 'frozen revocation', 'raw quotes retained', 'strict expiry', '390px mobile'], rows: await rowCount(), requests: Object.fromEntries(counts) };
  } finally { await page.clock.resume(); }
}
