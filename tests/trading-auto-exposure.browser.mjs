// Run against the isolated production build on localhost:4175. All APIs are fixtures.
async (page) => {
  const origin = page.url() === 'about:blank' ? 'http://127.0.0.1:4175' : new URL(page.url()).origin;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):4175$/.test(origin)) throw new Error('Exposure fixture requires isolated localhost:4175');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [], writes = []; let reads = 0, version = 'exposure-v1', hold = false, release = null, fail = false;
  const stamp = () => new Date().toISOString();
  const config = { name: '敞口规则', market: 'oil', exchange: 'binance', direction: 'short', openThreshold: '4', closeThreshold: '2', equalSize: '1', orderType: 'chase', confirmSamples: 3, maxOpensPerDay: 3, batchCount: 1, batchIntervalMs: 1000, repriceIntervalMs: 5000, timeoutMs: 300000 };
  const rule = { id: '00000000-0000-4000-8000-000000000001', revision: 1, enabled: false, mode: 'observe', observing: true, createdAt: stamp(), title: '敞口规则', config,
    spread: { label: 'BZ − CL', unit: 'USDT/桶' }, state: { phase: 'idle', jobId: null, held: null, opensToday: 0, failures: 0, retryAt: null, reason: null, events: [] }, live: null };
  const auto = () => ({ generatedAt: stamp(), exposureVersion: version, maintenance: false, rules: [rule] });
  const total = quantity => ({ quantity, knownQuantity: quantity ?? '0', unknownCount: quantity === null ? 1 : 0, notional: quantity === null ? null : String(Number(quantity) * 70) });
  const exposure = () => ({ generatedAt: stamp(), startedAt: stamp(), expiresAt: new Date(Date.now() + 10_000).toISOString(), maxAgeMs: 10_000, rulesVersion: version, complete: false,
    scope: '配置目标包含停用与只观察规则；四列分别展示，不相加。', gaps: [], groups: ['short', 'long'].map((side, index) => ({ id: side, exchange: 'binance', symbol: 'BZUSDT', accountKey: 'fixture-account', accountLabel: '账户 fixture', instrumentId: 'BZUSDT', unit: '桶', contractSize: '1', quoteAsset: 'USDT', side, currentAccount: true, accountAt: stamp(), quoteAt: stamp(),
      target: total(index ? '2' : '0.3'), held: total('0'), actual: { quantity: index ? '4' : null, notional: index ? '280' : null }, sharedRuleIds: ['one', 'two', 'reverse'],
      rules: [{ id: rule.id, title: rule.title, mode: 'observe', enabled: false, observing: true, phase: 'idle', quantity: index ? '2' : '0.3', heldQuantity: null, waitingFor: ['task-unknown'] }],
      jobs: [{ id: 'task-unknown', ruleId: null, status: 'attention', action: 'open', accountMatches: true, remainingQuantity: null }],
      orders: { buyQuantity: null, sellQuantity: null, unknownCount: 1, items: [{ id: 'unknown-order', kind: 'order', side: 'buy', remainingQuantity: null, positionSide: null, reduceOnly: null }] },
      gaps: ['在途委托数量未确认，不能当作零'] })) });
  await page.context().setOffline(false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.install();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (request.method() !== 'GET') { writes.push(path); return send({ error: 'This fixture permits reads only' }, 405); }
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'exposure-fixture-csrf' });
    if (path === '/api/overview/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: stamp() })}\n\n` });
    if (path === '/api/overview' || path === '/api/projects') return send({ projects: [], generatedAt: stamp() });
    if (path === '/api/trading/execution') return send({ generatedAt: stamp(), connections: [], positions: [], jobs: [] });
    if (path === '/api/trading/execution/quotes') return send({ generatedAt: stamp(), maxAgeMs: 10_000, books: [] });
    if (path === '/api/trading/execution/auto') return send(auto());
    if (path === '/api/trading/execution/auto/exposure') {
      reads++; const value = exposure();
      if (hold) await new Promise(resolve => { release = resolve; });
      return fail ? send({ error: '模拟敞口读取失败' }, 503) : send(value);
    }
    return send({ error: 'Not part of the exposure fixture' }, 503);
  });
  await page.goto(`${origin}/?view=trading&tradingSection=auto`);
  const panel = page.locator('section.auto-exposure'), refresh = panel.getByRole('button', { name: '刷新敞口' });
  await refresh.waitFor(); assert(await refresh.isEnabled(), 'rule version enables manual read');
  await page.clock.runFor(3100); assert(reads === 0, 'regular rule polling does not read exposure');
  await refresh.click(); await panel.getByRole('article', { name: 'Binance BZUSDT 空头敞口' }).waitFor();
  const short = panel.getByRole('article', { name: 'Binance BZUSDT 空头敞口' }), long = panel.getByRole('article', { name: 'Binance BZUSDT 多头敞口' });
  assert((await short.innerText()).includes('配置目标合计：0.3 桶'), 'same-direction total remains exact');
  assert((await long.innerText()).includes('配置目标合计：2 桶'), 'reverse direction stays separate');
  assert((await short.innerText()).includes('账户真实仓位：未知'), 'unknown positions never show zero');
  assert((await short.innerText()).includes('买入余量 未知'), 'unknown orders never show zero');
  assert((await short.innerText()).includes('这是同一委托，不能相加'), 'unassigned orders shown in both directions cannot be summed');
  assert((await short.innerText()).includes('3 条规则共享合约'), 'sharing is visible');
  assert((await short.innerText()).includes('观察运行中'), 'target activation status stays visible');
  await page.clock.runFor(10_100); await panel.getByText('敞口证据已过期，请手动刷新；旧合计已撤回。').waitFor();
  assert(await panel.getByRole('article').count() === 0, 'expiry retracts every old aggregate'); assert(reads === 1, 'expiry does not poll');
  await refresh.click(); await short.waitFor();
  await page.context().setOffline(true); await panel.getByText('网络离线，已撤回旧敞口结果。').waitFor();
  assert(await panel.getByRole('article').count() === 0, 'offline retracts results');
  await page.context().setOffline(false); await panel.getByText('网络已恢复，请手动刷新取得当前证据。').waitFor();
  assert(reads === 2, 'network recovery does not automatically fetch exposure');
  hold = true; await refresh.click();
  await page.waitForFunction(() => document.querySelector('.auto-exposure')?.textContent.includes('读取中'));
  for (let attempt = 0; !release && attempt < 100; attempt++) await page.waitForTimeout(10);
  assert(release, 'delayed exposure request reached the fixture');
  version = 'exposure-v2';
  await page.locator('section.auto-panel').getByRole('button', { name: '刷新', exact: true }).click();
  await panel.getByText('规则或运行状态已变化，请手动刷新敞口。').waitFor();
  hold = false; release(); release = null;
  await page.waitForTimeout(100);
  assert(await panel.getByRole('article').count() === 0, 'late response for the old rules is discarded');
  fail = true; await refresh.click(); await panel.getByText('模拟敞口读取失败').waitFor();
  assert(await panel.getByRole('article').count() === 0, 'failed manual read never restores old evidence');
  fail = false; await refresh.click(); await short.waitFor();
  await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(100);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'exposure panel stays inside narrow viewport');
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert(writes.length === 0, 'exposure actions issue no writes'); assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
  return { exposureReads: reads, writes: writes.length, scenarios: ['manual-only', 'directions', 'unknown', 'expiry', 'offline-reconnect', 'late-response', 'failure', 'narrow-layout'] };
}
