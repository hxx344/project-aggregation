// node --experimental-strip-types tests/ssr-browser-server.mjs 3193
// playwright-cli -s=perpetual-fairness run-code --filename tests/perpetual-display-fairness.browser.mjs
// To exercise the workbench iframe too, first open its production preview at http://hub.localhost:4187.
// Production UI with local whole-frame SSE observations and a deterministic clock; no live services.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const monitorBuild = 'http://127.0.0.1:3193', hubOrigin = 'http://hub.localhost:4187';
  const embedded = page.url().startsWith(hubOrigin), origin = embedded ? 'http://p-0123456789abcdef01234567.hub.localhost:4187' : monitorBuild;
  const anchor = Date.UTC(2026, 10, 7), errors = [], external = [];
  let surface = page;
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const until = async (predicate, message) => {
    const deadline = Date.now() + 10_000;
    while (!await predicate()) {
      if (Date.now() >= deadline) throw Error(message);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const onError = error => errors.push(error.message);
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.install({ time: new Date(anchor - 1000) });
  await page.clock.pauseAt(new Date(anchor));
  await page.addInitScript(({ origin, anchor }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('market-monitor:perpetual:v1', JSON.stringify({ version: 2, priceMode: 'book', sortBy: 'gross', minSpreadPercent: 0 }));
    localStorage.setItem('market-monitor:perpetual-scanner:v1', JSON.stringify({ version: 3, groupByBase: false }));
    localStorage.removeItem('market-monitor:perpetual-scanner-ranges:v1');
    const state = window.perpetualFairnessFixture = { sequence: 0, streams: [], created: 0, frozenAt: null, startAt: anchor };
    state.snapshot = () => {
      const at = Date.now(), quoteAt = state.frozenAt ?? at, second = Math.floor((quoteAt - state.startAt) / 1000);
      return { schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: at, staleAfterMs: 30_000,
        streamId: 'fairness', sequence: state.sequence,
        exchanges: ['binance', 'bybit'].map(id => ({ id, name: id, kind: 'cex', status: 'live', marketCount: 2, quoteCount: 2, lastMessageAt: at, error: null })),
        quotes: ['SAMPLED', 'OTHER'].flatMap(base => ['binance', 'bybit'].map(exchange => {
          const aligned = (base === 'SAMPLED' && second < 20) || second % 20 === (base === 'SAMPLED' ? 19 : 5);
          const observed = quoteAt - (exchange === 'binance' ? 0 : aligned ? 5000 : 6000), price = exchange === 'binance' ? 100 : 102;
          return { exchange, base, symbol: `${base}USDT`, quoteCurrency: 'USDT', multiplier: 1,
            bid: price, ask: price, mark: price, last: price, bidAskAt: observed, markAt: observed, sourceTime: observed, receivedAt: at,
            fundingRate: exchange === 'bybit' ? .0002 : .0001, fundingIntervalHours: 8, fundingAt: quoteAt, nextFundingAt: quoteAt + 3_600_000,
            transport: 'ws', comparable: true, assetClass: 'crypto', identityVerified: true, identitySource: 'local fixture', collateralCurrency: 'USDT' };
        })) };
    };
    window.EventSource = class FixtureEventSource {
      constructor(url) {
        if (url !== '/api/monitors/perpetual/stream') throw Error(`Unexpected stream ${url}`);
        this.readyState = 1; state.created++; state.streams.push(this);
        queueMicrotask(() => this.emit());
      }
      emit() { if (this.readyState === 1) { state.sequence++; this.onmessage?.({ data: JSON.stringify(state.snapshot()) }); } }
      close() { this.readyState = 2; }
    };
  }, { origin, anchor });
  page.on('pageerror', onError);
  try {
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (embedded && url.origin === hubOrigin) {
        const path = url.pathname, stamp = new Date(anchor).toISOString();
        const send = json => route.fulfill({ json });
        if (path === '/api/projects/monitor/launch') return send({ url: `${origin}/?monitor=perpetual` });
        if (path === '/api/session') return send({ authenticated: true, csrfToken: 'local-fairness-fixture' });
        if (path === '/api/health') return send({ status: 'ok' });
        if (path.endsWith('/events')) return route.abort();
        if (path === '/api/overview') return send({ generatedAt: stamp, projects: [{
          project: { id: 'monitor', name: 'monitor', description: '', category: 'other', adapter: 'monitor', enabled: true,
            embedded: true, accessMode: 'proxy', apiUrl: monitorBuild, url: '', mode: 'embed', hasCredentials: true,
            revision: 'fairness-fixture', staleAfterSeconds: 120, order: 0 },
          state: 'online', freshness: 'static', message: '', checkedAt: null, updatedAt: null, latencyMs: 1, diagnostics: [], metrics: [],
        }] });
        if (path === '/api/system/updates') return send({ enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null });
        if (path === '/api/trading/fills' || path === '/api/trading/positions') return send({ generatedAt: stamp, sources: [] });
        if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Controlled unavailable host detail' } });
        return route.continue();
      }
      if (url.origin !== origin) { external.push(url.origin); return route.abort('blockedbyclient'); }
      if (!url.pathname.startsWith('/api/')) return embedded ? route.fulfill({ response: await route.fetch({ url: monitorBuild + url.pathname + url.search }) }) : route.continue();
      if (url.pathname.endsWith('/perpetual/quote')) return route.fulfill({ json: await route.request().frame().evaluate(() => window.perpetualFairnessFixture.snapshot()) });
      if (url.pathname.endsWith('/perpetual/crossex-settings')) return route.fulfill({ json: { available: true, generatedAt: anchor, revision: 0, metadataRevision: 1,
        config: { requireSpotTransfer: false, blockedBases: [] }, error: '', spotTransferPairs: [],
        venues: ['binance', 'bybit'].map(exchange => ({ exchange, state: 'live', checkedAt: anchor, error: '' })) } });
      return route.fulfill({ status: 503, json: { error: 'Controlled unavailable detail' } });
    });
    await page.goto(embedded ? `${hubOrigin}/?view=project&id=monitor` : `${origin}/?monitor=perpetual`);
    if (embedded) {
      await until(async () => { await page.clock.runFor(100); return Boolean(page.frame({ url: url => url.origin === origin })); }, 'The workbench must open the Monitor iframe');
      surface = page.frame({ url: url => url.origin === origin });
    }
    const rows = surface.locator('.perp-scanner:visible .perp-scanner-table > tbody > tr:not(.perp-detail-row)');
    const names = () => rows.locator('.perp-base-cell > div > strong').allTextContents();
    await until(async () => { await page.clock.runFor(100); return JSON.stringify(await names()) === JSON.stringify(['SAMPLED']); }, 'First paint must exclude the initially skewed OTHER pair');
    // Let initial hydration/lazy effects finish, then reset the phase and display cadence together.
    await surface.evaluate(() => { const state = window.perpetualFairnessFixture; state.startAt = Date.now(); state.streams.at(-1).emit(); });
    const refreshed = page.waitForResponse(response => response.url() === `${origin}/api/monitors/perpetual/quote`);
    await surface.getByRole('button', { name: '刷新', exact: true }).click();
    await (await refreshed).finished();
    const visibility = new Map(), changes = [], lastSeen = { SAMPLED: 0, OTHER: 0 };
    let previousStamp = await surface.locator('.scanner-status').innerText();
    for (let second = 1; second <= 180; second++) {
      await page.clock.runFor(1000);
      await surface.evaluate(() => window.perpetualFairnessFixture.streams.at(-1).emit());
      // Allow React to commit the received frame without changing the simulated time.
      await new Promise(resolve => setTimeout(resolve, 10));
      const shown = await names(); visibility.set(second, shown);
      for (const base of Object.keys(lastSeen)) {
        if (shown.includes(base)) lastSeen[base] = second;
        check(second - lastSeen[base] <= 40, `${base} starved at ${second}s`);
      }
      const stamp = await surface.locator('.scanner-status').innerText();
      if (stamp !== previousStamp) { changes.push(second); previousStamp = stamp; }
      check(shown.length <= (second < 40 ? 2 : 1), 'Disjoint cohorts must never be combined from different frames');
    }
    check(visibility.get(40).includes('SAMPLED') && !visibility.get(40).includes('OTHER'), 'The baseline sample must show only SAMPLED');
    check(visibility.get(45).includes('OTHER') && !visibility.get(45).includes('SAMPLED'), 'The next recovery must fairly replace SAMPLED with OTHER');
    const recoveries = changes.filter(second => second >= 40 && second % 20 !== 0);
    check(recoveries.length >= 6, 'The recurring alternate cohort must keep recovering');
    for (let index = 1; index < recoveries.length; index++) check(recoveries[index] - recoveries[index - 1] >= 20, 'Recovery publications must respect the rolling 20s budget');
    const screenshot = `output/playwright/perpetual-display-fairness${embedded ? '-workbench' : ''}.png`;
    await page.screenshot({ path: screenshot });
    // Freeze the aligned t=179s frame, so loss of the row can only be caused by source expiry.
    await surface.evaluate(() => { window.perpetualFairnessFixture.frozenAt = Date.now() - 1000; });
    for (let second = 0; second < 32; second++) {
      await page.clock.runFor(1000);
      await surface.evaluate(() => window.perpetualFairnessFixture.streams.at(-1).emit());
      if (second === 23) check((await names()).includes('SAMPLED'), 'The aligned quote remains ranked through its exact 30-second freshness boundary');
    }
    await until(async () => (await names()).length === 0, 'Frozen source observations must expire despite fresh SSE receipt times');
    check(await surface.evaluate(() => window.perpetualFairnessFixture.created) === 1, 'Display recovery must not reconnect the source');
    check(!errors.length && !external.length, `Unexpected browser errors/external requests: ${errors}; ${external}`);
    return { passed: true, embedded, recoveries, lastSeen, pageErrors: errors,
      checks: ['initially skewed pair gets its first display', 'baseline-sampled pair rotates with disjoint phase', 'both pairs reappear within 40 seconds', 'no cross-frame rows', 'rolling 20-second recovery budget', '30-second source expiry'],
      screenshot };
  } finally { page.off('pageerror', onError); await page.clock.resume(); }
}
