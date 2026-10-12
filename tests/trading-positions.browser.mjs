// Run with playwright-cli run-code --filename tests/trading-positions.browser.mjs.
// All APIs are synthetic fixtures on the isolated localhost:4175 build.
async (page) => {
  const origin = page.url() === 'about:blank' ? 'http://127.0.0.1:4175' : new URL(page.url()).origin;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):4175$/.test(origin)) throw new Error('Positions fixture requires isolated localhost:4175');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const requests = [], pageErrors = [], heldReads = [];
  const base = Date.now();
  let elapsed = 0, failRead = false, expire = false, holdRead = false, replacement = false, noSources = false;
  const stamp = () => new Date(base + elapsed).toISOString();
  page.on('pageerror', error => pageErrors.push(error.message));
  const position = (id, overrides = {}) => ({ id, symbol: 'BTCUSDT', instrumentId: 'BTC-USDT-SWAP', side: 'long', quantity: '0.123456789012345678', quantityUnit: 'BTC', contractSize: null, entryPrice: '60123.123456789012345678', markPrice: '60234.567890123456789', notional: '7436.123456789012345678', unrealizedPnl: '-0.000000123456789012', leverage: '3', liquidationPrice: null, priceCurrency: 'USDT', notionalCurrency: 'USDT', pnlCurrency: 'BTC', marginMode: 'cross', sourceUpdatedAt: stamp(), ...overrides });
  const scope = (id, label, status, positions = [], error = null) => ({ id, label, status, refreshing: false, fetchedAt: ['unconfigured', 'loading', 'unsupported'].includes(status) ? null : stamp(), error, positions });
  const state = () => ({ generatedAt: stamp(), sources: noSources ? [] : [
    { projectId: 'asset-one', name: 'Asset 主账本', status: 'ready', error: null, checkedAt: stamp(), data: { schemaVersion: 1, generatedAt: stamp(), exchanges: [
      { id: 'binance', name: 'Binance', accounts: replacement ? [{ id: 'replaced', name: '更换后的账户', configured: false, revision: 'r2', scopes: [scope('new-linear', 'U 本位合约', 'unconfigured')] }] : [
        { id: 'primary', name: '主账户', configured: true, revision: 'r1', scopes: [scope('linear', 'U 本位合约', 'live', [position('btc-long')]), scope('inverse', '币本位合约', 'live'), scope('options', '期权', 'unsupported'), scope('failed', '逐仓账户', 'error', [], '此产品范围暂时读取失败'), scope('pending', '新增产品', 'loading'), scope('expired', '历史产品', 'stale')] },
        { id: 'hedge', name: '对冲账户', configured: true, revision: 'r1', scopes: [scope('hedge-linear', 'U 本位合约', 'live', [position('eth-short', { symbol: 'ETHUSDT', instrumentId: 'ETHUSDT', side: 'short', quantity: '12', quantityUnit: 'contracts', contractSize: '0.1', pnlCurrency: 'USDT' })])] },
      ] },
      { id: 'kraken', name: 'Kraken Futures', accounts: [{ id: 'derivatives', name: '衍生品账户', configured: true, revision: 'r1', scopes: [scope('kraken-futures', '多币种合约', 'live', [position('eur-long', { symbol: 'BTCEUR', instrumentId: 'PF_BTCEUR', priceCurrency: 'EUR', notionalCurrency: 'EUR', pnlCurrency: 'EUR', unrealizedPnl: '5.123456789012345678' })])] }] },
    ] } },
    { projectId: 'asset-two', name: 'Asset 备用账本', status: 'unavailable', error: '来源暂不可用', checkedAt: stamp(), data: { schemaVersion: 1, generatedAt: stamp(), exchanges: [{ id: 'bitget', name: 'Bitget', accounts: [{ id: 'backup', name: '备用账户', configured: true, revision: 'r1', scopes: [scope('backup-linear', 'U 本位合约', 'live', [position('backup-long', { symbol: 'SOLUSDT', instrumentId: 'SOLUSDT' })])] }] }] } },
    { projectId: 'asset-three', name: 'Asset 待连接', status: 'unconfigured', error: null, checkedAt: null, data: null },
  ] });
  const oilState = url => {
    const days = url.searchParams.get('days') === '30' ? 30 : 7, start = base + elapsed - days * 86_400_000;
    return { mode: 'read-only', exchanges: (url.searchParams.get('pair') || 'binance,bybit').split(','), strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: stamp(), period: { days, start: new Date(start).toISOString(), end: stamp() }, cache: { builtAt: stamp(), servedAt: stamp(), rebuilding: false }, accounts: [], legs: [], structure: { state: 'unknown', message: '尚未连接只读观察账户' }, pnl: { currency: 'USDT', intervalMs: 60_000, cumulativeStart: start, end: base + elapsed, recordingStartedAt: null, pointCount: 0, points: [], latest: null, status: 'collecting' }, funding: { complete: false, income: null, expense: null, net: null, currency: 'USDT', events: [], pagination: { page: 0, pageSize: 50, total: 0, pages: 0 }, daily: [] } };
  };
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ path: url.pathname, search: url.search, method: request.method() });
    const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (request.method() !== 'GET') return send({ error: 'Unexpected write' }, 400);
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'positions-fixture-only' });
    const updates = { enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null };
    if (url.pathname === '/api/system/updates') return send(updates);
    if (url.pathname === '/api/system/updates/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'snapshot', state: updates })}\n\n` });
    const overview = { projects: [], generatedAt: stamp() };
    if (url.pathname === '/api/overview') return send(overview);
    if (url.pathname === '/api/overview/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(overview)}\n\n` });
    if (url.pathname === '/api/trading/positions') {
      if (expire) return send({ error: '登录已过期' }, 401);
      if (failRead) return send({ error: '测试仓位读取失败' }, 503);
      const snapshot = state();
      if (holdRead) await new Promise(resolve => heldReads.push(resolve));
      return send(snapshot);
    }
    if (url.pathname === '/api/trading') return send(oilState(url));
    if (url.pathname === '/api/trading/execution') return send({ generatedAt: stamp(), connections: [], positions: [], jobs: [] });
    return send({ error: 'Unexpected fixture API' }, 404);
  });
  const release = () => { holdRead = false; for (const resume of heldReads.splice(0)) resume(); };
  const refresh = async () => {
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/trading/positions');
    await page.evaluate(() => window.dispatchEvent(new Event('online'))); await page.clock.runFor(1_000); await (await response).finished();
  };
  const positionsReads = () => requests.filter(request => request.path === '/api/trading/positions').length;
  const oilReads = () => requests.filter(request => request.path === '/api/trading' || request.path.startsWith('/api/trading/execution')).length;
  // Install before mount so component intervals use the controlled clock.
  await page.clock.install({ time: new Date(base) });
  try {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?view=trading`);
  await page.getByRole('heading', { name: '交易所仓位', exact: true }).waitFor();
  await page.locator('[data-position-id="btc-long"]').waitFor();
  assert(oilReads() === 0, 'default trading entry must not fetch oil or execution data');
  assert(await page.locator('.execution-panel,.trading-pnl,input[type="password"]').count() === 0, 'default positions has no execution, charts or credential fields');
  assert(await page.getByRole('heading', { name: 'Kraken Futures', exact: true }).count() === 1, 'exchange directory comes from Asset, including unlisted exchanges');
  assert((await page.locator('[data-position-id="btc-long"]').innerText()).includes('0.123456789012345678'), 'quantity preserves decimal precision');
  assert((await page.locator('[data-position-id="btc-long"]').innerText()).includes('60,123.123456789012345678'), 'price preserves decimal precision');
  assert((await page.locator('[data-position-id="eur-long"]').innerText()).includes('EUR'), 'currency is attached to each amount');
  assert((await page.locator('[data-position-id="eth-short"]').innerText()).includes('张'), 'contract quantity unit is visible');
  assert(await page.locator('[data-scope="inverse"]').getByText('当前无持仓', { exact: true }).count() === 1, 'live empty range is a confirmed empty position');
  for (const scopeId of ['failed', 'options', 'pending', 'expired']) assert(!(await page.locator(`[data-scope="${scopeId}"]`).innerText()).includes('当前无持仓'), `${scopeId} must not be shown as an empty position`);
  assert((await page.locator('[data-scope="backup-linear"] .positions-status').innerText()) === '旧值', 'failed source retains and labels old positions');
  await page.locator('[data-position-id="eth-short"] summary').click();
  assert((await page.locator('[data-position-id="eth-short"] dl').innerText()).includes('0.1'), 'contract multiplier remains available without unit conversion');
  await page.locator('[data-position-id="eth-short"] summary').click();

  await page.getByRole('combobox', { name: 'Asset 来源', exact: true }).selectOption('asset-one');
  await page.getByRole('combobox', { name: '交易所', exact: true }).selectOption('binance');
  await page.getByRole('combobox', { name: '账户', exact: true }).selectOption(JSON.stringify(['asset-one', 'binance', 'hedge']));
  assert(await page.locator('.positions-table tbody tr').count() === 1, 'filters narrow source, exchange and account');
  assert(new URL(page.url()).searchParams.get('positionsExchange') === 'binance', 'filter saved in URL');
  await page.goBack();
  await page.waitForFunction(() => document.querySelectorAll('.positions-table tbody tr').length === 2);
  assert(await page.getByRole('combobox', { name: '账户', exact: true }).inputValue() === '', 'back restores account filter');
  await page.goForward();
  await page.waitForFunction(() => document.querySelectorAll('.positions-table tbody tr').length === 1);
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'output/playwright/trading-positions-desktop.png', fullPage: true });

  failRead = true; await refresh();
  await page.getByRole('alert').filter({ hasText: '测试仓位读取失败' }).waitFor();
  assert(await page.locator('[data-position-id="btc-long"]').count() === 1, 'failed GET preserves previous positions');
  assert(await page.locator('.positions-scope .positions-status.live').count() === 0, 'failed GET cannot keep a live range');
  assert(await page.getByText('当前无持仓', { exact: true }).count() === 0, 'read failure no longer confirms an old empty range');
  failRead = false; replacement = true; await refresh();
  await page.getByRole('heading', { name: '更换后的账户', exact: true }).waitFor();
  assert(await page.locator('[data-position-id="btc-long"],[data-position-id="eth-short"]').count() === 0, 'replacement response clears removed account positions');
  replacement = false; await refresh(); await page.locator('[data-position-id="btc-long"]').waitFor();

  await page.getByRole('button', { name: '在 Asset 备用账本 管理账户', exact: true }).click();
  assert(new URL(page.url()).searchParams.get('id') === 'asset-two', 'manage account navigates to selected Asset project');
  await page.getByRole('button', { name: '交易', exact: true }).click();
  await page.getByRole('heading', { name: '交易所仓位', exact: true }).waitFor();
  await page.locator('[data-position-id="btc-long"]').waitFor();
  assert(new URL(page.url()).searchParams.get('tradingSection') === 'positions' && oilReads() === 0, 'main navigation enters positions explicitly');

  await page.goto(`${origin}/?view=trading&tradingDays=30&tradingPair=binance,okx`);
  await page.getByRole('heading', { name: '原油四腿资金费套利', exact: true }).waitFor();
  await page.locator('.trading-funding').waitFor();
  assert(requests.some(request => request.path === '/api/trading' && new URLSearchParams(request.search).get('days') === '30' && new URLSearchParams(request.search).get('pair') === 'binance,okx'), 'legacy oil links preserve range and pair');
  await page.getByRole('button', { name: '交易所仓位', exact: true }).click();
  await page.locator('[data-position-id="btc-long"]').waitFor();
  assert(new URL(page.url()).searchParams.get('tradingSection') === 'positions', 'explicit positions overrides old oil parameters');
  await page.goBack();
  await page.getByRole('heading', { name: '原油四腿资金费套利', exact: true }).waitFor();
  await page.goForward();
  await page.locator('[data-position-id="btc-long"]').waitFor();
  await page.getByRole('button', { name: '原油四腿套利', exact: true }).click();
  await page.getByRole('heading', { name: '原油四腿资金费套利', exact: true }).waitFor();
  assert(new URL(page.url()).searchParams.get('tradingDays') === '30', 'return to oil preserves cached range');
  await page.getByRole('button', { name: '交易所仓位', exact: true }).click();
  await page.locator('[data-position-id="btc-long"]').waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'mobile has no page-wide overflow');
  const tableRegion = page.locator('[data-scope="linear"] .positions-table-scroll');
  assert(await tableRegion.evaluate(element => element.scrollWidth > element.clientWidth), 'wide table scrolls inside its own region');
  await tableRegion.focus(); await page.keyboard.press('ArrowRight');
  assert(await tableRegion.evaluate(element => element === document.activeElement), 'table region supports keyboard focus');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'output/playwright/trading-positions-mobile.png', fullPage: true });

  const frozenAt = await page.evaluate(() => Date.now()) + 1000;
  await page.clock.pauseAt(new Date(frozenAt)); elapsed = frozenAt - base;
  await refresh();
  const inactiveOilReads = oilReads(), foreground = positionsReads();
  elapsed += 15_000; await page.clock.runFor(15_000);
  assert(positionsReads() >= foreground + 2, 'foreground checks positions every five seconds');
  assert(oilReads() === inactiveOilReads, 'unmounted oil page stops all polling');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenReads = positionsReads(); elapsed += 15_000; await page.clock.runFor(15_000);
  assert(positionsReads() === hiddenReads, 'hidden page slows polling');
  elapsed += 15_000; await page.clock.runFor(15_000);
  assert(positionsReads() === hiddenReads + 1, 'hidden page still checks every thirty seconds');
  const visibleRead = page.waitForResponse(value => new URL(value.url()).pathname === '/api/trading/positions');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  elapsed += 1_000; await page.clock.runFor(1_000);
  await visibleRead;
  holdRead = true; elapsed += 100_000; await page.clock.runFor(100_000);
  await page.waitForFunction(() => !document.querySelector('[data-scope="linear"] .positions-status.live'));
  assert(await page.locator('[data-position-id="btc-long"]').count() === 1, 'timeout and aging retain old positions');
  release(); await refresh();
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); window.dispatchEvent(new Event('offline')); });
  await page.getByRole('status').filter({ hasText: '网络已断开' }).waitFor();
  const offlineReads = positionsReads(); elapsed += 15_000; await page.clock.runFor(15_000);
  assert(positionsReads() === offlineReads, 'offline page stops polling');
  const reconnect = page.waitForResponse(value => new URL(value.url()).pathname === '/api/trading/positions');
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')); });
  elapsed += 1_000; await page.clock.runFor(1_000);
  await reconnect;
  assert(positionsReads() > offlineReads, 'reconnect reads after the coalesced recovery window');
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert(!storage.includes('btc-long') && !storage.includes('0.123456789012345678'), 'positions never persist in browser storage');
  noSources = true; await refresh(); await page.getByRole('heading', { name: '尚未接入 Asset 来源', exact: true }).waitFor();
  assert(await page.locator('.positions-table').count() === 0, 'removed sources clear cached account data');
  expire = true; await refresh(); await page.getByRole('heading', { name: '进入工作台', exact: true }).waitFor();
  const expiredReads = positionsReads(); elapsed += 15_000; await page.clock.runFor(15_000);
  assert(positionsReads() === expiredReads, '401 unmount stops positions polling');
  assert(requests.every(request => request.method === 'GET'), 'all positions interactions and navigation are read-only');
  assert(!pageErrors.length, `No uncaught browser errors: ${pageErrors.join('; ')}`);
  return { passed: true, scenarios: ['default positions only', 'dynamic exchange directory', 'exact decimal and per-field units', 'live empty versus failed/loading/unsupported', 'source old values', 'URL filters and back/forward', 'source account management', 'failure retention and revision replacement', 'legacy oil links and lazy subpage', 'mobile table keyboard scrolling', 'foreground/hidden/offline polling', 'timeout and age', 'no browser persistence', 'source removal and session expiry', 'no write requests'], requests: requests.length };
  } finally {
    release();
    // The CLI waits for a page timer to settle, including after a failed assertion.
    await page.clock.resume();
  }
}
