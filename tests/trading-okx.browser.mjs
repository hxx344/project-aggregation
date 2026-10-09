// Run with playwright-cli run-code --filename against isolated localhost:4175.
// All API calls are intercepted before navigation; no real account is accessed.
async (page) => {
  const origin = 'http://127.0.0.1:4175';
  if (page.url() !== 'about:blank' && new URL(page.url()).origin !== origin) throw new Error('OKX fixture requires isolated localhost:4175');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const stamp = () => new Date().toISOString();
  const requests = [], errors = [], previews = new Map(), jobs = [];
  let holdPair = null, releaseRead = null, heldReadReady = null, holdPreview = false, releasePreview = null, heldPreviewReady = null, sequence = 0;
  const readonly = { binance: true, bybit: false, okx: false };
  const revisions = { binance: 1, bybit: 0, okx: 0 };
  const connections = ['binance', 'bybit', 'okx'].map(exchange => ({ exchange, connected: exchange !== 'okx', revision: exchange === 'okx' ? 0 : 1, accountMode: exchange === 'binance' ? 'standard' : exchange === 'okx' ? 'cross' : 'unified', identity: `fixture-${exchange}`, keyLabel: '1234', verifiedAt: stamp(), locked: false }));
  const execution = () => ({ generatedAt: stamp(), connections: structuredClone(connections), positions: [], jobs: structuredClone(jobs) });
  function state(url) {
    const exchanges = (url.searchParams.get('pair') || 'binance,bybit').split(',');
    const days = url.searchParams.get('days') === '30' ? 30 : 7;
    const now = Date.now(), start = new Date(now - days * 86400000).toISOString();
    const accounts = ['binance', 'bybit', 'okx'].map(exchange => ({ exchange, name: exchange, connected: readonly[exchange], revision: revisions[exchange], accountMode: exchange === 'binance' ? 'standard' : 'unified', verifiedAt: readonly[exchange] ? stamp() : null, refreshing: false,
      positions: { state: readonly[exchange] ? 'live' : 'unconfigured', fetchedAt: readonly[exchange] ? stamp() : null, error: null },
      funding: { state: readonly[exchange] ? 'live' : 'unconfigured', fetchedAt: readonly[exchange] ? stamp() : null, error: null, complete: readonly[exchange], coverageStart: start, coverageEnd: stamp() } }));
    const complete = exchanges.every(exchange => readonly[exchange]);
    const legs = exchanges.flatMap((exchange, index) => ['CLUSDT', 'BZUSDT'].map(symbol => {
      const side = (index === 0) === (symbol === 'CLUSDT') ? 'long' : 'short';
      const position = { id: `${exchange}-${symbol}`, exchange, symbol, side, mode: 'hedge', marginMode: 'isolated', quantity: '4', entryPrice: '80', markPrice: '81', notional: exchange === 'okx' ? '81' : '324', unrealizedPnl: '1', leverage: '2', liquidationPrice: '40', sourceUpdatedAt: stamp(), ...(exchange === 'okx' ? { instrumentId: symbol === 'CLUSDT' ? 'CL-USDT-SWAP' : 'BZ-USDT-SWAP', quantityUnit: 'contracts', contractSize: '0.25' } : {}) };
      return { id: `${exchange}-${symbol}`, exchange, symbol, name: symbol, state: readonly[exchange] ? 'live' : 'unconfigured', fetchedAt: readonly[exchange] ? stamp() : null, positions: readonly[exchange] ? [position] : [], grossNotional: position.notional, netNotional: position.notional, unrealizedPnl: '1', fundingNet: '0', fundingComplete: readonly[exchange] };
    }));
    return { mode: 'read-only', exchanges, strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: stamp(), period: { days, start, end: stamp() }, cache: { builtAt: stamp(), servedAt: stamp(), rebuilding: false }, accounts, legs,
      structure: { state: complete ? 'opposed' : 'unknown', message: complete ? '所选两所方向相反' : '等待所选两所仓位' },
      pnl: { currency: 'USDT', intervalMs: 60000, cumulativeStart: Date.parse(start), end: now, recordingStartedAt: null, pointCount: 0, points: [], latest: null, status: 'collecting' },
      funding: { complete, income: complete ? '0' : null, expense: complete ? '0' : null, net: complete ? '0' : null, currency: 'USDT', events: [], pagination: { page: 0, pageSize: 50, total: 0, pages: 0 }, daily: [] } };
  }
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), body = request.postDataJSON();
    requests.push({ path: url.pathname, pair: url.searchParams.get('pair'), method, body });
    const send = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture-only-csrf' });
    if (url.pathname === '/api/overview') return send({ projects: [], generatedAt: stamp() });
    if (url.pathname === '/api/overview/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: stamp() })}\n\n` });
    if (url.pathname === '/api/trading/import-sources') return send({ sources: [] });
    if (url.pathname === '/api/trading') {
      assert(['binance,bybit', 'binance,okx', 'bybit,okx'].includes(url.searchParams.get('pair')), 'request pair must be canonical');
      const snapshot = state(url);
      if (holdPair === url.searchParams.get('pair')) await new Promise(resolve => { releaseRead = resolve; heldReadReady?.(); });
      return send(snapshot);
    }
    if (url.pathname === '/api/trading/accounts/okx' && method === 'PUT') {
      assert(body.passphrase === 'readonly-fixture-pass' && body.accountMode === 'unified', 'readonly Passphrase and unified mode');
      assert(url.searchParams.get('pair') === 'binance,okx', 'account mutation preserves requested pair');
      readonly.okx = true; revisions.okx++; return send(state(url));
    }
    if (url.pathname === '/api/trading/execution' && method === 'GET') return send(execution());
    if (url.pathname === '/api/trading/execution/accounts/okx' && method === 'PUT') {
      assert(body.passphrase === 'execution-fixture-pass' && body.accountMode === 'isolated', 'execution Passphrase and explicitly selected margin mode');
      Object.assign(connections[2], { connected: true, accountMode: body.accountMode, revision: 1 }); return send(execution());
    }
    if (url.pathname === '/api/trading/execution/preview') {
      const preview = { ...body, id: `preview-${++sequence}`, expiresAt: new Date(Date.now() + 60000).toISOString(), connections: connections.filter(connection => body.legs.some(leg => leg.exchange === connection.exchange)), notes: [],
        legs: body.legs.map((leg, index) => ({ ...leg, id: `leg-${index}`, orderSide: (body.action === 'open') === (leg.side === 'long') ? 'buy' : 'sell', positionMode: 'hedge', accountRevision: 1, currentQuantity: '4', batchQuantities: [leg.quantity], estimatedNotional: leg.exchange === 'okx' ? '80' : '320', bid: '80', ask: '80.1', quoteAt: stamp(), rule: leg.exchange === 'okx' ? { instrumentId: leg.symbol === 'CLUSDT' ? 'CL-USDT-SWAP' : 'BZ-USDT-SWAP', contractSize: '0.25', quantityUnit: 'contracts' } : {} })) };
      previews.set(preview.id, preview);
      if (holdPreview) await new Promise(resolve => { releasePreview = resolve; heldPreviewReady?.(); });
      return send(preview);
    }
    if (url.pathname === '/api/trading/execution/jobs' && method === 'POST') {
      assert(Object.keys(body).sort().join(',') === 'confirmLive,previewId,requestId' && body.confirmLive, 'confirmation uses immutable server preview');
      const preview = previews.get(body.previewId); assert(preview, 'known preview');
      jobs.push({ ...preview, id: 'fixture-okx-job', status: 'running', createdAt: stamp(), updatedAt: stamp(), deadlineAt: preview.expiresAt, batchIndex: 0, reason: null, canResume: false, events: [], legs: preview.legs.map(leg => ({ ...leg, filledQuantity: '0', remainingQuantity: leg.quantity, currentOrder: null })) });
      return send(execution());
    }
    return send({ error: `Unexpected fixture: ${method} ${url.pathname}` }, 404);
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?view=trading&tradingPair=okx,binance`);
  const pairs = page.getByRole('group', { name: '交易所组合' }), panel = page.locator('.execution-panel');
  await pairs.getByRole('button', { name: 'Binance + OKX' }).waitFor();
  assert(await pairs.getByRole('button', { name: 'Binance + OKX' }).getAttribute('aria-pressed') === 'true', 'reversed URL resolves canonical pair');
  await page.locator('.trading-positions').getByRole('button', { name: '账户连接', exact: true }).click();
  const readForm = page.getByRole('form', { name: 'OKX 账户连接', exact: true });
  await readForm.getByLabel('API Key', { exact: true }).fill('readonly-fixture-key');
  await readForm.getByLabel('API Secret', { exact: true }).fill('readonly-fixture-secret');
  await readForm.getByLabel('Passphrase', { exact: true }).fill('readonly-fixture-pass');
  assert(await readForm.getByLabel('Passphrase', { exact: true }).getAttribute('type') === 'password', 'readonly Passphrase is obscured');
  await readForm.getByRole('button', { name: '验证并连接', exact: true }).click();
  await page.getByText('所选两所方向相反', { exact: true }).waitFor();
  assert(await readForm.getByLabel('Passphrase', { exact: true }).inputValue() === '', 'readonly Passphrase is cleared');
  const okxPosition = page.locator('[data-leg="okx-CLUSDT"]');
  assert((await okxPosition.innerText()).includes('CL-USDT-SWAP') && (await okxPosition.innerText()).includes('4 张'), 'real instrument and contracts shown');
  await okxPosition.locator('summary').click();
  assert((await okxPosition.innerText()).includes('0.25') && (await okxPosition.innerText()).includes('逐仓'), 'server multiplier and margin mode shown');
  await page.getByRole('heading', { name: '区间资金费', exact: true }).waitFor();
  await panel.locator('.execution-connections > summary').click();
  const executionForm = page.getByRole('form', { name: 'OKX 实盘账户连接', exact: true });
  await executionForm.getByLabel('OKX 实盘保证金模式').selectOption('isolated');
  await executionForm.getByLabel('OKX 实盘 API Key').fill('execution-fixture-key');
  await executionForm.getByLabel('OKX 实盘 API Secret').fill('execution-fixture-secret');
  await executionForm.getByLabel('OKX 实盘 Passphrase').fill('execution-fixture-pass');
  await executionForm.getByRole('button', { name: '验证并连接实盘账户' }).click();
  await executionForm.getByRole('button', { name: '验证并替换实盘连接' }).waitFor();
  assert(await executionForm.getByLabel('OKX 实盘 Passphrase').inputValue() === '', 'execution Passphrase is cleared');
  await panel.locator('.execution-connections > summary').click();
  async function build() {
    await panel.getByRole('combobox', { name: '开仓方向', exact: true }).selectOption('forward');
    for (const leg of await panel.locator('.execution-leg-input').all()) {
      await leg.getByLabel(/^数量/).fill('4');
      await leg.getByLabel(/追价停止/).fill(await leg.getByLabel(/买单追价/).count() ? '90' : '70');
    }
    await panel.getByRole('button', { name: '预览开仓组合' }).click();
  }
  await build();
  await panel.getByRole('heading', { name: '确认四腿组合开仓' }).waitFor();
  const review = panel.locator('.execution-review');
  assert((await review.innerText()).includes('0.25') && (await review.innerText()).includes('CL-USDT-SWAP'), 'preview uses server contract rules');
  assert(await review.getByText('总数量 · 张', { exact: true }).count() === 2, 'OKX legs explicitly use contracts');
  assert(previews.get('preview-1').legs.map(leg => leg.exchange).join(',') === 'binance,binance,okx,okx', 'four leg structure follows selected pair');
  await page.screenshot({ path: 'output/playwright/trading-okx-desktop.png', fullPage: true });
  await review.getByRole('button', { name: '确认并一键开仓' }).click();
  await panel.locator('.execution-job').waitFor();
  holdPair = 'bybit,okx';
  const readStarted = new Promise(resolve => { heldReadReady = resolve; });
  await pairs.getByRole('button', { name: 'Bybit + OKX' }).click();
  assert(await page.locator('.trading-positions').count() === 0, 'uncached pair never displays the previous positions');
  assert(await panel.getByRole('combobox', { name: '开仓方向', exact: true }).inputValue() === '', 'pair change resets direction');
  assert(await panel.locator('.execution-job').count() === 1, 'job management retains all pairs');
  await readStarted;
  holdPair = null; releaseRead?.();
  await page.locator('.trading-positions').waitFor();
  holdPreview = true;
  const previewStarted = new Promise(resolve => { heldPreviewReady = resolve; });
  await build();
  await previewStarted;
  await pairs.getByRole('button', { name: 'Binance + Bybit' }).click();
  await pairs.getByRole('button', { name: 'Bybit + OKX' }).click();
  const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/preview'));
  holdPreview = false; releasePreview?.();
  await panel.getByRole('button', { name: '预览开仓组合' }).waitFor();
  await previewResponse;
  assert(await panel.locator('.execution-review').count() === 0, 'delayed preview cannot reappear after pair round trip');
  await panel.getByRole('button', { name: /跨所两腿/ }).click();
  await build();
  await panel.getByRole('heading', { name: '确认跨所两腿开仓' }).waitFor();
  const crossPreview = [...previews.values()].at(-1);
  assert(crossPreview.legs.map(leg => leg.exchange).join(',') === 'bybit,okx', 'cross exchange structure uses current pair');
  await review.getByRole('button', { name: '返回修改参数' }).click();
  await panel.getByRole('button', { name: /同所两腿/ }).click();
  await panel.getByRole('combobox', { name: '交易所', exact: true }).selectOption('okx');
  await build();
  await panel.getByRole('heading', { name: '确认同所两腿开仓' }).waitFor();
  assert([...previews.values()].at(-1).legs.every(leg => leg.exchange === 'okx'), 'same exchange supports OKX');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/playwright/trading-okx-mobile.png', fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no viewport overflow on mobile');
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert(!storage.includes('fixture-pass') && !storage.includes('fixture-secret'), 'credentials never enter browser storage');
  assert(errors.length === 0, errors.join('\n'));
  return { passed: true, assertions: 'canonical pair, isolated cache, selected completeness, Passphrase, contract units, three presets, stale preview, all-pair jobs, mobile layout', requests: requests.length };
}
