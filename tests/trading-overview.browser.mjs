// Run against the isolated production workbench build with playwright-cli run-code --filename.
async (page) => {
  const origin = 'http://127.0.0.1:4175';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], writes = [];
  let mode = 'live';
  let holdWatch = false, watchRequested = () => {};
  const pendingWatch = [];
  page.on('pageerror', error => errors.push(error.message));
  const position = (id, symbol, side, unrealizedPnl) => ({ id, symbol, side, unrealizedPnl, mode: 'one-way', quantity: '400', entryPrice: '80', markPrice: '84', notional: '33600', liquidationPrice: '10', leverage: '2', sourceUpdatedAt: new Date().toISOString() });
  const trading = () => {
    const now = new Date().toISOString();
    const legs = (symbols, pnls) => symbols.map((symbol, i) => ({ id: symbol, exchange: 'binance', symbol, state: 'live', fetchedAt: now,
      positions: [position(symbol, symbol, i ? 'short' : 'long', pnls[i])], grossNotional: '33600', netNotional: '33600', unrealizedPnl: pnls[i], fundingNet: null, fundingComplete: false }));
    const oil = legs(['CLUSDT', 'BZUSDT'], mode === 'zero' ? ['0.004', '-0.004'] : ['-3122.03', mode === 'missing' ? null : '5303.24']);
    if (mode === 'multi') oil.push({ ...oil[0], id: 'extra', positions: [position('extra', 'CLUSDT', 'short', '-2200')] });
    return { mode: 'read-only', generatedAt: now, cache: { builtAt: now, servedAt: now, rebuilding: false }, period: { days: 7, start: now, end: now },
      strategy: { id: 'oil-four-leg', name: '原油' }, accounts: [{ exchange: 'binance', connected: true, revision: 1, positions: { state: 'live', fetchedAt: now, error: null }, funding: { state: 'live', fetchedAt: now, error: null } }],
      legs: mode === 'empty' ? [] : oil, structure: { state: 'incomplete', message: '当前未持齐四腿，空仓合约仍保留历史资金费' },
      hynix: { accounts: [{ exchange: 'binance', state: 'live', fetchedAt: now, error: null }], legs: legs(['SKHYUSDT', 'SKHYNIXUSDT'], ['816.73', '-733.99']) },
      pnl: { currency: 'USDT', points: [], latest: null, status: 'collecting' }, funding: { complete: false, income: null, expense: null, net: null, events: [], daily: [], pagination: { page: 0, pages: 1, pageSize: 50, total: 0 } } };
  };
  const watch = () => {
    const now = new Date().toISOString();
    return { generatedAt: now, sources: ['binance', mode === 'unknown-currency' ? 'hyperliquid' : 'rh-lighter'].map((exchange, i) => ({
      exchange, connected: true, state: mode === 'stale' ? 'stale' : 'live', fetchedAt: mode === 'aged' ? new Date(Date.parse(now) - 76_000).toISOString() : now, error: null, refreshing: false,
      positions: [{ ...position(exchange, i ? exchange === 'hyperliquid' ? 'xyz:ANT' : 'ANTHROPIC' : 'ANTHROPICUSDT', i ? 'long' : 'short', i ? '4349.22' : '-811.48'), exchange, quantityUnit: 'ANTHROPIC', distancePercent: '30', alerting: false }],
    })), alerts: { config: { enabled: false, thresholdPercent: 20, repeatMinutes: 30 }, channel: { configured: false, source: null }, history: [], error: null, staleAfterSeconds: 180, hysteresisPercent: 2 } };
  };
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() !== 'GET') { writes.push(pathname); return send({ error: 'read-only fixture' }, 400); }
    if (pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture-only' });
    if (pathname === '/api/overview/events') return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: new Date().toISOString() })}\n\n` });
    if (pathname === '/api/overview') return send({ projects: [], generatedAt: new Date().toISOString() });
    if (pathname === '/api/trading') return send(trading());
    if (pathname === '/api/trading/anthropic') {
      if (holdWatch) { watchRequested(); await new Promise(resolve => pendingWatch.push(resolve)); }
      return send(watch());
    }
    if (pathname === '/api/trading/execution') return send({ generatedAt: new Date().toISOString(), connections: [], positions: [], jobs: [] });
    return send({ error: 'outside fixture scope' }, 503);
  });
  const group = id => page.locator(`.trading-overview tbody[data-market="${id}"]`);
  const total = id => group(id).locator('.trading-overview-total');
  const open = async next => { mode = next; await page.goto(`${origin}/?view=trading&tradingSection=trade`); await group('anthropic').locator('tr[data-position-id]').first().waitFor(); };
  await page.setViewportSize({ width: 1800, height: 1000 });
  await open('live');
  for (const [id, value] of [['oil', '+2,181.21'], ['hynix', '+82.74'], ['anthropic', '+3,537.74']]) {
    assert((await total(id).innerText()).includes('双腿合计浮盈亏'), `${id} pair label`);
    assert((await total(id).locator('td').first().innerText()).includes(value), `${id} exact total`);
    assert(await total(id).locator('td').first().getAttribute('class') === 'trading-positive', `${id} positive color`);
    const [leg, sum] = await Promise.all([group(id).locator('tr[data-position-id] td').nth(2).boundingBox(), total(id).locator('td').first().boundingBox()]);
    assert(Math.abs(leg.x - sum.x) < 1, `${id} PnL column alignment`);
  }
  assert((await total('anthropic').innerText()).includes('估算：USDG 按 1:1 折算 USDT'), 'ANT conversion remains visible');
  await page.getByRole('button', { name: '完整仓位', exact: true }).click();
  assert(new URL(page.url()).searchParams.get('tradingSection') === 'legs', 'details navigation retained');
  await open('missing');
  assert((await total('oil').innerText()).includes('部分浮盈亏缺失'), 'missing leg explained');
  assert(await total('oil').locator('td').first().innerText() === '—', 'missing leg not zero-filled');
  await open('zero');
  assert((await total('oil').locator('td').first().innerText()).startsWith('0'), 'true zero is displayed');
  assert(await total('oil').locator('td').first().getAttribute('class') === '', 'zero has neutral color');
  await open('multi');
  assert((await total('oil').innerText()).includes('持仓合计浮盈亏'), 'multiple positions not called a pair');
  assert((await total('oil').innerText()).includes('−18.79'), 'all displayed legs contribute');
  assert(await total('oil').locator('td').first().getAttribute('class') === 'trading-negative', 'negative total color');
  await open('stale');
  assert((await total('anthropic').innerText()).includes('仓位数据未同步'), 'stale total withheld');
  await open('aged');
  assert((await total('anthropic').innerText()).includes('仓位数据未同步'), 'old source time overrides a live state');
  await open('unknown-currency');
  assert((await total('anthropic').innerText()).includes('盈亏币种未确认'), 'unconfirmed currency not summed');
  await open('empty');
  assert(await total('oil').count() === 0, 'empty market has no fabricated zero total');
  await open('live');
  await page.setViewportSize({ width: 390, height: 900 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page-level horizontal overflow');
  assert((await total('oil').innerText()).includes('+2,181.21'), 'narrow view retains total');
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await total('anthropic').getByText('仓位数据未同步，暂不合计', { exact: true }).waitFor();
  assert(await total('anthropic').locator('td').first().innerText() === '—', 'offline total withheld');
  holdWatch = true;
  const reconnectRead = new Promise(resolve => { watchRequested = resolve; });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await reconnectRead;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const pendingTotal = await total('anthropic').locator('td').first().innerText();
  holdWatch = false;
  for (const release of pendingWatch.splice(0)) release();
  assert(pendingTotal === '—', 'reconnecting waits for a fresh response before restoring the total');
  await total('anthropic').getByText('+3,537.74', { exact: false }).waitFor();
  assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
  assert(writes.length === 0, `unexpected writes: ${writes.join('; ')}`);
  return { markets: 3, scenarios: 11, pageErrors: errors.length, writes: writes.length };
}
