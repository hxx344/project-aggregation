// Open about:blank, then run this file with playwright-cli run-code --filename.
// Every API request is intercepted before navigating to the isolated localhost:4175 build.
// Never point this fixture at a real Hub session.
async (page) => {
  const origin = page.url() === 'about:blank' ? 'http://127.0.0.1:4175' : new URL(page.url()).origin;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):4175$/.test(origin)) throw new Error('Anthropic fixture requires isolated localhost:4175');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const stamp = () => new Date().toISOString();
  const MASTER = '0x' + 'AB'.repeat(20), AGENT_KEY = '0x' + '11'.repeat(32);
  const requests = [], pageErrors = [], previews = new Map();
  let jobs = [], sequence = 0;
  const connections = ['binance', 'bybit', 'okx', 'hyperliquid'].map(exchange => ({ exchange, connected: false, revision: 0, accountMode: exchange === 'hyperliquid' ? 'agent' : exchange === 'okx' ? 'cross' : exchange === 'bybit' ? 'unified' : 'standard', identity: null, keyLabel: null, verifiedAt: null, locked: false }));
  const execution = () => ({ generatedAt: stamp(), connections: structuredClone(connections), positions: [], jobs: structuredClone(jobs) });
  // Per share at 12.7B / 16.7B: io 8.9 / 9, Binance 10 / 10.1, OKX 10.2 / 10.3, xyz 9.5 / 9.6.
  const books = { 'hyperliquid:io:ANTH': ['148.63', '150.3'], 'hyperliquid:xyz:ANT': ['9.5', '9.6'], 'binance:ANTHROPICUSDT': ['127', '128.27'], 'okx:ANTHROPICUSDT': ['12.954', '13.081'], 'binance:CLUSDT': ['60.00', '60.02'], 'binance:BZUSDT': ['64.20', '64.22'] };
  const quotes = () => ({ generatedAt: stamp(), maxAgeMs: 10_000, books: Object.entries(books).map(([key, [bid, ask]]) => { const [exchange, ...symbol] = key.split(':'); return { exchange, symbol: symbol.join(':'), bid, ask, at: stamp() }; }) });
  function makePreview(input) {
    assert(input.market === 'anthropic' && input.legs.length === 2, 'Anthropic preview has two legs');
    assert(input.shares && typeof input.shares.outstanding === 'string' && typeof input.shares.diluted === 'string', 'share assumptions are sent as strings');
    assert(input.legs.every(leg => leg.quantity === undefined), 'equal shares send no per-leg quantity');
    const result = { ...input, id: `fixture-preview-${++sequence}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), resumeJobId: null,
      connections: connections.filter(connection => input.legs.some(leg => leg.exchange === connection.exchange)),
      legs: input.legs.map((leg, index) => { const [bid, ask] = books[`${leg.exchange}:${leg.symbol}`]; const hl = leg.exchange === 'hyperliquid';
        return { ...leg, stopPrice: leg.stopPrice ?? null, id: `leg-${index}`, orderSide: leg.side === 'long' ? 'buy' : 'sell', positionMode: 'one-way', accountRevision: 1, currentQuantity: '0', batchQuantities: [hl ? '10' : '13.149'], quantity: hl ? '10' : '13.149', estimatedNotional: hl ? '1503' : '1669.923', bid, ask, quoteAt: stamp(),
          rule: hl ? { quoteAsset: 'USDC' } : {}, ...(hl ? { leverage: { type: 'isolated', value: 15 } } : {}) }; }),
      notes: ['模拟预览：不会访问交易所。'] };
    previews.set(result.id, structuredClone(result)); return result;
  }
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    assert(url.origin === origin, 'fixture API never leaves isolated origin');
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    requests.push({ path: url.pathname, method, body });
    const send = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'anthropic-fixture-csrf' });
    if (url.pathname === '/api/overview/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: stamp() })}\n\n` });
    if (url.pathname === '/api/overview' || url.pathname === '/api/projects') return send({ projects: [], generatedAt: stamp() });
    if (url.pathname === '/api/trading/import-sources') return send({ sources: [] });
    if (url.pathname === '/api/trading') return send({ error: '只读账本不在本用例范围' }, 503);
    if (url.pathname === '/api/trading/execution/quotes') return send(quotes());
    if (url.pathname === '/api/trading/execution/auto') return send({ generatedAt: stamp(), maintenance: false, rules: [] });
    if (!url.pathname.startsWith('/api/trading/execution')) return send({ error: 'Unexpected fixture API' }, 404);
    if (method !== 'GET') assert(request.headers()['x-csrf-token'] === 'anthropic-fixture-csrf', 'execution writes carry the session CSRF');
    if (url.pathname === '/api/trading/execution' && method === 'GET') return send(execution());
    const account = url.pathname.match(/\/accounts\/(binance|hyperliquid)$/)?.[1];
    if (account && method === 'PUT') {
      const connection = connections.find(value => value.exchange === account);
      if (account === 'hyperliquid') {
        assert(Object.keys(body).sort().join(',') === 'accountMode,address,agentKey,revision', 'wallet connection sends exactly mode, address and API wallet key');
        assert(body.accountMode === 'agent' && body.address === MASTER && body.agentKey === AGENT_KEY, 'wallet fields are sent trimmed and unchanged');
        Object.assign(connection, { connected: true, revision: 1, identity: MASTER.toLowerCase(), keyLabel: '9f3e', verifiedAt: stamp() });
      } else {
        assert(body.apiKey === 'fixture_binance_key' && body.apiSecret === 'fixture_binance_secret', 'HMAC credentials only sent to connection endpoint');
        Object.assign(connection, { connected: true, revision: 1, identity: 'fixture-binance-uid', keyLabel: '1234', verifiedAt: stamp() });
      }
      return send(execution());
    }
    if (url.pathname.endsWith('/preview') && method === 'POST') return send(makePreview(body));
    if (url.pathname.endsWith('/jobs') && method === 'POST') {
      assert(Object.keys(body).sort().join(',') === 'confirmLive,previewId,requestId', 'submission cannot replace reviewed legs');
      const preview = previews.get(body.previewId); assert(preview, 'submission references a server preview');
      jobs = [{ id: 'fixture-job-1', market: 'anthropic', preset: preview.preset, action: 'open', status: 'running', createdAt: stamp(), updatedAt: stamp(), deadlineAt: new Date(Date.now() + 120_000).toISOString(), batchIndex: 0, batchCount: 1, reason: null, canResume: false,
        legs: preview.legs.map(leg => ({ ...leg, filledQuantity: '0', remainingQuantity: leg.quantity, currentOrder: { id: `9${leg.id.slice(-1)}001`, clientId: null, kind: 'order', state: '挂单中', lastCheckedAt: stamp(), price: leg.orderSide === 'buy' ? leg.bid : leg.ask, filledQuantity: '0', unknown: false } })),
        events: [{ time: stamp(), message: '模拟执行已受理。' }] }];
      return send(execution(), 202);
    }
    return send({ error: 'Unexpected execution fixture route' }, 404);
  });

  const spread = page.locator('section.spread-panel'), panel = page.locator('.execution-panel');
  const ant = spread.locator('.spread-anthropic');
  const row = (caption, name) => ant.locator(`table:has(caption:text-is("${caption}")) tbody tr:has(th:text-is("${name}"))`);
  const perShare = 'Anthropic 上市前合约 · 按股数假设折算为每股价格', pairs = '两两组合 · 买入便宜一侧卖一、卖出较贵一侧买一';
  const lastPreview = () => requests.filter(request => request.path.endsWith('/preview')).at(-1).body;
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`${origin}/?view=trading&tradingSection=oil`);
  await ant.waitFor();

  // Read-only comparison: per-share prices under the default assumptions and the widest pair first.
  assert(await ant.getByLabel('流通股 · 十亿股').inputValue() === '12.7' && await ant.getByLabel('完全稀释股 · 十亿股').inputValue() === '16.7', 'defaults are 12.7B and 16.7B shares');
  assert((await row(perShare, 'Hyperliquid io:ANTH（Entropy）').locator('td').nth(2).textContent()) === '8.900 / 9.000', 'io per-share bid / ask');
  assert((await row(perShare, 'OKX ANTHROPIC-USDT-SWAP').locator('td').nth(1).textContent()) === '1.27', 'OKX unit stands for S / 10 shares');
  const best = ant.locator(`table:has(caption:text-is("${pairs}")) tbody tr`).first();
  assert((await best.locator('th').textContent()) === 'Hyperliquid io:ANTH（Entropy）' && (await best.locator('td').first().textContent()) === 'OKX ANTHROPIC-USDT-SWAP', 'widest pair buys io and sells OKX');
  assert((await best.locator('td').nth(1).textContent()).includes('13.33'), 'gap is (10.2 - 9) / 9');
  assert((await best.locator('td').nth(2).textContent()) === '13.1496 单位空头', 'hedge ratio is F / (S / 10)');
  assert(await ant.locator(`table:has(caption:text-is("${pairs}")) tbody tr`).count() === 6, 'each contract pair once');
  await ant.getByLabel('完全稀释股 · 十亿股').fill('20');
  await page.waitForFunction(() => document.querySelector('.spread-anthropic tbody tr td:nth-child(4)')?.textContent?.includes('7.515'));
  await ant.getByLabel('流通股 · 十亿股').fill('30');
  await ant.getByText('完全稀释股数不能小于流通股数。').waitFor();
  assert(await ant.locator(`table:has(caption:text-is("${pairs}"))`).count() === 0, 'invalid assumptions show no pair gap');
  await ant.getByRole('button', { name: '恢复默认 127 亿 / 167 亿' }).click();
  assert(await ant.getByLabel('流通股 · 十亿股').inputValue() === '12.7', 'restore defaults');
  await spread.screenshot({ path: 'output/playwright/trading-anthropic-spread.png' });

  // Execution: Anthropic picks two contracts; the preset follows from the venues.
  await panel.getByRole('heading', { name: '组合交易', exact: true }).waitFor();
  await panel.getByRole('group', { name: '品种', exact: true }).getByRole('button', { name: 'Anthropic', exact: true }).click();
  assert(await panel.getByRole('group', { name: '交易预设', exact: true }).count() === 0, 'fixed-pair presets are hidden for Anthropic');
  const contractA = panel.getByRole('combobox', { name: '合约 A', exact: true }), contractB = panel.getByRole('combobox', { name: '合约 B', exact: true });
  assert(await contractA.inputValue() === 'hyperliquid:io:ANTH' && await contractB.inputValue() === 'binance:ANTHROPICUSDT', 'default pair is io long against Binance short');
  assert(await contractB.locator('option[value="hyperliquid:io:ANTH"]').evaluate(option => option.disabled), 'the same contract cannot be both legs');
  assert(await panel.getByRole('group', { name: '数量方式', exact: true }).getByRole('button', { name: '等股数', exact: true }).getAttribute('aria-pressed') === 'true', 'Anthropic defaults to equal shares');
  const forward = panel.getByRole('group', { name: '开仓方向', exact: true }).getByRole('button').nth(0);
  assert((await forward.innerText()).replace(/\s+/g, ' ').includes('Hyperliquid io:ANTH 多 Binance ANTHROPICUSDT 空'), 'direction names the native contracts');
  assert(await panel.getByLabel('流通股 · 十亿股').inputValue() === '12.7', 'builder shares the assumptions with the spread table');

  // Connections: Hyperliquid uses the wallet form; the key leaves the field once sent.
  await panel.locator('.execution-connections > summary').click();
  assert((await panel.locator('.execution-connections > summary').innerText()).includes('0 / 4'), 'four live venues are listed');
  const wallet = panel.getByRole('form', { name: 'Hyperliquid 实盘账户连接' });
  const connectWallet = wallet.getByRole('button', { name: '验证并连接实盘账户' });
  await wallet.getByLabel('Hyperliquid 主账户地址').fill('0x12');
  await wallet.getByText('主账户地址须为 0x 开头的 40 位十六进制。').waitFor();
  assert(await connectWallet.isDisabled(), 'malformed address cannot be sent');
  await wallet.getByLabel('Hyperliquid 主账户地址').fill(MASTER);
  await wallet.getByLabel('Hyperliquid API 钱包私钥').fill(AGENT_KEY);
  assert(await wallet.getByLabel('Hyperliquid API 钱包私钥').getAttribute('type') === 'password', 'API wallet key is masked');
  await connectWallet.click();
  await wallet.getByText(MASTER.toLowerCase(), { exact: false }).waitFor();
  assert((await wallet.innerText()).includes('API 钱包地址尾号 9f3e'), 'only the public API wallet tail is shown');
  const binance = panel.getByRole('form', { name: 'Binance 实盘账户连接' });
  await binance.getByLabel('Binance 实盘 API Key', { exact: true }).fill('fixture_binance_key');
  await binance.getByLabel('Binance 实盘 API Secret', { exact: true }).fill('fixture_binance_secret');
  await binance.getByRole('button', { name: '验证并连接实盘账户' }).click();
  await binance.getByText('fixture-binance-uid', { exact: false }).waitFor();
  await panel.locator('.execution-connection-grid').screenshot({ path: 'output/playwright/trading-anthropic-connections.png' });
  await panel.locator('.execution-connections > summary').click();

  await forward.click();
  await panel.getByLabel(/^每腿股数/).fill('167');
  assert(await panel.getByLabel('追价上限 · USDC（选填）').count() === 1 && await panel.getByLabel('追价下限 · USDT（选填）').count() === 1, 'chase limits name each venue quote asset');
  await panel.getByLabel('流通股 · 十亿股').fill('30');
  await panel.locator('.execution-anthropic').getByText('完全稀释股数不能小于流通股数。').waitFor();
  assert(await panel.getByRole('button', { name: '预览开仓组合' }).isDisabled(), 'invalid assumptions block the preview');
  await panel.getByLabel('流通股 · 十亿股').fill('12.7');
  await panel.locator('.execution-builder').screenshot({ path: 'output/playwright/trading-anthropic-builder.png' });
  await panel.getByRole('button', { name: '预览开仓组合' }).click();
  await panel.getByRole('heading', { name: '确认Anthropic跨所两腿开仓' }).waitFor();
  const sent = lastPreview();
  assert(sent.preset === 'cross-exchange' && sent.equalSize === '167' && sent.shares.outstanding === '12.7' && sent.shares.diluted === '16.7', 'preview sends preset, equal shares and the assumptions');
  assert(JSON.stringify(sent.legs.map(leg => [leg.exchange, leg.symbol, leg.side, leg.orderType])) === JSON.stringify([['hyperliquid', 'io:ANTH', 'long', 'chase'], ['binance', 'ANTHROPICUSDT', 'short', 'chase']]), 'preview legs follow the chosen contracts');
  const review = await panel.locator('.execution-review').innerText();
  assert(review.includes('逐仓 15x（不修改）') && review.includes('USDC') && review.includes('股数假设：流通 12.7 十亿股'), 'review shows live leverage, USDC and the assumptions');
  assert(review.includes('主账户 ' + MASTER.toLowerCase()), 'review names the Hyperliquid master account');
  await panel.locator('.execution-review').screenshot({ path: 'output/playwright/trading-anthropic-review.png' });

  // Same venue: io against xyz is a same-exchange pair.
  await panel.getByRole('button', { name: '返回修改参数' }).click();
  await contractB.selectOption('hyperliquid:xyz:ANT');
  await panel.getByRole('group', { name: '开仓方向', exact: true }).getByRole('button').nth(1).click();
  await panel.getByLabel(/^每腿股数/).fill('100');
  await panel.getByRole('button', { name: '预览开仓组合' }).click();
  await panel.getByRole('heading', { name: '确认Anthropic同所两腿开仓' }).waitFor();
  const same = lastPreview();
  assert(same.preset === 'same-exchange' && JSON.stringify(same.legs.map(leg => [leg.symbol, leg.side])) === JSON.stringify([['io:ANTH', 'short'], ['xyz:ANT', 'long']]), 'reverse same-venue pair');
  await panel.getByRole('button', { name: '确认并一键开仓' }).click();
  await panel.getByText('组合已受理。', { exact: false }).waitFor();
  const card = await panel.locator('.execution-job').first().innerText();
  assert(card.includes('Anthropic同所两腿开仓') && card.includes('Hyperliquid 同向价一 · 150.3 USDC'), 'job card names the market and the USDC price');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'mobile layout does not overflow');
  await ant.screenshot({ path: 'output/playwright/trading-anthropic-mobile-spread.png' });
  await panel.locator('.execution-builder').screenshot({ path: 'output/playwright/trading-anthropic-mobile-builder.png' });
  const rendered = await page.locator('body').innerText();
  assert(!rendered.includes(AGENT_KEY.slice(2)) && !rendered.includes('fixture_binance_secret'), 'keys never render');
  assert(requests.filter(request => JSON.stringify(request.body ?? {}).includes(AGENT_KEY.slice(2))).every(request => request.path.endsWith('/accounts/hyperliquid')), 'API wallet key only goes to its connection endpoint');
  assert(pageErrors.length === 0, `no browser exceptions: ${pageErrors.join('; ')}`);
  return { passed: true, requests: requests.length, previews: requests.filter(request => request.path.endsWith('/preview')).length };
}
