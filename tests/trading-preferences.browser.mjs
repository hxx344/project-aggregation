// Run with playwright-cli run-code --filename on an isolated localhost:4178 production preview.
// All APIs are intercepted, including every write; no trading account is contacted.
async page => {
  const origin = 'http://127.0.0.1:4178';
  const check = (value, message) => { if (!value) throw Error(message); };
  const stamp = () => new Date().toISOString();
  const requests = [], errors = [];
  const listener = error => errors.push(error.message);
  const connections = ['binance', 'bybit', 'okx', 'hyperliquid', 'rh-lighter'].map(exchange => ({ exchange, connected: true, accountMode: exchange === 'hyperliquid' ? 'agent' : exchange === 'rh-lighter' ? 'api-key' : 'standard', identity: 'fixture', keyLabel: 'fixture', revision: 1, verifiedAt: stamp(), locked: false }));
  const handler = async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    requests.push({ path: url.pathname, method: request.method() });
    const send = json => route.fulfill({ json });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'preferences-fixture' });
    if (url.pathname.endsWith('/events')) return route.abort();
    if (url.pathname === '/api/overview' || url.pathname === '/api/projects') return send({ projects: [], generatedAt: stamp() });
    if (url.pathname === '/api/trading/execution') return send({ connections, jobs: [], positions: [], generatedAt: stamp(), maintenance: false });
    if (url.pathname.endsWith('/quotes')) return send({ generatedAt: stamp(), maxAgeMs: 10000, books: [] });
    if (url.pathname.endsWith('/preview')) {
      const body = request.postDataJSON();
      return send({ ...body, id: 'old-fixture-preview', expiresAt: new Date(Date.now() + 60_000).toISOString(), resumeJobId: null, notes: [], connections,
        legs: body.legs.map((leg, index) => ({ ...leg, id: `leg-${index}`, orderSide: leg.side === 'long' ? 'buy' : 'sell', stopPrice: leg.stopPrice ?? null, positionMode: 'one-way', accountRevision: 1, currentQuantity: '0', batchQuantities: ['10'], quantity: '10', estimatedNotional: '1000', bid: '99', ask: '100', quoteAt: stamp(), rule: { quoteAsset: 'USDG' } })) });
    }
    if (url.pathname.endsWith('/auto')) return send({ generatedAt: stamp(), rules: [], maintenance: false });
    return route.fulfill({ status: 503, json: { error: 'Outside preference fixture' } });
  };
  await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.route('**/*', handler); page.on('pageerror', listener);
  try {
    await page.goto(origin);
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('workbench:')) localStorage.removeItem(key); });
    await page.goto(`${origin}/?view=trading&tradingSection=trade`);
    const panel = page.locator('.execution-panel'), form = panel.getByRole('form', { name: '组合交易参数' });
    const choose = (label, name) => form.getByRole('group', { name: label, exact: true }).getByRole('button', { name, exact: true }).click();
    await form.waitFor();
    check(await page.getByRole('group', { name: '交易所组合' }).count() === 0, 'trade has no three shortcut buttons');
    await choose('品种', 'Anthropic');
    await form.getByRole('combobox', { name: '合约 A', exact: true }).selectOption('rh-lighter:ANTHROPIC');
    await form.getByRole('combobox', { name: '合约 B', exact: true }).selectOption('binance:ANTHROPICUSDT');
    await form.getByRole('group', { name: '开仓方向', exact: true }).getByRole('button').first().click();
    const lighter = form.getByRole('region', { name: 'Lighter RH ANTHROPIC 交易参数', exact: true });
    await lighter.getByRole('button', { name: '市价', exact: true }).click();
    await form.getByLabel('每腿股数').fill('167');
    await form.getByLabel('完全稀释股 · 十亿股').fill('18.2');
    await form.locator('.execution-advanced > summary').click();
    await form.getByLabel('拆分批数').fill('3');
    await form.getByRole('button', { name: '预览开仓组合', exact: true }).click();
    await panel.locator('.execution-review').waitFor();
    const writes = requests.filter(request => request.method !== 'GET').length;
    await page.reload(); await form.getByRole('combobox', { name: '合约 A', exact: true }).waitFor();
    check(await form.getByRole('combobox', { name: '合约 A', exact: true }).inputValue() === 'rh-lighter:ANTHROPIC', 'Lighter A restores');
    check(await form.getByRole('combobox', { name: '合约 B', exact: true }).inputValue() === 'binance:ANTHROPICUSDT', 'Binance B restores');
    check(await form.getByRole('button', { name: '开仓', exact: true }).getAttribute('aria-pressed') === 'true', 'action restores');
    check(await lighter.getByRole('button', { name: '市价', exact: true }).getAttribute('aria-pressed') === 'true', 'order type restores');
    check(await form.getByLabel('拆分批数').inputValue() === '3' && await form.locator('.execution-advanced').evaluate(node => node.open), 'parameters and disclosure restore');
    check(await form.getByLabel('完全稀释股 · 十亿股').inputValue() === '18.2', 'shared share assumption restores');
    check(await form.getByLabel('每腿股数').inputValue() === '', 'quantity does not survive reload');
    check(await panel.locator('.execution-review').count() === 0, 'old confirmation is discarded');
    check(requests.filter(request => request.method !== 'GET').length === writes, 'reload sends no writes');
    const stored = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]))));
    check(!stored.includes('old-fixture-preview') && !stored.includes('confirmLive') && !stored.includes('requestId') && !stored.includes('quantity'), 'browser storage excludes execution authority and sizes');
    await choose('品种', '原油'); await choose('交易所', 'OKX');
    await form.getByRole('button', { name: /^四腿组合/ }).click();
    await form.getByRole('combobox', { name: '跨所组合', exact: true }).selectOption('binance,okx');
    await form.getByRole('group', { name: '开仓方向', exact: true }).getByRole('button').first().click();
    check((await form.locator('.execution-leg-input').allTextContents()).join(' ').includes('OKX'), 'contextual pair selector controls actual legs');
    await choose('品种', 'Anthropic');
    check(await form.getByRole('combobox', { name: '合约 A', exact: true }).inputValue() === 'rh-lighter:ANTHROPIC', 'switching market retains ANT selection');
    await choose('交易动作', '平仓');
    await choose('数量方式', '逐腿填写');
    await page.goto(`${origin}/?view=trading`); await form.getByRole('combobox', { name: '合约 A', exact: true }).waitFor();
    check(await page.getByRole('tab', { name: '价差下单', exact: true }).getAttribute('aria-selected') === 'true', 'unqualified entry restores trading tab');
    check(await form.getByRole('button', { name: '平仓', exact: true }).getAttribute('aria-pressed') === 'true', 'close action survives a new visit');
    check(await form.getByRole('button', { name: '逐腿填写', exact: true }).getAttribute('aria-pressed') === 'true', 'sizing choice survives');
    await page.getByRole('tab', { name: '盈亏资金费', exact: true }).click();
    await page.getByRole('group', { name: '交易所组合', exact: true }).waitFor();
    await page.goto(`${origin}/?view=trading&tradingSection=positions`);
    check(await page.getByRole('tab', { name: '全部仓位', exact: true }).getAttribute('aria-selected') === 'true', 'explicit section overrides saved selection');
    await page.evaluate(() => localStorage.setItem('workbench:execution-preferences:v1', JSON.stringify({ market: 'anthropic', profiles: { oil: { action: 'open', selectedSymbol: 'CLUSDT', selectedExchange: { toString: null }, preset: ['four-leg'], orientation: 'reverse' } } })));
    await page.goto(`${origin}/?view=trading&tradingSection=trade`);
    await form.getByRole('combobox', { name: '合约 A', exact: true }).waitFor();
    check(await form.getByRole('combobox', { name: '合约 A', exact: true }).inputValue() === 'hyperliquid:io:ANTH', 'malformed non-current profile cannot crash the trading entry');
    check(errors.length === 0, errors.join('\n'));
    return { passed: true, checks: ['ANT/Lighter reload', 'market isolation', 'action and sizing', 'order types', 'execution settings', 'shares', 'no stale preview or automatic write', 'contextual pair', 'URL priority'] };
  } finally { page.off('pageerror', listener); await page.unroute('**/*', handler); }
}
