// Start the Windows-native SSR fixture on 127.0.0.1:3193, then run in an isolated session:
// playwright-cli -s=perpetual-background open about:blank --headed
// playwright-cli -s=perpetual-background run-code --filename tests/perpetual-background.browser.mjs
// All HTTP data and EventSource frames are local fixtures. No collectors or accounts are used.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3193', hubOrigin = 'http://hub.localhost:3193';
  const moduleOrigin = 'http://p-0123456789abcdef01234567.hub.localhost:3193';
  const anchor = Date.UTC(2026, 9, 11), hour = 3_600_000;
  const bases = Array.from({ length: 35 }, (_, index) => `COIN${String(index).padStart(2, '0')}`);
  const venues = [{ id: 'binance', name: 'Binance' }, { id: 'gate', name: 'Gate' }];
  const preferenceKey = 'market-monitor:perpetual:v1', displayKey = 'market-monitor:perpetual-scanner:v1', rangeKey = 'market-monitor:perpetual-scanner-ranges:v1';
  let now = anchor;
  const errors = [], external = [], unsafeRequests = [], counts = new Map(), results = [];
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const onError = error => { if (!errors.includes(error.message)) errors.push(error.message); };
  const snapshot = () => ({ schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: now, staleAfterMs: 30_000,
    quotes: bases.flatMap((base, index) => venues.map(({ id: exchange }) => {
      const price = exchange === 'binance' ? 100 : 102 - index * .01;
      return { exchange, base, symbol: `${base}USDT`, quoteCurrency: 'USDT', multiplier: 1,
        bid: price, ask: price, mark: price, last: price, bidAskAt: now, markAt: now, sourceTime: now, receivedAt: now, transport: 'ws',
        fundingRate: exchange === 'gate' ? .0002 : .0001, fundingIntervalHours: 8, fundingAt: now, nextFundingAt: now + hour,
        comparable: true, assetClass: 'crypto', identityVerified: true, identitySource: 'local fixture', collateralCurrency: 'USDT' };
    })), exchanges: venues.map(venue => ({ ...venue, kind: 'cex', status: 'live', marketCount: bases.length, quoteCount: bases.length, lastMessageAt: now, error: null })) });
  const metric = value => ({ value, currency: 'USD', observedAt: now, source: 'local fixture', error: '' });
  const metricsFor = pairs => Object.fromEntries([...new Set(pairs.flatMap(pair => [pair.longKey, pair.shortKey]))].map(key => {
    const [exchange, symbol] = key.split(':');
    return [key, { key, exchange, symbol, identity: `${key}:fixture`, status: 'ready', fetchedAt: now, volume24h: metric(1_000_000), openInterest: metric(100_000), error: '' }];
  }));
  const historyFor = pairs => Object.fromEntries([...new Set(pairs.flatMap(pair => [pair.longKey, pair.shortKey]))].map(key => {
    const [exchange, symbol] = key.split(':');
    return [key, { key, exchange, symbol, identity: `${key}:fixture`, status: 'ready', fetchedAt: now, coverage: { from: now - 768 * hour, to: now }, error: '', backfillComplete: true,
      records: Array.from({ length: 97 }, (_, index) => ({ time: now - (96 - index) * 8 * hour, rate: exchange === 'gate' ? .0002 : .0001 })) }];
  }));
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.context().setOffline(false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.install({ time: new Date(anchor - 1000) });
  await page.clock.pauseAt(new Date(anchor));
  await page.addInitScript(({ origins, initial, preferenceKey, displayKey, rangeKey }) => {
    if (!origins.includes(location.origin)) return;
    localStorage.setItem(preferenceKey, JSON.stringify({ version: 2, sortBy: 'gross', minSpreadPercent: 0 }));
    localStorage.removeItem(displayKey); localStorage.removeItem(rangeKey);
    const fixture = window.perpetualBackgroundFixture = { streams: [], created: 0, closed: 0, hidden: false, sequence: 0, initial };
    // Explicit visibility events are deterministic even when the test runner retains OS focus.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => fixture.hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => fixture.hidden ? 'hidden' : 'visible' });
    window.EventSource = class FixtureEventSource {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      constructor(url) {
        if (url !== '/api/monitors/perpetual/stream') throw Error(`Unexpected EventSource ${url}`);
        this.url = url; this.readyState = 1; this.onmessage = null; this.onerror = null;
        fixture.created++; fixture.streams.push(this);
        this.timer = setInterval(() => this.emit(), 1000);
        this.first = setTimeout(() => this.emit(), 0);
      }
      emit() {
        if (this.readyState !== 1) return;
        const at = Date.now(), frame = structuredClone(fixture.initial);
        frame.generatedAt = at; frame.streamId = 'background-fixture'; frame.sequence = ++fixture.sequence;
        for (const quote of frame.quotes) for (const key of ['bidAskAt', 'markAt', 'sourceTime', 'receivedAt', 'fundingAt']) quote[key] = at;
        for (const exchange of frame.exchanges) exchange.lastMessageAt = at;
        this.onmessage?.({ data: JSON.stringify(frame) });
      }
      close() {
        if (this.readyState === 2) return;
        this.readyState = 2; clearInterval(this.timer); clearTimeout(this.first); fixture.closed++;
      }
    };
  }, { origins: [origin, moduleOrigin], initial: snapshot(), preferenceKey, displayKey, rangeKey });
  page.on('pageerror', onError);
  const tick = async ms => { now += ms; await page.clock.runFor(ms); };
  const until = async (predicate, message) => {
    for (let attempt = 0; attempt < 100; attempt++) { if (await predicate()) return; await tick(100); }
    throw Error(message);
  };
  const stats = frame => frame.evaluate(() => ({ created: window.perpetualBackgroundFixture.created, closed: window.perpetualBackgroundFixture.closed,
    live: window.perpetualBackgroundFixture.streams.filter(stream => stream.readyState === 1).length }));
  const visibility = (frame, hidden) => frame.evaluate(value => {
    window.perpetualBackgroundFixture.hidden = value; document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  const restoreEvents = frame => frame.evaluate(() => {
    for (let index = 0; index < 4; index++) { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: index % 2 === 0 })); window.dispatchEvent(new Event('online')); }
  });
  const activity = active => page.evaluate(({ active, moduleOrigin }) => {
    document.querySelector('iframe').contentWindow.postMessage({ channel: 'project-hub', version: 1, type: 'activity', active, backgroundUpdates: true }, moduleOrigin);
  }, { active, moduleOrigin });
  try {
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (![origin, hubOrigin, moduleOrigin].includes(url.origin)) { external.push(url.origin); return route.abort('blockedbyclient'); }
      if (url.origin === hubOrigin) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><title>Local activity host</title></head><body style="margin:0"><iframe title="Monitor fixture" style="border:0;width:100vw;height:100vh" src="${moduleOrigin}/?monitor=perpetual"></iframe><script>let connected=false;addEventListener('message',event=>{const frame=document.querySelector('iframe');if(connected||event.origin!==${JSON.stringify(moduleOrigin)}||event.source!==frame.contentWindow||event.data?.type!=='ready'||event.data?.role!=='module')return;connected=true;for(const value of [{type:'ready',role:'host'},{type:'activity',active:true,backgroundUpdates:true}])frame.contentWindow.postMessage({channel:'project-hub',version:1,...value},${JSON.stringify(moduleOrigin)});});</script></body></html>` });
      if (!path.startsWith('/api/')) {
        if (url.origin === moduleOrigin) return route.fulfill({ response: await route.fetch({ url: origin + path + url.search }) });
        return route.continue();
      }
      counts.set(path, (counts.get(path) ?? 0) + 1);
      const readPosts = ['/api/monitors/perpetual/metrics', '/api/monitors/perpetual/funding-history', '/api/monitors/perpetual/quality', '/api/monitors/perpetual/scanner-data'];
      if (!['GET', 'HEAD'].includes(request.method()) && !readPosts.includes(path)) unsafeRequests.push(`${request.method()} ${path}`);
      if (path.endsWith('/perpetual/quote')) return route.fulfill({ json: snapshot() });
      if (path.endsWith('/perpetual/stream')) throw Error('Native EventSource escaped the local fixture');
      if (path.endsWith('/perpetual/crossex-settings')) return route.fulfill({ json: { available: true, generatedAt: now, revision: 0, metadataRevision: 1,
        config: { requireSpotTransfer: false, blockedBases: [] }, error: '', spotTransferPairs: [], venues: venues.map(venue => ({ exchange: venue.id, state: 'live', checkedAt: now, error: '' })) } });
      if (path.endsWith('/perpetual/metrics')) return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, legs: metricsFor(request.postDataJSON().pairs) } });
      if (path.endsWith('/perpetual/funding-history')) return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, legs: historyFor(request.postDataJSON().pairs) } });
      if (path.endsWith('/perpetual/quality')) return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, pairs: {}, assets: {}, fees: {} } });
      return route.fulfill({ status: 503, json: { error: 'Unavailable local fixture detail' } });
    });
    for (const embedded of [false, true]) {
      await page.goto(embedded ? hubOrigin : `${origin}/?monitor=perpetual`);
      if (embedded) await until(() => Boolean(page.frame({ url: url => url.origin === moduleOrigin })), 'Trusted host iframe loads');
      const frame = embedded ? page.frame({ url: url => url.origin === moduleOrigin }) : page.mainFrame();
      const label = embedded ? 'trusted host' : 'standalone';
      const rows = frame.locator('.perp-scanner:visible .perp-scanner-table > tbody > tr:not(.perp-detail-row)');
      const names = () => rows.locator('.perp-base-cell > div > strong').allTextContents();
      const detail = frame.locator('.perp-detail-row');
      const filter = frame.getByRole('textbox', { name: '开仓价差最小值', exact: true });
      await until(async () => (await names()).length === 30 && (await stats(frame)).live === 1, `${label}: initial ranking and stream load`);
      await frame.getByRole('textbox', { name: '搜索币种', exact: true }).fill('COIN');
      await frame.locator('#perpetual-filter-toggle').click();
      await filter.fill('.5');
      await frame.getByRole('button', { name: '下一页', exact: true }).click();
      await until(async () => JSON.stringify(await names()) === JSON.stringify(bases.slice(30)), `${label}: second page is selected`);
      await tick(1000);
      const original = await stats(frame), originalReads = counts.get('/api/monitors/perpetual/quote') ?? 0;
      const preserved = async () => {
        check(JSON.stringify(await names()) === JSON.stringify(bases.slice(30)), `${label}: ranking and page survive activity changes`);
        check(await filter.inputValue() === '.5' && await frame.getByRole('textbox', { name: '搜索币种', exact: true }).inputValue() === 'COIN', `${label}: filters survive activity changes`);
      };
      await restoreEvents(frame); await tick(100);
      if (embedded) await activity(false); else await visibility(frame, true);
      await tick(2200); await preserved();
      if (embedded) await activity(true); else await visibility(frame, false);
      await restoreEvents(frame); await tick(100);
      await preserved();
      check((await stats(frame)).created === original.created && (await stats(frame)).closed === original.closed, `${label}: healthy SSE survives hidden/visible and repeated focus/pageshow/online`);
      check((counts.get('/api/monitors/perpetual/quote') ?? 0) === originalReads, `${label}: healthy restores do not re-fetch the full quote snapshot`);

      await rows.first().getByRole('button', { name: /^展开 .*质量依据与各平台报价$/ }).click();
      await until(async () => await detail.count() === 1 && (await stats(frame)).live === 0, `${label}: opening details intentionally pauses the feed`);
      await frame.getByRole('tab', { name: '各平台报价', exact: true }).click();
      const inspectionStats = await stats(frame), inspectionReads = counts.get('/api/monitors/perpetual/quote') ?? 0;
      if (embedded) await activity(false); else await visibility(frame, true);
      await tick(31_100);
      check(await detail.count() === 1 && (await detail.innerText()).includes('行情已暂停'), `${label}: background preserves expanded detail and pause state`);
      if (embedded) await activity(true); else await visibility(frame, false);
      await restoreEvents(frame); await tick(100);
      await preserved();
      check(await detail.count() === 1 && await frame.getByRole('tab', { name: '各平台报价', exact: true }).getAttribute('aria-selected') === 'true', `${label}: foreground preserves selected detail tab`);
      check((await detail.innerText()).includes('报价已过期，仅供核对'), `${label}: retained inspection quote ages while hidden`);
      check((await stats(frame)).created === inspectionStats.created && (await stats(frame)).live === 0 && (counts.get('/api/monitors/perpetual/quote') ?? 0) === inspectionReads, `${label}: restore events cannot silently resume inspection`);
      await page.screenshot({ path: `output/playwright/perpetual-background-${embedded ? 'host' : 'standalone'}-inspection.png` });
      await detail.getByRole('button', { name: '收起并恢复', exact: true }).click();
      await until(async () => await detail.count() === 0 && (await stats(frame)).live === 1 && (await names()).length === 5, `${label}: explicit close resumes live quotes`);
      check((await stats(frame)).created === inspectionStats.created + 1, `${label}: explicit close starts exactly one replacement SSE`);
      await preserved();

      const beforeOffline = await stats(frame);
      await page.context().setOffline(true);
      await until(async () => (await stats(frame)).live === 0, `${label}: offline stops the stream`);
      await page.context().setOffline(false);
      await until(async () => (await stats(frame)).live === 1, `${label}: online resumes the stream`);
      await restoreEvents(frame); await tick(1000); await preserved();
      check((await stats(frame)).created === beforeOffline.created + 1, `${label}: online recovery and concurrent restore events create one SSE`);
      results.push({ mode: label, streams: await stats(frame), checks: ['healthy SSE and HTTP baseline retained', 'ranking, filters and second page retained', 'expanded detail, selected tab and pause retained', 'hidden quote expiration remains explicit', 'explicit close resumes once', 'real offline/online recovers once'] });
    }
    check(errors.length === 0, `Unexpected browser errors: ${errors.join('; ')}`);
    check(external.length === 0, `Unexpected external requests: ${external.join(', ')}`);
    check(unsafeRequests.length === 0, `Unexpected mutation requests: ${unsafeRequests.join(', ')}`);
    return { passed: true, results, apiRequests: Object.fromEntries(counts), screenshots: ['output/playwright/perpetual-background-standalone-inspection.png', 'output/playwright/perpetual-background-host-inspection.png'] };
  } finally { await page.context().setOffline(false); page.off('pageerror', onError); await page.clock.resume(); }
}
