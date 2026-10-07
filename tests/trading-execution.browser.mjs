// Open about:blank, then run this file with the existing Playwright fixture runner.
// Install all intercepts before navigating to the isolated localhost:4175 build.
// Every API request is intercepted. Never point this fixture at a real Hub session.
async (page) => {
  const origin = page.url() === 'about:blank' ? 'http://127.0.0.1:4175' : new URL(page.url()).origin;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):4175$/.test(origin)) throw new Error('Execution fixture requires isolated localhost:4175');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const stamp = () => new Date().toISOString();
  const requests = [], pageErrors = [], previews = new Map(), jobsByRequest = new Map(), expiredPreviews = new Set();
  let expire = false, readFailure = false, failFirstSubmit = true, dropNextBeforeSave = false, previewSequence = 0;
  let jobs = [];
  const connections = ['binance', 'bybit'].map(exchange => ({ exchange, connected: false, revision: 0, accountMode: exchange === 'binance' ? 'standard' : 'unified', identity: null, keyLabel: null, verifiedAt: null, locked: false }));
  const execution = () => ({ generatedAt: stamp(), connections: structuredClone(connections), positions: connections.flatMap(connection => ['CLUSDT', 'BZUSDT'].flatMap(symbol => ['long', 'short'].map(side => ({ exchange: connection.exchange, symbol, side, quantity: '2', fetchedAt: stamp() })))), jobs: structuredClone(jobs) });
  const readOnly = () => {
    const now = Date.now(), start = now - 7 * 86_400_000;
    return { mode: 'read-only', strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: stamp(), period: { days: 7, start: new Date(start).toISOString(), end: stamp() }, cache: { builtAt: stamp(), servedAt: stamp(), rebuilding: false },
      accounts: connections.map(connection => ({ exchange: connection.exchange, name: connection.exchange, connected: false, revision: 0, accountMode: connection.accountMode, verifiedAt: null, refreshing: false, positions: { state: 'unconfigured', fetchedAt: null, error: null }, funding: { state: 'unconfigured', fetchedAt: null, error: null, coverageStart: null, coverageEnd: null, complete: false } })),
      legs: connections.flatMap(connection => ['CLUSDT', 'BZUSDT'].map(symbol => ({ id: `${connection.exchange}:${symbol}`, exchange: connection.exchange, symbol, name: symbol, state: 'unconfigured', fetchedAt: null, positions: [], grossNotional: null, netNotional: null, unrealizedPnl: null, fundingNet: null, fundingComplete: false }))),
      pnl: { currency: 'USDT', intervalMs: 60_000, cumulativeStart: start, end: now, recordingStartedAt: null, pointCount: 0, points: [], latest: null, status: 'collecting' },
      structure: { state: 'unknown', message: '尚未连接只读观察账户' }, funding: { complete: false, income: null, expense: null, net: null, currency: 'USDT', events: [], pagination: { page: 0, pageSize: 50, total: 0, pages: 0 }, daily: [] } };
  };
  function makePreview(input) {
    const resume = input.resumeJobId ? jobs.find(job => job.id === input.resumeJobId) : null;
    if (input.resumeJobId) assert(resume, 'resume references an existing job');
    const plan = resume ? { preset: resume.preset, action: resume.action, legs: resume.legs.map(leg => ({ exchange: leg.exchange, symbol: leg.symbol, side: leg.side, quantity: leg.remainingQuantity, stopPrice: leg.stopPrice })), batchCount: 1, batchIntervalMs: 1000, repriceIntervalMs: 5000, timeoutMs: 300000 } : input;
    assert([2, 4].includes(plan.legs.length), 'preview has complete preset legs');
    assert(plan.legs.every(leg => typeof leg.quantity === 'string' && typeof leg.stopPrice === 'string'), 'financial inputs remain strings');
    const result = { ...plan, id: `fixture-preview-${++previewSequence}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), resumeJobId: input.resumeJobId || null,
      connections: connections.filter(connection => plan.legs.some(leg => leg.exchange === connection.exchange)),
      legs: plan.legs.map((leg, index) => ({ ...leg, id: `leg-${index}`, orderSide: (plan.action === 'open') === (leg.side === 'long') ? 'buy' : 'sell', positionMode: 'hedge', accountRevision: connections.find(connection => connection.exchange === leg.exchange).revision, currentQuantity: '2', batchQuantities: plan.batchCount === 2 ? ['1', '1'] : [leg.quantity], estimatedNotional: '140.123456789012345678', bid: '70.01', ask: '70.02', quoteAt: stamp() })),
      notes: ['模拟预览：不会访问交易所。'] };
    previews.set(result.id, structuredClone(result)); return result;
  }
  function makeJob(preview, id) {
    return { id, preset: preview.preset, action: preview.action, status: 'running', createdAt: stamp(), updatedAt: stamp(), deadlineAt: new Date(Date.now() + preview.timeoutMs).toISOString(), batchIndex: 0, batchCount: preview.batchCount, reason: null, canResume: false,
      legs: preview.legs.map(leg => ({ ...leg, filledQuantity: '0.5', remainingQuantity: '1.5', currentOrder: { id: leg.exchange === 'bybit' ? 'f6290c90-5a55-42cf-96b9-9c39d5f04f36' : leg.id === 'leg-0' ? null : `fixture-order-${leg.id}`, clientId: leg.exchange === 'binance' ? 'fixture-client-12345678901234567890123' : null, kind: leg.exchange === 'bybit' ? 'strategy' : 'order', state: '部分成交', lastCheckedAt: stamp(), price: '70.01', filledQuantity: '0.5', unknown: false } })),
      events: [{ time: stamp(), message: '模拟执行已受理，等待各腿完成。' }] };
  }
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    assert(url.origin === origin, 'fixture API never leaves isolated origin');
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    requests.push({ path: url.pathname, method, body });
    const send = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/session') return send({ authenticated: !expire, csrfToken: 'execution-fixture-csrf' });
    if (url.pathname === '/api/overview/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: stamp() })}\n\n` });
    if (url.pathname === '/api/overview' || url.pathname === '/api/projects') return send({ projects: [], generatedAt: stamp() });
    if (url.pathname === '/api/trading') return send(readOnly());
    if (url.pathname === '/api/trading/import-sources') return send({ sources: [] });
    if (!url.pathname.startsWith('/api/trading/execution')) return send({ error: 'Unexpected fixture API' }, 404);
    if (expire) return send({ error: '登录已过期' }, 401);
    if (method !== 'GET') assert(request.headers()['x-csrf-token'] === 'execution-fixture-csrf', 'execution writes carry current session CSRF');
    if (url.pathname === '/api/trading/execution' && method === 'GET') return readFailure ? send({ error: '模拟读取故障' }, 503) : send(execution());
    const account = url.pathname.match(/\/accounts\/(binance|bybit)$/)?.[1];
    if (account && method === 'PUT') {
      const connection = connections.find(value => value.exchange === account);
      assert(body.revision === connection.revision, 'connection uses current revision');
      assert(body.apiKey === `fixture_${account}_key` && body.apiSecret === `fixture_${account}_secret`, 'credentials only sent to connection endpoint');
      Object.assign(connection, { connected: true, revision: connection.revision + 1, accountMode: body.accountMode, identity: `fixture-${account}-uid`, keyLabel: '1234', verifiedAt: stamp() });
      return send(execution());
    }
    if (url.pathname.endsWith('/preview') && method === 'POST') return send(makePreview(body));
    if (url.pathname.endsWith('/jobs') && method === 'POST') {
      assert(body.confirmLive === true && typeof body.requestId === 'string', 'explicit review confirmation required');
      assert(Object.keys(body).sort().join(',') === 'confirmLive,previewId,requestId', 'submission cannot replace reviewed legs');
      // Match the service contract: accepted requests are recovered before expiry.
      if (jobsByRequest.has(body.requestId)) return send(execution(), 202);
      if (dropNextBeforeSave) { dropNextBeforeSave = false; expiredPreviews.add(body.previewId); return send({ error: '模拟服务未保存提交，请核对本次请求' }, 503); }
      if (expiredPreviews.has(body.previewId)) return send({ error: '预览已过期或已提交，请重新预览' }, 409);
      if (!jobsByRequest.has(body.requestId)) {
        const preview = previews.get(body.previewId); assert(preview, 'submission references server preview');
        const job = makeJob(preview, `fixture-job-${jobsByRequest.size + 1}`); jobsByRequest.set(body.requestId, job.id); jobs.unshift(job);
      }
      if (failFirstSubmit) { failFirstSubmit = false; return send({ error: '模拟响应丢失，提交结果尚未确认' }, 503); }
      return send(execution(), 202);
    }
    const stop = url.pathname.match(/\/jobs\/([^/]+)\/stop$/)?.[1];
    if (stop && method === 'POST') {
      const job = jobs.find(value => value.id === stop); assert(job, 'stop existing execution');
      job.status = 'stopped'; job.canResume = false; job.updatedAt = stamp(); job.reason = '余单已撤销，已成交仓位保留'; job.legs.forEach(leg => { leg.currentOrder = null; });
      return send(execution());
    }
    const reconcile = url.pathname.match(/\/jobs\/([^/]+)\/reconcile$/)?.[1];
    if (reconcile && method === 'POST') {
      const job = jobs.find(value => value.id === reconcile), leg = job?.legs.find(value => value.id === body.legId); assert(leg, 'reconcile targets known leg');
      if (leg.exchange === 'bybit' && !leg.currentOrder.id) assert(body.strategyId === 'fixture-manually-verified-strategy' && body.acknowledge === true, 'unknown Bybit strategy needs explicit identity acknowledgment');
      leg.currentOrder = { ...leg.currentOrder, id: body.strategyId || leg.currentOrder.id, unknown: false, state: '已撤销', lastCheckedAt: stamp() };
      return send(execution());
    }
    return send({ error: 'Unexpected execution fixture route' }, 404);
  });
  const refresh = async () => { const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/trading/execution' && value.request().method() === 'GET'); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await response; };
  const panel = page.locator('.execution-panel');
  const fillLegs = async () => {
    for (const leg of await panel.locator('.execution-leg-input').all()) {
      await leg.getByLabel('数量 · 原生合约单位', { exact: true }).fill('2');
      await leg.getByLabel(/追价停止/).fill(await leg.getByLabel(/买单追价/).count() ? '80' : '60');
    }
  };
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`${origin}/?view=trading`);
  await panel.getByRole('heading', { name: '组合交易', exact: true }).waitFor();
  assert(await panel.getByRole('button', { name: '预览开仓组合' }).isDisabled(), 'unconnected execution cannot preview');
  assert(await panel.getByRole('combobox', { name: '开仓方向', exact: true }).inputValue() === '', 'direction starts unselected');
  assert(requests.every(request => request.method === 'GET'), 'initial page and polling never write');

  await panel.locator('.execution-connections > summary').click();
  for (const exchange of ['binance', 'bybit']) {
    const name = exchange === 'binance' ? 'Binance' : 'Bybit';
    const form = panel.getByRole('form', { name: `${name} 实盘账户连接` });
    if (exchange === 'binance') await form.getByRole('combobox', { name: 'Binance 实盘账户模式', exact: true }).selectOption('portfolio-margin');
    await form.getByLabel(`${name} 实盘 API Key`, { exact: true }).fill(`fixture_${exchange}_key`);
    await form.getByLabel(`${name} 实盘 API Secret`, { exact: true }).fill(`fixture_${exchange}_secret`);
    await form.getByRole('button', { name: '验证并连接实盘账户' }).click();
    await form.getByText(`fixture-${exchange}-uid`, { exact: false }).waitFor();
    assert(await form.getByLabel(`${name} 实盘 API Secret`, { exact: true }).inputValue() === '', 'saved secret cleared from field');
  }
  await panel.locator('.execution-connections > summary').click();
  await panel.getByRole('combobox', { name: '开仓方向', exact: true }).selectOption('forward');
  assert(await panel.locator('.execution-leg-input').count() === 4, 'four-leg preset exposes four complete legs');
  for (const input of await panel.locator('.execution-leg-input input').all()) assert(await input.inputValue() === '', 'financial inputs start blank');
  await fillLegs(); await panel.getByLabel('拆分批数', { exact: true }).fill('2');
  await panel.getByRole('button', { name: '预览开仓组合' }).click();
  await panel.getByRole('heading', { name: '确认四腿组合开仓' }).waitFor();
  assert(requests.filter(request => request.path.endsWith('/jobs')).length === 0, 'preview creates no execution');
  assert(await panel.locator('.execution-review-legs article').count() === 4, 'review includes every leg');
  assert((await panel.locator('.execution-review').innerText()).includes('140.123456789012345678'), 'review retains fractional precision');
  await panel.screenshot({ path: 'output/playwright/trading-execution-desktop-preview.png' });
  await panel.getByRole('button', { name: '确认并一键开仓' }).click();
  await panel.getByText('本次提交结果尚未确认。', { exact: false }).waitFor();
  assert(await panel.getByRole('button', { name: '返回修改参数' }).isDisabled(), 'uncertain submission cannot be replaced by a fresh plan');
  await panel.getByRole('button', { name: '重新核对本次提交' }).click();
  await panel.getByText('组合已受理。实际成交与余单状态见执行进度。', { exact: true }).waitFor();
  const submits = requests.filter(request => request.path.endsWith('/jobs') && request.method === 'POST');
  assert(submits.length === 2 && submits[0].body.requestId === submits[1].body.requestId && jobs.length === 1, 'uncertain retry reuses one idempotency key and execution');
  assert(await panel.getByText('已全部成交', { exact: true }).count() === 0, 'accepted job is never shown as fully filled');
  await panel.getByText('客户单号：fixture-client-12345678901234567890123', { exact: true }).waitFor();
  assert(await panel.getByText('策略 ID：f6290c90-5a55-42cf-96b9-9c39d5f04f36', { exact: true }).count() === 2, 'exchange strategy IDs are visible for reconciliation');
  await panel.getByText('订单 ID：fixture-order-leg-1', { exact: true }).waitFor();
  await panel.screenshot({ path: 'output/playwright/trading-execution-desktop-progress.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'long order identifiers wrap within the mobile viewport');
  await panel.locator('.execution-jobs').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: 'output/playwright/trading-execution-mobile-order-ids.png' });
  await page.setViewportSize({ width: 1440, height: 1100 });

  jobs[0].status = 'paused'; jobs[0].canResume = true; jobs[0].reason = '模拟某腿暂停，保留已成交数量';
  await refresh(); await panel.getByRole('button', { name: '预览继续剩余' }).click();
  await panel.getByRole('heading', { name: '确认剩余数量的四腿组合开仓' }).waitFor();
  const resumed = requests.filter(request => request.path.endsWith('/preview')).at(-1).body;
  assert(Object.keys(resumed).join(',') === 'resumeJobId', 'resume preview is derived by the server');
  await panel.getByRole('button', { name: '返回修改参数' }).click();
  jobs[0].status = 'attention'; jobs[0].canResume = false;
  const unknown = jobs[0].legs.find(leg => leg.exchange === 'bybit'); unknown.currentOrder = { ...unknown.currentOrder, id: null, state: 'unknown', unknown: true };
  await refresh();
  const reconcileForm = panel.locator('.execution-reconcile');
  assert(await reconcileForm.getByRole('button', { name: '核对并停止策略余单' }).isDisabled(), 'unknown strategy is never guessed');
  await reconcileForm.getByLabel('对应策略 ID', { exact: true }).fill('fixture-manually-verified-strategy');
  await reconcileForm.getByLabel('我已核对这是此交易腿提交的策略').check();
  await reconcileForm.getByRole('button', { name: '核对并停止策略余单' }).click();
  await panel.getByText('核对请求已完成，请查看各腿最新状态。').waitFor();
  await panel.getByRole('button', { name: '停止并撤销余单' }).click();
  await panel.getByText('已请求停止，正在核对并撤销余单。已成交仓位保留。').waitFor();
  assert(jobs[0].legs.every(leg => leg.filledQuantity === '0.5'), 'stopping does not pretend to close filled positions');

  await panel.getByRole('button', { name: /^同所两腿/ }).click();
  await panel.getByRole('combobox', { name: '交易所', exact: true }).selectOption('bybit');
  await panel.getByRole('combobox', { name: '交易动作', exact: true }).selectOption('close');
  await panel.getByRole('combobox', { name: '待平仓方向', exact: true }).selectOption('reverse');
  assert(await panel.locator('.execution-leg-input').count() === 2, 'same-exchange preset has two legs');
  for (const leg of await panel.locator('.execution-leg-input').all()) {
    await leg.getByRole('button', { name: '填入当前数量' }).click();
    assert(await leg.getByLabel('数量 · 原生合约单位', { exact: true }).inputValue() === '2', 'close copies explicit current-side quantity only after click');
    await leg.getByLabel(/追价停止/).fill(await leg.getByLabel(/买单追价/).count() ? '80' : '60');
  }
  await panel.getByRole('button', { name: '预览平仓组合' }).click();
  await panel.getByRole('heading', { name: '确认同所两腿平仓' }).waitFor();
  const closePreview = [...previews.values()].at(-1);
  assert(closePreview.legs.every(leg => leg.exchange === 'bybit') && closePreview.legs[0].orderSide === 'buy' && closePreview.legs[1].orderSide === 'sell', 'close reverses order side while preserving position side');
  await panel.getByRole('button', { name: '返回修改参数' }).click();
  await panel.getByRole('button', { name: /^跨所两腿/ }).click();
  await panel.getByRole('combobox', { name: '合约', exact: true }).selectOption('BZUSDT');
  await panel.getByRole('combobox', { name: '待平仓方向', exact: true }).selectOption('forward');
  assert(await panel.locator('.execution-leg-input').count() === 2 && (await panel.locator('.execution-leg-inputs').innerText()).includes('Binance BZUSDT') && (await panel.locator('.execution-leg-inputs').innerText()).includes('Bybit BZUSDT'), 'cross-exchange preset preserves one symbol across both venues');

  await fillLegs(); dropNextBeforeSave = true;
  await panel.getByRole('button', { name: '预览平仓组合' }).click();
  await panel.getByRole('heading', { name: '确认跨所两腿平仓' }).waitFor();
  await panel.getByRole('button', { name: '确认并一键平仓' }).click();
  await panel.getByText('模拟服务未保存提交，请核对本次请求', { exact: true }).waitFor();
  assert(jobs.length === 1, 'failed pre-save submission creates no execution');
  assert(await panel.getByRole('button', { name: '返回修改参数' }).isDisabled(), 'uncertain pre-save result still freezes editing before retry');
  const unsavedRequest = requests.filter(request => request.path.endsWith('/jobs')).at(-1).body;
  await panel.getByRole('button', { name: '重新核对本次提交' }).click();
  await panel.getByText('预览已过期或已提交，请重新预览', { exact: true }).waitFor();
  const rejectedRetry = requests.filter(request => request.path.endsWith('/jobs')).at(-1).body;
  assert(unsavedRequest.requestId === rejectedRetry.requestId && unsavedRequest.previewId === rejectedRetry.previewId, 'expired unknown submission retries the identical request');
  assert(await panel.getByRole('button', { name: '返回修改参数' }).isEnabled(), 'definite expiry rejection releases editing after uncertain submission');
  await panel.getByRole('button', { name: '返回修改参数' }).click();
  await panel.getByRole('button', { name: '预览平仓组合' }).click();
  await panel.getByRole('heading', { name: '确认跨所两腿平仓' }).waitFor();
  assert([...previews.keys()].at(-1) !== unsavedRequest.previewId && jobs.length === 1, 'fresh preview follows definite rejection without creating an order');
  await panel.getByRole('button', { name: '返回修改参数' }).click();

  readFailure = true; await refresh(); await panel.getByText('模拟读取故障', { exact: true }).waitFor();
  assert(await panel.locator('.execution-history').count() === 1, 'failed poll preserves prior execution evidence');
  readFailure = false; await refresh();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await panel.getByText('网络已断开，显示最后取得的执行状态。', { exact: false }).waitFor();
  assert(await panel.getByRole('button', { name: '预览平仓组合' }).isDisabled(), 'offline disables new writes');
  await refresh();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.locator('.execution-history > summary').click();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'mobile execution does not overflow viewport');
  assert(await panel.locator('.execution-progress-table tbody tr').first().isVisible(), 'mobile retains individual leg evidence');
  await panel.screenshot({ path: 'output/playwright/trading-execution-mobile.png' });
  await panel.evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: 'output/playwright/trading-execution-mobile-viewport.png' });
  assert(await page.locator('.skip-link').evaluate(element => element.getBoundingClientRect().bottom <= 0), 'unfocused skip link remains outside the real viewport');
  await panel.locator('.execution-history').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: 'output/playwright/trading-execution-mobile-progress.png' });
  const text = await panel.innerText();
  assert(!text.includes('fixture_binance_secret') && !text.includes('fixture_bybit_secret'), 'secrets never appear in public state or rendered text');
  assert(requests.filter(request => request.body?.apiSecret).every(request => /\/accounts\/(binance|bybit)$/.test(request.path)), 'secrets sent only to connection save');
  expire = true; await refresh();
  await page.getByRole('button', { name: /登录|进入工作台/ }).first().waitFor();
  assert(await panel.count() === 0, 'session expiry removes execution data and secrets');
  assert(pageErrors.length === 0, `no browser exceptions: ${pageErrors.join('; ')}`);
  return { passed: true, scenarios: ['credential separation', 'preset direction and precision', 'preview without orders', 'idempotent uncertain retry', 'definite rejection after unknown submission', 'visible order and strategy IDs', 'resume preview', 'unknown strategy acknowledgment', 'stop retains fills', 'close direction', 'cross-symbol preset', 'stale and offline recovery', 'mobile', 'session expiry'], requests: requests.length };
}
