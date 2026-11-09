// Open about:blank, then run this file with playwright-cli run-code.
// All API intercepts are installed before navigating to isolated localhost:4175.
async (page) => {
  const origin = page.url() === 'about:blank' ? 'http://127.0.0.1:4175' : new URL(page.url()).origin;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):4175$/.test(origin)) throw new Error('Trading fixture requires isolated localhost:4175');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const fixedTime = '2026-10-07T04:00:00.000Z', start = '2026-09-30T04:00:00.000Z';
  let withHynix = true, bybitFailure = false;
  const exchanges = ['binance', 'bybit'];
  const position = (exchange, symbol, side, extra = {}) => ({ id: `${exchange}:${symbol}:${side}`, exchange, symbol, side, mode: 'one-way', quantity: '2', entryPrice: '80', markPrice: '81', notional: '162', unrealizedPnl: '1', leverage: '2', liquidationPrice: null, sourceUpdatedAt: fixedTime, ...extra });
  const state = () => {
    const accounts = exchanges.map(exchange => ({ exchange, name: exchange === 'binance' ? 'Binance' : 'Bybit', connected: true, revision: 1, accountMode: exchange === 'binance' ? 'standard' : 'unified', verifiedAt: fixedTime, refreshing: false,
      positions: { state: 'live', fetchedAt: fixedTime, error: null },
      funding: { state: 'live', fetchedAt: fixedTime, error: null, coverageStart: start, coverageEnd: fixedTime, complete: true } }));
    const legs = ['CLUSDT', 'BZUSDT'].flatMap(symbol => exchanges.map(exchange => {
      const side = (exchange === 'binance') === (symbol === 'CLUSDT') ? 'long' : 'short';
      return { id: `${exchange}:${symbol}`, exchange, symbol, name: symbol, state: 'live', fetchedAt: fixedTime, positions: [position(exchange, symbol, side)], grossNotional: '162', netNotional: side === 'long' ? '162' : '-162', unrealizedPnl: '1', fundingNet: '0', fundingComplete: true };
    }));
    const hynixRows = { 'binance:SKHYUSDT': [position('binance', 'SKHYUSDT', 'long', { quantity: '100', entryPrice: '37', markPrice: '38.25', notional: '3825', unrealizedPnl: '125' })],
      'bybit:SKHYNIXUSDT': [position('bybit', 'SKHYNIXUSDT', 'short', { quantity: '10', entryPrice: '380', markPrice: '382.5', notional: '3825', unrealizedPnl: '-25' })] };
    const hynix = { accounts: exchanges.map(exchange => ({ exchange, state: bybitFailure && exchange === 'bybit' ? 'stale' : 'live', fetchedAt: fixedTime, error: bybitFailure && exchange === 'bybit' ? 'Bybit 仓位读取失败（HTTP 400，Bybit 10001），请检查账户模式、API 读取权限、IP 白名单与服务器时间' : null })),
      legs: exchanges.flatMap(exchange => ['SKHYUSDT', 'SKHYNIXUSDT'].map(symbol => {
        const positions = hynixRows[`${exchange}:${symbol}`] ?? [];
        return { id: `${exchange}:${symbol}`, exchange, symbol, name: symbol, state: bybitFailure && exchange === 'bybit' ? 'stale' : 'live', fetchedAt: fixedTime, positions,
          grossNotional: positions.length ? '3825' : '0', netNotional: positions.length ? positions[0].side === 'long' ? '3825' : '-3825' : '0', unrealizedPnl: positions[0]?.unrealizedPnl ?? '0' };
      })) };
    const pnl = { currency: 'USDT', intervalMs: 60000, cumulativeStart: Date.parse(start), end: Date.parse(fixedTime), recordingStartedAt: Date.parse(fixedTime), pointCount: 1, points: [{ time: Date.parse(fixedTime), unrealizedPnl: '0', fundingPnl: '0', totalPnl: '0' }], latest: { time: Date.parse(fixedTime), unrealizedPnl: '0', fundingPnl: '0', totalPnl: '0' }, status: 'ready' };
    return { mode: 'read-only', strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: fixedTime, cache: { builtAt: fixedTime, servedAt: fixedTime, rebuilding: false }, period: { days: 7, start, end: fixedTime },
      exchanges, accounts, legs, ...(withHynix ? { hynix } : {}), pnl, structure: { state: 'opposed', message: 'CL、BZ 的跨所方向均相反；数量与名义金额按各腿实际仓位展示' },
      funding: { complete: true, income: '0', expense: '0', net: '0', currency: 'USDT', events: [], pagination: { page: 0, pageSize: 50, total: 0, pages: 1 }, daily: [] } };
  };
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    const send = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (url.pathname === '/api/trading/execution' && method === 'GET') return send({ generatedAt: fixedTime, connections: [], positions: [], jobs: [] });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture-only-csrf' });
    if (url.pathname === '/api/overview/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: fixedTime })}\n\n` });
    if (url.pathname === '/api/overview') return send({ projects: [], generatedAt: fixedTime });
    if (url.pathname === '/api/trading' && method === 'GET') return send(state());
    return send({ error: `Unexpected fixture API: ${method} ${url.pathname}` }, 404);
  });
  const refreshCache = async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading');
    await page.evaluate(() => window.dispatchEvent(new Event('online'))); await response;
  };
  const section = page.locator('section.trading-hynix-positions');
  const oilRows = page.locator('section.trading-positions:not(.trading-hynix-positions):not(.trading-anthropic-positions) .trading-position-table tbody tr');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?view=trading&tradingSection=legs`);
  await section.getByRole('heading', { name: '海力士仓位', exact: true }).waitFor();
  assert(await oilRows.count() === 4, 'oil table keeps exactly its four legs');
  assert(!(await page.locator('section.trading-positions:not(.trading-hynix-positions):not(.trading-anthropic-positions)').innerText()).includes('SKHY'), 'SK hynix rows never enter the oil table');
  const rows = section.locator('.trading-position-table tbody tr');
  assert(await rows.count() === 4, 'SK hynix shows two contracts on each selected exchange');
  const texts = await rows.allInnerTexts();
  assert(texts[0].includes('SKHYUSDT') && texts[0].includes('做多') && texts[0].includes('3,825') && texts[0].includes('+125'), `Binance ADR long row: ${texts[0]}`);
  assert(texts[1].includes('SKHYNIXUSDT') && texts[1].includes('无持仓'), `Binance ordinary-share empty row: ${texts[1]}`);
  assert(texts[3].includes('SKHYNIXUSDT') && texts[3].includes('做空') && texts[3].includes('−25'), `Bybit ordinary-share short row: ${texts[3]}`);
  assert((await section.innerText()).includes('不计入「盈亏资金费」中的原油总盈亏与资金费'), 'section states that SK hynix stays out of oil PnL and funding');

  bybitFailure = true; await refreshCache();
  await section.getByText('Bybit 仓位读取失败（HTTP 400，Bybit 10001）', { exact: false }).waitFor();
  assert((await rows.nth(3).innerText()).includes('做空'), 'a failed read keeps the last observed SK hynix position');
  assert((await section.locator('.trading-account-status').nth(1).innerText()).includes('数据已过期'), 'failed exchange is marked stale');
  assert(!(await page.locator('section.trading-positions:not(.trading-hynix-positions):not(.trading-anthropic-positions)').innerText()).includes('仓位读取失败'), 'an SK hynix failure does not mark the oil table');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '390px viewport has no page-wide horizontal overflow');
  assert(await section.locator('.trading-position-table thead').isHidden(), 'phone uses labelled position cards for SK hynix');
  await section.screenshot({ path: 'output/playwright/trading-hynix-mobile.png' });

  await page.setViewportSize({ width: 1440, height: 1000 });
  withHynix = false; bybitFailure = false; await refreshCache();
  await section.waitFor({ state: 'detached' });
  assert(await oilRows.count() === 4, 'a server without SK hynix data still renders the oil table');
  assert(!pageErrors.length, `No uncaught browser errors: ${pageErrors.join('; ')}`);
  return { passed: true, scenarios: ['separate SK hynix table', 'oil table unchanged', 'independent read failure keeps last rows', '390px mobile', 'server without hynix field'] };
}
