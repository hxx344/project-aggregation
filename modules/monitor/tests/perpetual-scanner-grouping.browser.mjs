// Start the production preview at 127.0.0.1:3193 (node --experimental-strip-types tests/ssr-browser-server.mjs 3193), then:
// playwright-cli -s=scanner-grouping open about:blank --headed
// playwright-cli -s=scanner-grouping run-code --filename tests/perpetual-scanner-grouping.browser.mjs
// Deterministic local fixtures only; external requests are blocked.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3193', anchor = Date.UTC(2026, 10, 4, 12), hour = 3_600_000;
  const preferenceKey = 'market-monitor:perpetual:v1', displayKey = 'market-monitor:perpetual-scanner:v1', principalKey = 'market-monitor:perpetual-principal:v1';
  const bases = Array.from({ length: 25 }, (_, index) => `COIN${String(index).padStart(2, '0')}`);
  const venues = [{ id: 'binance', name: 'Binance' }, { id: 'gate', name: 'Gate' }, { id: 'kraken', name: 'Kraken' }];
  let now = anchor;
  const errors = [], external = [], qualityBodies = [];
  const check = (condition, message) => { if (!condition) throw Error(message); };
  // Three venues give every base three positive-spread combinations: binance→kraken leads, two others follow.
  const price = (index, exchange) => exchange === 'binance' ? 100 : (exchange === 'gate' ? 101 : 102) + (24 - index) * .01;
  const snapshot = () => ({ schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: now, staleAfterMs: 30_000, streamId: 'scanner-grouping-fixture', sequence: 0,
    quotes: bases.flatMap((base, index) => venues.map(({ id: exchange }) => {
      const value = price(index, exchange);
      return { exchange, base, symbol: `${base}USDT`, quoteCurrency: 'USDT', multiplier: 1, bid: value, ask: value, mark: value, last: value,
        bidAskAt: now, markAt: now, sourceTime: now, receivedAt: now, transport: 'rest', fundingRate: exchange === 'kraken' ? .0002 : .0001, fundingIntervalHours: 8,
        fundingAt: now, nextFundingAt: now + hour, comparable: true, assetClass: 'crypto', identityVerified: true, identitySource: 'official fixture directory', collateralCurrency: 'USDT' };
    })),
    exchanges: venues.map(venue => ({ ...venue, kind: 'cex', status: 'live', marketCount: bases.length, quoteCount: bases.length, lastMessageAt: now, error: null })) });
  const stats = { samples: 288, expectedSamples: 288, coverage: 1, firstAt: now - 24 * hour, lastAt: now - 60_000, mean: .0123, stddev: .001, positiveRatio: 1, signChanges: 0 };
  const quality = pairs => ({ schemaVersion: 1, generatedAt: now, assets: {}, assetErrors: {}, positioning: {}, positioningErrors: {}, positioningOverview: {}, error: null,
    pairs: Object.fromEntries(pairs.map(pair => [JSON.stringify([pair.base, pair.longKey, pair.shortKey]), { base: pair.base, longKey: pair.longKey, shortKey: pair.shortKey,
      spread: { ...stats, mean: 1 },
      funding: { ...stats, longStddev: 0, shortStddev: 0, max: .0456, positiveRunMs: 5 * hour, positiveRunCapped: false } }])) });
  const rows = page.locator('.perp-scanner:visible .perp-scanner-table > tbody > tr:not(.perp-detail-row):not(.scanner-group-more)');
  const names = () => rows.locator('.perp-base-cell > div > strong').evaluateAll(cells => cells.map(cell => cell.firstChild?.textContent ?? ''));
  const tick = async ms => { now += ms; await page.clock.runFor(ms); };
  const until = async (predicate, message) => {
    for (let attempt = 0; attempt < 100; attempt++) { if (await predicate()) return; await tick(100); }
    throw Error(`${message}; rows=${JSON.stringify(await names())}`);
  };
  const expectRows = expected => until(async () => JSON.stringify(await names()) === JSON.stringify(expected), `Expected ${expected.join(', ')}`);
  const groupButton = page.getByRole('button', { name: '按币种聚合', exact: true });
  const toggleFor = base => page.getByRole('button', { name: new RegExp(`^(展开|收起) ${base} 的其他 2 个组合$`) });
  const stored = key => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), key);
  const checks = [];
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.install({ time: new Date(anchor - 1000) });
  await page.clock.pauseAt(new Date(anchor));
  await page.addInitScript(({ origin, preferenceKey, displayKey, principalKey }) => {
    if (location.origin !== origin || sessionStorage.getItem('scanner-grouping-seeded')) return;
    sessionStorage.setItem('scanner-grouping-seeded', '1');
    localStorage.setItem(preferenceKey, JSON.stringify({ version: 2, sortBy: 'gross', minSpreadPercent: 0 }));
    for (const key of [displayKey, principalKey, 'market-monitor:perpetual-scanner-ranges:v1', 'market-monitor:perpetual-scanner-sort:v1']) localStorage.removeItem(key);
  }, { origin, preferenceKey, displayKey, principalKey });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (url.origin !== origin) { external.push(url.origin); return route.abort('blockedbyclient'); }
      if (!path.startsWith('/api/')) return route.continue();
      if (path.endsWith('/perpetual/quote')) return route.fulfill({ json: snapshot() });
      if (path.endsWith('/perpetual/stream')) return route.fulfill({ status: 503, body: 'fixture polling only' });
      if (path.endsWith('/perpetual/crossex-settings')) return route.fulfill({ json: { available: true, generatedAt: now, revision: 0, metadataRevision: 1,
        config: { requireSpotTransfer: false, blockedBases: [] }, error: '', spotTransferPairs: [], venues: venues.map(venue => ({ exchange: venue.id, state: 'live', checkedAt: now, error: '' })) } });
      if (path.endsWith('/perpetual/fx')) return route.fulfill({ json: { baseCurrency: 'USDT', generatedAt: now, staleAfterMs: 180_000, rates: {} } });
      if (path.endsWith('/perpetual/quality')) { const body = route.request().postDataJSON(); qualityBodies.push(body); return route.fulfill({ json: quality(body.pairs) }); }
      return route.fulfill({ status: 503, json: { error: 'Unavailable fixture detail' } });
    });
    await page.goto(`${origin}/?monitor=perpetual&goldOil=cl&goldOilExchange=binance`);

    // New users start grouped: one lead row per base, twenty bases per page.
    await expectRows(bases.slice(0, 20));
    check(await groupButton.getAttribute('aria-pressed') === 'true', 'Grouping is on by default');
    check(await page.getByRole('button', { name: /^展开 COIN\d\d 的其他 2 个组合$/ }).count() === 20, 'Every lead shows a +2 toggle');
    check(await rows.first().innerText().then(text => /Binance[\s\S]*Kraken/.test(text)), 'The widest combination (Binance → Kraken) leads its group');
    checks.push('grouped by default');
    // The 24h funding column reads history only; positioning stays off while no quality column, detail or tools are open.
    await until(async () => qualityBodies.length > 0, 'Funding stability requests quality history');
    check(qualityBodies.every(body => body.positioning === false && body.pairs.length <= 30), 'History-only quality reads never ask for positioning');
    const historyOnlyReads = qualityBodies.length;

    await toggleFor('COIN00').click();
    await expectRows(['COIN00', 'COIN00', 'COIN00', ...bases.slice(1, 20)]);
    check(await page.locator('.perp-scanner:visible tr.scanner-group-child').count() === 2, 'Children are marked as group rows');
    check(await toggleFor('COIN00').getAttribute('aria-expanded') === 'true', 'The open group reports aria-expanded');
    // A paused detail on a child row closes when another group replaces it; the list resumes instead of freezing.
    await page.locator('.perp-scanner:visible tr.scanner-group-child').first().getByRole('button', { name: /^展开 .* 质量依据与各平台报价$/ }).click();
    await until(async () => await page.locator('.perp-inspection-bar').count() === 1, 'Child detail pauses the list');
    await toggleFor('COIN01').click();
    await expectRows(['COIN00', 'COIN01', 'COIN01', 'COIN01', ...bases.slice(2, 20)]);
    check(await page.locator('.perp-inspection-bar').count() === 0 && !(await page.locator('.perp-connection').innerText()).includes('暂停'), 'Switching groups closes the hidden child detail and resumes');
    await toggleFor('COIN01').click();
    await expectRows(bases.slice(0, 20));
    checks.push('one group expands at a time');

    const stabilityCell = rows.first().locator('td').filter({ hasText: '连续为正' });
    await until(async () => await stabilityCell.count() === 1, 'Funding stability cell renders');
    const stabilityText = await stabilityCell.innerText();
    check(/0\.0123/.test(stabilityText) && /0\.0456/.test(stabilityText) && /5h/.test(stabilityText), `Stability shows mean, peak and run: ${stabilityText}`);
    checks.push('funding stability without positioning');

    // Principal drives the profit estimate and persists.
    check(await page.locator('.perp-scanner:visible thead [data-column="breakEven"]').innerText().then(text => text.includes('本金 1,000 U')), 'Default principal is 1,000 USDT');
    await page.locator('.scanner-tools > summary').click();
    await page.locator('.scanner-advanced-filters > summary').click();
    await page.getByRole('spinbutton', { name: '收益估算本金', exact: true }).fill('5000');
    await until(async () => (await page.locator('.perp-scanner:visible thead [data-column="breakEven"]').innerText()).includes('本金 5,000 U'), 'Principal updates the header');
    await until(async () => (await stored(principalKey))?.principal === 5000, 'Principal persists');
    checks.push('principal persists');
    // Opening the tools panel shows positioning evidence, so later reads may ask for it again.
    await until(async () => qualityBodies.slice(historyOnlyReads).some(body => body.positioning === true), 'Open details or tools re-enable positioning reads');
    checks.push('tools re-enable positioning');

    // Turning grouping off restores the flat thirty-row page and survives reload.
    await groupButton.click();
    await until(async () => (await names()).length === 30, 'Ungrouped view shows thirty combinations');
    check((await stored(displayKey))?.groupByBase === false, 'Grouping preference persists');
    await page.reload();
    await until(async () => (await names()).length === 30 && await groupButton.getAttribute('aria-pressed') === 'false', 'Ungrouped preference survives reload');
    checks.push('grouping toggle persists');

    check(errors.length === 0 && external.length === 0, `Unexpected activity: errors=${errors.join('; ')} external=${external.join(', ')}`);
    return { passed: true, checks, qualityReads: qualityBodies.length };
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
}
