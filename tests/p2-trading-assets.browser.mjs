// Production Hub static preview :4180 + Monitor SSR without collectors :3193.
// playwright-cli -s=p2-trading open about:blank
// playwright-cli -s=p2-trading run-code --filename tests/p2-trading-assets.browser.mjs
// Every API is synthetic; only local production assets are fetched.
async page => {
  const origin = 'http://hub.localhost:4180', moduleOrigin = 'http://p-0123456789abcdef01234567.hub.localhost:4180', monitorBuild = 'http://127.0.0.1:3193';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const now = Date.now(), stamp = new Date(now).toISOString(), iso = value => new Date(value).toISOString(), day = 86400000, step = 900000;
  const jobId = '11111111-1111-4111-8111-111111111111', requests = [], errors = [], external = [], scenarios = [];
  const onError = error => errors.push(error.message);
  let missing = false, launchMonitor = 'oil';
  const project = { id: 'monitor', name: 'monitor', description: '', category: 'other', adapter: 'monitor', enabled: true, embedded: true, accessMode: 'proxy', apiUrl: 'http://127.0.0.1:9000', url: '', mode: 'embed', hasCredentials: true, revision: 'p2-fixture', staleAfterSeconds: 120, order: 0 };
  const overview = { generatedAt: stamp, projects: [{ project, state: 'online', freshness: 'static', message: '', checkedAt: null, updatedAt: null, latencyMs: 1, diagnostics: [], metrics: [] }] };
  const connections = ['binance', 'bybit', 'okx', 'hyperliquid', 'rh-lighter'].map(exchange => ({ exchange, connected: false, revision: 0, accountMode: exchange === 'binance' ? 'standard' : exchange === 'bybit' ? 'unified' : exchange === 'okx' ? 'cross' : exchange === 'hyperliquid' ? 'agent' : 'api-key', identity: null, keyLabel: null, verifiedAt: null, locked: false }));
  const job = { id: jobId, market: 'anthropic', preset: 'cross-exchange', action: 'close', status: 'completed', createdAt: iso(now - 3600000), updatedAt: stamp, deadlineAt: stamp, batchIndex: 1, batchCount: 2, reason: null, canResume: false,
    legs: [['binance', 'ANTHROPICUSDT', 'long'], ['rh-lighter', 'ANTHROPIC', 'short']].map(([exchange, symbol, side], index) => ({ id: 'leg-' + index, exchange, symbol, side, orderSide: side === 'long' ? 'sell' : 'buy', quantity: '2', filledQuantity: '2', remainingQuantity: '0', orderType: 'market', stopPrice: null, currentOrder: { id: 'order-' + index, clientId: null, kind: 'order', state: '已成交', lastCheckedAt: stamp, price: '9999', filledQuantity: '2', unknown: false } })), events: [{ time: stamp, message: '合成结束任务' }] };
  const evidence = () => ({ version: 1, exportedAt: stamp, job: { id: jobId }, orders: [{ remoteId: 'order-0', unknown: false }, { remoteId: 'order-1', unknown: true, filledQuantity: null }], events: [{ time: stamp }], attempts: [{ operationId: 'hub:create:fixture', state: 'unknown' }], gaps: ['只读脱敏证据；不发订单、不撤单'], costs: { note: '仅通过账户与原订单核验的真实成交；不完整时不能证明双腿完成时差。', gaps: missing ? ['尚未取得成交缓存证据', '触发盘口未保留，滑点不可计算'] : ['触发盘口未保留，滑点不可计算'], truncated: false, batches: missing ? [] : [{ phase: 1, batch: 1, completionGapMs: null, legs: [{ exchange: 'binance', symbol: 'ANTHROPICUSDT', quantity: '2', averagePrice: '107.5', priceCurrency: 'USDT', fees: [], feesComplete: false, coverageComplete: false, fillCount: 1, evidenceTruncated: false, slippageReason: '未持久化本批触发盘口，无法计算滑点；未跨币种换算', coverage: { start: iso(now - day), end: stamp, status: 'live', truncated: true }, fills: [{ id: 'real-fill-1', orderId: 'order-0', time: stamp, quantity: '2', price: '107.5', priceCurrency: 'USDT', fee: null, feeCurrency: null }] }] }] } });
  const readOnly = { mode: 'read-only', strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: stamp, period: { days: 7, start: iso(now - 7 * day), end: stamp }, cache: { builtAt: stamp, servedAt: stamp, rebuilding: false }, accounts: [], legs: [], pnl: { currency: 'USDT', intervalMs: 60000, cumulativeStart: now - 7 * day, end: now, recordingStartedAt: null, pointCount: 0, points: [], latest: null, status: 'collecting' }, structure: { state: 'unknown', message: '只读夹具' }, funding: { complete: false, income: null, expense: null, net: null, currency: 'USDT', events: [], pagination: { page: 0, pageSize: 50, total: 0, pages: 0 }, daily: [] } };
  const rows = Array.from({ length: 45 }, (_, index) => ({ id: 'cycle-' + index, time: iso(now - day + index * 1000), kind: 'fill', side: index % 2 ? 'sell' : 'buy', closingQuantity: index % 2 ? '1' : '0', status: index === 0 ? 'partial' : 'included', quantity: index === 0 ? '3' : '1', price: index % 2 ? '110' : '100', fraction: index === 0 ? '0.6' : null, realizedPnl: index === 0 ? null : index % 2 ? '2' : '0', fee: index === 0 ? '-0.6' : '-0.1', feeCurrency: 'USDT', amount: null, currency: 'USDT', reason: index === 0 ? '翻仓只纳入本轮开仓份额的手续费，前轮已实现不纳入' : null }));
  const cycle = { status: 'complete', since: iso(now - day), closedQuantity: '22', closePrice: '110', realizedPnl: '44', fees: '-5', funding: '0', net: '39', currency: 'USDT', note: null, updatedAt: stamp, evidence: { version: 1, coverageStart: iso(now - day), coverageEnd: stamp, openingFound: true, totalRows: 45, truncated: false, rows } };
  const position = (symbol, extra = {}) => ({ id: symbol, symbol, instrumentId: symbol, side: 'long', quantity: '3', quantityUnit: 'contracts', entryPrice: '100', markPrice: '110', unrealizedPnl: '30', pnlCurrency: 'USDT', ...extra });
  const positions = { generatedAt: stamp, sources: [{ projectId: 'asset', name: 'Asset', status: 'ready', data: { exchanges: [{ id: 'binance', name: 'Binance', accounts: [{ id: 'default', name: '测试账户', scopes: [{ id: 'um', status: 'live', fetchedAt: stamp, positions: [position('CLUSDT', { cycle }), position('BZUSDT', { side: 'short', cycle: { ...cycle, evidence: { ...cycle.evidence, totalRows: 200, truncated: true, rows: rows.slice(0, 20) } } })] }] }] }] } }] };
  const end = Math.floor(now / step) * step - step;
  const samples = Array.from({ length: 40 * 96 }, (_, index) => ({ time: end - (40 * 96 - 1 - index) * step, binance: 1270, xyz: 80, io: 1670, rh: 835 }));
  const antCandles = { status: 'live', metadata: { source: 'Binance + Hyperliquid + rh-Lighter', symbols: ['ANTHROPICUSDT', 'xyz:ANT', 'io:ANTH', 'ANTHROPIC'], interval: '15m', timezone: 'UTC', priceBasis: 'Completed 15-minute candle closes', fetchedAt: stamp, firstObservation: iso(samples[0].time), lastObservation: iso(end), rows: samples.length, errors: {} }, data: samples };
  const antQuote = { fetchedAt: stamp, errors: {}, binance: { markPx: 1270, fundingRate: 0, nextFundingTime: null }, xyz: { markPx: 80, fundingRate: 0, oraclePx: 80 }, io: { markPx: 1670, fundingRate: 0, oraclePx: 1670 }, rh: { markPx: 835, fundingRate: null, indexPx: 835 } };
  const association = { jobId, phase: 1, batch: 1, comparisonLeg: 'rh', cex: 'binance' };
  const fill = (id, extra = {}) => ({ id, orderId: id + '-order', symbol: 'ANTHROPICUSDT', base: 'ANTHROPIC', time: iso(end - day + 60000), side: 'buy', positionSide: 'net', quantity: '2', quantityUnit: 'ANTHROPIC', price: '1270', priceCurrency: 'USDT', fee: null, feeCurrency: null, realizedPnl: null, positionBefore: '0', positionAfter: '2', ...extra });
  const fillsExchange = (id, values) => ({ id, name: id, accounts: [{ id: 'default', name: '合成账户', scopes: [{ id: id === 'binance' ? 'um' : 'perpetual', status: 'live', refreshing: false, fetchedAt: stamp, coverageStart: iso(now - 85 * day), coverageEnd: stamp, truncated: false, fills: values }] }] });
  const fills = { generatedAt: stamp, sources: [{ projectId: 'asset', name: 'Asset', status: 'ready', data: { schemaVersion: 1, generatedAt: stamp, lookbackStart: iso(now - 85 * day), exchanges: [
    fillsExchange('binance', [fill('linked', { execution: association, attribution: { reason: 'matched', updatedAt: stamp } }), fill('unlinked', { time: iso(end - day / 2 + 60000), attribution: { reason: 'insufficient-evidence', updatedAt: stamp } })]),
    fillsExchange('rh-lighter', [fill('rh-linked', { symbol: 'ANTHROPIC', price: '835', priceCurrency: 'USDG', side: 'sell', positionAfter: '-2', execution: association, attribution: { reason: 'matched', updatedAt: stamp } })]),
  ] } }] };
  const oilCandles = await (await page.request.get(monitorBuild + '/oil/data/binance-15m.json')).json();
  const handler = async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const send = (json, status = 200) => route.fulfill({ status, json });
    requests.push({ origin: url.origin, path, method });
    if (url.origin === moduleOrigin) {
      if (method !== 'GET') return send({ error: 'Fixture blocks writes' }, 405);
      if (path === '/api/monitors') return send({ schemaVersion: 1, monitors: ['oil', 'hynix', 'anthropic', 'perpetual'].map(id => ({ id, runtime: { available: true, monitorId: id, enabled: true, running: true, revision: 0 } })) });
      if (path === '/api/monitors/oil/candles/15m') return send({ ...oilCandles, status: 'live', metadata: { ...oilCandles.metadata, fetchedAt: stamp } });
      if (path === '/api/monitors/oil/quote') { const leg = (coin, markPx) => ({ coin, markPx, fundingRate: 0, fundingIntervalHours: 4, nextFundingAt: iso(now + 3600000) }); return send({ source: 'Binance', currency: 'USDT', status: 'live', fetchedAt: stamp, brent: leg('BZUSDT', 110), wti: leg('CLUSDT', 100), collection: { maxAgeMs: 75000 } }); }
      if (path === '/api/monitors/anthropic/candles/15m') return send(antCandles);
      if (path === '/api/monitors/anthropic/quote') return send(antQuote);
      if (path.startsWith('/api/')) return send({ error: 'Controlled unavailable fixture' }, 503);
      return route.fulfill({ response: await route.fetch({ url: monitorBuild + path + url.search }) });
    }
    if (url.origin !== origin) { external.push(url.href); return route.abort('blockedbyclient'); }
    if (path === '/api/projects/monitor/launch' && method === 'POST') return send({ url: `${moduleOrigin}/?monitor=${launchMonitor}` });
    if (method !== 'GET') return send({ error: 'Fixture blocks trading writes' }, 405);
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'p2-readonly-fixture' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/overview/events' || path === '/api/system/updates/events') return route.abort();
    if (path === '/api/overview') return send(overview);
    if (path === '/api/system/updates') return send({ enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null });
    if (path === '/api/trading') return send(readOnly);
    if (path === '/api/trading/execution') return send({ generatedAt: stamp, connections, positions: [], jobs: [job] });
    if (path === `/api/trading/execution/jobs/${jobId}/evidence`) return send(evidence());
    if (path === '/api/trading/positions') return send(positions);
    if (path === '/api/trading/fills') return send(url.searchParams.get('market') === 'anthropic' ? fills : { generatedAt: stamp, sources: [] });
    if (path === '/api/trading/anthropic') return send({ generatedAt: stamp, sources: [], alerts: { config: { enabled: false, thresholdPercent: 10, repeatMinutes: 30 }, channel: { configured: false, source: null, host: null, error: null }, history: [], error: null, staleAfterSeconds: 75, hysteresisPercent: 2 } });
    if (path.startsWith('/api/')) return send({ error: 'Controlled unavailable fixture' }, 503);
    return route.continue();
  };
  await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' }); await page.setViewportSize({ width: 1440, height: 1050 });
  page.on('pageerror', onError); await page.route('**/*', handler);
  try {
    await page.goto(origin + '/?view=trading&tradingSection=trade');
    await page.locator('.execution-job').first().waitFor({ state: 'attached', timeout: 10000 });
    if (await page.locator('.execution-history > summary').count()) await page.locator('.execution-history > summary').click();
    const card = page.getByRole('article', { name: 'Anthropic跨所两腿平仓 已全部成交', exact: true });
    await card.waitFor();
    const proof = card.locator('details').filter({ has: page.locator('summary', { hasText: '只读执行证据与逐批成本' }) });
    await proof.locator(':scope > summary').click(); await proof.getByRole('button', { name: '下载脱敏证据 JSON' }).waitFor();
    await proof.locator('summary', { hasText: '实际均价 107.5' }).click();
    const proofText = await proof.innerText();
    assert(proofText.includes('手续费：不可计算（费用证据不完整）') && proofText.includes('费用 未知'), proofText);
    assert(proofText.includes('双腿最后可见成交时差：不可计算') && proofText.includes('无法计算滑点'), proofText);
    assert(proofText.includes('实际均价 107.5') && !proofText.includes('9999'), 'evidence uses actual fills rather than order price');
    const downloadPromise = page.waitForEvent('download'); await proof.getByRole('button', { name: '下载脱敏证据 JSON' }).click();
    const download = await downloadPromise; assert(download.suggestedFilename() === `execution-evidence-${jobId}.json`, 'single-job download filename');
    await download.saveAs('output/playwright/p2-trading/execution-evidence.json');
    await proof.screenshot({ path: 'output/playwright/p2-trading/execution-costs.png' });
    missing = true; await proof.locator(':scope > summary').click();
    const refresh = page.waitForResponse(response => response.url().endsWith(`/jobs/${jobId}/evidence`));
    await proof.locator(':scope > summary').click(); await refresh;
    await proof.getByText('尚未取得成交缓存证据', { exact: true }).waitFor();
    assert(await proof.locator('summary', { hasText: '实际均价' }).count() === 0, 'missing fills do not retain prior cost metrics');
    assert(requests.filter(request => request.path.startsWith('/api/trading')).every(request => request.method === 'GET'), 'evidence expand/download never sends a trading write');
    scenarios.push('ended ANT cost details and JSON download are GET-only; missing fees/fills/baseline/time gap stay unknown');

    await page.goto(origin + '/?view=project&id=monitor');
    const frame = page.frameLocator('iframe[title="monitor模块"]'), panel = frame.locator('[data-related-positions="oil"][data-status="ok"]');
    await panel.waitFor({ timeout: 20000 });
    const first = panel.locator('[data-cycle-status="complete"]').first();
    const detail = first.locator('details'); await detail.locator(':scope > summary').click();
    assert(await detail.locator(':scope > ol > li').count() === 20, 'cycle first page is capped at 20');
    const firstText = await detail.innerText(); assert(firstText.includes('买入') && firstText.includes('本轮平仓量 0') && firstText.includes('本轮比例 0.6') && firstText.includes('翻仓只纳入'), firstText);
    const firstIds = await detail.locator(':scope > ol > li > strong').allInnerTexts();
    await detail.getByRole('button', { name: '下一页', exact: true }).click();
    const secondIds = await detail.locator(':scope > ol > li > strong').allInnerTexts();
    assert(secondIds.length === 20 && !secondIds.some(id => firstIds.includes(id)), 'cycle pages do not repeat evidence');
    await detail.getByRole('button', { name: '下一页', exact: true }).click(); assert(await detail.locator(':scope > ol > li').count() === 5, 'last cycle page preserves remaining records');
    assert((await first.innerText()).includes('平仓数量') && (await first.innerText()).includes('22 contracts'), 'card summary is preserved');
    const truncated = panel.locator('[data-cycle-status="complete"]').nth(1).locator('details'); await truncated.locator(':scope > summary').click();
    assert((await truncated.innerText()).includes('20 / 200 条证据') && (await truncated.innerText()).includes('全局明细预算限制'), 'global evidence budget is visible with original total count');
    await panel.screenshot({ path: 'output/playwright/p2-trading/cycle-evidence.png' });
    scenarios.push('real Hub→Monitor bridge preserves cycle side/closing quantity/flip; pages are 20/20/5; budget says 20/200');

    launchMonitor = 'anthropic'; await page.goto(origin + '/?view=project&id=monitor');
    const ant = frame.getByRole('tabpanel', { name: 'Anthropic 价差', exact: true });
    await ant.getByRole('button', { name: 'Lighter RH', exact: true }).click();
    const linked = ant.locator('.trade-list-item').filter({ hasText: '工作台组合' }).first(); await linked.waitFor({ timeout: 20000 }); await linked.click();
    const fillDetails = ant.getByLabel('套利成交明细'); await fillDetails.waitFor();
    assert((await fillDetails.innerText()).includes('已按订单与账户证据关联') && (await fillDetails.innerText()).includes(jobId), 'matched fills show real task attribution reason');
    const unlinked = ant.locator('.trade-list-item').filter({ hasText: '组合关联未知' }).first(); await unlinked.click();
    assert((await fillDetails.innerText()).includes('订单、合约或账户证据不足，未关联'), 'unlinked fill remains visible with safe explanation');
    await fillDetails.screenshot({ path: 'output/playwright/p2-trading/attribution-reason.png' });
    scenarios.push('ANT linked/unlinked fill explanations survive actual host bridge and remain visible');
    assert(!external.length && !errors.length, JSON.stringify({ external, errors }));
    assert(requests.filter(request => request.method !== 'GET').every(request => request.path === '/api/projects/monitor/launch'), 'only synthetic module launch can POST');
    return { passed: true, scenarios, evidenceReads: requests.filter(request => request.path.endsWith('/evidence')).length, tradingWrites: 0, errors, external };
  } catch (error) {
    await page.screenshot({ path: 'output/playwright/p2-trading/failure.png', fullPage: true }).catch(() => {});
    throw new Error(`${error.message}\n${JSON.stringify({ errors, recentRequests: requests.slice(-16), body: (await page.locator('body').innerText()).slice(0, 4000) })}`);
  } finally { page.off('pageerror', onError); await page.goto('about:blank').catch(() => {}); await page.unroute('**/*', handler); }
}
