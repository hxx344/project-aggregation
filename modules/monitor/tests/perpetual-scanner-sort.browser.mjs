// Windows-native production preview: node --experimental-strip-types tests/ssr-browser-server.mjs 3193
// playwright-cli -s=scanner-sort open about:blank --headed
// playwright-cli -s=scanner-sort run-code --filename tests/perpetual-scanner-sort.browser.mjs
// Deterministic public-market fixtures only. External requests and account writes are blocked.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3193', anchor = Date.UTC(2026, 9, 11, 12), hour = 3_600_000;
  const preferenceKey = 'market-monitor:perpetual:v1', displayKey = 'market-monitor:perpetual-scanner:v1';
  const rangeKey = 'market-monitor:perpetual-scanner-ranges:v1', sortKey = 'market-monitor:perpetual-scanner-sort:v1';
  const bases = Array.from({ length: 65 }, (_, index) => `COIN${String(index).padStart(2, '0')}`);
  const venues = [{ id: 'binance', name: 'Binance' }, { id: 'gate', name: 'Gate' }];
  const doubleColumns = new Set(['volume', 'openInterest', 'quote']);
  const historyHours = { history24h: 24, history7d: 168, history30d: 720 };
  const errors = [], external = [], writes = [], scannerRequests = [], counts = new Map();
  let now = anchor, pendingSevenDay = true, metricLeader = null, long00 = 100;
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const onError = error => { if (!errors.includes(error.message)) errors.push(error.message); };
  const indexOf = base => Number(base.slice(4));
  const quotePrice = (index, side, currentLong00 = long00) => side === 'long' ? index === 0 ? currentLong00 : 100 + index : 300 - index;
  const sourceMissing = index => index === 62 || index === 63;
  const snapshot = ({ at = now, sequence = 0, currentLong00 = long00 } = {}) => ({
    schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: at, staleAfterMs: 30_000, streamId: 'scanner-sort-fixture', sequence,
    quotes: bases.flatMap((base, index) => venues.map(({ id: exchange }) => {
      const price = quotePrice(index, exchange === 'binance' ? 'long' : 'short', currentLong00);
      return { exchange, base, symbol: `${base}USDT`, quoteCurrency: 'USDT', multiplier: 1,
        bid: price, ask: price, mark: price, last: price, bidAskAt: at, markAt: at, sourceTime: at, receivedAt: at, transport: 'ws',
        fundingRate: index === 63 ? null : exchange === 'gate' ? (index - 30) * .000001 : 0,
        fundingIntervalHours: 8, fundingAt: index === 62 ? at - 400_000 : at, nextFundingAt: at + hour,
        comparable: true, assetClass: 'crypto', identityVerified: true, identitySource: 'local sorting fixture', collateralCurrency: 'USDT' };
    })), exchanges: venues.map(venue => ({ ...venue, kind: 'cex', status: 'live', marketCount: bases.length, quoteCount: bases.length, lastMessageAt: at, error: null })),
  });
  const metricAmount = (index, column, leg) => {
    if (sourceMissing(index)) return null;
    if (leg === 'long' && bases[index] === metricLeader) return column === 'volume' ? 100_000_000 : 10_000_000;
    if (column === 'volume') return leg === 'long' ? index * 1000 : (64 - index) * 2000;
    return leg === 'long' ? index * 3000 : (64 - index) * 5000;
  };
  const metricsFor = keys => Object.fromEntries([...new Set(keys)].map(key => {
    const [exchange, symbol] = key.split(':'), index = indexOf(symbol.slice(0, -4)), leg = exchange === 'binance' ? 'long' : 'short';
    // Raw currency amounts deliberately disagree with their comparable order.
    const currency = ['USD', 'USDC', 'USDT'][(index + (leg === 'short' ? 1 : 0)) % 3], fx = { USD: 2, USDC: 1.5, USDT: 1 }[currency];
    const metric = column => ({ value: index === 63 ? null : (metricAmount(index, column, leg) ?? 9_999_999) / fx,
      currency: index === 63 ? null : currency, observedAt: index === 63 ? null : index === 62 ? now - 700_000 : now,
      source: 'official sorting fixture', error: index === 63 ? 'upstream missing' : '' });
    return [key, { key, exchange, symbol, identity: `${key}:fixture`, status: index === 63 ? 'error' : 'ready', fetchedAt: now,
      volume24h: metric('volume'), openInterest: metric('openInterest'), error: index === 63 ? 'upstream missing' : '' }];
  }));
  const pairKey = pair => JSON.stringify([pair.base, ...[pair.longKey, pair.shortKey].sort()]);
  const actualFunding = (index, hours) => (index - 30) * (hours / 8) * .001;
  const totalFor = (pair, hours) => {
    const index = indexOf(pair.base), pending = pendingSevenDay && index === 64 && hours === 168, missing = index === 63, stale = index === 62;
    const value = actualFunding(index, hours);
    return { hours, asOf: pending ? null : stale ? now - 700_000 : now,
      longPercent: pending || missing ? null : 0, shortPercent: pending || missing ? null : value, netPercent: pending || missing ? null : value,
      longCount: pending ? 0 : hours / 8, shortCount: pending ? 0 : hours / 8,
      status: pending ? 'pending' : missing ? 'partial' : stale ? 'stale' : 'ready',
      reason: pending ? '历史结算采集中' : missing ? '历史不足' : stale ? '来源时间已过期' : '' };
  };
  const rawHistory = pairs => Object.fromEntries([...new Set(pairs.flatMap(pair => [pair.longKey, pair.shortKey]))].map(key => {
    const [exchange, symbol] = key.split(':'), index = indexOf(symbol.slice(0, -4)), at = index === 62 ? now - 700_000 : now;
    return [key, { key, exchange, symbol, identity: `${key}:fixture`, status: 'ready', fetchedAt: at, coverage: { from: at - 768 * hour, to: at }, error: '', backfillComplete: true,
      records: index === 63 ? [] : Array.from({ length: 97 }, (_, count) => ({ time: at - (96 - count) * 8 * hour, rate: exchange === 'gate' ? (index - 30) * .00001 : 0 })) }];
  }));
  const valueFor = (base, column, leg = 'long') => {
    const index = indexOf(base);
    if (column === 'quote') return quotePrice(index, leg);
    if (column === 'spread') return (quotePrice(index, 'short') / quotePrice(index, 'long') - 1) * 100;
    if (sourceMissing(index)) return null;
    if (doubleColumns.has(column)) return metricAmount(index, column, leg);
    if (historyHours[column]) return pendingSevenDay && index === 64 && column === 'history7d' ? null : actualFunding(index, historyHours[column]);
    return (index - 30) * (column === 'annualized' ? .1095 : .0001);
  };
  const expected = (column, direction, leg = 'long', candidates = bases) => [...candidates].sort((left, right) => {
    const a = valueFor(left, column, leg), b = valueFor(right, column, leg);
    if (a === null || b === null) return a === null ? b === null ? left.localeCompare(right) : 1 : -1;
    return (direction === 'desc' ? b - a : a - b) || left.localeCompare(right);
  });

  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.install({ time: new Date(anchor - 1000) });
  await page.clock.pauseAt(new Date(anchor));
  await page.addInitScript(({ origin, preferenceKey, displayKey, rangeKey, sortKey, initial }) => {
    if (location.origin !== origin) return;
    if (!sessionStorage.getItem('scanner-sort-seeded')) {
      sessionStorage.setItem('scanner-sort-seeded', '1');
      localStorage.setItem(preferenceKey, JSON.stringify({ version: 2, sortBy: 'gross', minSpreadPercent: 0 }));
      for (const key of [displayKey, rangeKey, sortKey]) localStorage.removeItem(key);
    }
    const fixture = window.perpetualSortFixture = { initial, streams: [], created: 0, frames: 0, sequence: 0, long00: 100 };
    window.EventSource = class FixtureEventSource {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      constructor(url) {
        if (url !== '/api/monitors/perpetual/stream') throw Error(`Unexpected EventSource ${url}`);
        this.readyState = 1; this.onmessage = null; this.onerror = null;
        fixture.created++; fixture.streams.push(this); this.restart(); this.first = setTimeout(() => this.emit(true), 0);
      }
      restart(delay = 1000) {
        clearInterval(this.timer); clearTimeout(this.leading);
        this.leading = setTimeout(() => { this.emit(false); this.timer = setInterval(() => this.emit(false), 1000); }, delay);
      }
      emit(baseline) {
        if (this.readyState !== 1) return;
        const at = Date.now(), baseSequence = fixture.sequence, frame = structuredClone(fixture.initial);
        frame.generatedAt = at; frame.sequence = ++fixture.sequence;
        for (const quote of frame.quotes) {
          for (const field of ['bidAskAt', 'markAt', 'sourceTime', 'receivedAt']) quote[field] = at;
          quote.fundingAt = quote.base === 'COIN62' ? at - 400_000 : at; quote.nextFundingAt = at + 3_600_000;
          if (quote.base === 'COIN00' && quote.exchange === 'binance') for (const field of ['bid', 'ask', 'mark', 'last']) quote[field] = fixture.long00;
        }
        for (const exchange of frame.exchanges) exchange.lastMessageAt = at;
        const payload = baseline ? frame : { schemaVersion: 1, monitorId: 'perpetual', type: 'patch', status: 'live', generatedAt: at, staleAfterMs: 30_000,
          streamId: 'scanner-sort-fixture', sequence: frame.sequence, baseSequence, patches: frame.quotes.map(quote => [`${quote.exchange}:${quote.symbol}`, quote]), removed: [], exchanges: frame.exchanges };
        fixture.frames++; this.onmessage?.({ data: JSON.stringify(payload) });
      }
      close() { this.readyState = 2; clearInterval(this.timer); clearTimeout(this.first); clearTimeout(this.leading); }
    };
  }, { origin, preferenceKey, displayKey, rangeKey, sortKey, initial: snapshot() });

  const table = page.locator('.perp-scanner:visible .perp-scanner-table');
  const rows = table.locator(':scope > tbody > tr:not(.perp-detail-row)');
  const names = () => rows.locator('.perp-base-cell > div > strong').allTextContents();
  const header = column => table.locator(`thead th[data-column="${column}"]`);
  const title = column => header(column).locator('button.scanner-sort-column').first();
  const legButton = (column, leg) => header(column).locator(`button[data-sort-leg="${leg}"]`);
  const field = name => page.getByRole('textbox', { name, exact: true });
  const nextPage = page.getByRole('button', { name: '下一页', exact: true });
  const previousPage = page.getByRole('button', { name: '上一页', exact: true });
  const filterToggle = page.locator('#perpetual-filter-toggle');
  const filterPanel = page.getByRole('region', { name: '套利组合范围筛选', exact: true });
  const tick = async ms => { now += ms; await page.clock.runFor(ms); };
  const until = async (predicate, message, budget = 10_000) => {
    for (let elapsed = 0; elapsed <= budget; elapsed += 100) { if (await predicate()) return; await tick(100); }
    throw Error(`${message}; rows=${JSON.stringify(await names())}`);
  };
  const expectRows = list => until(async () => JSON.stringify(await names()) === JSON.stringify(list), `Expected ${list.join(', ')}`);
  const expectFirstPage = (column, direction, leg = 'long', candidates = bases) => expectRows(expected(column, direction, leg, candidates).slice(0, 30));
  const expectSort = async (column, direction, leg = 'long') => {
    await until(async () => await header(column).count() > 0 && await header(column).getAttribute('aria-sort') === (direction === 'desc' ? 'descending' : 'ascending'), `${column} exposes ${direction}`);
    check(await table.locator('thead th[aria-sort="ascending"], thead th[aria-sort="descending"]').count() === 1, 'Only the active column announces a sort direction');
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), sortKey);
    check(saved?.column === column && saved.direction === direction && (!doubleColumns.has(column) || saved.leg === leg), `Persisted ${column}/${leg}/${direction} matches the active sort`);
    check(!new URL(page.url()).searchParams.has('perpView'), 'Sorting does not open the combination chart');
  };
  const firstPage = async () => { while (!await previousPage.isDisabled()) await previousPage.click(); };
  const expectMissingAtEnd = async (column, direction, leg = 'long') => {
    await nextPage.click(); await nextPage.click();
    const last = await names(), valid = expected(column, direction, leg).filter(base => valueFor(base, column, leg) !== null);
    check(JSON.stringify(last.slice(0, 3)) === JSON.stringify(valid.slice(60)), `${column} final page retains the last valid values in ${direction} order`);
    check(JSON.stringify([...last.slice(3)].sort()) === JSON.stringify(['COIN62', 'COIN63']), 'Stale and missing amounts stay last in either direction');
    await firstPage();
  };
  const manualRefresh = async () => {
    const [response] = await Promise.all([page.waitForResponse(response => response.url() === `${origin}/api/monitors/perpetual/quote`), page.getByRole('button', { name: '刷新', exact: true }).click()]);
    await response.finished();
  };
  page.on('pageerror', onError);
  try {
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin) { external.push(url.href); return route.abort('blockedbyclient'); }
      if (!path.startsWith('/api/')) return route.continue();
      counts.set(path, (counts.get(path) ?? 0) + 1);
      const readPosts = ['metrics', 'funding-history', 'scanner-data', 'quality', 'depth'];
      if (!['GET', 'HEAD'].includes(request.method()) && !readPosts.some(action => path === `/api/monitors/perpetual/${action}`)) {
        writes.push(`${request.method()} ${path}`); return route.abort('blockedbyclient');
      }
      if (path.endsWith('/perpetual/quote')) {
        const state = await page.evaluate(() => ({ at: Date.now(), sequence: window.perpetualSortFixture.sequence, currentLong00: window.perpetualSortFixture.long00 }));
        return route.fulfill({ json: snapshot(state) });
      }
      if (path.endsWith('/perpetual/stream')) throw Error('Native EventSource escaped the sorting fixture');
      if (path.endsWith('/perpetual/crossex-settings')) return route.fulfill({ json: { available: true, generatedAt: now, revision: 0, metadataRevision: 1,
        config: { requireSpotTransfer: false, blockedBases: [] }, error: '', spotTransferPairs: [], venues: venues.map(venue => ({ exchange: venue.id, state: 'live', checkedAt: now, error: '' })) } });
      if (path.endsWith('/perpetual/fx')) return route.fulfill({ json: { baseCurrency: 'USDT', generatedAt: now, staleAfterMs: 180_000,
        rates: Object.fromEntries([['USD', 2], ['USDC', 1.5]].map(([currency, mid]) => [currency, { bid: mid, ask: mid, at: now, source: 'official fixture FX' }])) } });
      if (path.endsWith('/perpetual/scanner-data')) {
        const body = request.postDataJSON(); scannerRequests.push({ at: now, ...body });
        check(body.pairs.length <= 30, 'Full-table sorting uses bounded batches of at most thirty pairs');
        return route.fulfill({ json: { schemaVersion: 1, generatedAt: now,
          metrics: body.metrics ? metricsFor(body.pairs.flatMap(pair => [pair.longKey, pair.shortKey])) : {},
          history: Object.fromEntries(body.pairs.filter(() => body.historyHours.length).map(pair => [pairKey(pair), Object.fromEntries(body.historyHours.map(hours => [hours, totalFor(pair, hours)]))])) } });
      }
      if (path.endsWith('/perpetual/metrics')) return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, legs: metricsFor(request.postDataJSON().pairs.flatMap(pair => [pair.longKey, pair.shortKey])) } });
      if (path.endsWith('/perpetual/funding-history')) return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, legs: rawHistory(request.postDataJSON().pairs) } });
      if (path.endsWith('/perpetual/quality')) return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, pairs: {}, assets: {}, assetErrors: {}, positioning: {}, positioningErrors: {} } });
      return route.fulfill({ status: 503, json: { error: 'Unavailable local fixture detail' } });
    });
    await page.goto(`${origin}/?monitor=perpetual`);
    await expectRows(bases.slice(0, 30));
    await nextPage.click(); await nextPage.click(); await expectRows(bases.slice(60));
    check((await names()).includes('COIN64'), 'The largest long-leg amount starts on the third page');

    await title('volume').click(); await expectSort('volume', 'desc'); await expectFirstPage('volume', 'desc');
    check(await previousPage.isDisabled(), 'A new column sort resets page three to page one');
    check(new Set(scannerRequests.filter(request => request.metrics).flatMap(request => request.pairs.map(pair => pair.base))).size === 65, 'Amount sorting loads all sixty-five candidates without requiring an amount filter');
    check((counts.get('/api/monitors/perpetual/fx') ?? 0) >= 1, 'Amount sorting loads the real quote-currency conversion');
    await expectMissingAtEnd('volume', 'desc');
    await title('volume').click(); await expectSort('volume', 'asc'); await expectFirstPage('volume', 'asc');
    check((await names())[0] === 'COIN00', 'A genuine zero sorts before positive amounts');
    await expectMissingAtEnd('volume', 'asc');

    for (const column of ['fundingSpread', 'annualized', 'openInterest', 'quote', 'spread', 'history24h', 'history30d']) {
      await title(column).click(); await expectSort(column, 'desc'); await expectFirstPage(column, 'desc');
      await title(column).click(); await expectSort(column, 'asc'); await expectFirstPage(column, 'asc');
    }
    for (const column of ['volume', 'openInterest', 'quote']) {
      await title(column).click(); await expectSort(column, 'desc'); await expectFirstPage(column, 'desc');
      await legButton(column, 'long').click(); await expectSort(column, 'asc'); await expectFirstPage(column, 'asc');
      await legButton(column, 'short').click(); await expectSort(column, 'desc', 'short'); await expectFirstPage(column, 'desc', 'short');
      await legButton(column, 'short').click(); await expectSort(column, 'asc', 'short'); await expectFirstPage(column, 'asc', 'short');
      await title(column).click(); await expectSort(column, 'desc'); await expectFirstPage(column, 'desc');
      check(await rows.locator('.perp-long .scanner-venue-mark').evaluateAll(elements => elements.every(element => element.dataset.exchange === 'binance'))
        && await rows.locator('.perp-short .scanner-venue-mark').evaluateAll(elements => elements.every(element => element.dataset.exchange === 'gate')), `${column} leg selection only reorders combinations and never swaps the actual trade legs`);
    }

    await title('history7d').click(); await expectSort('history7d', 'desc'); await expectFirstPage('history7d', 'desc');
    check((await names())[0] === 'COIN61', 'The pending largest historical value cannot be treated as zero or a completed return');
    check(new Set(scannerRequests.filter(request => request.historyHours.includes(168)).flatMap(request => request.pairs.map(pair => pair.base))).size === 65, 'Historical sorting reaches the final candidate while its history is still pending');
    pendingSevenDay = false; await tick(3100); await expectFirstPage('history7d', 'desc');
    check((await names())[0] === 'COIN64', 'Pending-to-ready data reorders the whole table without another header click');
    await title('history7d').click(); await expectSort('history7d', 'asc'); await expectFirstPage('history7d', 'asc');
    const row0 = rows.filter({ has: page.getByText('COIN00', { exact: true }) });
    check((await row0.locator('[data-column="history7d"] strong').innerText()).startsWith('−'), 'Negative actual funding remains negative in the selected sort display');
    check(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).sortBy, preferenceKey) === 'gross', 'Column sorting leaves price-arbitrage mode and the original opportunity preference unchanged');

    await title('volume').click(); await expectSort('volume', 'desc'); await expectFirstPage('volume', 'desc');
    await header('volume').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/scanner-sort-desktop.png', fullPage: false });
    await field('搜索币种').fill('COIN6');
    if (await filterToggle.getAttribute('aria-expanded') !== 'true') await filterToggle.click();
    await field('开仓价差最小值').fill('40');
    await expectFirstPage('volume', 'desc', 'long', bases.slice(60));
    await filterPanel.getByRole('button', { name: '收起', exact: true }).click();
    await page.reload(); await expectSort('volume', 'desc'); await expectFirstPage('volume', 'desc', 'long', bases.slice(60));
    check(await field('搜索币种').inputValue() === 'COIN6', 'Reload keeps the independent search');
    await filterToggle.click(); check(await field('开仓价差最小值').inputValue() === '40', 'Reload keeps the explicit range condition');
    await filterPanel.getByRole('button', { name: '收起', exact: true }).click();

    const frozen = await names();
    await rows.first().getByRole('button', { name: /^展开 COIN64，/ }).click();
    await until(async () => await page.locator('.perp-row-expanded').count() === 1, 'Opening details freezes the sorted row set');
    metricLeader = 'COIN60'; await tick(31_000);
    check(JSON.stringify(await names()) === JSON.stringify(frozen) && await page.locator('.perp-row-expanded').count() === 1, 'New metric data and its refresh deadline do not reorder the open inspection');
    await table.getByRole('button', { name: '收起并恢复', exact: true }).click();
    await expectFirstPage('volume', 'desc', 'long', bases.slice(60));
    check((await names())[0] === 'COIN60', 'Closing inspection resumes the saved column sort with newly collected amounts');

    await field('搜索币种').fill('');
    await filterToggle.click(); await field('开仓价差最小值').fill('0');
    await filterPanel.getByRole('button', { name: '收起', exact: true }).click();
    await title('quote').click(); await expectSort('quote', 'desc'); await expectFirstPage('quote', 'desc');
    await manualRefresh(); await expectFirstPage('quote', 'desc');
    const beforeTick = await names();
    await page.evaluate(() => { const fixture = window.perpetualSortFixture; fixture.long00 = 200; fixture.streams.at(-1).restart(500); });
    long00 = 200;
    for (let second = 1; second <= 19; second++) {
      await tick(1000); check(JSON.stringify(await names()) === JSON.stringify(beforeTick), `${second}s: quote sorting waits for the existing twenty-second display boundary`);
    }
    await tick(1000); await expectFirstPage('quote', 'desc');
    check((await names())[0] === 'COIN00', 'The latest received quote updates the selected whole-table sort at twenty seconds');

    await title('annualized').focus(); await title('annualized').press('Enter');
    await expectSort('annualized', 'desc'); await expectFirstPage('annualized', 'desc');
    check(await title('annualized').evaluate(element => element === document.activeElement), 'Enter leaves focus on the selected header');
    await title('annualized').press('Space'); await expectSort('annualized', 'asc'); await expectFirstPage('annualized', 'asc');
    check(await title('annualized').evaluate(element => element === document.activeElement), 'Space toggles direction without losing keyboard focus');

    await page.setViewportSize({ width: 390, height: 844 });
    await title('history30d').scrollIntoViewIfNeeded(); await title('history30d').click();
    await expectSort('history30d', 'desc'); await expectFirstPage('history30d', 'desc');
    await title('history30d').scrollIntoViewIfNeeded();
    check(await title('history30d').evaluate(element => {
      const bounds = element.getBoundingClientRect(), hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return bounds.x >= 0 && bounds.right <= innerWidth && bounds.y >= 0 && bounds.bottom <= innerHeight && (hit === element || element.contains(hit));
    }), 'The rightmost thirty-day sort remains visible and hit-testable after mobile horizontal scrolling');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The mobile page itself does not overflow horizontally');
    await page.screenshot({ path: 'output/playwright/scanner-sort-mobile.png', fullPage: false });

    check(errors.length === 0 && external.length === 0 && writes.length === 0, JSON.stringify({ errors, external, writes }));
    return { passed: true, checks: ['nine columns in both directions', 'sixty-five candidates sorted before pagination and page reset', 'three independent long/short numeric sorts', 'quote-currency conversion, true zero, negative actuals and missing/stale last', 'pending history becomes ranked without another click', 'independent filters and persisted sort', 'inspection freezes and resumes sort', 'existing twenty-second quote delivery', 'Enter/Space, focus and no chart navigation', '390px rightmost header and bounded horizontal scrolling'],
      scannerRequests: scannerRequests.length, apiRequests: Object.fromEntries(counts), screenshots: ['output/playwright/scanner-sort-desktop.png', 'output/playwright/scanner-sort-mobile.png'] };
  } finally { page.off('pageerror', onError); await page.clock.resume(); }
}
