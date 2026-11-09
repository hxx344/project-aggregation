// Production preview on 4193. Every API and outside origin is intercepted.
async (page) => {
  const origin = 'http://127.0.0.1:4193', watchPath = '/api/trading/anthropic', reductionPath = '/api/trading/execution/anthropic-reduction';
  if (page.url() !== 'about:blank' && new URL(page.url()).origin !== origin) throw new Error('Coverage fixture requires isolated localhost:4193');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const iso = value => new Date(value).toISOString(), initial = Date.parse('2026-11-09T08:30:00Z');
  let current = initial, failed = false, holdRead = null, revision = 1;
  const writes = [], errors = [], address = '0x' + 'a'.repeat(40);
  const updates = { enabled: false, checking: false, available: false, supported: false, modules: [], job: null, error: null };
  let alertConfig = { enabled: true, thresholdPercent: 20, repeatMinutes: 30 };
  let reductionConfig = { enabled: true, legs: [{ exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'long' }, { exchange: 'rh-lighter', symbol: 'ANTHROPIC', side: 'short' }],
    shares: { outstanding: '12.7', diluted: '16.7' }, thresholdPercent: '5', reducePercent: '25', batchCount: 3, batchIntervalMs: 5000, timeoutMs: 600000 };
  const status = (state, reason, ready = false) => ({ state, reason, checkedAt: iso(current - 1000), validUntil: ready ? iso(current + 5000) : null });
  const position = (exchange, symbol, side, extra = {}) => ({ id: `${exchange}:${symbol}:${side}`, exchange, symbol, side, quantity: '10', quantityUnit: null,
    entryPrice: '100', markPrice: '101', notional: '1010', unrealizedPnl: '10', leverage: '3', marginMode: 'cross', liquidationPrice: '50', distancePercent: '50.50', alerting: false, ...extra });
  const watch = () => {
    const alert = alertConfig.enabled ? status('ready', '强平距离达到阈值时提醒', true) : status('disabled', '强平预警未启用');
    const reduction = reductionConfig.enabled ? status('ready', '最近核验通过；触发和发送前仍会重新检查', true) : status('disabled', '规则未启用；仅保留配置');
    const sources = [
      { exchange: 'binance', positions: [position('binance', 'ANTHROPICUSDT', 'long', { protection: { alert, reduction: status('unknown', '配置包含该合约，但只读来源尚无账户 UID 证明') } })] },
      { exchange: 'okx', positions: [position('okx', 'ANTHROPICUSDT', 'long', { liquidationPrice: null, quantityUnit: '张', contractSize: '1', protection: { alert: status('blocked', '缺少有效强平价'), reduction: status('blocked', '批次过多，至少一批数量小于合约步长') } })] },
      { exchange: 'hyperliquid', address, positions: [position('hyperliquid', 'io:ANTH', 'long', { markPrice: null, riskUnknown: true, protection: { alert: status('blocked', '缺少有效标记价'), reduction: status('unconfigured', '没有包含该合约与方向的减仓规则') } })] },
      { exchange: 'rh-lighter', address, positions: [11, 12].map(account => position('rh-lighter', 'ANTHROPIC', 'short', { id: `rh-lighter:ANTHROPIC:${account}:short`, account, protection: { alert, reduction: account === 11 ? reduction : status('unmatched', '该钱包下的另一子账户未被此规则覆盖') } })) },
    ].map(source => ({ connected: true, state: 'live', fetchedAt: iso(current - 1000), error: null, refreshing: false, ...source }));
    return { generatedAt: iso(current), sources, alerts: { config: alertConfig, channel: { configured: true, source: 'digest', host: null, error: null }, history: [], error: null, staleAfterSeconds: 180, hysteresisPercent: 2 } };
  };
  const connections = ['binance', 'rh-lighter'].map(exchange => ({ exchange, connected: true, revision: 1, accountMode: exchange === 'binance' ? 'standard' : 'api-key', identity: exchange === 'binance' ? '42' : address, keyLabel: exchange === 'binance' ? 'test' : '11#4', verifiedAt: iso(current), locked: false }));
  const reduction = () => ({ generatedAt: iso(current), revision, config: reductionConfig, state: { phase: reductionConfig.enabled ? 'armed' : 'disabled', jobId: null, reason: null, events: [], triggeredAt: null }, live: null, job: null, connections, maintenance: false });
  const trading = { mode: 'read-only', strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: iso(initial), cache: { builtAt: iso(initial), servedAt: iso(initial), rebuilding: false }, period: { days: 7, start: iso(initial - 86400000), end: iso(initial) }, exchanges: [], accounts: [], legs: [], structure: { state: 'unknown', message: '' },
    pnl: { currency: 'USDT', intervalMs: 60000, cumulativeStart: initial, end: initial, recordingStartedAt: initial, pointCount: 0, points: [], latest: null, status: 'ready' }, funding: { complete: false, income: null, expense: null, net: null, currency: 'USDT', events: [], pagination: { page: 0, pageSize: 50, total: 0, pages: 1 }, daily: [] } };
  const handler = async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const send = (json, code = 200) => route.fulfill({ status: code, json });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'coverage-fixture' });
    if (url.pathname === '/api/health') return send({ ok: true });
    if (url.pathname === '/api/system/host') return send({ generatedAt: iso(current), cpu: { usagePercent: 10, cores: 4, loadAverage: [0.1, 0.1, 0.1] }, memory: { usedPercent: 25, usedBytes: 1024, totalBytes: 4096, availableBytes: 3072 }, disks: [], uptimeSeconds: 120 });
    if (url.pathname === '/api/system/updates') return send(updates);
    if (url.pathname === '/api/system/updates/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(updates)}\n\n` });
    if (url.pathname === '/api/overview/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: iso(current) })}\n\n` });
    if (url.pathname === '/api/projects' || url.pathname === '/api/overview') return send({ projects: [], generatedAt: iso(current) });
    if (url.pathname === '/api/trading') return send(trading);
    if (url.pathname === '/api/trading/execution') return send({ generatedAt: iso(current), connections, positions: [], jobs: [] });
    if (url.pathname === '/api/trading/execution/quotes') return send({ generatedAt: iso(current), maxAgeMs: 10000, books: [] });
    if (url.pathname === '/api/trading/execution/auto') return send({ generatedAt: iso(current), rules: [], maintenance: false });
    if (url.pathname === watchPath && method === 'GET') {
      if (holdRead) { const held = holdRead; holdRead = null; held({ route, data: watch() }); return; }
      return failed ? send({ error: '覆盖快照读取失败' }, 503) : send(watch());
    }
    if (url.pathname === watchPath + '/alerts' && method === 'PUT') { writes.push(url.pathname); alertConfig = request.postDataJSON().config; return send(watch()); }
    if (url.pathname === reductionPath && method === 'GET') return send(reduction());
    if (url.pathname === reductionPath + '/disable' && method === 'POST') { writes.push(url.pathname); reductionConfig = { ...reductionConfig, enabled: false }; revision++; return send(reduction()); }
    return send({ error: `Unexpected fixture API ${method} ${url.pathname}` }, 404);
  };
  const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const refresh = async () => {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === watchPath && r.request().method() === 'GET');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await (await response).finished(); await flush();
  };
  const onError = error => errors.push(error.message); page.on('pageerror', onError);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.install({ time: new Date(initial) });
  await page.route('**/*', handler);
  try {
    await page.goto(origin + '/?view=trading&tradingSection=legs');
    const section = page.getByRole('region', { name: 'Anthropic 套利仓位' });
    const target = section.locator('[data-position-id="rh-lighter:ANTHROPIC:11:short"]');
    const protectedCell = target.locator('[data-protection-kind="reduction"]');
    await protectedCell.getByText('最近核验通过', { exact: true }).waitFor();
    assert(await section.locator('[data-position-id="rh-lighter:ANTHROPIC:12:short"]').getByText('未覆盖', { exact: true }).count() === 1, 'other subaccount stays uncovered');
    assert(await section.getByText('缺少有效标记价', { exact: true }).count() === 1, 'missing mark is explicit');
    assert(await section.getByText('缺少有效强平价', { exact: true }).count() === 1, 'missing liquidation price is explicit');
    assert(await section.getByText('批次过多，至少一批数量小于合约步长', { exact: true }).count() === 1, 'enabled but infeasible rule is blocked');
    assert(writes.length === 0, 'opening and reading do not mutate');
    await section.screenshot({ path: 'output/playwright/ant-protection-desktop.png' });

    await page.clock.fastForward(6000); await flush();
    assert(await protectedCell.getAttribute('data-protection-state') === 'stale', 'local clock expires green evidence before next request');
    current += 6000; await refresh();
    assert(await protectedCell.getAttribute('data-protection-state') === 'ready', 'fresh evidence restores readiness');
    const previousTime = await protectedCell.locator('small').innerText();
    failed = true; await refresh();
    assert(await protectedCell.getAttribute('data-protection-state') === 'unknown', 'failed read immediately revokes readiness');
    assert(await protectedCell.locator('small').innerText() === previousTime, 'failure retains last evidence time');
    failed = false; await refresh();
    await page.context().setOffline(true); await flush();
    assert(await protectedCell.getAttribute('data-protection-state') === 'unknown', 'offline never remains green');
    // Another client disables the rule while this page is offline. Hold the
    // first reconnect read: old unexpired evidence must not turn green again.
    reductionConfig = { ...reductionConfig, enabled: false }; revision++;
    let resolveReconnect; const reconnectRead = new Promise(resolve => { resolveReconnect = resolve; }); holdRead = resolveReconnect;
    await page.context().setOffline(false);
    const reconnect = await reconnectRead; await flush();
    assert(await protectedCell.getAttribute('data-protection-state') === 'unknown', 'reconnect stays unknown until its new snapshot arrives');
    await reconnect.route.fulfill({ status: 200, json: reconnect.data });
    await protectedCell.getByText('未启用', { exact: true }).waitFor();
    reductionConfig = { ...reductionConfig, enabled: true }; revision++; await refresh();

    let resolveHeld; const heldRead = new Promise(resolve => { resolveHeld = resolve; }); holdRead = resolveHeld;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const held = await heldRead;
    await section.getByLabel('启用预警', { exact: true }).uncheck();
    await section.getByRole('button', { name: '保存', exact: true }).click();
    await section.getByText('预警设置已保存。', { exact: true }).waitFor();
    await held.route.fulfill({ status: 200, json: held.data }).catch(() => {}); await flush();
    assert(await target.locator('[data-protection-kind="alert"]').getAttribute('data-protection-state') === 'disabled', 'a pre-save GET cannot restore old alert coverage');

    const rule = page.getByRole('region', { name: 'ANT 自动多批减仓' });
    await rule.getByRole('button', { name: '停用新触发', exact: true }).click();
    await protectedCell.getByText('未启用', { exact: true }).waitFor();
    assert(writes.length === 2, 'only the two explicitly clicked changes wrote anything');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile has no page-wide overflow');
    assert(await target.locator('[data-label="自动减仓覆盖"]').isVisible(), 'mobile cards retain coverage and reasons');
    await section.screenshot({ path: 'output/playwright/ant-protection-mobile.png' });
    assert(!errors.length, `no browser errors: ${errors.join('; ')}`);
    return { passed: true, scenarios: 9, writes: writes.length };
  } finally { await page.context().setOffline(false); await page.unroute('**/*', handler); page.off('pageerror', onError); }
}
