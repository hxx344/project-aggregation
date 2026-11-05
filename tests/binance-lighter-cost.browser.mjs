// Run with playwright-cli run-code --filename against a production preview on port 4176.
async (page) => {
  const origin = 'http://127.0.0.1:4176', root = '/api/research/binance-lighter-cost';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const base = Date.parse('2026-11-05T02:00:00Z');
  const errors = [], writes = [], reads = [], detailReads = [], held = [], heldDetails = [], saveAcks = [], archivedReports = new Map();
  let elapsed = 0, state = 'stopped', session = 1, reportPresent = true, hasExposure = false, interrupted = false;
  let frozenAt = null, stale = false, failRead = false, rejectSave = false, holdRead = false, holdSave = false, unknownStop = false, expire = false;
  let sourceLeadMs = null, lighterChannelState = 'connected', sampleValid = true;
  let holdDetail = false, detailFailure = 0, valuationValid = true;
  let serverClock = null;
  const updateServerClock = async () => {
    if (serverClock) elapsed = serverClock.elapsed + await page.evaluate(() => performance.now()) - serverClock.mono;
  };
  const legacySession = { schema: 1, sessionId: 'cost-legacy-1', startedAt: base - 120000, updatedAt: base - 60000, stopped: true, interrupted: true, completed: 2, unresolved: 1, exposures: [{ id: 'BTC:buy:300', symbol: 'BTC', binanceQuantity: 0.02, lighterQuantity: -0.01, residualQuantity: 0.01 }] };
  const legacyReport = { schema: 1, sessionId: legacySession.sessionId, scenarios: [{ id: 'BTC:buy:300', direction: 'buy', recentRounds: [{ id: 'legacy-round', outcome: 'unresolved' }] }] };
  archivedReports.set(legacySession.sessionId, legacyReport);
  const archives = [{ schema: 1, sessionId: 'cost-legacy-archive', startedAt: base - 180000, endedAt: base - 120000, completed: 3, unresolved: 1, interrupted: true }];
  archivedReports.set('cost-legacy-archive', { ...legacyReport, sessionId: 'cost-legacy-archive' });
  let config = {
    schema: 2, symbols: ['BTC', 'ETH'], orderNotional: 1000, latencyScenarios: [300, 600, 1000],
    maxInventoryNotional: 5000, maxUnhedgedNotional: 2000, quoteOffsetBps: 0, inventorySkewBps: 2,
    quoteRefreshMs: 1000, quoteMaxAgeMs: 15000, hedgeWaitMs: 2000,
    maxBookAgeMs: 1000, maxSourceAgeMs: 2000, maxPairSkewMs: 750, maxHedgeSlippageBps: 5,
    queueMultiplier: 1, binanceMakerFeeBps: 0, lighterTakerFeeBps: 0, fundingCostBpsPerHour: null,
  };
  let sessionConfig = structuredClone(config);
  const report = () => {
    if (!reportPresent) return null;
    const at = base + (frozenAt ?? elapsed), age = stale ? 60000 : 100;
    const scenarios = sessionConfig.symbols.flatMap(symbol => sessionConfig.latencyScenarios.map((latencyMs, index) => {
      const retained = hasExposure && symbol === 'BTC' && index === 0;
      const active = state === 'running', mark = symbol === 'BTC' ? 100000 : 3000;
      const bn = retained ? 0.01 : active ? [0, 0.01, -0.01][index] : 0;
      const pendingHedge = active && symbol === 'ETH' && index === 1;
      const lighter = retained ? -0.004 : pendingHedge ? -bn + 0.003 : -bn;
      const id = `${symbol}-inventory-${latencyMs}`;
      const quote = side => ({ id: `${id}-${side}`, side, price: mark + (side === 'buy' ? -3 : 3) - bn * 200, quantity: (1000 / mark) * (side === 'buy' ? 1 - bn * mark / 5000 : 1 + bn * mark / 5000), remainingQuantity: (1000 / mark) * (side === 'buy' ? 1 - bn * mark / 5000 : 1 + bn * mark / 5000), queueAhead: 0.1, submittedAt: at - 500 });
      return { id, symbol, latencyMs, status: pendingHedge ? 'hedging' : active ? 'quoting' : 'stopped', reason: null,
        inventory: { binanceQuantity: bn, lighterQuantity: lighter, residualQuantity: bn + lighter, projectedResidualQuantity: pendingHedge ? 0 : bn + lighter, binanceAveragePrice: bn ? mark - 5 : null, lighterAveragePrice: lighter ? mark - 4 : null, binanceNotional: valuationValid ? bn * mark : null, utilization: valuationValid ? bn * mark / 5000 : null, limitNotional: 5000 },
        quotes: { buy: active ? quote('buy') : null, sell: active ? quote('sell') : null }, hedge: pendingHedge ? { id: `${id}-hedge`, side: 'sell', quantity: 0.003, dueAt: at + latencyMs, attempt: 1 } : null,
        stats: { quoteUpdates: 8, makerFills: 4, hedgeFills: 3, hedgeFailures: 1, binanceTurnover: 4000, lighterTurnover: 3000, fees: 0.3, realizedPnl: 0.6, unrealizedPnl: valuationValid ? 0.5 : null, netPnl: valuationValid ? 0.8 : null, markedCost: valuationValid ? -0.8 : null, costPer10000: valuationValid ? -2 : null, fundingScenarioCost: sessionConfig.fundingCostBpsPerHour === null ? null : 0.2, modeledCostPer10000: valuationValid && sessionConfig.fundingCostBpsPerHour !== null ? -1.5 : null },
        valuation: { at: valuationValid ? at : null, valid: valuationValid, reason: valuationValid ? null : 'valuation_unavailable', binanceMark: valuationValid ? mark : null, lighterMark: valuationValid ? mark : null },
        recentFills: [{ id: `${id}-fill`, venue: 'binance', side: 'buy', phase: 'quote', quantity: 0.01, price: mark, notional: mark * 0.01, fee: 0, at: base - 14000, sourceAt: base - 14050, model: 'maker_queue_proxy' }],
        history: [-5, -4, null, -3, -2].map((value, i) => ({ at: base - 20000 + i * 4000, costPer10000: value, modeledCostPer10000: null, binanceQuantity: bn, residualQuantity: bn + lighter })),
        events: [{ at: base - 10000, type: 'quoting', reason: null }],
      };
    }));
    return { schema: 2, strategy: 'inventory_quotes', sessionId: `cost-fixture-${session}`, startedAt: base - 60000, updatedAt: at, stopped: state === 'stopped', interrupted, mode: 'paper', sessionConfig: structuredClone(sessionConfig), markets: [],
      books: sessionConfig.symbols.flatMap(symbol => ['binance', 'lighter'].map(venue => ({ venue, symbol, nativeSymbol: venue === 'binance' ? `${symbol}USDC` : symbol, bid: symbol === 'BTC' ? 99999 : 3000, ask: symbol === 'BTC' ? 100001 : 3001, sourceAt: at - age, receivedAt: at - age, ageMs: age, valid: sampleValid,
        ...(venue === 'lighter' && sourceLeadMs !== null ? { sourceAt: at + sourceLeadMs, sourceClockDeltaMs: -age - sourceLeadMs, sourceClockUncertain: true } : {}),
      }))),
      channels: [{ venue: 'binance', channel: 'depth', state: 'connected', at }, { venue: 'lighter', channel: 'order_book', state: lighterChannelState, at }], scenarios, diagnostics: [{ at, level: 'warn', event: 'metadata', venue: 'lighter', message: '公开合约信息待恢复', reason: 'metadata_unavailable' }], assumptions: ['Paper simulation only.'],
    };
  };
  const snapshot = () => {
    const summary = report();
    if (summary) { summary.detailLevel = 'summary'; summary.scenarios = summary.scenarios.map(scenario => ({ ...scenario, recentFills: [], history: [], events: [] })); }
    return { schema: 2, state, enabled: state === 'running' || state === 'starting', error: null, serverNow: base + elapsed, config: structuredClone(config), report: summary, archives: structuredClone(archives), legacySession: structuredClone(legacySession), execution: { mode: 'paper', liveAvailable: false, version: 2 } };
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date(base) });
  await page.addInitScript(() => {
    window.__costHidden = false; window.__costOnline = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__costHidden });
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => window.__costOnline });
    window.EventSource = class { close() {} };
    window.__costDownloads = [];
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { void blob.text().then(text => window.__costDownloads.push(JSON.parse(text))); return createObjectURL(blob); };
  });
  await page.route(`${origin}/api/**`, async route => {
    // A timer can issue a request part-way through runFor(). Timestamp that
    // response at the actual virtual instant, not at the end of the whole jump.
    await updateServerClock();
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'cost-fixture-csrf' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/overview') return send({ projects: [], generatedAt: new Date(base + elapsed).toISOString() });
    if (path === '/api/system/updates') return send({ enabled: false, checking: false, modules: [], job: null });
    if (path === '/api/system/host') return send({ generatedAt: new Date(base + elapsed).toISOString(), cpu: { usagePercent: 10, cores: 4, loadAverage: [0.1, 0.1, 0.1] }, memory: { usedPercent: 25, usedBytes: 1024, totalBytes: 4096, availableBytes: 3072 }, disks: [], uptimeSeconds: 120 });
    if (!path.startsWith(root)) return send({ error: 'fixture endpoint unavailable' }, 404);
    if (expire) return send({ error: 'session expired' }, 401);
    if (path === root && request.method() === 'GET') {
      reads.push(elapsed);
      if (failRead) return send({ error: 'fixture read failed' }, 503);
      const captured = snapshot();
      if (holdRead) { holdRead = false; return new Promise(resolve => held.push(async () => { await send(captured); resolve(); })); }
      return send(captured);
    }
    if (path.startsWith(`${root}/scenario/`)) {
      const [sessionId, scenarioId] = path.slice(`${root}/scenario/`.length).split('/').map(decodeURIComponent);
      detailReads.push({ sessionId, scenarioId });
      if (detailFailure) return send({ error: 'fixture detail failed' }, detailFailure);
      const current = report();
      if (current?.sessionId !== sessionId) return send({ error: 'session changed' }, 409);
      const scenario = current.scenarios.find(item => item.id === scenarioId);
      if (!scenario) return send({ error: 'scenario missing' }, 404);
      const captured = { sessionId, updatedAt: current.updatedAt, scenario };
      if (holdDetail) { holdDetail = false; return new Promise(resolve => heldDetails.push(async () => { await send(captured); resolve(); })); }
      return send(captured);
    }
    if (path === `${root}/report`) return send({ report: report(), archives });
    if (path.startsWith(`${root}/report/`)) return send({ report: archivedReports.get(decodeURIComponent(path.slice(`${root}/report/`.length))), archives });
    assert(request.headers()['x-csrf-token'] === 'cost-fixture-csrf', 'research mutations carry the workbench CSRF token');
    writes.push({ path, method: request.method(), body: request.postDataJSON() });
    if (path === `${root}/config`) {
      if (rejectSave) return send({ error: 'fixture save rejected' }, 409);
      config = request.postDataJSON().config;
      const saved = snapshot();
      if (holdSave) { holdSave = false; return new Promise(resolve => saveAcks.push(async () => { await send(saved); resolve(); })); }
      return send(saved);
    }
    if (path === `${root}/stop`) {
      if (unknownStop) return route.abort('failed');
      state = 'stopped'; return send(snapshot());
    }
    if (path === `${root}/start`) { state = 'running'; sessionConfig = structuredClone(config); reportPresent = true; return send(snapshot()); }
    if (path === `${root}/archive`) {
      archivedReports.set(`cost-fixture-${session}`, report());
      archives.push({ schema: 2, sessionId: `cost-fixture-${session}`, startedAt: base - 60000, endedAt: base + elapsed, makerFills: 24, hasExposure, interrupted });
      session++; reportPresent = false; hasExposure = false; interrupted = false; return send(snapshot());
    }
    throw new Error(`Unexpected research request: ${request.method()} ${path}`);
  });
  const advance = async ms => { await page.clock.runFor(ms); await updateServerClock(); await page.waitForTimeout(25); };
  const refresh = async () => { const before = reads.length; await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('.blc-toolbar button')?.disabled); assert(reads.length > before, 'manual refresh fetched status'); };
  const overflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page has no outer horizontal overflow');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?view=cost-lab`);
  await page.locator('.blc-state.stopped').waitFor();
  elapsed = await page.evaluate(() => Date.now()) - base + 50;
  await page.clock.pauseAt(new Date(base + elapsed));
  serverClock = { elapsed, mono: await page.evaluate(() => performance.now()) };
  assert((await page.locator('.breadcrumb').innerText()).includes('监控'), 'the native route is in monitoring');
  assert(await page.getByRole('heading', { name: '对冲成本研究', exact: true }).count() === 1, 'native cost-lab route renders the research page');
  assert(await page.locator('.blc-scenarios tbody tr').count() === 6, 'BTC/ETH times three delays remain independent inventory accounts');
  assert((await page.locator('.blc-identity').innerText()).includes('真实订单 0'), 'simulation and qualification boundaries remain visible');
  assert((await page.locator('.blc-scenarios').innerText()).includes('模拟盯市收益'), 'negative costs are labeled simulated gains');
  await page.locator('.blc-diagnostics>summary').click();
  assert((await page.locator('.blc-diagnostics').innerText()).includes('公开合约信息待恢复'), 'public collection diagnostics expose bounded failure facts');
  await page.locator('.blc-diagnostics>summary').click();
  await page.locator('.blc-chart .recharts-line-curve').first().waitFor();
  const path = await page.locator('.blc-chart .recharts-line-curve').first().getAttribute('d');
  assert((path.match(/M/g) || []).length >= 2, 'null samples break the cost line');
  assert(snapshot().report.scenarios.every(scenario => scenario.history.length === 0 && scenario.recentFills.length === 0), 'state reads carry summary arrays only');
  assert(detailReads.length === 1 && detailReads[0].scenarioId === 'BTC-inventory-300', 'initial page requests only the selected scenario detail');
  assert((await page.locator('.blc-legacy').innerText()).includes('0.02 BTC'), 'legacy exposures remain separate from inventory scenarios');
  const legacyDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '下载旧版报告', exact: true }).click();
  assert((await legacyDownload).suggestedFilename().includes('cost-legacy-1'), 'legacy report downloads with its original session identity');
  await page.waitForTimeout(25);
  assert(await page.evaluate(() => window.__costDownloads.at(-1).report.schema === 1 && window.__costDownloads.at(-1).report.scenarios[0].recentRounds[0].id === 'legacy-round'), 'legacy report is not relabeled or converted into schema 2');
  await page.locator('.blc-selected-detail .blc-fills>summary').click();
  assert(await page.locator('.blc-selected-detail .blc-fills tbody tr').count() === 1, 'the selected detail restores fill records omitted by summary');
  assert((await page.locator('.blc-selected-detail .blc-fills').innerText()).includes('双边报价成交'), 'individual fills use quote and hedge phases');
  await page.locator('.blc-events>summary').click();
  assert(await page.locator('.blc-events li').count() === 1, 'bounded strategy events are available on demand');
  await page.locator('.blc-events>summary').click();
  holdDetail = true; await refresh(); await page.waitForTimeout(25);
  assert(heldDetails.length === 1, 'a selected detail refresh is held');
  const inFlightDetails = detailReads.length; await refresh(); await advance(5000);
  assert(detailReads.length === inFlightDetails, 'multiple summary refreshes coalesce behind one detail request');
  assert(await page.locator('.blc-chart .recharts-line-curve').count() > 0, 'summary empty arrays cannot erase the last selected history');
  await page.locator('.blc-scenario-select').nth(1).click();
  await page.locator('.blc-selected-detail[data-scenario-id="BTC-inventory-600"] .recharts-line-curve').first().waitFor();
  await heldDetails.shift()(); await page.waitForTimeout(25);
  assert(await page.locator('.blc-selected-detail').getAttribute('data-scenario-id') === 'BTC-inventory-600', 'late previous-scenario detail cannot replace the new selection');
  detailFailure = 503; await refresh(); await page.getByText(/详情读取失败：fixture detail failed/).waitFor();
  assert(await page.locator('.blc-chart .recharts-line-curve').count() > 0, 'detail transport failure retains matching historical records with its timestamp');
  detailFailure = 409; await refresh(); await page.getByText(/详情读取失败：会话或情景已变化/).waitFor();
  assert(await page.locator('.blc-chart .recharts-line-curve').count() === 0, 'server session conflict discards obsolete detail');
  detailFailure = 0; await page.locator('.blc-scenario-select').first().click();
  await page.locator('.blc-selected-detail[data-scenario-id="BTC-inventory-300"] .recharts-line-curve').first().waitFor();
  await overflow();
  await page.getByRole('button', { name: '启动模拟', exact: true }).click();
  await page.locator('.blc-state.running').waitFor();
  assert(await page.locator('.blc-buy-quote strong').count() === 6 && await page.locator('.blc-sell-quote strong').count() === 6, 'all six independent scenarios display buy and sell quotes simultaneously');
  assert((await page.locator('.blc-inventory tbody tr').nth(0).innerText()).includes('零库存'), 'zero inventory is visible without an opening-direction model');
  const longRow = page.locator('.blc-inventory tbody tr').nth(1), shortRow = page.locator('.blc-inventory tbody tr').nth(2);
  assert((await longRow.locator('.blc-binance-inventory').innerText()).includes('多仓') && (await shortRow.locator('.blc-binance-inventory').innerText()).includes('空仓'), 'positive and negative BN inventory retain directional labels');
  assert((await longRow.locator('.blc-buy-quote').innerText()).includes('0.008') && (await longRow.locator('.blc-sell-quote').innerText()).includes('0.012'), 'long inventory displays smaller buy and larger sell quantities');
  assert((await shortRow.locator('.blc-buy-quote').innerText()).includes('0.012') && (await shortRow.locator('.blc-sell-quote').innerText()).includes('0.008'), 'short inventory displays larger buy and smaller sell quantities');
  assert((await page.locator('.blc-inventory tbody tr').nth(4).innerText()).includes('卖出 0.003 ETH'), 'one pending net hedge is displayed with its remaining demand');
  assert(await page.locator('.blc-stopped-exposure').count() === 0, 'normal active inventory does not appear as an unresolved-error warning');
  valuationValid = false; await refresh();
  assert(await page.getByText('估值未知 · 缺少合格估值价格', { exact: true }).count() === 6, 'missing valuation is explicit for all affected scenarios');
  assert((await page.locator('.blc-marked-cost').first().innerText()).startsWith('—'), 'unknown valuation cannot appear as zero cost');
  assert((await page.locator('.blc-scenarios tbody tr').first().innerText()).includes('0.3 / —'), 'known fees survive missing unrealized and net PnL');
  assert((await longRow.locator('.blc-binance-inventory').innerText()).includes('名义额 — / 上限 5,000') && (await longRow.innerText()).includes('有向库存占比 —'), 'unknown inventory mark never becomes zero exposure');
  valuationValid = true; await refresh();
  assert(await page.locator('.blc-quality.good').count() === 4, 'current valid market samples meet strict single-leg timing');
  for (const lead of [40, 90, 250]) {
    sourceLeadMs = lead; await refresh();
    assert(await page.locator('.blc-quality.good').count() === 4, `source clock ${lead}ms ahead remains within the same 250ms backend tolerance`);
    assert(await page.getByText(`源时钟超前 ${lead} ms（容差内）`, { exact: true }).count() === 2, 'the current source-clock lead is disclosed independently of admission');
  }
  sourceLeadMs = 251; await refresh();
  assert(await page.locator('.blc-quality.good').count() === 2, 'a source clock more than 250ms ahead remains ineligible');
  assert(await page.getByText('采样时源时钟超前超过容差', { exact: true }).count() === 2, 'excessive clock lead has a specific sampling exclusion reason');
  frozenAt = elapsed; await advance(1100);
  assert(await page.getByText('采样时源时钟超前超过容差', { exact: true }).count() === 2, 'an invalid source clock at sampling cannot heal merely because browser time passes');
  frozenAt = null;
  sourceLeadMs = null; lighterChannelState = 'live'; await refresh();
  await page.getByText('公开数据源连接', { exact: true }).click();
  assert(await page.getByText('行情接收中', { exact: true }).count() === 1, 'live channel status has a Chinese label');
  lighterChannelState = 'stale'; await refresh();
  assert(await page.getByText('行情更新滞后', { exact: true }).count() === 1, 'stale channel status has a Chinese label');
  lighterChannelState = 'disconnected'; sampleValid = false; await refresh();
  assert(await page.getByText('已断开', { exact: true }).count() === 1, 'a known WS disconnect remains visible independently of sample timing');
  assert(await page.getByText('采样时未通过校验', { exact: true }).count() === 4, 'small ages cannot override a server-side invalid result');
  await advance(2100);
  assert(await page.locator('.blc-quality.stale').count() === 4, 'browser aging cannot hide a server-reported failure behind a neutral waiting state');
  sampleValid = true;
  lighterChannelState = 'connected'; await refresh(); await page.getByText('公开数据源连接', { exact: true }).click();
  await page.locator('.blc-config>summary').click();
  const notional = page.getByLabel('单侧基础报价名义额（USDC）', { exact: true });
  assert(await notional.isDisabled(), 'active configuration is read only');
  frozenAt = elapsed; await refresh(); await advance(3100);
  assert(await page.locator('.blc-quality.good').count() === 0, 'an old browser snapshot cannot assert current validity');
  assert(await page.locator('.blc-quality.stale').count() === 0, 'normal sampling delay is not mislabeled as a server-side stale book');
  assert(await page.getByText('采样时有效 · 当前待更新', { exact: true }).count() === 4, 'three-second-old samples retain their past validity with a neutral current-time state');
  const oldAge = await page.locator('.blc-book-age').first().innerText(); await refresh();
  assert(await page.locator('.blc-quality.good').count() === 0, 'a fresh HTTP GET cannot refresh a frozen market observation');
  const ageSeconds = text => Number.parseFloat(text.replaceAll(',', ''));
  assert(ageSeconds(await page.locator('.blc-book-age').first().innerText()) >= ageSeconds(oldAge), `frozen report age cannot move backwards across rereads: ${oldAge} -> ${await page.locator('.blc-book-age').first().innerText()}`);
  await advance(13000); await refresh();
  await page.getByText('研究报告超过 15 秒未更新', { exact: true }).waitFor();
  assert(await page.getByText('历史采样时有效', { exact: true }).count() === 4, 'a stopped report is explicitly historical, not a current healthy claim');
  assert((await page.locator('.blc-exposures .panel-heading').innerText()).includes('历史报告'), 'frozen quote and inventory evidence is visibly historical');
  frozenAt = null; await refresh();
  holdRead = true; await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await page.waitForTimeout(25);
  assert(held.length === 1, 'slow network response is held'); await advance(2500); await held.shift()(); await page.waitForTimeout(25);
  assert(await page.locator('.blc-quality.good').count() === 0, 'transport delay is included in book age before a response is accepted');
  assert(await page.locator('.blc-quality.stale').count() === 0, 'slow HTTP transport does not fabricate a WS-data failure');
  assert(await page.getByText('采样时有效 · 当前待更新', { exact: true }).count() === 4, 'slow transport shows waiting for current information');
  await page.clock.setSystemTime(new Date(base + elapsed + 3600000)); await refresh();
  assert(await page.locator('.blc-quality.good').count() === 4, 'browser wall clock skew cannot age server observations');
  await page.clock.setSystemTime(new Date(base + elapsed));
  stale = true; await refresh();
  assert((await page.locator('.blc-quality').first().innerText()).includes('接收年龄超限'), 'source age and receipt age do not become fresh when read');
  failRead = true; await refresh(); await page.getByText(/研究数据读取失败：fixture read failed/).waitFor();
  assert(await page.locator('.blc-chart .recharts-line-curve').count() > 0, 'read failure preserves historical costs');
  failRead = false; stale = false; await refresh();
  await page.getByRole('button', { name: '停止模拟', exact: true }).click(); await page.locator('.blc-state.stopped').waitFor();
  const beforeValidation = writes.length;
  await notional.fill(''); await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('单侧基础报价名义额（USDC）须为 10–100000 之间的数字。', { exact: true }).waitFor();
  assert(writes.length === beforeValidation, 'blank required numeric input is not converted to zero');
  await notional.fill('250');
  const latency = page.getByLabel('情景 1 延迟（ms）', { exact: true });
  await latency.fill('299'); await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('Lighter 延迟（ms）须为 300–10000 之间的整数。', { exact: true }).waitFor();
  await latency.fill('300.5'); await page.getByRole('button', { name: '保存配置', exact: true }).click();
  assert(writes.length === beforeValidation, 'latency floor and integer constraints match the backend');
  await latency.fill('300');
  const inventoryLimit = page.getByLabel('BN 库存名义额上限（USDC）', { exact: true });
  await inventoryLimit.fill('200'); await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('BN 库存名义额上限不得小于单侧基础报价名义额。', { exact: true }).waitFor();
  await inventoryLimit.fill('5000');
  const quoteRefresh = page.getByLabel('最短重报间隔（ms）', { exact: true }), quoteAge = page.getByLabel('挂单最长寿命（ms）', { exact: true });
  await quoteRefresh.fill('999'); await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('最短重报间隔（ms）须为 1000–60000 之间的整数。', { exact: true }).waitFor();
  await quoteRefresh.fill('2000'); await quoteAge.fill('1000'); await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('挂单最长寿命不得小于最短重报间隔。', { exact: true }).waitFor();
  assert(writes.length === beforeValidation, 'inventory reservation and refresh lifetime constraints reject before submitting');
  await quoteRefresh.fill('1000'); await quoteAge.fill('15000'); rejectSave = true;
  await page.getByRole('button', { name: '保存配置', exact: true }).click(); await page.getByText('fixture save rejected', { exact: true }).waitFor();
  assert(await notional.inputValue() === '250' && await page.getByRole('button', { name: '保存配置', exact: true }).isEnabled(), 'explicit rejection retains draft and allows corrected retry');
  rejectSave = false; holdRead = true; await advance(5000); assert(held.length === 1, 'pre-save GET is held');
  await page.getByRole('button', { name: '保存配置', exact: true }).click(); await page.getByText('配置已保存。', { exact: true }).waitFor();
  await held.shift()(); await page.waitForTimeout(25);
  assert(await notional.inputValue() === '250' && config.orderNotional === 250, 'late old GET cannot roll back a confirmed save');
  await notional.fill('300'); holdSave = true;
  await page.getByRole('button', { name: '保存配置', exact: true }).click(); await page.waitForTimeout(25);
  assert(saveAcks.length === 1, 'save response is held'); await notional.fill('350');
  await saveAcks.shift()(); await page.getByText('配置已保存。', { exact: true }).waitFor();
  assert(await notional.inputValue() === '350' && config.orderNotional === 300, 'edits during a save retain the newer draft');
  assert(await page.getByRole('button', { name: '保存配置', exact: true }).isEnabled(), 'newer draft remains visibly unsaved');
  await page.getByRole('button', { name: '保存配置', exact: true }).click(); await page.getByText('配置已保存。', { exact: true }).waitFor();
  const oldSession = await page.locator('.blc-session').innerText();
  await page.getByLabel('Binance Maker 费率（bps）', { exact: true }).fill('2');
  await page.getByRole('button', { name: '保存配置', exact: true }).click(); await page.getByText('配置已保存。', { exact: true }).waitFor();
  assert(await page.locator('.blc-session').innerText() === oldSession, 'new configuration cannot rewrite stopped session fee assumptions');
  await page.getByRole('button', { name: '启动模拟', exact: true }).click(); await page.locator('.blc-state.running').waitFor();
  unknownStop = true; const beforeUnknown = writes.length;
  await page.getByRole('button', { name: '停止模拟', exact: true }).click(); await page.getByText('操作结果尚未确认，正在读取核对；确认前不会重复提交。', { exact: true }).waitFor();
  await advance(5000); assert(writes.length === beforeUnknown + 1, 'unknown stop results are never automatically retried');
  assert(await page.getByRole('button', { name: '停止模拟', exact: true }).isDisabled(), 'an unrelated successful GET cannot release an unknown operation');
  state = 'stopped'; unknownStop = false; await refresh();
  await page.getByText('已读取并核对操作结果。', { exact: true }).waitFor();
  hasExposure = true; interrupted = true; await refresh();
  assert((await page.locator('.blc-exposures').innerText()).includes('0.006'), 'retained residual remains visible after stopping');
  assert(await page.getByRole('button', { name: '启动模拟', exact: true }).isDisabled(), 'retained inventory blocks a new session until archive');
  const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: '导出报告', exact: true }).click();
  assert((await downloadEvent).suggestedFilename().startsWith('binance-lighter-cost-'), 'the report exports as JSON');
  await page.waitForTimeout(25);
  assert(await page.evaluate(() => window.__costDownloads.at(-1).report.scenarios.every(scenario => scenario.recentFills.length > 0 && scenario.history.length > 0)), 'full report export retains every scenario history and fill record');
  holdDetail = true; await refresh(); await page.waitForTimeout(25);
  assert(heldDetails.length === 1, 'pre-archive detail is held');
  await page.getByRole('button', { name: '归档当前会话', exact: true }).click(); await page.getByText('会话已归档，可启动新的独立会话。', { exact: true }).waitFor();
  await heldDetails.shift()(); await page.waitForTimeout(25);
  assert(await page.locator('.blc-selected-detail').count() === 0, 'a late archived-session detail is never rendered under the empty or next session');
  await page.locator('.blc-archives>summary').click();
  assert((await page.locator('.blc-archives tbody tr').first().innerText()).includes('旧版单轮 · v1') && (await page.locator('.blc-archives tbody tr').first().innerText()).includes('1 条旧版未决'), 'v1 archives keep round and unresolved semantics');
  assert((await page.locator('.blc-archives tbody').innerText()).includes('cost-fixture-1'), 'archive preserves prior session identity');
  assert((await page.locator('.blc-archives tbody tr').last().locator('td').nth(2).innerText()) === '库存保留', 'v2 archive retains exposure without inventing unresolved rounds');
  assert((await page.locator('.blc-archives tbody tr').last().locator('td').nth(3).innerText()) === '曾中断', 'interruption is shown independently of exposure');
  const archivedDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '下载归档', exact: true }).last().click();
  assert((await archivedDownload).suggestedFilename().includes('cost-fixture-1'), 'archived full report downloads by server-provided session identity');
  await page.waitForTimeout(25);
  assert(await page.evaluate(() => window.__costDownloads.at(-1).report.scenarios[0].recentFills.length === 1), 'archived report export keeps fill evidence');
  await page.getByRole('button', { name: '启动模拟', exact: true }).click(); await page.locator('.blc-state.running').waitFor();
  await page.evaluate(() => { window.__costHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenReads = reads.length, hiddenDetailReads = detailReads.length, hiddenWrites = writes.length; await advance(20000);
  assert(reads.length === hiddenReads && detailReads.length === hiddenDetailReads && writes.length === hiddenWrites && state === 'running', 'hidden page stops state/detail reads without stopping server simulation');
  await page.evaluate(() => { window.__costHidden = false; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); });
  await advance(300); assert(reads.length === hiddenReads + 1, 'wake events coalesce into one GET');
  await page.evaluate(() => { window.__costOnline = false; window.dispatchEvent(new Event('offline')); });
  const offlineReads = reads.length, offlineDetailReads = detailReads.length; await advance(12000); assert(reads.length === offlineReads && detailReads.length === offlineDetailReads, 'offline state/detail polling is suspended');
  await page.evaluate(() => { window.__costOnline = true; window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); });
  await advance(300); assert(reads.length === offlineReads + 1, 'reconnection is coalesced');
  await page.locator('.blc-config>summary').click();
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.blc-heading').scrollIntoViewIfNeeded(); await overflow();
  await page.screenshot({ path: 'output/playwright/binance-lighter-cost-mobile.png', fullPage: false });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'output/playwright/binance-lighter-cost-desktop.png', fullPage: false });
  const beforeLeaving = writes.length;
  await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '总览', exact: true }).click();
  await page.locator('.blc-page').waitFor({ state: 'detached' }); const leftReads = reads.length, leftDetailReads = detailReads.length; await advance(20000);
  assert(reads.length === leftReads && detailReads.length === leftDetailReads && writes.length === beforeLeaving && state === 'running', 'unmount cancels state/detail polling without writing a stop');
  await page.getByRole('button', { name: '对冲成本研究', exact: true }).click(); await page.locator('.blc-state.running').waitFor();
  expire = true; await advance(5000); await page.getByRole('heading', { name: '进入工作台', exact: true }).waitFor();
  assert(errors.length === 0, `no browser errors: ${errors.join('; ')}`);
  assert(writes.every(write => ['/start', '/stop', '/config', '/archive'].some(suffix => write.path === root + suffix)), 'only paper research state is mutated');
  await page.clock.resume();
  return { checks: 'native-route, summary/detail, selected-only, coalesced-detail, detail-switch-race, detail-error-retention, detail-session-conflict, full-export, separate-archive-interruption, six-inventory-scenarios, simultaneous-quotes, signed-inventory, net-hedge, unknown-valuation, legacy-download, mixed-schema-archives, signed-costs, chart-gaps, stop-save-start, numeric-validation, rejected-save, stale-GET-save-race, save-draft-preservation, frozen-session, monotonic-freshness, server-clock, source-clock-tolerance, channel-labels, stale/error, retained-inventory/archive, unknown-write-latch, hidden/offline/resume, download, mobile-overflow, unmount, session-expiry', writes: writes.length, reads: reads.length, detailReads: detailReads.length };
}
