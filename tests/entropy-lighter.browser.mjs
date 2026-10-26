// Run with playwright-cli run-code --filename against a production preview on port 4176.
async (page) => {
  const origin = 'http://127.0.0.1:4176';
  const root = '/api/research/entropy-lighter';
  const assert = (value, text) => { if (!value) throw new Error(text); };
  const errors = [], writes = [], reads = [], held = [];
  const base = Date.parse('2026-10-27T02:00:00Z');
  let elapsed = 0, state = 'running', failSave = false, failRead = false, stale = false, expire = false, holdNext = false;
  let frozenReportAt = null, sourceClockUncertain = false, legacyFreshness = false, strictQuoteQuality = null, evidenceLagMs = 0, insightStatusOverride = null;
  let feeStatus = 'available', currentFeeBps = 0.9, evaluationFeeBps = 0.9, frozenFeeExpiresAt = null, omitAutomaticFees = false, omitEvaluationFeeSnapshot = false;
  let currentFeePatch = {}, lockedFeeExpired = false, mismatchedEvaluation = null;
  const reportAt = () => base + (frozenReportAt ?? elapsed) - (stale ? 60_000 : 5000);
  let config = {
    schema: 1, region: 'Tokyo', recordRaw: true, maxDataMb: 2048, retentionDays: 7,
    maxBookAgeMs: 750, maxSourceAgeMs: 2000, maxPairSkewMs: 500, sampleIntervalMs: 250,
    simulation: { enabled: false, verifiedSymbols: ['SNDK'], entropyTakerFeeBps: null, lighterTakerFeeBps: null,
      notionalPerLeg: 100, minEntryEdgeBps: 15, slippageBpsPerFill: 2, fundingReserveBpsPerRoundTrip: 2,
      holdMs: 5000, fillWaitMs: 2000, cooldownMs: 10000, rebateRatios: [0, 1.1, 1.2],
      latencyScenarios: [{ name: 'base-assumed', entropyMs: 200, lighterMs: 450 }, { name: 'stress-assumed', entropyMs: 500, lighterMs: 800 }] },
  };
  let sessionConfig = structuredClone(config), omitSessionConfig = false;
  const feeSnapshot = (symbol, entropyBps = currentFeeBps) => {
    const fetchedAt = base - 10000, expiresAt = frozenFeeExpiresAt ?? fetchedAt + 600000;
    const known = feeStatus === 'available', effectiveBps = entropyBps * (symbol === 'ANTH' ? 2 : 1);
    const fact = (source, takerFeeBps) => ({ status: known ? 'available' : 'unavailable', takerFeeBps: known ? takerFeeBps : null,
      baseTakerBps: source === 'entropy' ? 4.5 : 0, growthMultiplier: source === 'entropy' ? 0.1 : null, deployerFeeScale: source === 'entropy' ? 1 : null,
      scope: 'public_default_tier_no_builder', accountTier: source === 'entropy' ? 'default' : 'standard',
      sourceUrls: [source === 'entropy' ? 'https://api.hyperliquid.xyz/info' : 'https://mainnet.zklighter.elliot.ai/api/v1/info'], fetchedAt, expiresAt, revision: `${source}-${entropyBps}`,
      reason: known ? null : 'fixture-source-unavailable', assumptions: [] });
    return { mode: 'auto', symbol, status: feeStatus, revision: `fixture-fees-${symbol}-${entropyBps}`, entropy: fact('entropy', effectiveBps), lighter: fact('lighter', 0),
      takerBps: { entropy: known ? effectiveBps : null, lighter: known ? 0 : null }, fetchedAt, expiresAt, rebateBasis: 'total_entropy_fees', rebateRatios: [1.1, 1.2] };
  };
  const report = () => ({
    session: 'fixture-research', mode: sessionConfig.simulation.enabled ? 'paper' : 'research',
    ...(!legacyFreshness ? { observedAt: reportAt(), observation: { asOf: reportAt(), silenceAfterMs: 10000 } } : {}),
    ...(!omitSessionConfig ? { sessionConfig: structuredClone(sessionConfig), configHash: 'fixture-config-hash' } : {}),
    ...(!omitAutomaticFees ? { automaticFees: { mode: 'auto', rebateBasis: 'total_entropy_fees', rebateRatios: [1.1, 1.2], bySymbol: Object.fromEntries(['SNDK', 'ANTH'].map(symbol => [symbol, { ...feeSnapshot(symbol), ...currentFeePatch }])) } } : {}),
    startedAt: new Date(base - 60_000).toISOString(), heartbeatAt: new Date(base + elapsed).toISOString(),
    stopped: state === 'stopped', paperSuspendedReason: null,
    counts: { books: 1200, candidates: 2, invalidated: 1, rejected: { stale_receive: 2 } },
    basis: { SNDK: { samples: 10, meanBps: 7.25, minBps: 3, maxBps: 9 } },
    paper: sessionConfig.simulation.enabled ? { 'base-assumed': {
      completed: 1, failedLegs: 0, unresolved: 0, openTasks: 0, lossesBeforeRebate: 1,
      grossPnl: 0.5, fees: 1, costReserve: 0.2, netBeforeRebate: -0.7,
      turnover: { entropy: 500, lighter: 500 }, rebateScenarios: [{ ratio: 0, contingentRebate: 0, net: -0.7 }, { ratio: 1.1, contingentRebate: 1.1, net: 0.4 }, { ratio: 1.2, contingentRebate: 1.2, net: 0.5 }],
    } } : {},
    leaderMarkouts: { 'SNDK:entropy:300': { samples: 4, directionHitRate: 0.75, meanSignedMoveBps: 1.25 } },
    diagnostics: { counts: { 'lighter:ws_connected': 1 }, last: { 'lighter:ws_connected': { at: base } }, rttMs: { 'entropy:http': [30, 40, 60], 'lighter:ws_ping': [20, 25, 30] } },
    eventLoopDelayMs: { p50: 20, p95: 25, p99: 30 }, assumptions: { orderLatency: 'assumed_not_measured' },
    latestQuotes: ['SNDK', 'ANTH'].flatMap(symbol => ['entropy', 'lighter', 'binance'].map(venue => ({ venue, symbol, nativeSymbol: venue === 'entropy' ? `${symbol}-USD` : symbol, bid: 100, ask: 100.1,
      receivedAt: reportAt() - 100, sourceAt: reportAt() - (sourceClockUncertain ? 3_600_000 : 100), sourceClockUncertain,
      ...(!legacyFreshness ? { receiveAgeMs: 100, executionQuality: sourceClockUncertain ? 'stale_source' : strictQuoteQuality } : {}) }))),
    recentSpreads: { SNDK: [
      { at: base - 20000, midBasisBps: 3, takerEdgeBps: 6, buy: 'entropy', sell: 'lighter', sourceClockUncertain: false },
      { at: base - 18000, midBasisBps: 5, takerEdgeBps: 8, buy: 'entropy', sell: 'lighter', sourceClockUncertain: false },
      { at: base - 16000, midBasisBps: null, takerEdgeBps: null, buy: null, sell: null, sourceClockUncertain: true },
      { at: base - 14000, midBasisBps: 7, takerEdgeBps: 10, buy: 'entropy', sell: 'lighter', sourceClockUncertain: true },
      { at: base - 12000, midBasisBps: 6, takerEdgeBps: 9, buy: 'entropy', sell: 'lighter', sourceClockUncertain: true },
      { at: base - 2000, midBasisBps: 8, takerEdgeBps: 11, buy: 'entropy', sell: 'lighter', sourceClockUncertain: false },
      { at: base, midBasisBps: 9, takerEdgeBps: 12, buy: 'entropy', sell: 'lighter', sourceClockUncertain: false },
    ], ANTH: [] },
  });
  const feesKnown = () => feeStatus === 'available';
  const evaluation = (symbol, kind = 'raw') => {
    const quantity = sessionConfig.simulation.notionalPerLeg / 100, locked = feeSnapshot(symbol, evaluationFeeBps);
    if (lockedFeeExpired) locked.expiresAt = base - 1;
    if (mismatchedEvaluation === kind) locked.revision += '-old';
    const entropyFees = feesKnown() ? sessionConfig.simulation.notionalPerLeg * 2 * locked.takerBps.entropy / 10000 : null;
    const gross = (insightStatusOverride === 'no_edge' ? 0.06 : 0.8) * quantity;
    const costs = entropyFees === null ? null : entropyFees + 0.06 * quantity;
    const surplus = costs === null ? null : gross - costs;
    return { at: reportAt() - evidenceLagMs, quantity, buyPrice: 100, sellPrice: 100.8, buyNotional: sessionConfig.simulation.notionalPerLeg, sellNotional: sessionConfig.simulation.notionalPerLeg * 1.008,
      grossCash: gross, grossBps: gross / sessionConfig.simulation.notionalPerLeg * 10000,
      costs: { feesRoundTripCash: entropyFees, exitSlippageReserveCash: 0.04 * quantity, fundingReserveCash: 0.02 * quantity, totalReserveCash: costs },
      surplusBeforeRebateCash: surplus, surplusBeforeRebateBps: surplus === null ? null : surplus / sessionConfig.simulation.notionalPerLeg * 10000,
      entropyRoundTripFeesCash: entropyFees,
      ...(!omitEvaluationFeeSnapshot ? { feeSnapshot: locked } : {}),
      rebates: sessionConfig.simulation.rebateRatios.map(ratio => ({ ratio, contingentRebateCash: entropyFees === null ? null : entropyFees * ratio, surplusCash: surplus === null || entropyFees === null ? null : surplus + entropyFees * ratio })),
      gatePassed: feesKnown() && insightStatusOverride !== 'no_edge', sourceTimeUncertain: false };
  };
  const metrics = (symbol, kind = 'raw') => ({ name: 'base-assumed', feeRevision: evaluation(symbol, kind).feeSnapshot?.revision, buy: 'entropy', sell: 'lighter', scenario: { name: 'base-assumed', entropyMs: 200, lighterMs: 450 }, attempts: 40, completed: 40, failed: 0, costed: feesKnown() ? 40 : 0, passedAfterCosts: feesKnown() ? 40 : 0, spanMs: 600000,
    qualitySpanMs: 310000, qualityFirstAt: base - 310000, qualityLastAt: base,
    latest: evaluation(symbol, kind), completionRate: 1, passRate: feesKnown() ? 1 : null, meanSurplusBps: feesKnown() ? 54 : null, sampleReady: feesKnown() });
  const insights = () => ({ asOf: reportAt(), reportAgeMs: base + elapsed - reportAt(), reportCurrent: !stale && state === 'running', evidenceMaxAgeMs: 18000,
    summary: { status: 'observing', title: '先看观测结论', reason: '把价差换成金额，结合成本与延迟判断。' },
    bySymbol: Object.fromEntries(['SNDK', 'ANTH'].map(symbol => [symbol, {
      status: symbol === 'ANTH' || !sessionConfig.simulation.verifiedSymbols.includes(symbol) ? 'verify_equivalence' : insightStatusOverride || (feesKnown() ? 'paper_candidate' : 'unknown_costs'),
      title: symbol === 'ANTH' ? '先核验合约身份' : insightStatusOverride === 'no_edge' ? '当前价差覆盖不了整轮成本' : feesKnown() ? '值得纸面验证' : '等待自动费用',
      reason: symbol === 'ANTH' ? '同名不代表相同资产，暂不推荐收敛套利。' : insightStatusOverride === 'no_edge' ? '本轮价差不足以覆盖整轮成本。' : feesKnown() ? '本轮样本扣除成本和延迟后仍有余量。' : '公开费率自动获取中，行情继续采集。',
      direction: { buy: 'entropy', sell: 'lighter' }, raw: evaluation(symbol), rawMetrics: metrics(symbol), delayed: [metrics(symbol, 'delayed')], bestDelayed: metrics(symbol, 'delayed'),
      notional: { buyCash: sessionConfig.simulation.notionalPerLeg, sellCash: sessionConfig.simulation.notionalPerLeg * 1.008, approxRoundTripTurnoverCash: sessionConfig.simulation.notionalPerLeg * 4.016 },
      blockers: [], nextSteps: [symbol === 'ANTH' ? '核对底层资产与结算口径。' : '继续采集并核对不同延迟情景。'], caveat: '入场余量不是已实现利润。',
    }])), leader: { status: 'unproven', title: '领先策略待验证', reason: 'Binance 只用于观察相关反应，不证明可交易的领先。', samples: 4, nextSteps: [] }, paper: { scope: 'all_symbols', unresolved: false, openTasks: 0 } });
  const snapshot = () => ({ schema: 1, enabled: state !== 'stopped', state, error: null,
    ...(!legacyFreshness ? { serverNow: base + elapsed, reportAgeMs: base + elapsed - reportAt(), insights: insights() } : {}),
    heartbeatAt: new Date(base + elapsed - (stale ? 60000 : 0)).toISOString(), stale, config, report: report() });
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date(base) });
  await page.addInitScript(() => {
    window.__researchHidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__researchHidden });
    window.EventSource = class { close() {} };
  });
  await page.route(`${origin}/api/**`, async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'research-fixture-csrf' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/overview') return send({ projects: [], generatedAt: new Date(base + elapsed).toISOString() });
    if (path === '/api/system/updates') return send({ enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null });
    if (path === `${root}/report`) return send({ report: report() });
    if (path === root) {
      reads.push(elapsed);
      if (expire) return send({ error: '登录已过期' }, 401);
      if (failRead) return send({ error: 'fixture read failed' }, 503);
      const value = snapshot();
      if (holdNext) { holdNext = false; await new Promise(resolve => held.push(resolve)); }
      return send(value);
    }
    if (path.startsWith(`${root}/`)) {
      assert(req.headers()['x-csrf-token'] === 'research-fixture-csrf', 'writes use the workbench CSRF helper');
      writes.push({ path, method: req.method(), body: req.postDataJSON() });
      if (path === `${root}/stop`) { state = 'stopped'; return send(snapshot()); }
      if (path === `${root}/start`) { state = 'running'; sessionConfig = structuredClone(config); evaluationFeeBps = currentFeeBps; return send(snapshot()); }
      if (path === `${root}/config`) {
        assert(req.method() === 'PUT' && state === 'stopped', 'configuration only saves while stopped');
        if (failSave) return send({ error: 'fixture save rejected' }, 400);
        config = req.postDataJSON().config; return send(snapshot());
      }
    }
    return send({ error: `Unexpected fixture API: ${path}` }, 404);
  });
  const response = () => page.waitForResponse(r => new URL(r.url()).pathname === root);
  const advance = async (ms, expectedReads = null) => {
    const before = reads.length; elapsed += ms; await page.clock.runFor(ms); await page.waitForTimeout(30);
    if (expectedReads !== null) assert(reads.length - before === expectedReads, `expected ${expectedReads} research reads; got ${reads.length - before}`);
  };
  const refresh = async () => { const reading = response(); await page.getByRole('button', { name: '刷新研究数据' }).click(); await reading; await page.waitForTimeout(30); };
  const overflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page has no horizontal overflow');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Entropy / Lighter', exact: true }).click();
  await page.locator('.el-state.running').waitFor();
  // Let lazy-module loading and React's Suspense retry complete before freezing timers.
  elapsed = await page.evaluate(() => Date.now()) - base + 50;
  await page.clock.pauseAt(new Date(base + elapsed));
  assert(new URL(page.url()).searchParams.get('view') === 'research', 'native research route works without any monitor project');
  assert(await page.locator('iframe').count() === 0, 'research renders as a native workbench page');
  assert((await page.locator('.el-chart-readings').innerText()).includes('0.12'), 'latest chart percentages are visible without hovering');
  assert(await page.getByRole('article', { name: 'SNDK 研究结论' }).count() === 1 && await page.getByRole('article', { name: 'ANTH 研究结论' }).count() === 1, 'both symbols have readable conclusions');
  assert((await page.locator('.el-budget-heading').first().innerText()).includes('一轮双边开平成交额约 $401.60（示例）'), 'round-trip two-venue turnover is shown without extrapolating daily volume');
  assert((await page.locator('.el-budget').first().innerText()).includes('Entropy 0.2秒 / Lighter 0.45秒'), 'latency evidence uses full venue names and seconds on the main page');
  const sndkCard = page.getByRole('article', { name: 'SNDK 研究结论' });
  assert((await sndkCard.locator('.el-automatic-fees').innerText()).includes('Entropy 0.9 bps = 0.009%'), 'Entropy fees are available automatically without configuring a manual rate');
  assert((await sndkCard.locator('.el-automatic-fees').innerText()).includes('Lighter Standard 0 bps = 0%'), 'known Lighter Standard zero fee is displayed as a sourced public fee');
  assert((await page.getByRole('article', { name: 'ANTH 研究结论' }).locator('.el-automatic-fees').innerText()).includes('Entropy 1.8 bps'), 'automatic fees retain the symbol scope');
  assert(await sndkCard.locator('.el-rebate-row').count() === 2, '110 and 120 percent results are visible directly on each symbol card');
  assert((await sndkCard.locator('.el-rebate-row').first().innerText()).includes('$0.02') && (await sndkCard.locator('.el-rebate-row').first().innerText()).includes('$0.742'), '110 percent applies to the full Entropy fee and shows contingent rebate and surplus');
  assert((await sndkCard.locator('.el-rebate-row').last().innerText()).includes('$0.022') && (await sndkCard.locator('.el-rebate-row').last().innerText()).includes('$0.744'), '120 percent has a separate full-fee result');
  assert(await page.getByLabel('Entropy 实际 taker 费率（bps）', { exact: false }).count() === 0 && await page.getByLabel('假设返佣比例', { exact: false }).count() === 0, 'manual fee and rebate input controls are removed');
  await sndkCard.getByText('费用来源与更新时间', { exact: true }).click();
  assert(await sndkCard.getByRole('link', { name: 'api.hyperliquid.xyz', exact: true }).count() === 1, 'fee sources and update timestamps are accessible');
  await sndkCard.getByText('费用来源与更新时间', { exact: true }).click();
  feeStatus = 'unavailable'; await refresh();
  assert((await sndkCard.locator('.el-automatic-fees').innerText()).includes('自动获取中'), 'unavailable fees show automatic fetching');
  assert(!(await sndkCard.locator('.el-automatic-fees').innerText()).includes('Entropy 0 bps'), 'unavailable Entropy fee is not replaced with zero');
  assert((await sndkCard.locator('.el-rebate-row').first().innerText()).includes('待确认'), 'unknown fees leave rebate money unknown');
  feeStatus = 'available'; frozenFeeExpiresAt = base + elapsed + 1000; await refresh();
  assert(await page.locator('.el-conclusion.candidate').count() === 1, 'current automatic fees permit the research candidate before fee expiry');
  await advance(2100, 0);
  assert((await sndkCard.locator('.el-automatic-fees').innerText()).includes('费用已过期，待刷新'), 'fee expiry updates between report polls');
  assert(await page.locator('.el-conclusion.candidate').count() === 0 && await sndkCard.getByRole('heading', { name: '观测待更新', exact: true }).count() === 1, 'fee expiry withdraws the candidate in render ticks without a new GET');
  frozenFeeExpiresAt = null; await refresh();
  assert(await page.locator('.el-conclusion.candidate').count() === 1, 'refreshing still-equivalent current fees restores the candidate');
  assert(!await page.locator('.el-technical').evaluate(element => element.open), 'technical tables do not dominate the initial page');
  await page.locator('.el-chart .recharts-line-curve').first().waitFor();
  const path = await page.locator('.el-chart .recharts-line-curve').first().getAttribute('d');
  assert((path.match(/M/g) || []).length >= 3, 'explicit null samples and long time gaps break the line');
  await overflow();
  await page.screenshot({ path: 'output/playwright/entropy-lighter-desktop.png', fullPage: false });
  await page.locator('.el-insights').screenshot({ path: 'output/playwright/entropy-lighter-fees-desktop.png' });

  await page.locator('.el-technical>summary').click();
  assert((await page.locator('.el-paper .el-assumptions').innerText()).includes('每笔模拟按信号创建时锁定的费用版本结算'), 'paper results explain locked fee versions rather than a global session rate');
  assert(await page.locator('.el-quotes .el-quality.good').count() === 6, 'a report persisted five seconds ago still shows received market observations');
  await advance(5000, 1);
  assert(await page.locator('.el-quotes .el-quality.good').count() === 6, 'five-second report and five-second UI polling do not claim the feed stopped');
  await page.clock.setSystemTime(new Date(base + elapsed + 3_600_000));
  await refresh();
  assert(await page.locator('.el-quotes .el-quality.good').count() === 6, 'browser wall clock one hour ahead does not expire server observations');
  await page.clock.setSystemTime(new Date(base + elapsed));
  sourceClockUncertain = true; await refresh();
  assert(await page.locator('.el-quotes .el-quality.good').count() === 6, 'source clock uncertainty does not imply a silent feed');
  assert(await page.locator('.el-quotes .el-source-clock').count() === 6, 'source clock uncertainty is labeled independently');
  sourceClockUncertain = false; legacyFreshness = true; await refresh();
  assert(await page.locator('.el-quotes .el-quality.good').count() === 0, 'legacy reports cannot default to healthy quality');
  assert(await page.getByText('等待新版采样 / 质量未知', { exact: true }).count() === 6, 'legacy reports explain which quality evidence is missing');
  legacyFreshness = false; await refresh();
  await page.locator('.el-config>summary').click();
  const notional = page.getByLabel('每腿模拟名义金额（USD）');
  assert(await notional.isDisabled(), 'running configuration is read only');
  await page.getByRole('button', { name: '停止采集', exact: true }).click();
  await page.locator('.el-state.stopped').waitFor();
  await notional.fill('250');
  failSave = true;
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('fixture save rejected', { exact: true }).waitFor();
  assert(await notional.inputValue() === '250', 'rejected saves retain the exact draft');
  assert(await page.getByRole('button', { name: '保存配置', exact: true }).isEnabled(), 'an explicit rejection releases the save button');
  const beforeValidation = writes.length;
  await page.getByLabel('SNDK', { exact: true }).uncheck();
  await page.getByLabel('启用成交模拟', { exact: true }).check();
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('启用模拟需要至少一个已核验标的。', { exact: true }).waitFor();
  assert(writes.length === beforeValidation, 'invalid paper configuration is rejected locally');
  await page.getByLabel('SNDK', { exact: true }).check();
  const lighterLatency = page.getByLabel('Lighter 延迟（ms）', { exact: true }).first();
  await lighterLatency.fill('299');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('base-assumed Lighter 延迟须在 300–10000 之间。', { exact: true }).waitFor();
  assert(writes.length === beforeValidation, 'Lighter Standard taker latency respects its 300ms floor');
  await lighterLatency.fill('450'); failSave = false;
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('配置已保存。', { exact: true }).waitFor();
  assert(config.simulation.notionalPerLeg === 250 && config.simulation.entropyTakerFeeBps === null && config.simulation.lighterTakerFeeBps === null, 'paper configuration saves without manual fee values');
  assert(config.simulation.rebateRatios.join(',') === '0,1.1,1.2', 'rebate ratios remain fixed with a zero-rebate baseline');
  assert(config.simulation.verifiedSymbols.join(',') === 'SNDK', 'unverified ANTH stays excluded');
  assert(config.maxDataMb === 2048 && config.simulation.latencyScenarios[1].name === 'stress-assumed', 'advanced configuration and fixed scenario identities are preserved');
  await page.getByRole('button', { name: '启动采集', exact: true }).click();
  await page.locator('.el-state.running').waitFor();
  assert(await notional.isDisabled(), 'starting re-locks configuration');
  await page.getByText('返佣前净收益（USD）', { exact: true }).waitFor();
  await page.getByText('假设返佣敏感性：按已知 Entropy 手续费计算，未到账', { exact: true }).waitFor();
  await page.getByRole('button', { name: '停止采集', exact: true }).click();
  await page.locator('.el-state.stopped').waitFor();
  const lockedRebate = await sndkCard.locator('.el-rebate-results').innerText();
  currentFeeBps = 9;
  await lighterLatency.fill('600');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('配置已保存。', { exact: true }).waitFor();
  assert(config.simulation.entropyTakerFeeBps === null && config.simulation.latencyScenarios[0].lighterMs === 600, 'new configuration keeps automatic fees and saves the changed latency');
  assert((await sndkCard.locator('.el-automatic-fees').innerText()).includes('Entropy 9 bps'), 'a refreshed current fee is visible');
  assert(await sndkCard.locator('.el-rebate-results').innerText() === lockedRebate, 'updating current fees does not recalculate a previously evaluated sample');
  assert((await sndkCard.locator('.el-fee-lock').innerText()).includes('Entropy 0.9 bps'), 'the historical evaluation keeps its own fee snapshot');
  assert((await page.locator('.el-paper tbody tr').first().innerText()).includes('E 200 / L 450 ms'), 'old report retains its session latency assumptions');
  omitSessionConfig = true; omitAutomaticFees = true; omitEvaluationFeeSnapshot = true; await refresh();
  assert((await page.locator('.el-paper .el-assumptions').innerText()).includes('历史费用来源未知'), 'legacy reports never borrow current configuration fee assumptions');
  assert((await sndkCard.locator('.el-fee-lock').innerText()).includes('费用来源未知'), 'legacy evaluation results disclose missing fee provenance');
  assert((await sndkCard.locator('.el-rebate-row').first().innerText()).includes('$1.855'), 'legacy rebate amounts remain the original report values');
  omitSessionConfig = false; omitAutomaticFees = false; omitEvaluationFeeSnapshot = false;
  await page.getByRole('button', { name: '启动采集', exact: true }).click();
  await page.locator('.el-state.running').waitFor();
  await page.locator('.el-config>summary').click();
  assert(await page.locator('.el-conclusion.candidate').count() === 1, 'only verified SNDK can be a paper research candidate');
  lockedFeeExpired = true; await refresh();
  assert(await page.locator('.el-conclusion.candidate').count() === 1, 'same-revision current fee refresh remains valid even when the evaluation locks an older source expiry');
  lockedFeeExpired = false;
  for (const kind of ['raw', 'delayed']) {
    mismatchedEvaluation = kind; await refresh();
    assert(await page.locator('.el-conclusion.candidate').count() === 0 && await sndkCard.getByRole('heading', { name: '观测待更新', exact: true }).count() === 1, `a mismatched ${kind} evaluation fee revision withdraws the current conclusion`);
  }
  mismatchedEvaluation = null;
  for (const patch of [{ status: 'unavailable' }, { fetchedAt: base + elapsed + 10000 }, { expiresAt: null }, { revision: null }, { takerBps: { entropy: null, lighter: 0 } }]) {
    currentFeePatch = patch; await refresh();
    assert(await page.locator('.el-conclusion.candidate').count() === 0 && await sndkCard.getByRole('heading', { name: '观测待更新', exact: true }).count() === 1, 'invalid or incomplete current fees withdraw the candidate');
    assert(await sndkCard.locator('.el-automatic-fees .el-quality.good').count() === 0, 'invalid current fees cannot show an available fee badge');
  }
  for (const status of ['no_edge', 'latency_erases_edge', 'insufficient_samples']) {
    insightStatusOverride = status; await refresh();
    assert(await sndkCard.getByRole('heading', { name: '观测待更新', exact: true }).count() === 1, `${status} is also withdrawn when its current fee facts are invalid`);
  }
  currentFeePatch = {}; insightStatusOverride = null; await refresh();
  assert(await page.locator('.el-conclusion.candidate').count() === 1, 'valid current fee evidence restores the conclusion after malformed or mismatched reports');
  strictQuoteQuality = 'stale_receive'; evidenceLagMs = 7000; await refresh();
  assert(await page.locator('.el-conclusion.candidate').count() === 1, 'research evidence older than ten seconds remains valid within the server evidence window');
  assert(await page.getByText('该样本未满足模拟时效（stale_receive）', { exact: true }).count() === 6, 'strict execution freshness is disclosed independently from the research candidate');
  evidenceLagMs = 14000; await refresh();
  assert(await page.locator('.el-conclusion.candidate').count() === 0, 'a candidate is withdrawn when its research evidence exceeds the server evidence window');
  insightStatusOverride = 'no_edge'; evidenceLagMs = 12000; await refresh();
  await page.getByRole('heading', { name: '当前价差覆盖不了整轮成本', exact: true }).waitFor();
  assert(await page.locator('.el-conclusion.candidate').count() === 0, 'a negative pre-rebate strategy stays excluded despite a positive contingent rebate result');
  // The sample starts at age 17s; two 1s render ticks cross the strict >18s boundary before the next 5s poll.
  await advance(2100, 0);
  assert(await page.getByRole('article', { name: 'SNDK 研究结论' }).getByRole('heading', { name: '观测待更新', exact: true }).count() === 1, 'a negative conclusion also expires between reads when its research evidence ages out');
  insightStatusOverride = null;
  strictQuoteQuality = null; evidenceLagMs = 0; await refresh();
  frozenReportAt = elapsed;
  await advance(11000);
  assert(await page.locator('.el-conclusion.candidate').count() === 0, 'successful reads of an unchanged report older than fifteen seconds revoke the candidate');
  await page.getByRole('heading', { name: '观测保留，暂缓策略判断', exact: true }).waitFor();
  frozenReportAt = null; await refresh();
  assert(await page.locator('.el-conclusion.candidate').count() === 1, 'new evidence restores the paper research conclusion');

  // Polling is visible-only; wake events coalesce and a delayed pre-wake GET cannot win.
  await advance(5000, 1);
  await page.evaluate(() => { window.__researchHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenReads = reads.length, hiddenWrites = writes.length;
  await advance(20_000, 0);
  assert(state === 'running' && writes.length === hiddenWrites, 'hiding the page does not stop the server collector');
  await page.evaluate(() => { window.__researchHidden = false; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); });
  await advance(300, 1);
  assert(reads.length === hiddenReads + 1, 'wake event burst makes one read');
  holdNext = true; await advance(5000, 1);
  assert(held.length === 1, 'pre-wake request is held');
  stale = true;
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); });
  await advance(300, 1);
  await page.getByText('观测待更新 / 历史记录', { exact: true }).waitFor();
  held.shift()(); await page.waitForTimeout(30);
  await page.getByText('观测待更新 / 历史记录', { exact: true }).waitFor();
  assert((await page.locator('.el-chart-readings').innerText()).includes('0.12'), 'stale refresh retains the chart');
  assert(await page.getByText('历史记录，观测待更新', { exact: true }).count() === 6, 'old reports label retained quotes without claiming their current feed is disconnected');
  failRead = true; await refresh();
  await page.getByText(/研究数据读取失败：fixture read failed/).waitFor();
  assert(await page.locator('.el-chart .recharts-line-curve').count() === 2, 'HTTP failure preserves both historical series');
  assert(await page.locator('.el-conclusion.candidate').count() === 0, 'HTTP failure withdraws the current candidate conclusion');
  failRead = false; stale = false; await refresh();
  await page.getByRole('button', { name: 'ANTH', exact: true }).click();
  await page.getByText('尚无 ANTH 可比较价差', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'SNDK', exact: true }).click();

  await page.locator('.el-technical>summary').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.el-heading').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await overflow();
  await page.screenshot({ path: 'output/playwright/entropy-lighter-mobile.png', fullPage: false });
  await sndkCard.screenshot({ path: 'output/playwright/entropy-lighter-fees-mobile.png' });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载报告', exact: true }).click();
  assert((await downloadEvent).suggestedFilename().startsWith('entropy-lighter-'), 'report downloads as JSON');
  const writesBeforeLeaving = writes.length;
  await page.getByRole('navigation', { name: '快捷导航' }).getByRole('button', { name: '总览', exact: true }).click();
  await page.locator('.el-page').waitFor({ state: 'detached' });
  await advance(20_000, 0);
  assert(state === 'running' && writes.length === writesBeforeLeaving, 'leaving research stops UI reads only');
  await page.getByRole('button', { name: '更多导航', exact: true }).click();
  await page.getByRole('button', { name: 'Entropy / Lighter', exact: true }).click();
  await page.locator('.el-state.running').waitFor();
  expire = true; await advance(5000, 1);
  await page.getByRole('heading', { name: '进入工作台', exact: true }).waitFor();
  await advance(20_000, 0);
  assert(errors.length === 0, `no browser errors: ${errors.join('; ')}`);
  assert(writes.every(write => ['/stop', '/start', '/config'].some(suffix => write.path === root + suffix)), 'no exchange order writes occur');
  await page.clock.resume();
  return { checks: 'native-route, automatic-public-fees, symbol-fee-scope, 110/120-full-Entropy-fee-rebates, unavailable/expired-fees, locked-historical-fees, legacy-fee-provenance, readable conclusions, server/monotonic age, report/poll cadence, wall-clock skew, source-clock independence, legacy unknown quality, read-only controls, stop/save/start, validation, failed-save retention, chart gaps, polling/resume, stale/error withdrawal, mobile, download, expiry', writes: writes.length, reads: reads.length };
}
