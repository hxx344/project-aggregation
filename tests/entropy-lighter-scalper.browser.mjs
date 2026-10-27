// Run with playwright-cli run-code --filename against a production preview on port 4177.
async (page) => {
  const origin = 'http://127.0.0.1:4177', root = '/api/research/entropy-lighter';
  const assert = (value, text) => { if (!value) throw new Error(text); };
  const errors = [], writes = [], reads = [];
  const base = Date.parse('2026-10-27T02:00:00Z');
  let elapsed = 0, state = 'running', missingReport = true, omitStrategy = false, stale = false, frozenAt = null;
  let stage = 'armed', sourcePrice = 100, suspendedReason = null, previousSession = false;
  const config = {
    schema: 1, region: 'Tokyo', recordRaw: true, maxDataMb: 2048, retentionDays: 7,
    maxBookAgeMs: 750, maxSourceAgeMs: 2000, maxPairSkewMs: 500, sampleIntervalMs: 250,
    simulation: { enabled: false, verifiedSymbols: [], entropyTakerFeeBps: null, lighterTakerFeeBps: null,
      notionalPerLeg: 100, minEntryEdgeBps: 15, slippageBpsPerFill: 2, fundingReserveBpsPerRoundTrip: 2,
      holdMs: 5000, fillWaitMs: 2000, cooldownMs: 10000, rebateRatios: [0, 1.1, 1.2],
      latencyScenarios: [{ name: 'base-assumed', entropyMs: 200, lighterMs: 450 }, { name: 'stress-assumed', entropyMs: 500, lighterMs: 800 }] },
  };
  const reportAt = () => frozenAt ?? base + elapsed - 5000;
  const rebates = [{ ratio: 1.1, contingentRebate: 1.1, net: 0.4 }, { ratio: 1.2, contingentRebate: 1.2, net: 0.5 }];
  const scenario = (symbol, name, entropyMs) => {
    const open = ['entry_pending', 'holding', 'exit_pending', 'unresolved'].includes(stage);
    return { name, entropyMs, state: stage, reason: stage === 'unresolved' ? 'exit_timeout' : stage,
      armed: { at: base - 10000, upper: symbol === 'ANTH' ? 10004 : 100.4, lower: symbol === 'ANTH' ? 9996 : 99.6, sequence: '12345' },
      position: open ? { direction: 'long', triggerPrice: symbol === 'ANTH' ? 10004 : 100.4, signalAt: base - 2000,
        entryAt: stage === 'entry_pending' ? null : base - 1800, entryPrice: stage === 'entry_pending' ? null : 100, quantity: 1,
        entryCash: stage === 'entry_pending' ? null : 100, entryDueAt: base - 1800, exitDueAt: null, exitIntent: null } : null,
      stats: { signals: 3, completed: 2, failedEntries: 1, unresolved: stage === 'unresolved' ? 1 : 0, lossesBeforeRebate: 2,
        turnover: 400, fees: 1, costReserve: 0.2, settledGrossPnl: 0.5, settledNetBeforeRebate: -0.7,
        grossPnl: open ? null : 0.5, netBeforeRebate: open ? null : -0.7, hasOpenExposure: open,
        winRateBeforeRebate: 0, rebateScenarios: rebates.map(value => ({ ...value, net: open ? null : value.net })) },
      recentTrades: [{ id: `${symbol}-${name}-1`, at: base - 3000, direction: 'long', outcome: 'completed',
        entryPrice: 100, exitPrice: 100.5, exitReason: 'recross_trigger', durationMs: 1200, grossPnl: 0.5,
        fees: 1, costReserve: 0.2, netBeforeRebate: -0.7, turnover: 200, rebateScenarios: rebates }], lastEventAt: base - 1000 };
  };
  const strategy = () => ({ schema: 1, strategy: 'binance_depth4_entropy_taker', mode: 'directional_research', enabled: !previousSession,
    suspendedReason, observedAt: previousSession ? base - 60000 : reportAt(),
    ...(previousSession ? { previousSession: { session: 'previous-scalper-session', stopped: false, heartbeatAt: new Date(base - 60000).toISOString() } } : {}),
    policy: { level: 4, maxHoldMs: 5000, cooldownMs: 10000, notionalPerTrade: 100,
      slippageBpsPerFill: 2, fundingReserveBpsPerRoundTrip: 2, latency: 'assumed',
      entry: 'bid1_crosses_ask4_or_ask1_crosses_bid4', exit: 'recross_trigger_or_hold_timeout_or_leader_invalid' },
    bySymbol: Object.fromEntries(['SNDK', 'ANTH'].map(symbol => [symbol, {
      leader: { status: 'available', nativeSymbol: `${symbol}USDT`, identityVerified: true, settlementEquivalence: symbol === 'SNDK', reason: null },
      scenarios: { 'base-assumed': scenario(symbol, 'base-assumed', 200), 'stress-assumed': scenario(symbol, 'stress-assumed', 500) },
    }])), openTasks: [], assumptions: { orderLatency: 'assumed_not_measured' } });
  const report = () => missingReport ? null : ({ session: 'scalper-fixture', mode: 'research', observedAt: reportAt(),
    observation: { asOf: reportAt(), silenceAfterMs: 10000 }, sessionConfig: config, configHash: 'scalper-fixture',
    startedAt: new Date(base - 60000).toISOString(), heartbeatAt: new Date(base + elapsed).toISOString(),
    stopped: state === 'stopped', paperSuspendedReason: null,
    counts: { books: 1200, candidates: 0, invalidated: 0, rejected: {} }, basis: {}, paper: {}, leaderMarkouts: {},
    diagnostics: { counts: {}, last: {}, rttMs: {} }, eventLoopDelayMs: { p50: 20, p95: 25, p99: 30 }, assumptions: {},
    latestQuotes: ['SNDK', 'ANTH'].flatMap(symbol => ['entropy', 'lighter', 'binance'].map(venue => ({ venue, symbol,
      nativeSymbol: `${symbol}-USD`, bid: venue === 'binance' ? sourcePrice : 100, ask: venue === 'binance' ? sourcePrice + 0.1 : 100.1,
      receivedAt: reportAt() - 100, sourceAt: reportAt() - 100, sourceClockUncertain: false, receiveAgeMs: 100, executionQuality: null }))),
    recentSpreads: { SNDK: [], ANTH: [] }, ...(!omitStrategy ? { binanceScalper: strategy() } : {}) });
  const snapshot = () => ({ schema: 1, enabled: state !== 'stopped', state, error: null,
    serverNow: base + elapsed, reportAgeMs: base + elapsed - reportAt(),
    heartbeatAt: new Date(base + elapsed).toISOString(), stale, config, report: report() });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  await page.clock.install({ time: new Date(base) });
  await page.clock.resume();
  await page.addInitScript(() => {
    window.__scalperOnline = true;
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => window.__scalperOnline });
    window.EventSource = class { close() {} };
  });
  await page.route(`${origin}/api/**`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'scalper-fixture-csrf' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/overview') return send({ projects: [], generatedAt: new Date(base + elapsed).toISOString() });
    if (path === '/api/system/updates') return send({ enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null });
    if (path === root) { reads.push(elapsed); return send(snapshot()); }
    if (path === `${root}/stop`) { writes.push(path); state = 'stopped'; return send(snapshot()); }
    throw new Error(`Unexpected fixture API: ${request.method()} ${path}`);
  });
  const refresh = async () => {
    const response = page.waitForResponse(value => new URL(value.url()).pathname === root);
    await page.getByRole('button', { name: '刷新研究数据' }).click(); await response; await page.waitForTimeout(30);
  };
  const advance = async ms => { elapsed += ms; await page.clock.runFor(ms); await page.waitForTimeout(30); };
  const panel = page.getByRole('region', { name: 'Binance 第4档方向研究', exact: true });
  const first = panel.getByRole('article', { name: '200 ms 延迟情景', exact: true });
  const overflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page has no horizontal overflow');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Entropy / Lighter', exact: true }).click();
  await panel.waitFor();
  elapsed = await page.evaluate(() => Date.now()) - base + 50;
  await page.clock.pauseAt(new Date(base + elapsed));
  assert(new URL(page.url()).searchParams.get('view') === 'research', 'fixture reaches the actual workbench research entry');
  assert((await panel.innerText()).includes('等待首份方向研究报告'), 'missing report does not fabricate strategy state');
  missingReport = false; omitStrategy = true; await refresh();
  assert((await panel.innerText()).includes('等待首份方向研究报告'), 'older report without scalper is compatible');
  omitStrategy = false; await refresh();
  assert(await panel.getByRole('article').count() === 2, 'default research runs both independent delay scenarios without verified symbols');
  assert((await first.innerText()).includes('双向条件已冻结'), 'five-second report sampling does not falsely expire the armed strategy at 750 ms');
  assert((await first.locator('.el-scalper-triggers').innerText()).includes('100.4') && (await first.locator('.el-scalper-triggers').innerText()).includes('99.6'), 'ask4 and bid4 frozen levels are readable');
  sourcePrice = 110; await refresh();
  assert((await first.locator('.el-scalper-triggers').innerText()).includes('100.4'), 'new top-of-book observations do not move the frozen trigger');
  assert((await first.locator('.el-scalper-metrics').innerText()).includes('100%'), 'loss percentage uses completed trades as its denominator');
  assert((await first.locator('.el-scalper-metrics').innerText()).includes('$400.00') && (await first.locator('.el-scalper-metrics').innerText()).includes('-US$0.70'), 'turnover and costed loss retain Entropy-only units');
  assert((await first.locator('.el-scalper-rebates').innerText()).includes('$0.40') && (await first.locator('.el-scalper-rebates').innerText()).includes('$0.50'), '110 and 120 percent results appear independently');
  await first.locator('.el-scalper-trades>summary').click();
  assert((await first.locator('.el-scalper-trades').innerText()).includes('反穿原触发价'), 'recent trades explain the exit reason');
  await panel.locator('.el-scalper-policy>summary').click();
  assert((await panel.locator('.el-scalper-policy').innerText()).includes('结果不可相加'), 'mutually exclusive scenario totals are not added');
  assert((await panel.locator('.el-scalper-policy').innerText()).includes('单个头寸整轮资金费预留'), 'single-position cost basis is disclosed');
  await overflow();
  await panel.screenshot({ path: 'output/playwright/entropy-lighter-scalper-desktop.png' });
  stage = 'holding'; await refresh();
  assert((await panel.locator('.el-scalper-conclusion').innerText()).includes('总收益未知'), 'unclosed exposure blocks a total profit claim');
  assert((await first.locator('.el-scalper-metrics').innerText()).includes('本会话返佣前净收益\n未知'), 'holding net is unknown despite completed history');
  assert((await first.locator('.el-scalper-rebates').innerText()).includes('本会话 110% 后净收益\n未知'), 'contingent rebates cannot make unclosed exposure known');
  assert((await first.locator('.el-scalper-trades').innerText()).includes('-US$0.70'), 'completed historical result remains visible while total net is unknown');
  stage = 'unresolved'; await refresh();
  assert((await panel.locator('.el-scalper-conclusion').innerText()).includes('存在未决敞口'), 'unresolved exposure blocks the research conclusion');
  assert((await first.innerText()).includes('平仓等待超时'), 'unresolved state has a readable cause');
  stage = 'armed'; stale = true; await refresh();
  assert((await first.locator('.el-scalper-stage').innerText()).includes('最近记录'), 'stale data is explicitly historical');
  assert(!(await panel.locator('.el-scalper-conclusion').innerText()).includes('最近采样'), 'stale report is not promoted to current evidence');
  stale = false; frozenAt = reportAt(); await refresh();
  await advance(16000);
  assert((await panel.locator('.el-scalper-conclusion').innerText()).includes('观测待更新'), 'monotonic clock withdraws old research state between report reads');
  frozenAt = null; await refresh();
  await page.clock.setSystemTime(new Date(base + elapsed + 3600000)); await refresh();
  assert(!(await first.locator('.el-scalper-stage').innerText()).includes('最近记录'), 'browser wall-clock skew does not expire server-anchored research');
  await page.evaluate(() => { window.__scalperOnline = false; window.dispatchEvent(new Event('offline')); });
  assert((await panel.locator('.el-scalper-conclusion').innerText()).includes('观测待更新'), 'offline view preserves history without current strategy claims');
  await page.evaluate(() => { window.__scalperOnline = true; window.dispatchEvent(new Event('online')); });
  await advance(300); await refresh();
  suspendedReason = 'fees_unavailable'; await refresh();
  assert((await panel.locator('.el-scalper-conclusion').innerText()).includes('研究暂停新增信号'), 'server suspension is visible');
  assert((await first.locator('.el-scalper-metrics').innerText()).includes('本会话返佣前净收益\n未知'), 'suspension does not claim known total net even without a listed position');
  previousSession = true; suspendedReason = 'previous_unclean_session'; await refresh();
  assert((await panel.locator('.el-scalper-conclusion').innerText()).includes('前次会话暂停，待核对历史敞口') && (await panel.locator('.el-scalper-conclusion').innerText()).includes('previous-scalper-session'), 'restart identifies the prior session without resuming execution');
  assert((await first.locator('.el-scalper-metrics').innerText()).includes('$400.00') && (await first.locator('.el-scalper-costs').innerText()).includes('$1.00'), 'restart retains known turnover and fees');
  assert((await first.locator('.el-scalper-metrics').innerText()).includes('上次会话返佣前净收益\n未知') && (await first.locator('.el-scalper-trades').innerText()).includes('-US$0.70'), 'restart keeps historical closed losses but total exposure unknown');
  assert((await panel.locator('.el-scalper-scope').innerText()).includes('统计限定所示会话'), 'session statistics are not presented as full-history totals');
  previousSession = false;
  suspendedReason = null; await refresh();
  await panel.getByRole('button', { name: 'ANTH', exact: true }).click();
  assert((await first.locator('.el-scalper-triggers').innerText()).includes('10,004'), 'symbol switching changes frozen direction prices');
  assert((await panel.innerText()).includes('ANTH 只看 Binance 方向，不比较两地价位'), 'ANTH explicitly avoids subtracting non-equivalent prices');
  assert(writes.length === 0, 'default strategy, symbol switching and research states send no trading writes');
  await page.setViewportSize({ width: 390, height: 844 });
  await overflow();
  await panel.screenshot({ path: 'output/playwright/entropy-lighter-scalper-mobile.png' });
  await page.getByRole('button', { name: '停止采集', exact: true }).click();
  await page.locator('.el-state.stopped').waitFor();
  assert((await panel.locator('.el-scalper-conclusion').innerText()).includes('采集已停止，保留历史研究'), 'stopped strategy cannot be presented as current');
  assert((await first.locator('.el-scalper-stage').innerText()).includes('最近记录'), 'stopped armed levels remain historical');
  assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
  await page.clock.resume();
  return { checks: 'missing/legacy report, automatic research, frozen depth4, independent delays, completed losses and rebates, holding/unresolved/suspended unknown, prior-session retained history, report/stop/offline freshness, wall-clock skew, symbol switch, portrait overflow', reads: reads.length, writes, errors };
}
