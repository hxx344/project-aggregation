// Run with playwright-cli run-code --filename tests/crossex-position-metrics.browser.mjs.
// Serve the built Hub and CrossEx on isolated port 4175, choosing dist/ or
// modules/crossex/dist/ by the two Host names below. No application server is needed.
// This enters the real Hub route, launch handler UI, iframe and module bridge.
async (page) => {
  const origin = 'http://hub.localhost:4175';
  const moduleOrigin = 'http://p-000000000000000000000000.hub.localhost:4175';
  const allowed = new Set([origin, moduleOrigin]);
  if (page.url() !== 'about:blank' && !allowed.has(new URL(page.url()).origin)) {
    throw new Error('CrossEx positions fixture requires isolated localhost:4175');
  }
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const requests = [], errors = [], unexpected = [], blocked = [], heldReads = [];
  const base = Date.UTC(2026, 9, 14, 4, 0, 0), day = 86_400_000;
  let now = base, accountAt = base, fundingAt = base, fundingTtl = 10_000, btcShortMark = '108';
  let partial = false, missingFunding = false, holdState = false;
  const config = { entryPaused: false, monitorUrl: 'module://monitor', monitorUsername: '', hasMonitorPassword: false,
    notionalPerLeg: 500, maxOpen: 10, maxTotalNotional: 10000, feeBps: 5, feeSchedule: [], slippageBps: 5, minNetBps: 1, cooldownSeconds: 10 };
  const connection = { configured: true, connected: true, status: 'connected', accountId: 'fixture-account', keySuffix: 'TEST',
    version: 'fixture-1', positionMode: 'DUAL', permissions: { read: 'allowed', trade: 'allowed' }, lastVerifiedAt: base, error: null };
  const project = { id: 'crossex', name: 'Gate CrossEx', description: '隔离持仓指标验收', category: 'trading', adapter: 'standard',
    url: 'module://crossex/', apiUrl: 'module://crossex', accessMode: 'proxy', mode: 'embed', enabled: true, embedded: true,
    staleAfterSeconds: 120, order: 0, hasCredentials: true, revision: 'position-metrics-fixture' };
  const overview = () => ({ generatedAt: new Date(now).toISOString(), projects: [{ project, state: 'online', freshness: 'static',
    message: '', checkedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), latencyMs: 1, metrics: [] }] });
  const updates = { enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null };
  const symbol = (exchange, coin) => `${exchange.toUpperCase()}_FUTURE_${coin}_USDT`;
  const position = (coin, exchange, side, entryPrice, markPrice, openedAt, overrides = {}) => ({
    id: `${coin}-${exchange}-${side}`, symbol: symbol(exchange, coin), exchange, side,
    quantity: side === 'SHORT' ? '-1' : '1', signedQuantity: side === 'SHORT' ? '-1' : '1', baseQuantity: '1',
    baseCurrency: coin, quoteCurrency: 'USDT', pnlCurrency: 'USDT', marginCurrency: 'USDT',
    entryPrice, markPrice, notional: markPrice, positionValue: markPrice, unrealizedPnl: side === 'LONG' ? '0' : '2',
    margin: '20', maintenanceMargin: '1', liquidationPrice: null, realizedPnl: '0.1', fundingFee: '0.12', fee: '-0.01',
    leverage: '5', maxLeverage: '20', riskLimit: '100000', external: true, openedAt, updatedAt: accountAt, sourceAt: accountAt,
    directionSource: 'position_side', crossExAdlRank: '2', exchangeAdlRank: '1', ...overrides,
  });
  const positions = () => [
    position('BTC', 'binance', 'LONG', '100', '100', base - 2 * day),
    position('BTC', 'bybit', 'SHORT', '110', btcShortMark, base - 2 * day),
    position('ETH', 'binance', 'LONG', '100', '100', base - 8 * day),
    position('ETH', 'bybit', 'SHORT', '110', '104', base - 8 * day, { unrealizedPnl: '6' }),
    position('SOL', 'okx', 'LONG', '100', '102', null, { unrealizedPnl: '2' }),
  ];
  const fundingLeg = (coin, exchange, rate, intervalHours) => ({ exchange, symbol: symbol(exchange, coin), quoteCurrency: 'USDT',
    rate, intervalHours, normalized8hBps: rate * 8 / intervalHours * 10000, nextFundingAt: fundingAt + 3_600_000, fundingAt });
  const funding = () => missingFunding ? [] : [
    // Equal raw rates must produce +7 bp/8h in the actual held direction.
    { id: 'btc-funding', base: 'BTC', long: fundingLeg('BTC', 'binance', 0.0001, 8), short: fundingLeg('BTC', 'bybit', 0.0001, 1),
      equivalent8hBps: 7, grossBps: 800, asOf: fundingAt, expiresAt: fundingAt + fundingTtl, eligible: true, reason: '' },
    // The opportunity is profitable in reverse, but the held ETH direction pays funding.
    { id: 'eth-funding', base: 'ETH', long: fundingLeg('ETH', 'bybit', 0.0001, 8), short: fundingLeg('ETH', 'binance', 0.0003, 8),
      equivalent8hBps: 2, grossBps: -400, asOf: fundingAt, expiresAt: fundingAt + fundingTtl, eligible: true, reason: '' },
  ];
  const state = () => ({ now, csrfToken: 'position-metrics-fixture-only', mode: 'live', config,
    venues: [], fx: [], opportunities: [], fundingOpportunities: [],
    positionFundingRates: funding().flatMap(row => [row.long, row.short].map(leg => ({ ...leg, expiresAt: row.expiresAt }))),
    source: { state: 'live', error: null, updatedAt: fundingAt, generatedAt: fundingAt, checkedAt: fundingAt, quoteCount: 4 },
    catalog: { state: 'ready', count: 5, updatedAt: now, error: null },
    live: { connection, status: 'live', freshnessState: 'fresh', stale: false, partial, asOf: accountAt, tradingAllowed: !partial,
      reasons: [], account: { available_margin: '5000', margin_balance: '10000', initial_margin: '100', maintenance_margin: '5',
        initial_margin_rate: '0.01', maintenance_margin_rate: '0.0005' }, balances: [], positions: positions(), orders: [],
      executions: [], alerts: [], recentTrades: [], accountBook: [], fees: [], adlAsOf: accountAt, adlError: null } });
  const instruments = () => positions().map(p => ({ symbol: p.symbol, exchange: p.exchange, base: p.baseCurrency,
    quoteCurrency: 'USDT', settlementCurrency: 'USDT', lot_size: '0.001', tick_size: '0.01', min_size: '0.001', state: 'live' }));

  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ overview, updates }) => {
    // Neither SSE nor sockets can escape the HTTP fixture boundary.
    window.EventSource = class {
      constructor(url) {
        this.closed = false;
        queueMicrotask(() => {
          if (this.closed) return;
          const data = String(url).includes('/api/overview/events') ? overview : { type: 'snapshot', state: updates };
          this.onmessage?.({ data: JSON.stringify(data) });
        });
      }
      close() { this.closed = true; }
    };
    window.WebSocket = class { constructor() { throw new Error('WebSocket is forbidden in the positions fixture'); } };
  }, { overview: overview(), updates });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!allowed.has(url.origin)) { blocked.push(url.href); return route.abort('blockedbyclient'); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    requests.push({ origin: url.origin, path: url.pathname, search: url.search, method: request.method() });
    const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    // Launch issues only a synthetic iframe URL; no trading request is exempted.
    if (url.origin === origin && url.pathname === '/api/projects/crossex/launch' && request.method() === 'POST') {
      return send({ url: `${moduleOrigin}/#positions` });
    }
    if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${url.href}`); return send({ error: 'Unexpected write' }, 400); }
    if (url.origin === origin) {
      if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'hub-position-fixture' });
      if (url.pathname === '/api/overview') return send(overview());
      if (url.pathname === '/api/system/updates') return send(updates);
      if (url.pathname === '/api/health') return send({ status: 'ok' });
    } else {
      if (url.pathname === '/api/bootstrap') return send({ now, config, connection, csrfToken: 'position-metrics-fixture-only' });
      if (url.pathname === '/api/live/instruments') return send({ items: instruments() });
      if (url.pathname === '/api/state') {
        if (url.searchParams.get('opportunities') !== '0' || url.searchParams.get('funding') !== '1') {
          unexpected.push(`Positions must explicitly request funding: ${url.href}`);
          return send({ error: 'Positions funding projection was not requested' }, 400);
        }
        const snapshot = state();
        if (holdState) await new Promise(resolve => heldReads.push(resolve));
        return send(snapshot);
      }
    }
    unexpected.push(`${request.method()} ${url.href}`);
    return send({ error: 'Unexpected fixture API' }, 404);
  });
  const release = () => { holdState = false; for (const resolve of heldReads.splice(0)) resolve(); };
  await page.clock.install({ time: new Date(base) });
  try {
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(`${origin}/?view=project&id=crossex`);
    const iframe = page.locator('iframe[title="Gate CrossEx模块"]');
    await iframe.waitFor();
    await page.frameLocator('iframe[title="Gate CrossEx模块"]').getByRole('heading', { name: '持仓', exact: true }).waitFor();
    const frame = page.frames().find(item => item.url().startsWith(moduleOrigin));
    assert(frame, 'the real CrossEx build is loaded inside the Hub iframe');
    const module = frame;
    const group = coin => module.locator('.position-group').filter({ has: module.locator('.group-identity').filter({ hasText: coin }) });
    const btc = group('BTC'), eth = group('ETH'), sol = group('SOL');
    await btc.locator('.position-metrics-summary').waitFor();
    const summary = await btc.locator('.position-metrics-summary').innerText();
    for (const label of ['综合年化', '持仓时长', '三项规则观察']) assert(summary.includes(label), `collapsed overview includes ${label}`);
    assert(/未触发\s*100 \/ 100/.test(await btc.locator('.position-health').innerText()), 'complete BTC pair triggers no rule and starts at 100');
    assert(summary.includes('保证金、强平价、ADL 需另行核对'), 'the summary states what the three rules do not cover');
    assert(!/良好|关注|风险/.test(await module.locator('.position-health').allInnerTexts().then(values => values.join(' '))), 'conclusions do not read as an overall risk grade');
    assert(/触发 3 项\s*25 \/ 100/.test(await eth.locator('.position-health').innerText()), 'narrowing, long holding and negative current funding trigger all three rules');
    assert((await sol.locator('.position-metrics-summary').innerText()).includes('待补全'), 'unpaired position is explicitly incomplete');
    assert(await module.locator('.position-metrics-details').count() === 0, 'details are collapsed by default');
    assert(requests.some(r => r.origin === origin && r.path.endsWith('/launch')), 'Hub launch path was exercised');
    assert(requests.some(r => r.origin === moduleOrigin && r.path === '/api/state' && new URLSearchParams(r.search).get('funding') === '1'),
      'positions explicitly opts into the server funding projection');

    const btcToggle = btc.locator('.group-identity');
    await btcToggle.focus(); await page.keyboard.press('Enter');
    await btc.locator('.position-metrics-details').waitFor();
    assert(await btcToggle.getAttribute('aria-expanded') === 'true', 'Enter expands the position');
    assert(await btc.locator('.position-leg').count() === 2, 'both original position legs remain available');
    const details = await btc.locator('.position-metrics-details').innerText();
    assert(details.includes('价差') && details.includes('资金费'), 'spread and funding details are visible');
    assert(/8\s*(h|H|小时)/.test(details), 'funding details disclose the common eight-hour period');
    assert(/0\.07(?:0*)\s*%|7(?:\.0+)?\s*bps?/.test(details), 'equal raw rates with different intervals display +7 bp per 8h');
    const spreadHeading = btc.getByRole('heading', { name: '价差收益', exact: true });
    const fundingHeading = btc.getByRole('heading', { name: '资金费收益', exact: true });
    const spreadBounds = await spreadHeading.boundingBox(), fundingBounds = await fundingHeading.boundingBox();
    assert(spreadBounds && fundingBounds && spreadBounds.x < fundingBounds.x && Math.abs(spreadBounds.y - fundingBounds.y) < 10,
      'desktop spread and funding panels appear side by side');
    const advanced = btc.locator('details').filter({ has: module.locator('summary').filter({ hasText: '高级分析与计算口径' }) });
    assert(await advanced.count() === 1 && await advanced.getAttribute('open') === null, 'advanced analysis is optional and initially collapsed');
    await advanced.locator('summary').click();
    assert(await advanced.getAttribute('open') !== null, 'advanced analysis opens independently');
    assert((await advanced.innerText()).includes('ROI'), 'advanced analysis discloses ROI');
    await advanced.locator('summary').click();
    await btc.locator('.position-trend-empty').waitFor();
    assert((await btc.locator('.position-trend-empty').innerText()).includes('仅记录本次页面会话'), 'one sample does not manufacture a historical trend');
    await btcToggle.focus(); await page.keyboard.press('Space');
    assert(await btcToggle.getAttribute('aria-expanded') === 'false', 'Space collapses the position');
    assert(await btc.locator('.position-metrics-details').count() === 0, 'keyboard collapse removes details');

    await btc.getByRole('button', { name: '平仓组合', exact: true }).click();
    await module.getByRole('dialog').waitFor();
    assert(await btcToggle.getAttribute('aria-expanded') === 'false', 'close action does not toggle the group');
    await module.getByRole('button', { name: '关闭平仓选择', exact: true }).click();
    assert(await module.getByRole('dialog').count() === 0, 'close selector dismisses without an API write');

    const search = module.getByRole('textbox', { name: '搜索持仓币种或交易所', exact: true });
    await search.fill('eth');
    assert(await module.locator('.position-group').count() === 1 && await eth.count() === 1, 'coin filter retains only matching metrics');
    await search.fill('okx');
    assert(await module.locator('.position-group').count() === 1 && await sol.count() === 1, 'exchange filter retains the matching position');
    await search.fill('does-not-exist');
    await module.getByRole('heading', { name: '没有匹配的持仓', exact: true }).waitFor();
    await search.fill('');
    assert(await module.locator('.position-group').count() === 3, 'clearing search restores all position groups');

    const refresh = async () => {
      const response = page.waitForResponse(r => r.url().startsWith(`${moduleOrigin}/api/state`));
      await module.getByRole('button', { name: '刷新页面状态', exact: true }).click();
      await (await response).finished();
    };
    missingFunding = true; await refresh();
    await btc.locator('.position-metrics-summary').getByText('待补全', { exact: true }).waitFor();
    assert(!(await btc.locator('.position-metrics-summary').innerText()).includes('未触发'), 'missing funding cannot retain a no-trigger conclusion');
    missingFunding = false; partial = true; await refresh();
    await module.getByText('持仓数据不完整', { exact: false }).first().waitFor();
    await module.locator('.account-identity').getByText('数据不完整', { exact: true }).waitFor();
    assert(!(await btc.locator('.position-metrics-summary').innerText()).includes('未触发'), 'partial account evidence cannot retain a no-trigger conclusion');
    partial = false; await refresh();
    await btc.locator('.position-health').filter({ hasText: '未触发' }).waitFor();

    // No new successful response may be needed to expire a funding deadline.
    fundingTtl = 1000; await refresh(); holdState = true;
    await page.clock.runFor(2100);
    await btc.locator('.position-health').filter({ hasText: '待补全' }).waitFor();
    assert((await btc.locator('.position-metrics-summary').innerText()).includes('持仓资金费缺少完全匹配的新鲜双腿数据'), 'funding-only expiry explains the incomplete evidence');
    assert(!(await btc.locator('.position-metrics-summary').innerText()).includes('未触发'), 'the page clock independently expires funding evidence');
    release(); fundingTtl = 10_000; await refresh();
    await btc.locator('.position-health').filter({ hasText: '未触发' }).waitFor();

    await btcToggle.click();
    // Each new source snapshot is one minute later. Repeated poll responses
    // and the one-second UI clock retain these real observations unchanged.
    const trend = btc.locator('.position-trend');
    for (let minute = 1; minute <= 2; minute++) {
      now = base + minute * 60_000; accountAt = now; fundingAt = now;
      btcShortMark = minute === 1 ? '107.8' : '107.6';
      await page.clock.runFor(60_000); await refresh();
      await btc.getByRole('figure', { name: `本会话价差趋势，${minute + 1}个采样点，覆盖${minute}分钟`, exact: true }).waitFor();
    }
    await trend.locator('path.recharts-line-curve').waitFor();
    assert((await trend.innerText()).includes('本会话覆盖 2 分钟'), 'the chart reports only the observed session coverage');
    const plottedPath = await trend.locator('path.recharts-line-curve').getAttribute('d');
    assert(plottedPath && plottedPath.includes('L'), 'multiple real samples render a line');
    const samplingLabel = await trend.getAttribute('aria-label');
    const countdown = btc.locator('.position-metric-values > div').filter({ has: module.getByText('下次结算倒计时', { exact: true }) }).locator('dd');
    const countdownBefore = await countdown.innerText();
    holdState = true; await page.clock.runFor(2100);
    assert(await countdown.innerText() !== countdownBefore, 'the one-second settlement countdown advances without a new response');
    assert(await trend.getAttribute('aria-label') === samplingLabel, 'countdown ticks do not add trend samples or extend coverage');
    assert(await trend.locator('path.recharts-line-curve').getAttribute('d') === plottedPath, 'countdown ticks leave the observed line unchanged');
    release(); await refresh();
    await page.screenshot({ path: 'output/playwright/crossex-position-metrics-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile Hub has no page overflow');
    assert(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile module has no page overflow');
    assert(await btc.locator('.position-metrics-details').isVisible(), 'expanded analysis remains visible on mobile');
    const mobileSpread = await spreadHeading.boundingBox(), mobileFunding = await fundingHeading.boundingBox();
    assert(mobileSpread && mobileFunding && mobileFunding.y > mobileSpread.y && Math.abs(mobileFunding.x - mobileSpread.x) < 2, 'mobile detail columns stack vertically');
    await btc.locator('.position-metrics-summary').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/crossex-position-metrics-mobile.png', fullPage: true });

    // Keep successful GETs flowing with an aging source snapshot; the UI's
    // independent clock must revoke health even without a failed request.
    now += 16_000;
    await page.clock.runFor(16_000);
    await btc.locator('.position-metrics-summary').getByText('数据待更新', { exact: true }).waitFor();
    await module.locator('.account-identity').getByText('数据已过期', { exact: true }).waitFor();
    assert(await module.locator('.account-identity').getByText('已同步', { exact: true }).count() === 0, 'cached live status cannot contradict local account expiry');
    assert(await btc.getByRole('button', { name: '平仓组合', exact: true }).isDisabled(), 'aged account data still disables closing');
    assert(!(await btc.locator('.position-metrics-summary').innerText()).includes('未触发'), 'expired evidence removes the rule conclusion');
    await page.setViewportSize({ width: 1440, height: 1050 });
    accountAt = now; fundingAt = now; await refresh();
    await btc.locator('.position-health').filter({ hasText: '未触发' }).waitFor();
    await module.locator('.account-identity').getByText('已同步', { exact: true }).waitFor();

    const mutations = requests.filter(r => r.method !== 'GET');
    assert(mutations.length === 1 && mutations[0].origin === origin && mutations[0].path === '/api/projects/crossex/launch', 'only the synthetic Hub launch POST is sent');
    assert(unexpected.length === 0, `no unexpected APIs: ${unexpected.join('; ')}`);
    assert(blocked.length === 0, `no external network attempts: ${blocked.join('; ')}`);
    assert(errors.length === 0, `no uncaught browser errors: ${errors.join('; ')}`);
    return { passed: true, requests: requests.length, tradingWrites: 0,
      scenarios: ['Hub entry and embedded bridge', 'summary health', 'keyboard expand/collapse', 'eight-hour funding normalization',
        'close dialog isolation', 'coin and exchange filters', 'missing and partial evidence', 'real session trend samples',
        'countdown without synthetic samples', 'mobile layout', 'live age expiry and recovery', 'no trading writes'] };
  } finally {
    release();
    await page.clock.resume();
  }
}
