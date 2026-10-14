// Build the Hub and CrossEx, then serve scripts/preview-position-metrics.mjs.
// Run with playwright-cli run-code --filename tests/crossex-position-actions.browser.mjs.
// All account/trading APIs below are isolated browser fixtures, never live orders.
async (page) => {
  const origin = 'http://hub.localhost:4175';
  const moduleOrigin = 'http://p-000000000000000000000000.hub.localhost:4175';
  const allowed = new Set([origin, moduleOrigin]);
  if (page.url() !== 'about:blank' && !allowed.has(new URL(page.url()).origin)) throw new Error('Isolated localhost:4175 required');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const now = Date.UTC(2026, 9, 14, 12), errors = [], unexpected = [], requests = [], previews = [], confirmations = [];
  let paused = false, partial = false, stale = false, holdPreview = false, releasePreview = null, previewFailure = '', executions = [];
  const symbol = exchange => `${exchange.toUpperCase()}_FUTURE_BTC_USDT`;
  const held = [
    { id: 'btc-long', symbol: symbol('binance'), exchange: 'binance', side: 'LONG', quantity: '1', baseQuantity: '1', markPrice: '100', entryPrice: '100' },
    { id: 'btc-short', symbol: symbol('bybit'), exchange: 'bybit', side: 'SHORT', quantity: '1', baseQuantity: '1', markPrice: '104', entryPrice: '103' },
  ];
  const positions = () => held.map(p => ({ ...p, baseCurrency: 'BTC', quoteCurrency: 'USDT', pnlCurrency: 'USDT', marginCurrency: 'USDT',
    unrealizedPnl: '1', fundingFee: '0.1', realizedPnl: '0', fee: '0.01', margin: '20', maintenanceMargin: '1',
    leverage: '7', liquidationPrice: null, external: true, updatedAt: now, openedAt: now - 86400000, directionSource: 'exchange' }));
  const config = () => ({ entryPaused: paused, monitorUrl: 'module://monitor', monitorUsername: '', hasMonitorPassword: false,
    notionalPerLeg: 500, maxOpen: 10, maxTotalNotional: 10000, feeBps: 5, feeSchedule: [], slippageBps: 5, minNetBps: 1, cooldownSeconds: 0 });
  const connection = { configured: true, connected: true, status: 'connected', accountId: 'fixture', keySuffix: 'TEST', version: 'position-actions-1',
    positionMode: 'DUAL', permissions: { read: 'allowed', trade: 'allowed' }, lastVerifiedAt: now, error: null };
  const project = { id: 'crossex', name: 'Gate CrossEx', description: '隔离持仓操作验收', category: 'trading', adapter: 'standard',
    url: 'module://crossex/', apiUrl: 'module://crossex', accessMode: 'proxy', mode: 'embed', enabled: true, embedded: true,
    staleAfterSeconds: 120, order: 0, hasCredentials: true, revision: 'position-actions-fixture' };
  const overview = { generatedAt: new Date(now).toISOString(), projects: [{ project, state: 'online', freshness: 'static', message: '',
    checkedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), latencyMs: 1, metrics: [] }] };
  const updates = { enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null };
  const state = () => ({ now, csrfToken: 'position-actions-fixture', mode: 'live', config: config(), venues: [], fx: [], opportunities: [], fundingOpportunities: [], positionFundingRates: [],
    source: { state: 'live', error: null, updatedAt: now, generatedAt: now, checkedAt: now, quoteCount: 2 }, catalog: { state: 'ready', count: 2, updatedAt: now, error: null },
    live: { connection, status: 'live', freshnessState: 'fresh', stale, partial, asOf: now, tradingAllowed: !partial && !stale, reasons: [],
      account: { account_mode: 'CROSS_EXCHANGE', available_margin: '30', margin_balance: '10000', initial_margin: '40', maintenance_margin: '2' },
      balances: [], positions: positions(), orders: [], executions, alerts: [], recentTrades: [], accountBook: [], fees: [], adlAsOf: now, adlError: null } });
  const instruments = positions().map((p, i) => ({ symbol: p.symbol, exchange: p.exchange, base: 'BTC', quoteCurrency: 'USDT', settlementCurrency: 'USDT',
    lot_size: i ? '0.005' : '0.002', tick_size: '0.01', min_size: i ? '0.005' : '0.002', min_notional: '0.1', max_limit_size: '100', max_market_size: '100', contract_size: '0.001', state: 'live' }));
  const previewResult = input => {
    assert(input.kind === 'position', 'position actions use the dedicated endpoint contract');
    assert(input.connectionVersion === connection.version, 'preview carries the connection version');
    assert(input.positions.length === 2 && input.positions.every(s => held.some(p => p.id === s.positionId && p.baseQuantity === s.expectedQuantity && p.side === s.expectedSide)), 'preview binds both displayed quantities and directions');
    const quantities = held.map(p => Number(p.baseQuantity));
    const target = input.action === 'add' ? null : input.strategy === 'reduce' ? Math.min(...quantities) : input.strategy === 'increase' ? Math.max(...quantities) : Number(input.targetQuantity);
    const legs = held.flatMap((p, i) => {
      const delta = input.action === 'add' ? Number(input.quantity) : target - quantities[i];
      if (Math.abs(delta) < 1e-9) return [];
      const reduceOnly = delta < 0;
      return [{ exchange: p.exchange, symbol: p.symbol, positionId: p.id, side: (p.side === 'LONG') !== reduceOnly ? 'BUY' : 'SELL',
        positionSide: p.side, quantity: String(Number(Math.abs(delta).toFixed(8))), price: p.markPrice, referencePrice: p.markPrice, orderType: 'LIMIT', timeInForce: 'IOC',
        reduceOnly, heldQuantity: p.baseQuantity, targetQuantity: String(Number((quantities[i] + delta).toFixed(8))), baseCurrency: 'BTC', quoteCurrency: 'USDT',
        notionalUSDT: String(Math.abs(delta) * Number(p.markPrice)), singleLegBudgetUSDT: '500', budgetPrice: p.markPrice, budgetFxRate: '1' }];
    }).sort((a, b) => Number(b.reduceOnly) - Number(a.reduceOnly));
    return { id: `preview-${previews.length}`, kind: 'position', action: input.action, strategy: input.strategy, targetQuantity: target === null ? undefined : String(target),
      createdAt: now, expiresAt: now + 30000, connectionVersion: connection.version, accountUid: 'fixture', warnings: [], canConfirm: true, legs,
      feeEstimate: { asOf: now, error: null, legs: legs.map(l => ({ symbol: l.symbol, makerRate: '0.0002', takerRate: '0.0005', assumedRate: '0.0005', estimatedFee: '0.01', currency: 'USDT', source: 'fixture' })) } };
  };
  const plans = new Map();
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ overview, updates }) => {
    window.EventSource = class { constructor(url) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(String(url).includes('/api/overview/events') ? overview : { type: 'snapshot', state: updates }) })); } close() {} };
    window.WebSocket = class { constructor() { throw new Error('WebSocket forbidden in isolated fixture'); } };
  }, { overview, updates });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!allowed.has(url.origin)) { unexpected.push(url.href); return route.abort('blockedbyclient'); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    requests.push({ path: url.pathname, method: request.method() });
    const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.origin === origin) {
      if (url.pathname === '/api/projects/crossex/launch' && request.method() === 'POST') return send({ url: `${moduleOrigin}/#positions` });
      if (url.pathname === '/api/projects/crossex/check' && request.method() === 'POST') return send({ snapshot: overview.projects[0] });
      if (request.method() === 'GET') {
        if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'hub-fixture' });
        if (url.pathname === '/api/overview') return send(overview);
        if (url.pathname === '/api/system/updates') return send(updates);
        if (url.pathname === '/api/health') return send({ status: 'ok' });
      }
    } else {
      if (request.method() === 'GET') {
        if (url.pathname === '/api/bootstrap') return send({ now, config: config(), connection, csrfToken: 'position-actions-fixture' });
        if (url.pathname === '/api/live/instruments') return send({ items: instruments });
        if (url.pathname === '/api/state') return send(state());
      }
      if (url.pathname === '/api/live/preview' && request.method() === 'POST') {
        const input = request.postDataJSON(); previews.push(input);
        if (previewFailure) { const error = previewFailure; previewFailure = ''; return send({ error }, 409); }
        const result = previewResult(input); plans.set(result.id, result);
        if (holdPreview) await new Promise(resolve => { releasePreview = resolve; });
        return send(result);
      }
      if (url.pathname === '/api/live/confirm' && request.method() === 'POST') {
        const input = request.postDataJSON(); confirmations.push(input);
        assert(typeof input.requestId === 'string' && input.requestId.length > 0, 'confirmation includes a durable request ID');
        const plan = plans.get(input.previewId); assert(plan, 'confirmation references the displayed preview');
        for (const leg of plan.legs) { const p = held.find(p => p.id === leg.positionId); p.quantity = p.baseQuantity = leg.targetQuantity; }
        const result = { id: `execution-${confirmations.length}`, requestId: input.requestId, kind: 'position', action: plan.action, state: 'completed', createdAt: now,
          legs: plan.legs.map(l => ({ ...l, state: 'FILLED', status: 'FILLED', filledQuantity: l.quantity, orderId: `fixture-${l.positionId}` })) };
        executions = [result]; return send(result);
      }
    }
    unexpected.push(`${request.method()} ${url.href}`); return send({ error: 'Unexpected fixture request' }, 400);
  });
  await page.clock.install({ time: new Date(now) });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/?view=project&id=crossex`);
    const iframe = page.locator('iframe[title="Gate CrossEx模块"]'); await iframe.waitFor();
    await page.frameLocator('iframe[title="Gate CrossEx模块"]').getByRole('heading', { name: '投资组合', exact: true }).waitFor();
    const module = page.frames().find(f => f.url().startsWith(moduleOrigin)); assert(module, 'real Hub embedded entry loads CrossEx');
    const group = module.locator('.position-group').filter({ has: module.locator('.group-identity').filter({ hasText: 'BTC' }) });
    const addButton = group.getByRole('button', { name: 'BTC 加仓', exact: true });
    const balanceButton = group.getByRole('button', { name: 'BTC 平衡双腿', exact: true });
    const refresh = async () => {
      const response = page.waitForResponse(r => r.url().startsWith(`${moduleOrigin}/api/state`));
      await module.getByRole('button', { name: '刷新页面状态', exact: true }).click(); await (await response).finished();
    };
    const toPositions = async () => { await module.getByRole('button', { name: '投资组合', exact: true }).click(); await addButton.waitFor(); };
    const setQuantities = async (long, short) => { held[0].quantity = held[0].baseQuantity = long; held[1].quantity = held[1].baseQuantity = short; await refresh(); };
    const dialog = name => module.getByRole('dialog', { name, exact: true });
    assert(await addButton.isEnabled(), 'equal pair can be increased');
    assert(await balanceButton.isDisabled(), 'equal pair does not need balancing');
    await addButton.click();
    let picker = dialog('BTC · 加仓持仓组合'); await picker.waitFor({ timeout: 10000 });
    assert((await picker.innerText()).includes('当前价差较开仓价差偏离 33.3333%'), 'recurring spread deviation renders the warning without unmounting the module');
    assert((await picker.innerText()).includes('按 10% 保证金预留估算，可用保证金不足'), 'recurring margin estimates retain the insufficient-margin warning');
    await page.clock.runFor(200);
    await page.screenshot({ path: 'output/playwright/crossex-position-actions-crash-fixed.png', fullPage: true });
    await picker.getByRole('button', { name: '25%', exact: true }).click();
    assert((await picker.innerText()).includes('0.25'), 'percentage selects a common-step quantity');
    await picker.getByRole('textbox', { name: '自定义加仓数量', exact: true }).fill('0.003');
    assert(await picker.getByRole('button', { name: '预览加仓', exact: true }).isDisabled(), 'custom quantity must fit both unequal lot sizes');
    await picker.getByRole('textbox', { name: '自定义加仓数量', exact: true }).fill('0.2');
    assert(await picker.locator('.percentage-controls button[aria-pressed="true"]').count() === 0, 'custom input clears the percentage selection');
    await page.clock.runFor(200);
    await page.screenshot({ path: 'output/playwright/crossex-position-actions-add.png', fullPage: true });
    holdPreview = true;
    const previewRequest = page.waitForRequest(r => r.url().endsWith('/api/live/preview'));
    await picker.getByRole('button', { name: '预览加仓', exact: true }).click();
    await previewRequest;
    assert(previews.length === 1, 'one preview is sent');
    assert(await picker.getByRole('button', { name: /正在预览|预览加仓/ }).isDisabled(), 'preview submission locks the dialog');
    holdPreview = false; releasePreview?.(); releasePreview = null;
    await module.getByRole('heading', { name: /核对.*加仓/ }).waitFor();
    assert(previews[0].quantity === '0.2' && previews[0].action === 'add', 'add request carries the exact increment');
    const review = module.getByRole('dialog');
    assert((await review.innerText()).includes('IOC'), 'review discloses the protected immediate-or-cancel orders');
    await review.getByRole('checkbox').check(); await review.getByRole('button', { name: '确认实盘下单', exact: true }).click();
    await module.getByRole('heading', { name: '订单与操作记录', exact: true }).waitFor();
    assert(confirmations.length === 1 && held.every(p => p.baseQuantity === '1.2'), 'one confirmation updates both held quantities');
    await toPositions();
    await setQuantities('1.2', '1');
    assert(await addButton.isDisabled() && await balanceButton.isEnabled(), 'unequal pair exposes balancing and blocks add');
    await balanceButton.click(); picker = dialog('BTC · 平衡双腿数量'); await picker.waitFor();
    await picker.getByRole('radio', { name: /减少较大腿/ }).check();
    await picker.getByRole('button', { name: '预览平衡操作', exact: true }).click();
    await module.getByRole('heading', { name: /核对.*平衡/ }).waitFor();
    assert(previews.at(-1).strategy === 'reduce', 'reduce strategy uses one balance preview');
    assert(plans.get(`preview-${previews.length}`).legs.length === 1 && plans.get(`preview-${previews.length}`).legs[0].reduceOnly, 'reduce plan contains only the larger leg');
    await module.getByRole('button', { name: '关闭订单核对', exact: true }).click();
    await balanceButton.click(); picker = dialog('BTC · 平衡双腿数量');
    await picker.getByRole('radio', { name: /增加较小腿/ }).check();
    await picker.getByRole('button', { name: '预览平衡操作', exact: true }).click();
    await module.getByRole('heading', { name: /核对.*平衡/ }).waitFor();
    assert(previews.at(-1).strategy === 'increase', 'increase strategy is preserved');
    const increasePlan = plans.get(`preview-${previews.length}`);
    assert(increasePlan.legs.length === 1 && increasePlan.legs[0].positionSide === 'SHORT' && !increasePlan.legs[0].reduceOnly, 'increase changes only the smaller short leg');
    await module.getByRole('button', { name: '关闭订单核对', exact: true }).click();
    await balanceButton.click(); picker = dialog('BTC · 平衡双腿数量');
    await picker.getByRole('radio', { name: /指定目标数量/ }).check();
    await picker.getByRole('textbox', { name: '平衡目标数量', exact: true }).fill('1.1');
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await module.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile module has no overflow');
    assert(await picker.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mobile balance dialog has no horizontal overflow');
    await page.screenshot({ path: 'output/playwright/crossex-position-actions-balance-mobile.png', fullPage: true });
    await picker.locator('.position-strategies').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/crossex-position-actions-strategies-mobile.png', fullPage: true });
    await picker.getByRole('button', { name: '预览平衡操作', exact: true }).click();
    await module.getByRole('heading', { name: /核对.*平衡/ }).waitFor();
    const mixed = plans.get(`preview-${previews.length}`);
    assert(previews.at(-1).targetQuantity === '1.1' && mixed.legs.length === 2 && mixed.legs[0].reduceOnly && !mixed.legs[1].reduceOnly, 'one target preview shows reduction before increase');
    await module.getByRole('dialog').getByRole('checkbox').check();
    await module.getByRole('button', { name: '确认实盘下单', exact: true }).click();
    await module.getByRole('heading', { name: '订单与操作记录', exact: true }).waitFor();
    assert(held.every(p => p.baseQuantity === '1.1') && confirmations.length === 2, 'mixed target refreshes actual resulting quantities');
    await page.setViewportSize({ width: 1440, height: 1000 }); await toPositions();
    paused = true; await setQuantities('1.2', '1'); await balanceButton.click(); picker = dialog('BTC · 平衡双腿数量');
    assert(await picker.getByRole('radio', { name: /增加较小腿/ }).isDisabled(), 'entry pause disables the increasing strategy');
    await picker.getByRole('radio', { name: /减少较大腿/ }).check();
    assert(await picker.getByRole('button', { name: '预览平衡操作', exact: true }).isEnabled(), 'entry pause still permits reduction');
    previewFailure = '测试：盘口深度不足，请减少调整数量';
    await picker.getByRole('button', { name: '预览平衡操作', exact: true }).click();
    await picker.getByText('测试：盘口深度不足，请减少调整数量', { exact: true }).waitFor();
    assert(await picker.isVisible(), 'failed preview preserves the form and displays the server reason inside it');
    await page.keyboard.press('Escape');
    paused = false; await setQuantities('1', '1'); await addButton.click(); picker = dialog('BTC · 加仓持仓组合');
    await picker.getByRole('button', { name: '25%', exact: true }).click();
    await picker.getByRole('button', { name: '预览加仓', exact: true }).click();
    await module.getByRole('heading', { name: /核对.*加仓/ }).waitFor();
    held[0].quantity = held[0].baseQuantity = '1.2'; await page.clock.runFor(2500);
    await module.getByRole('dialog').getByText('持仓数量、方向或账户已变化，请关闭并重新预览。', { exact: true }).waitFor();
    await module.getByRole('dialog').getByRole('checkbox').check();
    assert(await module.getByRole('button', { name: '确认实盘下单', exact: true }).isDisabled(), 'held changes also invalidate the final confirmation');
    await module.getByRole('button', { name: '关闭订单核对', exact: true }).click();
    paused = false; await setQuantities('1', '1'); await addButton.click(); picker = dialog('BTC · 加仓持仓组合');
    // A read-only background refresh changes the held snapshot while the form stays open.
    held[0].quantity = held[0].baseQuantity = '1.2';
    await page.clock.runFor(6500);
    await picker.getByText(/持仓.*变化|仓位.*变化/).first().waitFor();
    assert(await picker.getByRole('button', { name: '预览加仓', exact: true }).isDisabled(), 'changed snapshot requires reopening the dialog');
    await page.keyboard.press('Escape');
    partial = true; await refresh(); assert(await addButton.isDisabled() && await balanceButton.isDisabled(), 'partial account disables both position actions');
    partial = false; stale = true; await refresh(); assert(await balanceButton.isDisabled(), 'stale account disables balancing');
    stale = false; await setQuantities('1', '1');
    await group.getByRole('button', { name: '平仓组合', exact: true }).click();
    await dialog('BTC · 选择平仓持仓腿').waitFor();
    connection.version = 'position-actions-2';
    await page.clock.runFor(2500);
    assert(await dialog('BTC · 选择平仓持仓腿').count() === 0, 'connection change discards the old account close selection');
    assert(unexpected.length === 0, `unexpected requests: ${unexpected.join('; ')}`);
    assert(errors.length === 0, `uncaught browser errors: ${errors.join('; ')}`);
    return { passed: true, previews: previews.length, confirmations: confirmations.length, liveOrders: 0,
      scenarios: ['real Hub entry', 'recurring spread and margin warnings', 'common lot-size validation', 'add percentage and exact request', 'preview lock', 'confirm and refresh',
        'reduce', 'increase', 'custom mixed target', 'mobile dialog', 'entry pause', 'server error in modal', 'review invalidation', 'snapshot changes', 'partial/stale account', 'close selection account scope'] };
  } finally { releasePreview?.(); await page.clock.resume(); }
}
