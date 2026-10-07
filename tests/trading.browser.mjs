// Run with playwright-cli run-code, passing this file's text as the code argument.
// Uses the origin of the already-open app page; all /api requests are isolated fixtures.
async (page) => {
  const origin = new URL(page.url()).origin;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const requests = [], pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const fixedTime = '2026-10-07T04:00:00.000Z';
  let scenario = 'empty', hedge = false, refreshing = false, rejectSave = false, expire = false, readFailure = false;
  let revisions = { binance: 0, bybit: 0 };
  let configured = { binance: false, bybit: false };
  let pnlMode = 'history', holdReads = false;
  const heldReads = [];
  const releaseReads = () => { holdReads = false; for (const release of heldReads.splice(0)) release(); };
  const state = (days, requestedPage = 0) => {
    const start = days === 30 ? '2026-09-07T04:00:00.000Z' : '2026-09-30T04:00:00.000Z';
    const partial = scenario === 'partial';
    const accounts = ['binance', 'bybit'].map(exchange => ({
      exchange, name: exchange === 'binance' ? 'Binance' : 'Bybit', connected: configured[exchange], revision: revisions[exchange],
      verifiedAt: configured[exchange] ? fixedTime : null, refreshing: configured[exchange] && refreshing,
      positions: { state: !configured[exchange] ? 'unconfigured' : partial ? exchange === 'binance' ? 'stale' : 'error' : 'live', fetchedAt: configured[exchange] ? fixedTime : null, error: partial && exchange === 'bybit' ? 'Bybit 仓位读取暂时失败' : null },
      funding: { state: !configured[exchange] ? 'unconfigured' : partial && exchange === 'bybit' ? 'error' : 'live', fetchedAt: configured[exchange] ? fixedTime : null, error: partial && exchange === 'bybit' ? 'Bybit 部分账本未能读取' : null, coverageStart: configured[exchange] ? start : null, coverageEnd: configured[exchange] ? fixedTime : null, complete: configured[exchange] && !partial },
    }));
    const legs = ['CLUSDT', 'BZUSDT'].flatMap(symbol => ['binance', 'bybit'].map(exchange => {
      const account = accounts.find(item => item.exchange === exchange);
      const side = exchange === 'binance' ? (symbol === 'CLUSDT' ? 'long' : 'short') : (symbol === 'CLUSDT' ? 'short' : 'long');
      const position = { id: `${exchange}-${symbol}-${side}`, exchange, symbol, side, mode: 'one-way', quantity: '12.34567890', entryPrice: '80.12', markPrice: '81.15', notional: '1001.851852735', unrealizedPnl: exchange === 'binance' ? '12.715999' : '-7.215999', leverage: '2', liquidationPrice: '41.25', sourceUpdatedAt: '2026-10-06T00:04:00.000Z' };
      const positions = configured[exchange] ? [position] : [];
      if (hedge && exchange === 'bybit' && symbol === 'CLUSDT') { position.mode = 'hedge'; positions.push({ ...position, id: `${exchange}-${symbol}-long`, side: 'long', quantity: '2', notional: '162.3' }); }
      return { id: `${exchange}-${symbol}`, exchange, symbol, name: `${exchange} ${symbol}`, state: account.positions.state, fetchedAt: account.positions.fetchedAt, positions, grossNotional: configured[exchange] ? '1001.851852735' : null, netNotional: configured[exchange] ? side === 'long' ? '1001.851852735' : '-1001.851852735' : null, unrealizedPnl: configured[exchange] ? position.unrealizedPnl : null, fundingNet: configured[exchange] ? '3.1' : null, fundingComplete: account.funding.complete };
    }));
    const points = accounts.every(account => account.connected) ? Array.from({ length: pnlMode === 'single' ? 1 : 60 }, (_, i) => ({ time: Date.parse(fixedTime) - (59 - i) * 60000, unrealizedPnl: i === 20 ? null : String(i - 30), fundingPnl: partial || i === 20 ? null : days === 30 ? '30.123456789012345678' : '3.123456789012345678', totalPnl: partial || i === 20 ? null : `${i - (days === 30 ? 0 : 27)}.123456789012345678` })) : [];
    const pnl = { currency: 'USDT', intervalMs: 60000, cumulativeStart: Date.parse(start), end: Date.parse(fixedTime), recordingStartedAt: points[0]?.time ?? null, pointCount: points.length, points, latest: points.at(-1) ?? null, status: points.length ? partial ? 'incomplete' : 'ready' : 'collecting' };
    const any = accounts.some(account => account.connected);
    const complete = accounts.every(account => account.funding.complete);
    const events = any ? Array.from({ length: 63 }, (_, index) => ({ id: `receipt-${index}`, exchange: index % 2 ? 'bybit' : 'binance', symbol: index % 3 ? 'CLUSDT' : 'BZUSDT', time: new Date(Date.parse(fixedTime) - index * 3600000).toISOString(), amount: index % 2 ? '-0.12345678' : '0.52345678', currency: 'USDT' })).filter(event => configured[event.exchange]) : [];
    const pages = Math.max(1, Math.ceil(events.length / 50)), pageIndex = Math.min(requestedPage, pages - 1);
    return { mode: 'read-only', pnl, strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: fixedTime, cache: { builtAt: fixedTime, servedAt: fixedTime, rebuilding: refreshing }, period: { days, start, end: fixedTime }, accounts, legs, structure: { state: !any ? 'unknown' : hedge ? 'mixed' : partial ? 'incomplete' : 'opposed', message: !any ? '连接账户后检查同品种的跨所持仓方向。' : hedge ? 'CLUSDT 同时存在双向持仓，请分别核对。' : partial ? '部分仓位状态未能确认，暂不能判断完整结构。' : 'CLUSDT 与 BZUSDT 均为跨交易所反向持仓。' }, funding: { complete, income: any ? days === 30 ? '95.4' : '18.6' : null, expense: any ? '6.2' : null, net: any ? days === 30 ? '89.2' : '12.4' : null, currency: 'USDT', events: events.slice(pageIndex * 50, (pageIndex + 1) * 50), pagination: { page: pageIndex, pageSize: 50, total: events.length, pages }, daily: any ? Array.from({ length: days + 1 }, (_, index) => ({ date: new Date(Date.parse(fixedTime) - (days - index) * 86400000).toISOString().slice(0, 10), income: partial && index === 2 ? null : index % 3 ? '1.7' : '0', expense: partial && index === 2 ? null : index % 4 ? '0' : '0.7', net: partial && index === 2 ? null : index % 3 ? '1.7' : '-0.7', complete: !partial })) : [] } };
  };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const record = { path: url.pathname, query: url.search, method, body: request.postDataJSON() };
    requests.push(record);
    const send = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture-only-csrf' });
    if (url.pathname === '/api/login') { expire = false; return send({ csrfToken: 'fixture-only-csrf-new-login' }); }
    if (url.pathname === '/api/logout') return send({ ok: true });
    if (url.pathname === '/api/overview/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: fixedTime })}\n\n` });
    if (url.pathname === '/api/overview') return send({ projects: [], generatedAt: fixedTime });
    if (url.pathname === '/api/trading' && method === 'GET') {
      if (expire) return send({ error: '登录已过期' }, 401);
      if (readFailure) return send({ error: '测试读取失败' }, 503);
      const pageIndex = Number(url.searchParams.get('page'));
      assert(url.searchParams.has('page') && Number.isInteger(pageIndex) && pageIndex >= 0, 'cache reads specify one server ledger page');
      const snapshot = state(url.searchParams.get('days') === '30' ? 30 : 7, pageIndex);
      assert(snapshot.funding.events.length <= 50, 'fixture serves only requested ledger page');
      if (holdReads) await new Promise(resolve => heldReads.push(resolve));
      return send(snapshot);
    }
    if (url.pathname === '/api/trading/refresh' && method === 'POST') { refreshing = true; return send(state(url.searchParams.get('days') === '30' ? 30 : 7), 202); }
    const account = url.pathname.match(/^\/api\/trading\/accounts\/(binance|bybit)$/)?.[1];
    if (account && method === 'PUT') {
      if (rejectSave) return send({ error: '只允许没有交易权限的只读密钥' }, 400);
      assert(record.body.revision === revisions[account], 'save must use latest account revision');
      assert(record.body.apiKey === 'fixture-key' && record.body.apiSecret === 'fixture-secret', 'key sent only to account save endpoint');
      configured[account] = true; revisions[account]++; return send(state(url.searchParams.get('days') === '30' ? 30 : 7), 202);
    }
    if (account && method === 'DELETE') { assert(record.body.revision === revisions[account], 'disconnect must use current revision'); configured[account] = false; revisions[account]++; return send(state(url.searchParams.get('days') === '30' ? 30 : 7)); }
    return send({ error: `Unexpected fixture API: ${method} ${url.pathname}` }, 404);
  });
  const refreshCache = async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading');
    await page.evaluate(() => window.dispatchEvent(new Event('online'))); await response;
  };
  const waitForText = text => page.getByText(text, { exact: false }).first().waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?view=trading`);
  await waitForText('连接账户，查看四腿的真实仓位');
  await page.getByText('连接两所并取得完整仓位后开始记录，历史浮盈亏无法回补。', { exact: true }).waitFor();
  assert(await page.locator('.trading-position-table tbody tr').count() === 4, 'empty fixture retains four defined legs');
  assert((await page.locator('.trading-funding-summary strong').allTextContents()).every(text => text === '—'), 'unconfigured funding must remain missing, never zero');
  await page.getByRole('button', { name: '连接只读账户', exact: true }).click();
  const binanceForm = page.getByRole('form', { name: 'Binance 账户连接' });
  await binanceForm.getByLabel('API Key', { exact: true }).fill('draft-keep');
  await binanceForm.getByLabel('API Secret', { exact: true }).fill('draft-secret');

  configured = { binance: true, bybit: true }; revisions = { binance: 4, bybit: 8 }; scenario = 'live';
  await refreshCache(); await waitForText('CLUSDT 与 BZUSDT 均为跨交易所反向持仓。');
  assert(await binanceForm.getByLabel('API Key', { exact: true }).inputValue() === '', 'changed connection revision clears stale credential draft');
  await binanceForm.getByLabel('API Key', { exact: true }).fill('draft-keep');
  await binanceForm.getByLabel('API Secret', { exact: true }).fill('draft-secret');
  await refreshCache();
  assert(await page.locator('.trading-position-table tbody tr').count() === 4, 'live fixture displays four legs');
  const pnlPath = await page.locator('[data-series="totalPnl"]').getAttribute('d');
  assert((pnlPath.match(/M/g) || []).length === 2, 'PnL path breaks at missing sample');
  assert((await page.locator('.trading-pnl-latest').innerText()).includes('32.123456789012345678'), 'exact PnL decimals survive rendering');
  const slider = page.getByRole('slider', { name: '选择盈亏采样时刻' });
  await slider.focus(); await page.keyboard.press('ArrowLeft');
  assert((await page.locator('.trading-pnl-inspect').innerText()).includes('31.123456789012345678'), 'keyboard selects exact previous PnL sample');
  assert(await binanceForm.getByLabel('API Key', { exact: true }).inputValue() === 'draft-keep', 'cache refresh must preserve key draft');
  assert((await page.locator('.trading-funding-summary strong').allTextContents()).join('|') === '18.6|6.2|+12.4', 'income, positive expense and signed net use correct units');
  await page.locator('.trading-connections > summary').click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'output/playwright/trading-desktop.png', fullPage: true });
  await page.locator('.trading-connections > summary').click();
  assert(await page.locator('.trading-ledger-scroll tbody tr').count() === 50, 'ledger page bound is fifty');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.trading-ledger-scroll tbody tr').length === 13);
  assert(await page.locator('.trading-ledger-scroll tbody tr').count() === 13, 'ledger second page shows remainder');
  await page.getByRole('button', { name: '近30天', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.trading-funding-summary')?.textContent.includes('89.2'));
  assert(new URL(page.url()).searchParams.get('tradingDays') === '30', 'range persists in URL');
  assert(await page.locator('.trading-chart svg title').count() === 31, 'rolling thirty-day window retains both partial calendar boundary dates');
  assert(await page.locator('.trading-ledger-scroll tbody tr').count() === 50, 'range change resets ledger pagination');
  assert(await binanceForm.getByLabel('API Key', { exact: true }).inputValue() === 'draft-keep', 'range change preserves draft');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('.trading-funding-summary')?.textContent.includes('12.4'));
  assert(await page.getByRole('button', { name: '近7天', exact: true }).getAttribute('aria-pressed') === 'true', 'history restores range');
  holdReads = true;
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await page.getByRole('button', { name: /^交易\s*只读$/ }).click();
  await page.waitForFunction(() => document.querySelector('.trading-funding-summary')?.textContent.includes('12.4'));
  assert(await page.locator('.trading-initial').count() === 0, 'returning to trading displays the cached page before a held GET completes');
  await page.getByRole('button', { name: '近30天', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.trading-funding-summary')?.textContent.includes('89.2'));
  assert(await page.locator('.trading-window-loading').count() === 0, 'previously loaded thirty-day cache is available before its GET completes');
  await page.getByRole('button', { name: '近7天', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.trading-funding-summary')?.textContent.includes('12.4'));
  releaseReads();
  await page.getByRole('button', { name: '账户连接', exact: true }).click();
  await binanceForm.getByLabel('API Key', { exact: true }).fill('draft-keep');
  await binanceForm.getByLabel('API Secret', { exact: true }).fill('draft-secret');
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await waitForText('后台同步中');
  assert(await page.locator('.trading-position-table tbody tr').count() === 4, 'manual refresh retains positions');
  assert(await binanceForm.getByLabel('API Secret', { exact: true }).inputValue() === 'draft-secret', 'manual refresh preserves secret draft');
  refreshing = false; hedge = true;
  await refreshCache(); await waitForText('CLUSDT 同时存在双向持仓，请分别核对。');
  assert(await page.locator('.trading-position-table tbody tr').count() === 5, 'hedge mode preserves both directions');
  const bybitCl = page.locator('[data-leg="bybit-CLUSDT"]');
  assert(await bybitCl.count() === 2, 'hedged contract must use two rows');
  assert((await bybitCl.locator('.trading-side').allTextContents()).sort().join('|') === '做多|做空', 'both actual sides shown');
  await bybitCl.first().locator('summary').click();
  await bybitCl.first().getByText('2026/10/06 08:04:00', { exact: true }).waitFor();

  scenario = 'partial';
  await refreshCache(); await waitForText('Bybit 部分账本未能读取');
  assert(await page.locator('[data-series="totalPnl"]').getAttribute('d') === Array(60).fill('').join(' '), 'missing funding never produces a total PnL line');
  assert((await page.locator('[data-series="unrealizedPnl"]').getAttribute('d')).includes('M'), 'floating PnL stays visible while funding is incomplete');
  await page.getByRole('heading', { name: '已获取的资金费', exact: true }).waitFor();
  assert(await page.locator('.trading-status.stale').count() > 0, 'stale data is visibly labelled');
  assert(await page.locator('.trading-status.error').count() > 0, 'single-exchange read error is visible');
  await page.getByText('查看逐日数值', { exact: true }).click();
  assert((await page.locator('.trading-daily-data tbody tr').nth(2).allTextContents()).join('').includes('———'), 'missing daily values are not filled with zero');
  await waitForText('当前汇总不代表整个区间的完整实收。');
  readFailure = true; await refreshCache(); await waitForText('测试读取失败');
  assert(await page.locator('.trading-position-table tbody tr').count() === 5, 'read failure retains prior positions');
  assert(await page.locator('.trading-status.live').count() === 0, 'a failed cache read cannot keep a live status');
  await page.locator('.trading-cache-status').getByText('当前显示旧缓存', { exact: false }).waitFor();
  readFailure = false; await refreshCache();

  await binanceForm.getByLabel('API Key', { exact: true }).fill('fixture-key');
  await binanceForm.getByLabel('API Secret', { exact: true }).fill('fixture-secret');
  rejectSave = true;
  await binanceForm.getByRole('button', { name: '验证并替换连接', exact: true }).click();
  await waitForText('只允许没有交易权限的只读密钥');
  await refreshCache();
  assert(await page.getByRole('alert').filter({ hasText: '只允许没有交易权限的只读密钥' }).count() === 1, 'cache refresh must not erase a failed account operation');
  assert(await binanceForm.getByLabel('API Key', { exact: true }).inputValue() === 'fixture-key', 'failed verification preserves correctable draft');
  rejectSave = false;
  await binanceForm.getByRole('button', { name: '验证并替换连接', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#trading-key-binance')?.value === '');
  assert(await binanceForm.getByLabel('API Secret', { exact: true }).inputValue() === '', 'successful save clears secret');
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert(!storage.includes('fixture-key') && !storage.includes('fixture-secret') && !storage.includes('draft-secret'), 'credentials never enter browser storage');
  readFailure = true;
  await binanceForm.getByRole('button', { name: '断开连接', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-leg="binance-CLUSDT"] .trading-side').length === 0);
  assert(await page.locator('[data-leg="bybit-CLUSDT"] .trading-side').count() === 2, 'disconnecting one exchange preserves the other exchange');
  await waitForText('测试读取失败');
  assert(await page.locator('[data-leg="binance-CLUSDT"] .trading-side').count() === 0, 'successful disconnect clears local positions even if the follow-up read fails');
  readFailure = false;

  configured = { binance: true, bybit: true }; revisions.binance++; scenario = 'live'; hedge = false;
  pnlMode = 'single';
  await refreshCache(); await waitForText('已取得首个采样点');
  assert(await page.locator('.trading-pnl-plot circle').count() === 2, 'single sample displays visible points');
  pnlMode = 'history';
  await refreshCache(); await waitForText('CLUSDT 与 BZUSDT 均为跨交易所反向持仓。');
  await page.locator('.trading-connections > summary').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '390px viewport has no page-wide horizontal overflow');
  assert(await page.locator('.trading-position-table thead').isHidden(), 'phone uses labelled position cards');
  assert(await page.locator('.trading-position-table tbody tr').count() === 4, 'phone retains all four legs');
  assert(await page.locator('.trading-chart svg').getAttribute('height') === '224', 'phone reserves readable chart height');
  while (await page.locator('.trading-page details[open] > summary').count()) await page.locator('.trading-page details[open] > summary').first().click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'output/playwright/trading-mobile.png', fullPage: true });
  await page.locator('.trading-pnl').screenshot({ path: 'output/playwright/trading-pnl-mobile.png' });
  await page.getByRole('button', { name: '账户连接', exact: true }).click();
  await binanceForm.getByLabel('API Key', { exact: true }).focus();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'expanded phone connection form has no horizontal overflow');

  const getCount = () => requests.filter(request => request.path === '/api/trading' && request.method === 'GET').length;
  await page.clock.install();
  holdReads = true;
  await page.clock.runFor(80_000);
  await page.waitForFunction(() => [...document.querySelectorAll('.trading-account-status .trading-status')].every(element => element.classList.contains('stale')));
  assert(await page.locator('.trading-position-table tbody tr').count() === 4, 'freshness ages while held reads retain positions');
  releaseReads();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenCount = getCount(); await page.clock.runFor(15000);
  assert(getCount() === hiddenCount, 'hidden tab stops polling');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); window.dispatchEvent(new Event('offline')); });
  const offlineCount = getCount(); await page.clock.runFor(15000);
  assert(getCount() === offlineCount, 'offline tab stops polling');
  await waitForText('网络已断开');
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')); });
  await page.waitForFunction(() => !document.querySelector('.trading-notice')?.textContent.includes('网络已断开'));
  assert(getCount() > offlineCount, 'reconnecting immediately reads cache');
  expire = true; await refreshCache();
  await page.getByRole('heading', { name: '进入工作台', exact: true }).waitFor();
  const afterUnmount = getCount(); await page.clock.runFor(15000);
  assert(getCount() === afterUnmount, 'expired-session unmount stops trading polling');
  await page.setViewportSize({ width: 1440, height: 1000 });
  configured = { binance: false, bybit: false }; revisions = { binance: 0, bybit: 0 }; holdReads = true;
  await page.getByLabel('工作台密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('.trading-initial').waitFor();
  assert(await page.locator('.trading-position-table').count() === 0, 'new login after 401 cannot reuse the previous account cache');
  releaseReads(); await waitForText('连接账户，查看四腿的真实仓位');
  configured = { binance: true, bybit: true }; revisions = { binance: 1, bybit: 1 };
  await refreshCache(); await waitForText('CLUSDT 与 BZUSDT 均为跨交易所反向持仓。');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('heading', { name: '进入工作台', exact: true }).waitFor();
  configured = { binance: false, bybit: false }; revisions = { binance: 0, bybit: 0 }; holdReads = true;
  await page.getByLabel('工作台密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('.trading-initial').waitFor();
  assert(await page.locator('.trading-position-table').count() === 0, 'explicit logout also clears the authenticated session cache');
  releaseReads(); await waitForText('连接账户，查看四腿的真实仓位');
  assert(requests.filter(request => request.path.startsWith('/api/trading') && request.method !== 'GET').every(request => request.path === '/api/trading/refresh' && request.method === 'POST' || /^\/api\/trading\/accounts\/(binance|bybit)$/.test(request.path) && ['PUT', 'DELETE'].includes(request.method)), 'UI issues only read-only account and refresh operations');
  assert(!requests.some(request => /order|trade|execute/i.test(request.path)), 'no trading operation endpoint called');
  assert(!pageErrors.length, `No uncaught browser errors: ${pageErrors.join('; ')}`);
  return { passed: true, scenarios: ['empty', 'PnL gaps and exact values', 'PnL keyboard inspection', 'single PnL sample', 'partial funding PnL', 'four legs', 'hedged positions', 'partial and stale', 'read failure and timed expiry', '7/30 and history', 'server ledger pagination', 'immediate session cache after navigation and range change', 'refresh preserves drafts', 'account save/reject/disconnect', '390px mobile', 'offline and hidden polling', '401 and logout clear session cache', 'no trade actions'], tradingRequests: requests.filter(request => request.path.startsWith('/api/trading')).length };
}
