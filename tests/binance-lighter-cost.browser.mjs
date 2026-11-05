// Run with playwright-cli run-code --filename against a production preview on port 4176.
async (page) => {
  const origin = 'http://127.0.0.1:4176', root = '/api/research/binance-lighter-cost';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const base = Date.parse('2026-11-05T02:00:00Z');
  const errors = [], writes = [], reads = [], detailReads = [], held = [], heldDetails = [], saveAcks = [], archivedReports = new Map();
  let elapsed = 0, state = 'stopped', session = 1, reportPresent = true, unresolved = false, interrupted = false;
  let frozenAt = null, stale = false, failRead = false, rejectSave = false, holdRead = false, holdSave = false, unknownStop = false, expire = false;
  let sourceLeadMs = null, lighterChannelState = 'connected';
  let holdDetail = false, detailFailure = 0;
  const archives = [];
  let config = {
    schema: 1, symbols: ['BTC', 'ETH'], notionalPerLeg: 1000, latencyScenarios: [300, 600, 1000],
    makerWaitMs: 15000, holdMs: 5000, hedgeWaitMs: 2000, cooldownMs: 3000,
    maxBookAgeMs: 1000, maxSourceAgeMs: 2000, maxPairSkewMs: 750, maxHedgeSlippageBps: 5,
    queueMultiplier: 1, binanceMakerFeeBps: 0, lighterTakerFeeBps: 0, fundingCostBpsPerHour: null,
  };
  let sessionConfig = structuredClone(config);
  const report = () => {
    if (!reportPresent) return null;
    const at = base + (frozenAt ?? elapsed), age = stale ? 60000 : 100;
    const scenarios = sessionConfig.symbols.flatMap(symbol => ['buy', 'sell'].flatMap(direction => sessionConfig.latencyScenarios.map(latencyMs => {
      const open = unresolved && symbol === 'BTC' && direction === 'buy' && latencyMs === sessionConfig.latencyScenarios[0];
      const id = `${symbol}:${direction}:${latencyMs}`;
      return { id, symbol, direction, latencyMs, status: open ? 'unresolved' : state === 'running' ? 'waiting' : 'stopped', reason: open ? 'hedge_depth_insufficient' : null,
        task: open ? { id: 'open-task', startedAt: base - 20000, phase: 'unresolved', targetQuantity: 0.01, binanceQuantity: 0.01, lighterQuantity: -0.004, residualQuantity: 0.006, maker: null, pendingHedges: [] } : null,
        stats: { attempts: 4, completed: 2, unfilled: 1, unresolved: open ? 1 : 0, binanceTurnover: open ? 5000 : 4000, closedBinanceTurnover: 4000, fees: open ? 0.4 : 0.3, closedFees: 0.3, tradingPnl: 1.1, tradingCost: -0.8, costPer10000: -2, fundingScenarioCost: sessionConfig.fundingCostBpsPerHour === null ? null : 0.2, modeledCostPer10000: sessionConfig.fundingCostBpsPerHour === null ? null : -1.5 },
        recentRounds: [{ id: `${id}:round`, startedAt: base - 15000, endedAt: base - 5000, outcome: 'completed', reason: null, quantity: 0.01, binanceTurnover: 2000, fees: 0.15, tradingPnl: 0.55, tradingCost: -0.4, costPer10000: -2, fundingScenarioCost: null, modeledCostPer10000: null,
          fills: [{ id: 'fill-1', venue: 'binance', side: 'buy', phase: 'entry', quantity: 0.01, price: 100000, notional: 1000, fee: 0, at: base - 14000, sourceAt: base - 14050, model: 'maker_queue_proxy' }] }],
        history: [-5, -4, null, -3, -2].map((value, index) => ({ at: base - 20000 + index * 4000, costPer10000: value, modeledCostPer10000: null })),
      };
    })));
    return { schema: 1, sessionId: `cost-fixture-${session}`, startedAt: base - 60000, updatedAt: at, stopped: state === 'stopped', interrupted, mode: 'paper', sessionConfig: structuredClone(sessionConfig), markets: [],
      books: sessionConfig.symbols.flatMap(symbol => ['binance', 'lighter'].map(venue => ({ venue, symbol, nativeSymbol: venue === 'binance' ? `${symbol}USDC` : symbol, bid: symbol === 'BTC' ? 99999 : 3000, ask: symbol === 'BTC' ? 100001 : 3001, sourceAt: at - age, receivedAt: at - age, ageMs: age, valid: true,
        ...(venue === 'lighter' && sourceLeadMs !== null ? { sourceAt: at + sourceLeadMs, sourceClockDeltaMs: -age - sourceLeadMs, sourceClockUncertain: true } : {}),
      }))),
      channels: [{ venue: 'binance', channel: 'depth', state: 'connected', at }, { venue: 'lighter', channel: 'order_book', state: lighterChannelState, at }], scenarios, diagnostics: [{ at, level: 'warn', event: 'metadata', venue: 'lighter', message: '公开合约信息待恢复', reason: 'metadata_unavailable' }], assumptions: ['Paper simulation only.'],
    };
  };
  const snapshot = () => {
    const summary = report();
    if (summary) { summary.detailLevel = 'summary'; summary.scenarios = summary.scenarios.map(scenario => ({ ...scenario, recentRounds: [], history: [] })); }
    return { schema: 1, state, enabled: state === 'running' || state === 'starting', error: null, serverNow: base + elapsed, config: structuredClone(config), report: summary, archives: structuredClone(archives), execution: { mode: 'paper', liveAvailable: false, version: 1 } };
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
      archives.push({ sessionId: `cost-fixture-${session}`, startedAt: base - 60000, endedAt: base + elapsed, completed: 24, unresolved: unresolved ? 1 : 0, interrupted });
      session++; reportPresent = false; unresolved = false; interrupted = false; return send(snapshot());
    }
    throw new Error(`Unexpected research request: ${request.method()} ${path}`);
  });
  const advance = async ms => { elapsed += ms; await page.clock.runFor(ms); await page.waitForTimeout(25); };
  const refresh = async () => { const before = reads.length; await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('.blc-toolbar button')?.disabled); assert(reads.length > before, 'manual refresh fetched status'); };
  const overflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page has no outer horizontal overflow');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?view=cost-lab`);
  await page.locator('.blc-state.stopped').waitFor();
  elapsed = await page.evaluate(() => Date.now()) - base + 50;
  await page.clock.pauseAt(new Date(base + elapsed));
  assert((await page.locator('.breadcrumb').innerText()).includes('监控'), 'the native route is in monitoring');
  assert(await page.getByRole('heading', { name: '对冲成本研究', exact: true }).count() === 1, 'native cost-lab route renders the research page');
  assert(await page.locator('.blc-scenarios tbody tr').count() === 12, 'BTC/ETH buy/sell times three delays remain independent rows');
  assert((await page.locator('.blc-identity').innerText()).includes('真实订单 0'), 'simulation and qualification boundaries remain visible');
  assert((await page.locator('.blc-scenarios').innerText()).includes('模拟收益'), 'negative costs are labeled simulated gains');
  await page.locator('.blc-diagnostics>summary').click();
  assert((await page.locator('.blc-diagnostics').innerText()).includes('公开合约信息待恢复'), 'public collection diagnostics expose bounded failure facts');
  await page.locator('.blc-diagnostics>summary').click();
  await page.locator('.blc-chart .recharts-line-curve').first().waitFor();
  const path = await page.locator('.blc-chart .recharts-line-curve').first().getAttribute('d');
  assert((path.match(/M/g) || []).length >= 2, 'null samples break the cost line');
  assert(snapshot().report.scenarios.every(scenario => scenario.history.length === 0 && scenario.recentRounds.length === 0), 'state reads carry summary arrays only');
  assert(detailReads.length === 1 && detailReads[0].scenarioId === 'BTC:buy:300', 'initial page requests only the selected scenario detail');
  await page.locator('.blc-selected-detail .blc-records>summary').click();
  assert(await page.locator('.blc-selected-detail .blc-records tbody tr').count() === 1, 'the selected detail restores round records omitted by summary');
  holdDetail = true; await refresh(); await page.waitForTimeout(25);
  assert(heldDetails.length === 1, 'a selected detail refresh is held');
  const inFlightDetails = detailReads.length; await refresh(); await advance(5000);
  assert(detailReads.length === inFlightDetails, 'multiple summary refreshes coalesce behind one detail request');
  assert(await page.locator('.blc-chart .recharts-line-curve').count() > 0, 'summary empty arrays cannot erase the last selected history');
  await page.locator('.blc-scenario-select').nth(1).click();
  await page.locator('.blc-selected-detail[data-scenario-id="BTC:buy:600"] .recharts-line-curve').first().waitFor();
  await heldDetails.shift()(); await page.waitForTimeout(25);
  assert(await page.locator('.blc-selected-detail').getAttribute('data-scenario-id') === 'BTC:buy:600', 'late previous-scenario detail cannot replace the new selection');
  detailFailure = 503; await refresh(); await page.getByText(/详情读取失败：fixture detail failed/).waitFor();
  assert(await page.locator('.blc-chart .recharts-line-curve').count() > 0, 'detail transport failure retains matching historical records with its timestamp');
  detailFailure = 409; await refresh(); await page.getByText(/详情读取失败：会话或情景已变化/).waitFor();
  assert(await page.locator('.blc-chart .recharts-line-curve').count() === 0, 'server session conflict discards obsolete detail');
  detailFailure = 0; await page.locator('.blc-scenario-select').first().click();
  await page.locator('.blc-selected-detail[data-scenario-id="BTC:buy:300"] .recharts-line-curve').first().waitFor();
  await overflow();
  await page.getByRole('button', { name: '启动模拟', exact: true }).click();
  await page.locator('.blc-state.running').waitFor();
  assert(await page.locator('.blc-quality.good').count() === 4, 'current valid market samples meet strict single-leg timing');
  for (const lead of [40, 90, 250]) {
    sourceLeadMs = lead; await refresh();
    assert(await page.locator('.blc-quality.good').count() === 4, `source clock ${lead}ms ahead remains within the same 250ms backend tolerance`);
    assert(await page.getByText(`源时钟超前 ${lead} ms（容差内）`, { exact: true }).count() === 2, 'the current source-clock lead is disclosed independently of admission');
  }
  sourceLeadMs = 251; await refresh();
  assert(await page.locator('.blc-quality.good').count() === 2, 'a source clock more than 250ms ahead remains ineligible');
  assert(await page.getByText('源时钟超前超过容差', { exact: true }).count() === 2, 'excessive clock lead has a specific exclusion reason');
  sourceLeadMs = null; lighterChannelState = 'live'; await refresh();
  await page.getByText('公开数据源连接', { exact: true }).click();
  assert(await page.getByText('行情接收中', { exact: true }).count() === 1, 'live channel status has a Chinese label');
  lighterChannelState = 'stale'; await refresh();
  assert(await page.getByText('行情更新滞后', { exact: true }).count() === 1, 'stale channel status has a Chinese label');
  lighterChannelState = 'connected'; await refresh(); await page.getByText('公开数据源连接', { exact: true }).click();
  await page.locator('.blc-config>summary').click();
  const notional = page.getByLabel('每腿模拟名义额（USDC）', { exact: true });
  assert(await notional.isDisabled(), 'active configuration is read only');
  frozenAt = elapsed; await refresh(); await advance(2100);
  assert(await page.locator('.blc-quality.good').count() === 0, 'local monotonic time expires a book between GETs');
  const oldAge = await page.locator('.blc-book-age').first().innerText(); await refresh();
  assert(await page.locator('.blc-quality.good').count() === 0, 'a fresh HTTP GET cannot refresh a frozen market observation');
  const ageSeconds = text => Number.parseFloat(text.replaceAll(',', ''));
  assert(ageSeconds(await page.locator('.blc-book-age').first().innerText()) >= ageSeconds(oldAge), 'frozen report age cannot move backwards across rereads');
  frozenAt = null; await refresh();
  holdRead = true; await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await page.waitForTimeout(25);
  assert(held.length === 1, 'slow network response is held'); await advance(2500); await held.shift()(); await page.waitForTimeout(25);
  assert(await page.locator('.blc-quality.good').count() === 0, 'transport delay is included in book age before a response is accepted');
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
  await page.getByText('每腿模拟名义额（USDC）须为 10–100000 之间的数字。', { exact: true }).waitFor();
  assert(writes.length === beforeValidation, 'blank required numeric input is not converted to zero');
  await notional.fill('250');
  const latency = page.getByLabel('情景 1 延迟（ms）', { exact: true });
  await latency.fill('299'); await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('Lighter 延迟（ms）须为 300–10000 之间的整数。', { exact: true }).waitFor();
  await latency.fill('300.5'); await page.getByRole('button', { name: '保存配置', exact: true }).click();
  assert(writes.length === beforeValidation, 'latency floor and integer constraints match the backend');
  await latency.fill('300'); rejectSave = true;
  await page.getByRole('button', { name: '保存配置', exact: true }).click(); await page.getByText('fixture save rejected', { exact: true }).waitFor();
  assert(await notional.inputValue() === '250' && await page.getByRole('button', { name: '保存配置', exact: true }).isEnabled(), 'explicit rejection retains draft and allows corrected retry');
  rejectSave = false; holdRead = true; await advance(5000); assert(held.length === 1, 'pre-save GET is held');
  await page.getByRole('button', { name: '保存配置', exact: true }).click(); await page.getByText('配置已保存。', { exact: true }).waitFor();
  await held.shift()(); await page.waitForTimeout(25);
  assert(await notional.inputValue() === '250' && config.notionalPerLeg === 250, 'late old GET cannot roll back a confirmed save');
  await notional.fill('300'); holdSave = true;
  await page.getByRole('button', { name: '保存配置', exact: true }).click(); await page.waitForTimeout(25);
  assert(saveAcks.length === 1, 'save response is held'); await notional.fill('350');
  await saveAcks.shift()(); await page.getByText('配置已保存。', { exact: true }).waitFor();
  assert(await notional.inputValue() === '350' && config.notionalPerLeg === 300, 'edits during a save retain the newer draft');
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
  unresolved = true; interrupted = true; await refresh();
  assert((await page.locator('.blc-exposures').innerText()).includes('0.006'), 'unresolved residual remains visible after stopping');
  assert(await page.getByRole('button', { name: '启动模拟', exact: true }).isDisabled(), 'unresolved prior session blocks a new session until archive');
  const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: '导出报告', exact: true }).click();
  assert((await downloadEvent).suggestedFilename().startsWith('binance-lighter-cost-'), 'the report exports as JSON');
  await page.waitForTimeout(25);
  assert(await page.evaluate(() => window.__costDownloads.at(-1).report.scenarios.every(scenario => scenario.recentRounds.length > 0 && scenario.history.length > 0)), 'full report export retains every scenario history and fill record');
  holdDetail = true; await refresh(); await page.waitForTimeout(25);
  assert(heldDetails.length === 1, 'pre-archive detail is held');
  await page.getByRole('button', { name: '归档当前会话', exact: true }).click(); await page.getByText('会话已归档，可启动新的独立会话。', { exact: true }).waitFor();
  await heldDetails.shift()(); await page.waitForTimeout(25);
  assert(await page.locator('.blc-selected-detail').count() === 0, 'a late archived-session detail is never rendered under the empty or next session');
  await page.locator('.blc-archives>summary').click();
  assert((await page.locator('.blc-archives tbody').innerText()).includes('cost-fixture-1'), 'archive preserves prior session identity');
  assert((await page.locator('.blc-archives tbody tr td').nth(2).innerText()) === '1', 'archive retains the unresolved count');
  assert((await page.locator('.blc-archives tbody tr td').nth(3).innerText()) === '曾中断', 'interruption is shown independently and never added to the unresolved count');
  const archivedDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '下载归档', exact: true }).click();
  assert((await archivedDownload).suggestedFilename().includes('cost-fixture-1'), 'archived full report downloads by server-provided session identity');
  await page.waitForTimeout(25);
  assert(await page.evaluate(() => window.__costDownloads.at(-1).report.scenarios[0].recentRounds[0].fills.length === 1), 'archived report export keeps full round fill evidence');
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
  return { checks: 'native-route, summary/detail, selected-only, coalesced-detail, detail-switch-race, detail-error-retention, detail-session-conflict, full-export, separate-archive-interruption, independent-scenarios, signed-costs, chart-gaps, stop-save-start, numeric-validation, rejected-save, stale-GET-save-race, save-draft-preservation, frozen-session, monotonic-freshness, server-clock, source-clock-tolerance, channel-labels, stale/error, unresolved/archive, unknown-write-latch, hidden/offline/resume, download, mobile-overflow, unmount, session-expiry', writes: writes.length, reads: reads.length, detailReads: detailReads.length };
}
