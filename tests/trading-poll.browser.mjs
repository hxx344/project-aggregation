// Run with playwright-cli run-code --filename tests/trading-poll.browser.mjs.
// Open the built app first. Every API response below is a synthetic fixture.
async (page) => {
  const origin = new URL(page.url()).origin;
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const base = Date.parse('2026-10-07T04:00:00.000Z');
  let elapsed = 0, sampleOffset = 0, holdNext = false, expire = false;
  const reads = [], writes = [], held = [], pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const marker = () => String(100 + Math.floor(elapsed / 30_000) + sampleOffset);
  const state = () => {
    const time = base + Math.floor(elapsed / 30_000) * 30_000;
    const fetchedAt = new Date(time).toISOString(), start = new Date(base - 7 * 86400_000).toISOString();
    const accounts = ['binance', 'bybit'].map(exchange => ({
      exchange, name: exchange === 'binance' ? 'Binance' : 'Bybit', connected: true, revision: 1,
      accountMode: exchange === 'binance' ? 'standard' : 'unified', verifiedAt: fetchedAt, refreshing: false,
      positions: { state: 'live', fetchedAt, error: null },
      funding: { state: 'live', fetchedAt, error: null, coverageStart: start, coverageEnd: fetchedAt, complete: true },
    }));
    const legs = ['CLUSDT', 'BZUSDT'].flatMap(symbol => accounts.map(({ exchange }) => {
      const id = `${exchange}-${symbol}`, side = (exchange === 'binance') === (symbol === 'CLUSDT') ? 'long' : 'short';
      return { id, exchange, symbol, name: id, state: 'live', fetchedAt,
        positions: [{ id, exchange, symbol, side, mode: 'one-way', quantity: '1', entryPrice: '80', markPrice: marker(), notional: '80', unrealizedPnl: '1', leverage: '2', liquidationPrice: null, sourceUpdatedAt: null }],
        grossNotional: '80', netNotional: side === 'long' ? '80' : '-80', unrealizedPnl: '1', fundingNet: '0', fundingComplete: true,
      };
    }));
    const point = { time, unrealizedPnl: '4', fundingPnl: '0', totalPnl: '4' };
    return {
      mode: 'read-only', strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: fetchedAt,
      period: { days: 7, start, end: fetchedAt }, cache: { builtAt: fetchedAt, servedAt: new Date(base + elapsed).toISOString(), rebuilding: false },
      accounts, legs, structure: { state: 'opposed', message: 'CLUSDT 与 BZUSDT 均为跨交易所反向持仓。' },
      pnl: { currency: 'USDT', intervalMs: 60_000, cumulativeStart: Date.parse(start), end: time, recordingStartedAt: time, pointCount: 1, points: [point], latest: point, status: 'ready' },
      funding: { complete: true, income: '0', expense: '0', net: '0', currency: 'USDT', events: [], pagination: { page: 0, pageSize: 50, total: 0, pages: 1 }, daily: [{ date: fetchedAt.slice(0, 10), income: '0', expense: '0', net: '0', complete: true }] },
    };
  };
  await page.clock.install({ time: new Date(base - 1000) });
  await page.clock.pauseAt(new Date(base));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const send = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (request.method() !== 'GET') { writes.push(`${request.method()} ${url.pathname}`); return send({ error: 'Unexpected mutation' }, 400); }
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture-only-csrf' });
    const overview = { projects: [], generatedAt: new Date(base + elapsed).toISOString() };
    if (url.pathname === '/api/overview') return send(overview);
    if (url.pathname === '/api/overview/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(overview)}\n\n` });
    if (url.pathname !== '/api/trading') return send({ error: `Unexpected fixture API: ${url.pathname}` }, 404);
    reads.push(elapsed);
    assert(url.searchParams.get('days') === '7' && url.searchParams.get('page') === '0', 'poll reads the selected cached page');
    if (expire) return send({ error: '登录已过期' }, 401);
    const snapshot = state();
    if (holdNext) { holdNext = false; await new Promise(resolve => held.push(resolve)); }
    return send(snapshot);
  });
  const tradingResponse = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading', { timeout: 10_000 });
  const settle = async response => { await (await response).finished(); await page.waitForTimeout(20); };
  const checkFresh = async () => {
    assert(await page.locator('[data-label="标记价格 · USDT/合约单位"]').first().innerText() === marker(), 'latest server sample is visible');
    assert((await page.locator('.trading-account-status .trading-status').allTextContents()).every(value => value === '已同步'), 'both exchanges remain fresh');
  };
  const advance = async (ms, expectedReads) => {
    const before = reads.length, response = expectedReads ? tradingResponse() : null;
    elapsed += ms;
    await page.clock.runFor(ms);
    if (response) await settle(response);
    else await page.waitForTimeout(20);
    assert(reads.length - before === expectedReads, `${elapsed}ms: expected ${expectedReads} reads, received ${reads.length - before}`);
  };
  await page.goto(`${origin}/?view=trading`);
  await page.locator('.trading-position-table').waitFor();
  await checkFresh();
  const initialReads = reads.length;
  for (let index = 0; index < 120; index++) { await advance(5000, 1); await checkFresh(); }
  assert(reads.length - initialReads === 120, 'ten foreground minutes poll every five seconds without user events');

  // Reproduce embedded/restored tabs that keep reporting hidden, with no visibility event.
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  const hiddenStart = reads.length;
  for (let index = 1; index <= 24; index++) {
    await advance(5000, index % 6 === 0 ? 1 : 0);
    if (index % 6 === 0) await checkFresh();
  }
  assert(reads.length - hiddenStart === 4, 'hidden pages keep reading at thirty seconds without a five-second request flood');

  // Recovery must replace a pending GET; its delayed response cannot overwrite the newer sample.
  for (const event of ['focus', 'pageshow', 'visibilitychange']) {
    holdNext = true;
    const started = page.waitForRequest(request => new URL(request.url()).pathname === '/api/trading', { timeout: 10_000 });
    elapsed += 30_000;
    await page.clock.runFor(30_000);
    await started; await page.waitForTimeout(20);
    assert(held.length === 1, `${event}: old request is still pending`);
    sampleOffset += 100;
    const before = reads.length, response = tradingResponse();
    await page.evaluate(event => {
      if (event === 'visibilitychange') {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event(event));
      } else window.dispatchEvent(new Event(event));
    }, event);
    await settle(response);
    assert(reads.length === before + 1, `${event}: recovery immediately starts a new read`);
    await checkFresh();
    held.shift()();
    await page.waitForTimeout(20);
    await checkFresh();
  }

  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); window.dispatchEvent(new Event('offline')); });
  await advance(30_000, 0);
  await page.getByText('网络已断开，当前显示最后读取的数据；连接恢复后自动更新。', { exact: true }).waitFor();
  const onlineResponse = tradingResponse();
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')); });
  await settle(onlineResponse); await checkFresh();
  await advance(5000, 1); await checkFresh();
  await page.screenshot({ path: 'output/playwright/trading-poll-recovered.png', fullPage: false });

  await page.getByRole('button', { name: '总览', exact: true }).click();
  await page.locator('.trading-page').waitFor({ state: 'detached' });
  await advance(30_000, 0);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); document.dispatchEvent(new Event('visibilitychange')); });
  await advance(5000, 0);
  const returning = tradingResponse();
  await page.getByRole('button', { name: /^交易\s*只读$/ }).click();
  await settle(returning); await checkFresh();
  expire = true;
  await advance(5000, 1);
  await page.getByRole('heading', { name: '进入工作台', exact: true }).waitFor();
  await advance(30_000, 0);
  assert(writes.length === 0, `automatic updates never require a POST: ${writes.join(', ')}`);
  assert(pageErrors.length === 0, `no uncaught browser errors: ${pageErrors.join('; ')}`);
  return { passed: true, foregroundReads: 120, hiddenReads: 4, recoveryEvents: ['focus', 'pageshow', 'visibilitychange'], tradingGets: reads.length, mutationRequests: writes.length, scenarios: ['ten-minute automatic polling', 'hidden thirty-second polling', 'replace held reads on recovery', 'ignore delayed old responses', 'offline and online', 'navigation cleanup', 'expired-session cleanup'] };
}
