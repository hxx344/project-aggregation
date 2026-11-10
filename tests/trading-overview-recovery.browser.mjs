// Open an isolated production workbench preview first, then run with:
// playwright-cli run-code --filename tests/trading-overview-recovery.browser.mjs
// All API responses are synthetic; the fixture never connects to an account.
async (page) => {
  const origin = new URL(page.url()).origin;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin)) throw new Error('Open an isolated local production preview first');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const base = Date.parse('2026-11-10T04:00:00.000Z');
  const failureMessage = '持仓概览测试：服务暂不可用';
  const errors = [], writes = [], reads = [], held = [];
  let elapsed = 0, sourceAgeMs = 0, nextPollAt = 0, plan = [], fallback = {};
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.clock.install({ time: new Date(base - 1000) });
  await page.clock.pauseAt(new Date(base));
  await page.addInitScript(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('workbench:')) localStorage.removeItem(key);
    window.__overviewOnline = true;
    window.__overviewReads = [];
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => window.__overviewOnline });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    window.EventSource = class { close() {} };
    const originalFetch = window.fetch;
    window.fetch = (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input, location.href);
      if (url.pathname !== '/api/trading') return originalFetch(input, options);
      const read = { at: performance.now(), wallAt: Date.now(), aborted: false, reason: null };
      window.__overviewReads.push(read);
      options?.signal?.addEventListener('abort', () => {
        read.aborted = true;
        read.reason = options.signal.reason?.name ?? null;
      }, { once: true });
      return originalFetch(input, options);
    };
  });
  const stamp = () => new Date(base + elapsed).toISOString();
  const trading = () => {
    const now = stamp(), fetchedAt = new Date(base + elapsed - sourceAgeMs).toISOString();
    const legs = (symbols, pnls) => symbols.map((symbol, index) => ({
      id: symbol, exchange: 'binance', symbol, state: 'live', fetchedAt,
      positions: [{ id: symbol, exchange: 'binance', symbol, side: index ? 'short' : 'long', mode: 'one-way', quantity: '400', entryPrice: '80', markPrice: '84', notional: '33600', unrealizedPnl: pnls[index], liquidationPrice: '10', leverage: '2', sourceUpdatedAt: fetchedAt }],
      grossNotional: '33600', netNotional: index ? '-33600' : '33600', unrealizedPnl: pnls[index], fundingNet: null, fundingComplete: false,
    }));
    return {
      mode: 'read-only', exchanges: ['binance', 'bybit'], generatedAt: now,
      // A fresh transport/cache time must not refresh an old source fetchedAt.
      cache: { builtAt: now, servedAt: now, rebuilding: false },
      period: { days: 7, start: new Date(base - 7 * 86_400_000).toISOString(), end: now },
      strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' },
      accounts: [{ exchange: 'binance', connected: true, revision: 1, positions: { state: 'live', fetchedAt, error: null }, funding: { state: 'live', fetchedAt, error: null } }],
      legs: legs(['CLUSDT', 'BZUSDT'], ['-3122.03', '5303.24']),
      structure: { state: 'incomplete', message: '当前未持齐四腿，空仓合约仍保留历史资金费' },
      hynix: { accounts: [{ exchange: 'binance', state: 'live', fetchedAt, error: null }], legs: legs(['SKHYUSDT', 'SKHYNIXUSDT'], ['816.73', '-733.99']) },
      pnl: { currency: 'USDT', points: [], latest: null, status: 'collecting' },
      funding: { complete: false, income: null, expense: null, net: null, events: [], daily: [], pagination: { page: 0, pages: 1, pageSize: 50, total: 0 } },
    };
  };
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== origin) return route.abort('blockedbyclient');
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() !== 'GET') { writes.push(`${request.method()} ${path}`); return send({ error: 'Unexpected mutation in read-only fixture' }, 400); }
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'fixture-only' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/overview') return send({ projects: [], generatedAt: stamp() });
    if (path === '/api/system/updates') return send({ enabled: true, checking: false, modules: [], job: null });
    if (path === '/api/trading/execution') return send({ generatedAt: stamp(), connections: [], positions: [], jobs: [] });
    if (path === '/api/trading/execution/quotes') return send({ generatedAt: stamp(), maxAgeMs: 10_000, books: [] });
    if (path === '/api/trading/execution/auto') return send({ generatedAt: stamp(), maintenance: false, rules: [] });
    if (path === '/api/trading/anthropic') return send({ generatedAt: stamp(), sources: [], alerts: { config: { enabled: false, thresholdPercent: 20, repeatMinutes: 30 }, channel: { configured: false, source: null }, history: [], error: null, staleAfterSeconds: 180, hysteresisPercent: 2 } });
    if (path !== '/api/trading') return send({ error: 'Outside overview recovery fixture' }, 503);
    assert(url.searchParams.get('days') === '7' && url.searchParams.get('page') === '0' && url.searchParams.get('pair') === 'binance,bybit', 'reads retain the selected cache identity');
    const action = plan.shift() ?? fallback;
    reads.push({ at: elapsed, status: action.status ?? 200, held: !!action.hold });
    if (action.hold) await new Promise(resolve => held.push(resolve));
    if (action.networkFailure) return route.abort('failed');
    if (action.invalidJson) return route.fulfill({ status: 200, contentType: 'application/json', body: '{invalid-json' });
    // Timed-out and unmounted reads can already be cancelled when released.
    if (action.hold) return send(trading()).catch(() => {});
    return action.status ? send({ error: failureMessage }, action.status) : send(trading());
  });
  const advance = async ms => { elapsed += ms; await page.clock.runFor(ms); await page.waitForTimeout(40); };
  const eventually = async (check, message) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await check()) return;
      await page.waitForTimeout(20);
    }
    throw new Error(message);
  };
  const group = market => page.locator(`.trading-overview tbody[data-market="${market}"]`);
  const total = market => group(market).locator('.trading-overview-total td').first();
  const markets = ['oil', 'hynix'];
  const values = { oil: '+2,181.21', hynix: '+82.74' };
  const retry = () => page.getByRole('button', { name: '重试读取', exact: true });
  const checkFresh = async () => {
    for (const market of markets) {
      assert(await group(market).locator('tr[data-position-id]').count() === 2, `${market}: both position rows remain`);
      assert(await group(market).locator('.trading-status').innerText() === '已同步', `${market}: source is live`);
      assert((await total(market).innerText()).includes(values[market]), `${market}: current total is visible`);
    }
  };
  const checkStale = async () => {
    for (const market of markets) {
      assert(await group(market).locator('tr[data-position-id]').count() === 2, `${market}: stale positions are retained`);
      assert(await group(market).locator('.trading-status').innerText() === '数据已过期', `${market}: expired state is visible`);
      assert(await total(market).innerText() === '—', `${market}: unconfirmed total is withheld`);
      assert((await group(market).locator('.trading-overview-total').innerText()).includes('仓位数据未同步'), `${market}: withheld total is explained`);
    }
  };
  const waitOverviewMount = async () => {
    // React's lazy/Suspense reveal can require a timer even after the module and
    // synthetic response arrive. Bounded stepping lets it mount under the fake
    // clock instead of waiting forever for a reveal with the clock paused.
    for (let advanced = 0; advanced < 2000 && await group('hynix').locator('tr[data-position-id]').count() === 0; advanced += 50) await advance(50);
    assert(await group('hynix').locator('tr[data-position-id]').count() === 2, 'overview mounts within two seconds of virtual startup time');
    assert(await page.getByRole('heading', { name: '持仓概览', exact: true }).isVisible(), 'actual trade overview is visible');
  };
  const open = async (age = 0) => {
    plan = []; fallback = {}; sourceAgeMs = age;
    await page.goto(`${origin}/?view=trading&tradingSection=trade&pair=binance,bybit&days=7`);
    await waitOverviewMount();
    const firstReadAt = await page.evaluate(() => window.__overviewReads[0]?.wallAt);
    assert(Number.isFinite(firstReadAt), 'initial trading GET was recorded');
    // The poll timer and initial GET begin in the same mount effect. Anchor to
    // that GET, so startup stepping does not eat into the tested retry delay.
    nextPollAt = firstReadAt - base + 5000;
    assert(nextPollAt > elapsed, 'startup completes before the first regular poll');
  };
  const firstPoll = () => advance(nextPollAt - elapsed);
  const countReads = async count => eventually(() => Promise.resolve(reads.length === count), `expected ${count} trading GETs; received ${reads.length}`);
  const waitFreshResponse = () => eventually(async () => await group('oil').locator('time').getAttribute('datetime') === stamp(), 'new source timestamp is rendered after the successful response');
  const release = async () => { held.splice(0).forEach(resolve => resolve()); await page.waitForTimeout(40); };
  const setOnline = value => page.evaluate(value => {
    window.__overviewOnline = value;
    window.dispatchEvent(new Event(value ? 'online' : 'offline'));
  }, value);
  const startFreshnessWatch = () => page.evaluate(() => {
    window.__overviewFlashes = [];
    window.__overviewFreshnessObserver?.disconnect();
    const record = () => {
      for (const market of ['oil', 'hynix']) {
        const group = document.querySelector(`.trading-overview tbody[data-market="${market}"]`);
        if (group && (!group.querySelector('.trading-status.live') || group.querySelector('.trading-overview-total td')?.textContent === '—')) window.__overviewFlashes.push(market);
      }
    };
    window.__overviewFreshnessObserver = new MutationObserver(record);
    window.__overviewFreshnessObserver.observe(document.querySelector('.trading-overview'), { childList: true, subtree: true, characterData: true, attributes: true });
  });
  const checkNoFlash = async () => {
    const flashes = await page.evaluate(() => { window.__overviewFreshnessObserver.disconnect(); return window.__overviewFlashes; });
    assert(flashes.length === 0, `a transient read failure must not flash stale: ${flashes.join(', ')}`);
  };
  try {
    await open();
    await checkFresh();
    assert(await retry().count() === 0, 'healthy trade overview has no error retry');

    // One 503 is absorbed by a single read retry; observe every DOM mutation.
    let before = reads.length;
    plan = [{ status: 503 }, {}];
    await startFreshnessWatch();
    await firstPoll(); await countReads(before + 1); await checkFresh();
    await advance(900); assert(reads.length === before + 1, 'retry respects the one-second wait'); await checkFresh();
    await advance(100); await countReads(before + 2);
    await waitFreshResponse();
    await checkFresh(); await checkNoFlash();
    assert(await retry().count() === 0, 'recovered transient failure has no diagnostic');

    // Exhaust the two attempts, keep rows, and expose recovery on the trade tab.
    await open(); before = reads.length; fallback = { status: 503 };
    await firstPoll(); await countReads(before + 1); await checkFresh();
    await advance(1000); await countReads(before + 2);
    await retry().waitFor();
    assert(await page.getByRole('alert').filter({ hasText: failureMessage }).isVisible(), 'final failure diagnosis is visible on trade');
    await checkStale();
    await advance(2000); assert(reads.length === before + 2, 'no third immediate attempt follows the failed retry');
    fallback = {}; before = reads.length;
    await retry().click(); await countReads(before + 1);
    await waitFreshResponse();
    await eventually(async () => await retry().count() === 0, 'manual GET clears the error after success');
    await checkFresh();

    // Both a network TypeError and a 200 response with invalid JSON use the real
    // api() classification; the latter must fail once without automatic retry.
    await open(); before = reads.length; plan = [{ networkFailure: true }, {}];
    await startFreshnessWatch();
    await firstPoll(); await countReads(before + 1); await checkFresh();
    await advance(1000); await countReads(before + 2); await waitFreshResponse(); await checkFresh(); await checkNoFlash();
    await open(); before = reads.length; fallback = { invalidJson: true };
    await firstPoll(); await retry().waitFor(); await checkStale();
    await advance(1500); assert(reads.length === before + 1, 'invalid JSON is not retried');

    // Initial source age is 57s. The poll starts at 5s and times out at 17s;
    // retry begins at 18s, then source age crosses 75s while it is still pending.
    await open(57_000); before = reads.length; fallback = { hold: true };
    await checkFresh();
    await firstPoll(); await countReads(before + 1);
    await advance(12_000); await checkFresh();
    let browserReads = await page.evaluate(() => window.__overviewReads);
    assert(browserReads.at(-1).aborted && browserReads.at(-1).reason === 'TimeoutError', 'first attempt really times out at twelve seconds');
    await advance(1000); await countReads(before + 2); await checkFresh();
    await advance(2000); await checkStale();
    assert(await retry().count() === 0, 'natural expiry is not reported as a final request failure while retry is pending');
    sourceAgeMs = 0; fallback = {}; await release();
    await waitFreshResponse();
    await checkFresh();

    // A new HTTP response carrying genuinely old source timestamps stays stale.
    await open(76_000); await checkStale();
    assert(await retry().count() === 0, 'old source data is not misreported as a transport error');

    // Reconnecting grants permission to read, but cannot restore old totals.
    await open(); await checkFresh(); before = reads.length;
    await setOnline(false);
    await page.getByText('网络已断开，当前显示最后读取的数据；连接恢复后自动更新。', { exact: true }).waitFor();
    await checkStale();
    await advance(5000); assert(reads.length === before, 'offline pauses trading GETs');
    fallback = { hold: true }; await setOnline(true);
    await checkStale();
    await advance(1000); await countReads(before + 1); await checkStale();
    await advance(2000); await checkStale();
    fallback = {}; await release();
    await waitFreshResponse();
    await checkFresh();

    // App owns the cache even while OilTradingPage is unmounted. An offline
    // interval elsewhere must invalidate that cache before an online return.
    await open(); await checkFresh();
    const priorSourceTime = await group('oil').locator('time').getAttribute('datetime');
    await page.getByRole('button', { name: '总览', exact: true }).click();
    await page.locator('.trading-page').waitFor({ state: 'detached' });
    before = reads.length;
    await setOnline(false); await advance(1000);
    await setOnline(true); await advance(1000);
    assert(reads.length === before, 'offline and online away from trading do not start a trading GET');
    fallback = { hold: true };
    await page.getByRole('button', { name: '交易中心', exact: true }).click();
    await waitOverviewMount(); await countReads(before + 1);
    assert(await group('oil').locator('time').getAttribute('datetime') === priorSourceTime, 'return retains the original source timestamp while the new GET is held');
    assert(base + elapsed - Date.parse(priorSourceTime) < 75_000, 'returned cache is still within its normal source TTL');
    await checkStale();
    await advance(2000); await checkStale();
    fallback = {}; await release();
    await waitFreshResponse(); await checkFresh();

    // Cancel the retry delay by leaving the page; no later attempt may escape.
    await open(); before = reads.length; fallback = { status: 503 };
    await firstPoll(); await countReads(before + 1); await checkFresh();
    await advance(200);
    await page.getByRole('button', { name: '总览', exact: true }).click();
    await page.locator('.trading-page').waitFor({ state: 'detached' });
    before = reads.length; await advance(31_000);
    assert(reads.length === before, 'unmount cancels retry delay and polling');
    assert(writes.length === 0, `automatic and manual recovery issue no mutations: ${writes.join(', ')}`);
    assert(errors.length === 0, `uncaught page errors: ${errors.join('; ')}`);
    return { passed: true, markets: markets.length, tradingGets: reads.length, mutationRequests: writes.length, scenarios: ['healthy overview', '503 recovery without stale flash', 'two failures expose diagnosis', 'manual GET recovery', 'network failure retry', 'invalid JSON no retry', 'timeout retry crosses real source TTL', 'old fetchedAt remains stale', 'offline and held reconnect', 'offline while away requires fresh response on return', 'retry cancellation on navigation'] };
  } finally {
    await release();
    await page.clock.resume();
  }
}
