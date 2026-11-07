// Open about:blank, then run this file with playwright-cli run-code.
// All API intercepts are installed before navigating to isolated localhost:4175.
async (page) => {
  const origin = page.url() === 'about:blank' ? 'http://127.0.0.1:4175' : new URL(page.url()).origin;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):4175$/.test(origin)) throw new Error('Auto rule fixture requires isolated localhost:4175');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pageErrors = [], writes = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const stamp = () => new Date().toISOString();
  let rules = [];
  const auto = () => ({ generatedAt: stamp(), maintenance: false, rules });
  const ruleOf = (config, enabled) => ({ id: '00000000-0000-4000-8000-000000000001', revision: 0, enabled, createdAt: stamp(), title: 'Binance 原油做空价差', config,
    spread: { label: 'BZ − CL', unit: 'USDT/桶' },
    state: { phase: 'idle', jobId: null, held: null, opensToday: 0, failures: 0, retryAt: null, reason: null, events: [{ time: stamp(), message: '规则已创建并启用' }] },
    live: { hits: 1, value: 4.2, met: true, side: 'sell', at: stamp(), note: null } });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const send = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'auto-fixture-csrf' });
    if (url.pathname === '/api/overview/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: stamp() })}\n\n` });
    if (url.pathname === '/api/overview') return send({ projects: [], generatedAt: stamp() });
    if (url.pathname === '/api/trading/execution' && method === 'GET') return send({ generatedAt: stamp(), connections: [], positions: [], jobs: [] });
    if (url.pathname === '/api/trading/execution/quotes') return send({ generatedAt: stamp(), maxAgeMs: 10_000, books: [] });
    if (url.pathname === '/api/trading') return send({ error: '只读账本不在本用例范围' }, 503);
    if (url.pathname === '/api/trading/execution/auto' && method === 'GET') return send(auto());
    if (url.pathname.startsWith('/api/trading/execution/auto/')) {
      assert(request.headers()['x-csrf-token'] === 'auto-fixture-csrf', 'rule writes carry the session CSRF token');
      const body = JSON.parse(request.postData() || '{}'); writes.push({ method, path: url.pathname, body });
      if (url.pathname === '/api/trading/execution/auto/rules' && method === 'POST') { rules = [ruleOf(body.config, body.enabled === true)]; return send(auto(), 201); }
      const action = url.pathname.match(/\/rules\/[^/]+\/(enable|disable|reset)$/)?.[1];
      if (action === 'disable') { rules[0] = { ...rules[0], enabled: false, revision: rules[0].revision + 1, live: null }; return send(auto()); }
      if (action === 'reset') { rules[0] = { ...rules[0], enabled: false, revision: rules[0].revision + 1, live: null, state: { ...rules[0].state, phase: 'idle', reason: null } }; return send(auto()); }
      return send({ error: `Unexpected auto route ${method} ${url.pathname}` }, 404);
    }
    return send({ error: `Unexpected fixture API: ${method} ${url.pathname}` }, 404);
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const ledgerRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading');
  await page.goto(`${origin}/?view=trading&tradingSection=auto`);
  const panel = page.locator('section.auto-panel');
  await panel.getByText('尚无自动规则').waitFor();
  await ledgerRead;
  assert(await page.locator('.trading-initial').count() === 0, 'ledger placeholder stays out of the auto rules tab');
  assert(await page.locator('.execution-panel').count() === 1, 'execution panel locator stays unique');

  await panel.getByRole('button', { name: '新建规则' }).click();
  const form = panel.getByRole('form', { name: '新建自动规则' });
  await form.getByLabel('开仓阈值 · USDT/桶').fill('2');
  await form.getByLabel('平仓阈值 · USDT/桶').fill('4');
  await form.getByLabel('每腿桶数 · 桶').fill('10');
  await form.getByRole('button', { name: '保存规则' }).click();
  await form.getByText('做空价差时，平仓阈值须低于开仓阈值。').waitFor();
  assert(writes.length === 0, 'invalid thresholds are not sent');
  await form.getByLabel('开仓阈值 · USDT/桶').fill('4');
  await form.getByLabel('平仓阈值 · USDT/桶').fill('2');
  await form.getByLabel('保存后立即启用').check();
  await form.getByRole('button', { name: '保存并启用' }).click();
  assert(writes.length === 0, 'enabling on save needs the live-trading confirmation');
  await form.getByLabel('我确认此规则会使用实盘账户自动开仓和平仓').check();
  await form.getByRole('button', { name: '保存并启用' }).click();
  await panel.getByText('规则已保存并启用。').waitFor();
  const created = writes.at(-1);
  assert(created.body.enabled === true && created.body.confirmLive === true, 'create carries explicit live confirmation');
  assert(JSON.stringify(created.body.config) === JSON.stringify({ name: '', market: 'oil', exchange: 'binance', direction: 'short', openThreshold: '4', closeThreshold: '2', equalSize: '10', orderType: 'chase', confirmSamples: 3, maxOpensPerDay: 3, batchCount: 1, batchIntervalMs: 1000, repriceIntervalMs: 5000, timeoutMs: 300000 }), `config body ${JSON.stringify(created.body.config)}`);

  const card = panel.getByRole('article', { name: '自动规则 Binance 原油做空价差' });
  await card.getByText('当前开仓可成交价差（卖出价差）：').waitFor();
  assert((await card.innerText()).includes('4.2000 USDT/桶'), 'live executable spread is shown with its unit');
  assert((await card.innerText()).includes('连续满足 1 / 3 次'), 'confirmation progress is shown');
  assert((await card.innerText()).includes('开仓：价差 ≥ 4 USDT/桶 · 平仓：价差 ≤ 2 USDT/桶'), 'conditions are shown');

  // A job that did not complete leaves the rule in review on the next poll.
  rules[0] = { ...rules[0], enabled: false, revision: 1, live: null, state: { ...rules[0].state, phase: 'review', reason: '开仓任务已停止。已停用规则；请在执行进度中核对成交与仓位，处理后重置规则' } };
  const reviewCard = panel.getByRole('article', { name: '自动规则 Binance 原油做空价差' });
  await reviewCard.getByRole('alert').filter({ hasText: '开仓任务已停止' }).waitFor({ timeout: 8000 });
  assert(await reviewCard.getByRole('button', { name: '启用' }).count() === 0, 'a rule in review cannot be enabled');
  const reset = reviewCard.getByRole('button', { name: '重置为等待开仓' });
  assert(await reset.isDisabled(), 'reset needs an acknowledgement');
  await reviewCard.getByLabel('我已核对并自行处理成交与仓位').check();
  await reset.click();
  await panel.getByText('规则已重置为等待开仓，需要重新启用。').waitFor();
  const resetWrite = writes.at(-1);
  assert(resetWrite.body.acknowledge === true && resetWrite.body.revision === 1, 'reset sends the acknowledgement and current revision');
  const idleCard = panel.getByRole('article', { name: '自动规则 Binance 原油做空价差' });
  assert(await idleCard.getByRole('button', { name: '启用' }).isDisabled(), 'enable waits for the live-trading confirmation');

  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(200);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'narrow layout has no page-level horizontal scroll');
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  return { writes: writes.length };
}
