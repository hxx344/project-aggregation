// Use the current production build with: node --experimental-strip-types tests/ssr-browser-server.mjs 3193
// playwright-cli -s=perpetual-refresh open about:blank --headed
// playwright-cli -s=perpetual-refresh run-code --filename tests/perpetual-refresh.browser.mjs
// All requests and one-second SSE patches are local fixtures; no accounts or collectors are used.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3193', anchor = Date.UTC(2026, 9, 11), hour = 3_600_000;
  const bases = Array.from({ length: 65 }, (_, index) => `COIN${String(index).padStart(2, '0')}`);
  const venues = [{ id: 'binance', name: 'Binance' }, { id: 'gate', name: 'Gate' }];
  const target = 'COIN64', slower = 'COIN00', otherMatch = 'COIN63';
  const scannerRequests = [], external = [], mutations = [], errors = [], counts = new Map();
  let now = anchor, holdNextQuote = null;
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const onError = error => { if (!errors.includes(error.message)) errors.push(error.message); };
  const snapshot = ({ at = now, quoteAt = at, price64 = 102, sequence = 0 } = {}) => ({
    schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: at, staleAfterMs: 30_000, streamId: 'refresh-fixture', sequence,
    quotes: bases.flatMap((base, index) => venues.map(({ id: exchange }) => {
      const price = exchange === 'binance' ? 100 : base === target ? price64 : base === otherMatch ? 103 : 105 - index * .01;
      return { exchange, base, symbol: `${base}USDT`, quoteCurrency: 'USDT', multiplier: 1,
        bid: price, ask: price, mark: price, last: price, bidAskAt: quoteAt, markAt: quoteAt, sourceTime: quoteAt, receivedAt: at, transport: 'ws',
        fundingRate: exchange === 'gate' ? .0002 : .0001, fundingIntervalHours: 8, fundingAt: at, nextFundingAt: at + hour,
        comparable: true, assetClass: 'crypto', identityVerified: true, identitySource: 'local fixture', collateralCurrency: 'USDT' };
    })), exchanges: venues.map(venue => ({ ...venue, kind: 'cex', status: 'live', marketCount: bases.length, quoteCount: bases.length, lastMessageAt: at, error: null })),
  });
  const pairKey = pair => JSON.stringify([pair.base, ...[pair.longKey, pair.shortKey].sort()]);
  const totalFor = (pair, hours) => {
    const pending = pair.base === slower, value = [target, otherMatch].includes(pair.base) ? .6 : 0;
    // The slow leg keeps receiving newer tail timestamps without completing older history.
    return { hours, asOf: now, longPercent: pending ? null : 0, shortPercent: pending ? null : value, netPercent: pending ? null : value,
      longCount: pending ? 1 : hours / 8, shortCount: pending ? 1 : hours / 8, status: pending ? 'pending' : 'ready', reason: pending ? '历史结算采集中' : '' };
  };
  const metricsFor = pairs => Object.fromEntries([...new Set(pairs.flatMap(pair => [pair.longKey, pair.shortKey]))].map(key => {
    const [exchange, symbol] = key.split(':'), metric = value => ({ value, currency: 'USD', observedAt: now, source: 'local fixture', error: '' });
    return [key, { key, exchange, symbol, identity: `${key}:fixture`, status: 'ready', fetchedAt: now, volume24h: metric(1_000_000), openInterest: metric(100_000), error: '' }];
  }));
  const rawHistory = pairs => Object.fromEntries([...new Set(pairs.flatMap(pair => [pair.longKey, pair.shortKey]))].map(key => {
    const [exchange, symbol] = key.split(':');
    return [key, { key, exchange, symbol, identity: `${key}:fixture`, status: 'ready', fetchedAt: now, coverage: { from: now - 768 * hour, to: now }, error: '', backfillComplete: true,
      records: Array.from({ length: 97 }, (_, index) => ({ time: now - (96 - index) * 8 * hour, rate: exchange === 'gate' ? .0002 : .0001 })) }];
  }));
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.install({ time: new Date(anchor - 1000) });
  await page.clock.pauseAt(new Date(anchor));
  await page.addInitScript(({ origin, initial }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('market-monitor:perpetual:v1', JSON.stringify({ version: 2, sortBy: 'gross', minSpreadPercent: 0 }));
    localStorage.removeItem('market-monitor:perpetual-scanner:v1'); localStorage.removeItem('market-monitor:perpetual-scanner-ranges:v1');
    const fixture = window.perpetualRefreshFixture = { initial, streams: [], created: 0, frames: 0, sequence: 0, price64: 102, growing: false, staleAt: null };
    window.EventSource = class FixtureEventSource {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      constructor(url) {
        if (url !== '/api/monitors/perpetual/stream') throw Error(`Unexpected EventSource ${url}`);
        this.readyState = 1; this.onmessage = null; this.onerror = null;
        fixture.created++; fixture.streams.push(this); this.restart();
        this.first = setTimeout(() => this.emit(true), 0);
      }
      restart(delay = 1000) {
        clearInterval(this.timer); clearTimeout(this.leading);
        this.leading = setTimeout(() => { this.emit(false); this.timer = setInterval(() => this.emit(false), 1000); }, delay);
      }
      emit(baseline) {
        if (this.readyState !== 1) return;
        const at = Date.now(), quoteAt = fixture.staleAt ?? at, baseSequence = fixture.sequence;
        if (!baseline && fixture.growing) fixture.price64 = Number((fixture.price64 + .1).toFixed(1));
        const sequence = ++fixture.sequence;
        const frame = structuredClone(fixture.initial);
        frame.generatedAt = at; frame.sequence = sequence;
        for (const quote of frame.quotes) {
          for (const key of ['bidAskAt', 'markAt', 'sourceTime']) quote[key] = quoteAt;
          quote.receivedAt = at; quote.fundingAt = at;
          if (quote.base === 'COIN64' && quote.exchange === 'gate') for (const key of ['bid', 'ask', 'mark', 'last']) quote[key] = fixture.price64;
        }
        for (const exchange of frame.exchanges) exchange.lastMessageAt = at;
        const payload = baseline ? frame : { schemaVersion: 1, monitorId: 'perpetual', type: 'patch', status: 'live', generatedAt: at, staleAfterMs: 30_000,
          streamId: 'refresh-fixture', sequence, baseSequence, patches: frame.quotes.map(quote => [`${quote.exchange}:${quote.symbol}`, quote]), removed: [], exchanges: frame.exchanges };
        fixture.frames++; this.onmessage?.({ data: JSON.stringify(payload) });
      }
      close() { this.readyState = 2; clearInterval(this.timer); clearTimeout(this.first); clearTimeout(this.leading); }
    };
  }, { origin, initial: snapshot() });
  const rows = page.locator('.perp-scanner:visible .perp-scanner-table > tbody > tr:not(.perp-detail-row)');
  const names = () => rows.locator('.perp-base-cell > div > strong').allTextContents();
  const rowFor = base => rows.filter({ has: page.getByText(base, { exact: true }) });
  const spread = base => rowFor(base).locator('[data-column="spread"] strong').innerText();
  const tick = async ms => { now += ms; await page.clock.runFor(ms); };
  const until = async (predicate, message, budget = 5000) => {
    for (let elapsed = 0; elapsed <= budget; elapsed += 100) { if (await predicate()) return; await tick(100); }
    throw Error(`${message}; rows=${JSON.stringify(await names())}`);
  };
  page.on('pageerror', onError);
  try {
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin) { external.push(url.origin); return route.abort('blockedbyclient'); }
      if (!path.startsWith('/api/')) return route.continue();
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (!['GET', 'HEAD'].includes(request.method()) && !['metrics', 'funding-history', 'scanner-data'].some(name => path === `/api/monitors/perpetual/${name}`)) mutations.push(`${request.method()} ${path}`);
      if (path.endsWith('/perpetual/quote')) {
        const held = holdNextQuote;
        if (held) { holdNextQuote = null; await new Promise(resolve => { held.release = resolve; }); }
        const state = await page.evaluate(() => { const fixture = window.perpetualRefreshFixture; return { at: Date.now(), quoteAt: fixture.staleAt ?? Date.now(), price64: fixture.price64, sequence: fixture.sequence }; });
        if (held) state.price64 = 109;
        return route.fulfill({ json: snapshot(state) });
      }
      if (path.endsWith('/perpetual/stream')) throw Error('Native EventSource escaped the local fixture');
      if (path.endsWith('/perpetual/crossex-settings')) return route.fulfill({ json: { available: true, generatedAt: now, revision: 0, metadataRevision: 1,
        config: { requireSpotTransfer: false, blockedBases: [] }, error: '', spotTransferPairs: [], venues: venues.map(venue => ({ exchange: venue.id, state: 'live', checkedAt: now, error: '' })) } });
      if (path.endsWith('/perpetual/scanner-data')) {
        const body = request.postDataJSON(); scannerRequests.push({ at: now, ...body });
        return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, metrics: body.metrics ? metricsFor(body.pairs) : {},
          history: Object.fromEntries(body.pairs.map(pair => [pairKey(pair), Object.fromEntries(body.historyHours.map(hours => [hours, totalFor(pair, hours)]))])) } });
      }
      if (path.endsWith('/perpetual/metrics')) return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, legs: metricsFor(request.postDataJSON().pairs) } });
      if (path.endsWith('/perpetual/funding-history')) return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, legs: rawHistory(request.postDataJSON().pairs) } });
      return route.fulfill({ status: 503, json: { error: 'Unavailable local fixture detail' } });
    });
    await page.goto(`${origin}/?monitor=perpetual`);
    await until(async () => (await names()).length === 30, 'Initial quotes are shown immediately');
    await page.locator('#perpetual-filter-toggle').click();
    const thirtyDays = page.getByRole('textbox', { name: '30天实际资金费最小值', exact: true });
    const filterStarted = now;
    await thirtyDays.fill('0.5');
    await until(async () => JSON.stringify(await names()) === JSON.stringify([otherMatch, target]), 'Matches after the first 30 appear while COIN00 is still pending');
    const discoveryMs = now - filterStarted;
    check(scannerRequests[0].pairs.some(pair => pair.base === slower), 'The slow pair is in the original batch');
    check(scannerRequests.length >= 3 && scannerRequests.every(request => request.pairs.length <= 30 && request.historyHours.includes(720)), 'Thirty-day filtering visits later candidates in bounded batches');
    check(new Set(scannerRequests.flatMap(request => request.pairs.map(pair => pair.base))).size === 65, 'One unfinished history does not block all 65 candidates');
    check((await page.getByRole('status', { name: '全量筛选状态' }).innerText()).includes('30天历史待补齐 1'), 'Only the genuinely unfinished pair stays pending');
    check(await thirtyDays.inputValue() === '0.5', 'The requested 0.5% lower bound remains visible');

    // Half-second source offsets keep the final patch ahead of the display timer at 20s.
    await page.evaluate(() => { const fixture = window.perpetualRefreshFixture; fixture.growing = true; fixture.price64 = 102.2; fixture.streams.at(-1).restart(500); });
    const refresh = page.getByRole('button', { name: '刷新', exact: true });
    const manualRefresh = async () => {
      const [response] = await Promise.all([page.waitForResponse(response => response.url() === `${origin}/api/monitors/perpetual/quote`), refresh.click()]);
      await response.finished();
    };
    await manualRefresh();
    await until(async () => await spread(target) === '+2.200%', 'Manual refresh establishes the starting quote', 500);
    const cadenceStarted = now, framesBefore = await page.evaluate(() => window.perpetualRefreshFixture.frames);
    for (let second = 1; second <= 19; second++) {
      await tick(1000);
      check(await spread(target) === '+2.200%' && JSON.stringify(await names()) === JSON.stringify([otherMatch, target]), `${second}s: prices and ordering wait for the 20-second boundary`);
    }
    await tick(1000);
    await until(async () => await spread(target) === '+4.200%' && JSON.stringify(await names()) === JSON.stringify([target, otherMatch]), 'At 20 seconds the latest accumulated patch updates prices and ordering', 200);
    check(now - cadenceStarted <= 20_200, 'Automatic delivery is at the requested 20-second cadence');
    check(await page.evaluate(() => window.perpetualRefreshFixture.frames) >= framesBefore + 20, 'All one-second source patches were received');
    check((await page.locator('.perp-connection').innerText()).includes('20 秒'), 'The visible status explains the 20-second refresh');
    await page.screenshot({ path: 'output/playwright/perpetual-refresh-20-seconds.png' });

    await page.evaluate(() => { const fixture = window.perpetualRefreshFixture; fixture.growing = false; fixture.price64 = 108; });
    await manualRefresh();
    await until(async () => await spread(target) === '+8.000%', 'Manual refresh bypasses the remaining display delay', 500);
    check(await thirtyDays.inputValue() === '0.5', 'Manual refresh retains the 30-day bound');

    await page.evaluate(() => { const fixture = window.perpetualRefreshFixture; fixture.staleAt = Date.now(); fixture.streams.at(-1).restart(); });
    await manualRefresh();
    await until(async () => await spread(target) === '+8.000%', 'Stale-source scenario starts with a current quote');
    await tick(29_000);
    check((await names()).includes(target), 'A 29-second source quote remains within the original freshness limit');
    await tick(2_100);
    await until(async () => (await names()).length === 0, 'Source quotes older than 30 seconds leave ranking before the next 40-second display delivery', 200);
    check(await page.evaluate(() => window.perpetualRefreshFixture.created) === 1, 'Healthy patch traffic never reconnects during display throttling or source expiry');

    // The automatic initial HTTP read has no manual callback of its own. A manual
    // refresh joining it must wait for its result before flushing the display.
    const heldQuote = { release: null };
    holdNextQuote = heldQuote;
    await page.reload();
    await until(async () => heldQuote.release && (await names()).length === 30, 'SSE baseline displays while the initial HTTP read is held');
    await page.getByRole('textbox', { name: '搜索币种', exact: true }).fill(target);
    await until(async () => (await names()).length === 1 && await spread(target) === '+2.000%', 'The unrefreshed source price is visible');
    const inFlightReads = counts.get('/api/monitors/perpetual/quote');
    await refresh.click();
    check(counts.get('/api/monitors/perpetual/quote') === inFlightReads, 'Manual refresh joins the existing HTTP read without duplicating it');
    const responseReady = page.waitForResponse(response => response.url() === `${origin}/api/monitors/perpetual/quote`);
    heldQuote.release();
    await (await responseReady).finished();
    await until(async () => await spread(target) === '+9.000%', 'Manual refresh flushes a joined automatic HTTP response immediately', 500);
    check(errors.length === 0 && external.length === 0 && mutations.length === 0, `Unexpected activity: errors=${errors.join('; ')} external=${external.join(', ')} mutations=${mutations.join(', ')}`);
    return { passed: true, discoveryMs, scannerRequests: scannerRequests.length, apiRequests: Object.fromEntries(counts), checks: ['30-day >= 0.5% filter advances past one pending item', 'bounded rolling batches cover 65 candidates', '1-19s stable prices and ordering', '20s latest accumulated source patch', 'manual refresh is immediate', '30s source expiry remains enforced', 'manual refresh joins in-flight HTTP and immediately publishes its result', 'no SSE reconnect, external requests or trade writes'], screenshot: 'output/playwright/perpetual-refresh-20-seconds.png' };
  } finally { page.off('pageerror', onError); await page.clock.resume(); }
}
