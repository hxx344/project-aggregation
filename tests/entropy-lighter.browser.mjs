// Run with playwright-cli run-code --filename against a production preview on port 4176.
async (page) => {
  const origin = 'http://127.0.0.1:4176';
  const root = '/api/research/entropy-lighter';
  const assert = (value, text) => { if (!value) throw new Error(text); };
  const errors = [], writes = [], reads = [], held = [];
  const base = Date.parse('2026-10-27T02:00:00Z');
  let elapsed = 0, state = 'running', failSave = false, failRead = false, stale = false, expire = false, holdNext = false;
  let config = {
    schema: 1, region: 'Tokyo', recordRaw: true, maxDataMb: 2048, retentionDays: 7,
    maxBookAgeMs: 750, maxSourceAgeMs: 2000, maxPairSkewMs: 500, sampleIntervalMs: 250,
    simulation: { enabled: false, verifiedSymbols: [], entropyTakerFeeBps: null, lighterTakerFeeBps: 0,
      notionalPerLeg: 100, minEntryEdgeBps: 15, slippageBpsPerFill: 2, fundingReserveBpsPerRoundTrip: 2,
      holdMs: 5000, fillWaitMs: 2000, cooldownMs: 10000, rebateRatios: [0, 1.1, 1.2],
      latencyScenarios: [{ name: 'base-assumed', entropyMs: 200, lighterMs: 450 }, { name: 'stress-assumed', entropyMs: 500, lighterMs: 800 }] },
  };
  let sessionConfig = structuredClone(config), omitSessionConfig = false;
  const report = () => ({
    session: 'fixture-research', mode: sessionConfig.simulation.enabled ? 'paper' : 'research',
    ...(!omitSessionConfig ? { sessionConfig: structuredClone(sessionConfig), configHash: 'fixture-config-hash' } : {}),
    startedAt: new Date(base - 60_000).toISOString(), heartbeatAt: new Date(base + elapsed).toISOString(),
    stopped: state === 'stopped', paperSuspendedReason: null,
    counts: { books: 1200, candidates: 2, invalidated: 1, rejected: { stale_receive: 2 } },
    basis: { SNDK: { samples: 10, meanBps: 7.25, minBps: 3, maxBps: 9 } },
    paper: sessionConfig.simulation.enabled ? { 'base-assumed': {
      completed: 1, failedLegs: 0, unresolved: 0, openTasks: 0, lossesBeforeRebate: 1,
      grossPnl: 0.5, fees: 1, costReserve: 0.2, netBeforeRebate: -0.7,
      turnover: { entropy: 500, lighter: 500 }, rebateScenarios: [{ ratio: 0, contingentRebate: 0, net: -0.7 }, { ratio: 1.1, contingentRebate: 1.1, net: 0.4 }],
    } } : {},
    leaderMarkouts: { 'SNDK:entropy:300': { samples: 4, directionHitRate: 0.75, meanSignedMoveBps: 1.25 } },
    diagnostics: { counts: { 'lighter:ws_connected': 1 }, last: { 'lighter:ws_connected': { at: base } }, rttMs: { 'entropy:http': [30, 40, 60], 'lighter:ws_ping': [20, 25, 30] } },
    eventLoopDelayMs: { p50: 20, p95: 25, p99: 30 }, assumptions: { orderLatency: 'assumed_not_measured' },
    latestQuotes: ['entropy', 'lighter'].map(venue => ({ venue, symbol: 'SNDK', nativeSymbol: venue === 'entropy' ? 'SNDK-USD' : 'SNDK', bid: 100, ask: 100.1,
      receivedAt: base + elapsed - (stale ? 60_000 : 100), sourceAt: base + elapsed - (stale ? 60_000 : 100), sourceClockUncertain: false })),
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
  const snapshot = () => ({ schema: 1, enabled: state !== 'stopped', state, error: null,
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
      if (path === `${root}/start`) { state = 'running'; sessionConfig = structuredClone(config); return send(snapshot()); }
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
  assert((await page.locator('.el-chart-readings').innerText()).includes('12'), 'latest chart values are visible without hovering');
  assert((await page.locator('.el-assumptions').first().innerText()).includes('Entropy 未知'), 'unknown Entropy fee is never rendered as zero');
  await page.locator('.el-chart .recharts-line-curve').first().waitFor();
  const path = await page.locator('.el-chart .recharts-line-curve').first().getAttribute('d');
  assert((path.match(/M/g) || []).length >= 3, 'explicit null samples and long time gaps break the line');
  await overflow();
  await page.screenshot({ path: 'output/playwright/entropy-lighter-desktop.png', fullPage: false });

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
  await page.getByLabel('启用成交模拟', { exact: true }).check();
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('启用模拟需要至少一个已核验标的，并填写两个平台的实际 taker 费率。', { exact: true }).waitFor();
  assert(writes.length === beforeValidation, 'invalid paper configuration is rejected locally');
  await page.getByLabel('SNDK', { exact: true }).check();
  await page.getByLabel('Entropy 实际 taker 费率（bps）', { exact: false }).fill('5');
  const lighterLatency = page.getByLabel('Lighter 延迟（ms）', { exact: true }).first();
  await lighterLatency.fill('299');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('base-assumed Lighter 延迟须在 300–10000 之间。', { exact: true }).waitFor();
  assert(writes.length === beforeValidation, 'Lighter Standard taker latency respects its 300ms floor');
  await lighterLatency.fill('450'); failSave = false;
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('配置已保存。', { exact: true }).waitFor();
  assert(config.simulation.notionalPerLeg === 250 && config.simulation.entropyTakerFeeBps === 5, 'full configuration is saved');
  assert(config.simulation.verifiedSymbols.join(',') === 'SNDK', 'unverified ANTH stays excluded');
  assert(config.maxDataMb === 2048 && config.simulation.latencyScenarios[1].name === 'stress-assumed', 'advanced configuration and fixed scenario identities are preserved');
  await page.getByRole('button', { name: '启动采集', exact: true }).click();
  await page.locator('.el-state.running').waitFor();
  assert(await notional.isDisabled(), 'starting re-locks configuration');
  await page.getByText('返佣前净收益（USD）', { exact: true }).waitFor();
  await page.getByText('假设返佣敏感性：按已知 Entropy 手续费计算，未到账', { exact: true }).waitFor();
  await page.getByRole('button', { name: '停止采集', exact: true }).click();
  await page.locator('.el-state.stopped').waitFor();
  await page.getByLabel('Entropy 实际 taker 费率（bps）', { exact: false }).fill('9');
  await lighterLatency.fill('600');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('配置已保存。', { exact: true }).waitFor();
  assert(config.simulation.entropyTakerFeeBps === 9 && config.simulation.latencyScenarios[0].lighterMs === 600, 'new configuration was saved');
  assert((await page.locator('.el-paper .el-assumptions').innerText()).includes('Entropy 5 bps'), 'old report retains its session fee after a new configuration is saved');
  assert((await page.locator('.el-paper tbody tr').first().innerText()).includes('E 200 / L 450 ms'), 'old report retains its session latency assumptions');
  omitSessionConfig = true; await refresh();
  assert((await page.locator('.el-paper .el-assumptions').innerText()).includes('该历史报告未记录参数'), 'legacy reports never borrow current configuration assumptions');
  omitSessionConfig = false;
  await page.getByRole('button', { name: '启动采集', exact: true }).click();
  await page.locator('.el-state.running').waitFor();
  await page.locator('.el-config>summary').click();

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
  await page.getByText('报告已过期', { exact: true }).waitFor();
  held.shift()(); await page.waitForTimeout(30);
  await page.getByText('报告已过期', { exact: true }).waitFor();
  assert((await page.locator('.el-chart-readings').innerText()).includes('12'), 'stale refresh retains the chart');
  assert(await page.getByText('接收报价已过期', { exact: true }).count() === 2, 'each quote independently reports its age');
  failRead = true; await refresh();
  await page.getByText(/研究数据读取失败：fixture read failed/).waitFor();
  assert(await page.locator('.el-chart .recharts-line-curve').count() === 2, 'HTTP failure preserves both historical series');
  failRead = false; stale = false; await refresh();
  await page.getByRole('button', { name: 'ANTH', exact: true }).click();
  await page.getByText('尚无 ANTH 可比较价差', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'SNDK', exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await overflow();
  await page.screenshot({ path: 'output/playwright/entropy-lighter-mobile.png', fullPage: false });
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
  return { checks: 'native-route, read-only controls, stop/save/start, validation, failed-save retention, chart gaps, polling/resume, stale/error preservation, mobile, download, expiry', writes: writes.length, reads: reads.length };
}
