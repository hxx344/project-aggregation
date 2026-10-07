// Run with playwright-cli run-code, passing this file's text as the code argument.
// Uses the current app origin; every API request is fulfilled locally and external requests are blocked.
async (page) => {
  const origin = new URL(page.url()).origin;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const requests = [], externalRequests = [], pageErrors = [];
  const fixedTime = '2026-10-07T04:00:00.000Z', importedTime = '2026-10-07T05:00:00.000Z';
  let sources = [], sourceFailure = false, readFailure = false, rejection = null, holdImport = false, releaseImport = null;
  let message = '已保留原有 Binance 只读连接。';
  const revisions = { binance: 7, bybit: 2 }, configured = { binance: true, bybit: false }, verifiedAt = { binance: fixedTime, bybit: null };
  const accountModes = { binance: 'standard', bybit: 'unified' };
  const connection = (exchange, revision, label, overrides = {}) => ({ exchange, configured: true, revision, label, updatedAt: fixedTime, supported: true, reason: null, ...overrides });
  const readySources = () => [
    { projectId: 'asset-a', name: 'Asset A', projectRevision: 'project-a-v1', status: 'ready', error: null, connections: [connection('binance', 'a-binance-v1', '•••• 1234'), connection('bybit', 'a-bybit-v1', '•••• 4321')] },
    { projectId: 'asset-b', name: 'Asset B · 独立资产账户与资金流水归档', projectRevision: 'project-b-v1', status: 'ready', error: null, connections: [connection('binance', 'b-binance-v1', '•••• 5678'), connection('bybit', 'b-bybit-v1', '•••• 8765', { supported: false, reason: '仅支持 HMAC 只读密钥' })] },
    { projectId: 'asset-old', name: 'Asset 旧服务', projectRevision: 'project-old-v1', status: 'unavailable', error: 'Asset 旧版本尚未提供导入接口，请升级服务。', connections: [] },
    { projectId: 'asset-missing', name: 'Asset 待配置', projectRevision: 'project-missing-v1', status: 'unconfigured', error: '请先配置 Asset API 地址与登录密码。', connections: [] },
  ];
  const state = days => {
    const start = days === 30 ? '2026-09-07T04:00:00.000Z' : '2026-09-30T04:00:00.000Z';
    const accounts = ['binance', 'bybit'].map(exchange => ({
      exchange, name: exchange === 'binance' ? 'Binance' : 'Bybit', connected: configured[exchange], revision: revisions[exchange], accountMode: accountModes[exchange], verifiedAt: verifiedAt[exchange], refreshing: false,
      positions: { state: configured[exchange] ? 'live' : 'unconfigured', fetchedAt: configured[exchange] ? fixedTime : null, error: null },
      funding: { state: configured[exchange] ? 'live' : 'unconfigured', fetchedAt: configured[exchange] ? fixedTime : null, error: null, coverageStart: configured[exchange] ? start : null, coverageEnd: configured[exchange] ? fixedTime : null, complete: configured[exchange] },
    }));
    const legs = ['CLUSDT', 'BZUSDT'].flatMap(symbol => accounts.map(account => ({
      id: `${account.exchange}-${symbol}`, exchange: account.exchange, symbol, name: `${account.name} ${symbol}`, state: account.positions.state, fetchedAt: account.positions.fetchedAt, positions: [], grossNotional: account.connected ? '0' : null, netNotional: account.connected ? '0' : null, unrealizedPnl: account.connected ? '0' : null, fundingNet: account.connected ? '0' : null, fundingComplete: account.connected,
    })));
    return { mode: 'read-only', strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: fixedTime, cache: { builtAt: fixedTime, servedAt: fixedTime, rebuilding: false }, period: { days, start, end: fixedTime }, accounts, legs, structure: { state: 'incomplete', message }, funding: { complete: configured.binance && configured.bybit, income: '0', expense: '0', net: '0', currency: 'USDT', events: [], pagination: { page: 0, pageSize: 50, total: 0, pages: 1 }, daily: [] } };
  };
  await page.unrouteAll({ behavior: 'wait' });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) { externalRequests.push(request.url()); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const record = { path: url.pathname, query: url.search, method, body: request.postDataJSON() };
    requests.push(record);
    const send = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture-only-csrf' });
    if (url.pathname === '/api/overview/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: fixedTime })}\n\n` });
    if (url.pathname === '/api/overview') return send({ projects: [], generatedAt: fixedTime });
    if (url.pathname === '/api/trading' && method === 'GET') return readFailure ? send({ error: '测试缓存暂不可读' }, 503) : send(state(url.searchParams.get('days') === '30' ? 30 : 7));
    if (url.pathname === '/api/trading/import-sources' && method === 'GET') {
      assert(!record.body, 'metadata lookup has no credential body');
      return sourceFailure ? send({ error: '测试来源读取失败，请刷新来源重试。' }, 503) : send({ sources });
    }
    const exchange = url.pathname.match(/^\/api\/trading\/accounts\/(binance|bybit)\/import$/)?.[1];
    if (exchange && method === 'POST') {
      assert(Object.keys(record.body).sort().join(',') === 'accountMode,projectId,projectRevision,revision,sourceRevision', 'import sends only source identifiers, revisions and account mode');
      assert(record.body.revision === revisions[exchange], 'import uses current target account revision');
      const selectedSource = sources.find(source => source.projectId === record.body.projectId);
      const selectedConnection = selectedSource?.connections.find(item => item.exchange === exchange);
      assert(selectedSource?.status === 'ready' && selectedConnection?.configured && selectedConnection.supported, 'import targets explicitly chosen eligible exchange connection');
      assert(record.body.projectRevision === selectedSource.projectRevision && record.body.sourceRevision === selectedConnection.revision, 'import sends exact selected project and source revisions');
      if (rejection === 'permission') return send({ error: '只允许没有交易权限的只读密钥，已保留原连接。' }, 400);
      if (rejection === 'stale') return send({ error: 'Asset 中的密钥已变更，请刷新来源后重新选择。' }, 409);
      if (holdImport) await new Promise(resolve => { releaseImport = resolve; });
      configured[exchange] = true; revisions[exchange]++; verifiedAt[exchange] = importedTime; accountModes[exchange] = record.body.accountMode;
      message = `已导入 ${record.body.projectId === 'asset-b' ? 'Asset B' : 'Asset A'} ${exchange === 'binance' ? 'Binance' : 'Bybit'} 测试连接。`;
      return send(state(url.searchParams.get('days') === '30' ? 30 : 7), 202);
    }
    if (url.pathname === '/api/trading/accounts/binance' && method === 'PUT') {
      assert(record.body.revision === revisions.binance && ['standard', 'portfolio-margin'].includes(record.body.accountMode), 'manual connection includes current revision and selected mode');
      if (rejection === 'api') return send({ error: 'Binance 组合保证金仓位读取失败（HTTP 401，Binance -2015），请检查账户模式、API 读取权限、IP 白名单与服务器时间' }, 400);
      accountModes.binance = record.body.accountMode; revisions.binance++; verifiedAt.binance = importedTime;
      return send(state(30), 202);
    }
    return send({ error: `Unexpected fixture API: ${method} ${url.pathname}` }, 404);
  });
  const metadataCount = () => requests.filter(request => request.path === '/api/trading/import-sources').length;
  const imports = () => requests.filter(request => request.path.endsWith('/import'));
  const waitForText = text => page.getByText(text, { exact: false }).first().waitFor();
  const refreshSources = async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading/import-sources');
    await page.getByRole('button', { name: '刷新来源', exact: true }).click(); await response;
    await page.waitForFunction(() => !document.querySelector('.trading-import-heading button')?.disabled);
  };
  const refreshCache = async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading');
    await page.evaluate(() => window.dispatchEvent(new Event('online'))); await response;
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?view=trading`);
  await waitForText('等待两所最新仓位，暂不判断四腿结构');
  assert(metadataCount() === 0, 'closed connections do not load Asset metadata');
  await page.getByRole('button', { name: '账户连接', exact: true }).click();
  await waitForText('暂无已启用的 Asset 项目');
  const binance = page.getByRole('form', { name: 'Binance 账户连接' }), bybit = page.getByRole('form', { name: 'Bybit 账户连接' });
  const binanceSource = binance.getByRole('combobox', { name: 'Asset 来源', exact: true }), bybitSource = bybit.getByRole('combobox', { name: 'Asset 来源', exact: true });
  const binanceMode = binance.getByRole('combobox', { name: 'Binance 账户模式', exact: true });
  assert(await binanceMode.inputValue() === 'standard', 'existing ordinary connection defaults to standard mode');
  assert(await bybit.getByRole('combobox').count() === 1, 'Bybit keeps its unified-account flow');
  const importBinance = binance.getByRole('button', { name: '从 Asset 导入并替换', exact: true });
  assert(await importBinance.isDisabled() && await binanceSource.isDisabled(), 'empty metadata disables import while retaining manual input');
  await binance.getByLabel('API Key', { exact: true }).fill('manual-binance-draft');
  await binance.getByLabel('API Secret', { exact: true }).fill('manual-binance-secret');
  await bybit.getByLabel('API Key', { exact: true }).fill('manual-bybit-draft');
  await bybit.getByLabel('API Secret', { exact: true }).fill('manual-bybit-secret');

  sources = readySources(); await refreshSources();
  await waitForText('Asset 旧版本尚未提供导入接口');
  await waitForText('请先配置 Asset API 地址与登录密码');
  assert(await binanceSource.inputValue() === '' && await importBinance.isDisabled(), 'metadata never auto-selects or imports a source');
  assert(await binanceSource.locator('option[value="asset-old"]').getAttribute('disabled') !== null, 'old Asset is unavailable only for its own source');
  assert(await bybitSource.locator('option[value="asset-b"]').getAttribute('disabled') !== null, 'unsupported Bybit connection cannot be imported');
  assert(await bybit.getByText('Asset B · 独立资产账户与资金流水归档：仅支持 HMAC 只读密钥', { exact: true }).count() === 1, 'unsupported connection reason is visible outside the disabled option');
  await binanceSource.selectOption('asset-a');
  assert(await importBinance.isEnabled(), 'ready source remains usable alongside old and unconfigured projects');
  await binanceSource.selectOption('asset-b');
  assert(imports().length === 0, 'choosing between two sources does not auto-import');
  const beforePolling = metadataCount();
  const rangeResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading' && new URL(response.url()).searchParams.get('days') === '30');
  await page.getByRole('button', { name: '近30天', exact: true }).click();
  await rangeResponse;
  await page.clock.install(); await page.clock.runFor(15000);
  assert(metadataCount() === beforePolling, 'range changes and five-second polling do not reload metadata');
  assert(await binanceSource.inputValue() === 'asset-b', 'trading polling retains explicit source selection');
  assert(await binance.getByLabel('API Key', { exact: true }).inputValue() === 'manual-binance-draft', 'metadata and trading refresh preserve manual draft');

  await binanceMode.selectOption('portfolio-margin');
  holdImport = true; readFailure = true;
  await importBinance.click();
  await page.waitForFunction(() => document.querySelector('#trading-key-binance')?.disabled === true);
  assert(await binanceSource.isDisabled() && await bybitSource.isDisabled(), 'pending import locks both source selectors');
  assert(await binanceMode.isDisabled(), 'pending import locks account mode');
  assert(await page.getByRole('button', { name: '刷新来源', exact: true }).isDisabled(), 'pending import blocks metadata refresh');
  assert(await binance.getByRole('button', { name: '验证并替换连接', exact: true }).isDisabled(), 'pending import blocks manual mutation');
  const selectedB = imports().at(-1);
  assert(selectedB?.query === '?days=30&page=0' && JSON.stringify(selectedB.body) === JSON.stringify({ revision: 7, accountMode: 'portfolio-margin', projectId: 'asset-b', projectRevision: 'project-b-v1', sourceRevision: 'b-binance-v1' }), 'selected Asset B payload, portfolio mode and time range are correct');
  const pendingImports = imports().length;
  await page.getByRole('button', { name: '近7天', exact: true }).click();
  assert(await importBinance.isDisabled(), 'changing range retains the pending mutation lock');
  await page.getByRole('button', { name: '近30天', exact: true }).click();
  assert(imports().length === pendingImports, 'range switching never duplicates the import');
  assert(typeof releaseImport === 'function', 'import fixture is held for busy-state checks');
  releaseImport(); holdImport = false;
  await waitForText('已从 Asset 导入并验证只读密钥');
  await waitForText('测试缓存暂不可读');
  await page.waitForFunction(() => document.querySelector('#trading-key-binance')?.value === '');
  assert(await binance.getByLabel('API Secret', { exact: true }).inputValue() === '', 'successful import clears its manual secret draft');
  assert(await bybit.getByLabel('API Secret', { exact: true }).inputValue() === 'manual-bybit-secret', 'importing Binance preserves the other account draft');
  assert((await binance.locator('small').allTextContents()).some(text => text.includes('13:00:00')), 'direct import response updates account despite failed follow-up GET');
  assert(metadataCount() === beforePolling, 'successful import does not mechanically reload sources');
  assert(await binanceMode.inputValue() === 'portfolio-margin' && await binance.getByText('当前连接：组合保证金（Portfolio Margin）', { exact: true }).count() === 1, 'successful import uses and displays the saved account mode');
  readFailure = false; await refreshCache();

  await binance.getByLabel('API Key', { exact: true }).fill('keep-on-failure-key');
  await binance.getByLabel('API Secret', { exact: true }).fill('keep-on-failure-secret');
  await binanceSource.selectOption('asset-a'); await binanceMode.selectOption('standard'); rejection = 'permission';
  await importBinance.click(); await waitForText('只允许没有交易权限的只读密钥，已保留原连接。');
  await refreshCache();
  assert(await binance.getByLabel('API Key', { exact: true }).inputValue() === 'keep-on-failure-key' && await binance.getByLabel('API Secret', { exact: true }).inputValue() === 'keep-on-failure-secret', 'failed permission verification preserves both manual draft fields');
  assert(await binance.getByText('当前连接：组合保证金（Portfolio Margin）', { exact: true }).count() === 1 && await binance.locator('.trading-account-form-heading').textContent() === 'Binance已连接', 'failed replacement keeps old connected account');
  assert(await page.getByRole('alert').filter({ hasText: '只允许没有交易权限' }).count() === 1, 'background polling does not erase import error');
  assert(imports().at(-1).body.projectId === 'asset-a' && imports().at(-1).body.sourceRevision === 'a-binance-v1', 'changing from B to A sends A revisions');
  assert(imports().at(-1).body.accountMode === 'standard' && await binance.getByText('当前连接：组合保证金（Portfolio Margin）', { exact: true }).count() === 1, 'failed mode replacement preserves active portfolio connection');

  sources[0] = { ...sources[0], projectRevision: 'project-a-v2', connections: [connection('binance', 'a-binance-v2', '•••• 1122'), sources[0].connections[1]] };
  await refreshSources();
  assert(await binanceSource.inputValue() === '' && await importBinance.isDisabled(), 'metadata revision change invalidates previous selection instead of silently switching keys');
  await waitForText('来源已变更或不可用，请重新选择。');
  await binanceSource.selectOption('asset-a'); rejection = 'stale';
  await importBinance.click(); await waitForText('Asset 中的密钥已变更，请刷新来源后重新选择。');
  assert(await binance.getByLabel('API Secret', { exact: true }).inputValue() === 'keep-on-failure-secret', '409 preserves manual draft');
  assert(imports().at(-1).body.projectRevision === 'project-a-v2' && imports().at(-1).body.sourceRevision === 'a-binance-v2', 'reselected source carries refreshed revisions');
  assert(await binance.getByText('当前连接：组合保证金（Portfolio Margin）', { exact: true }).count() === 1 && (await binance.locator('small').allTextContents()).some(text => text.includes('13:00:00')), '409 does not replace the previously verified account or its mode');

  sourceFailure = true; await refreshSources(); await waitForText('测试来源读取失败，请刷新来源重试。');
  assert(await importBinance.isDisabled(), 'failed metadata refresh blocks old source import');
  assert(await binance.getByRole('button', { name: '验证并替换连接', exact: true }).isEnabled(), 'metadata failure does not block manual connection');
  sourceFailure = false; rejection = null; await refreshSources();
  await bybitSource.selectOption('asset-a');
  await bybit.getByRole('button', { name: '从 Asset 导入', exact: true }).click();
  await bybit.locator('.trading-account-form-heading').getByText('已连接', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#trading-key-bybit')?.value === '');
  assert(imports().at(-1).path === '/api/trading/accounts/bybit/import' && imports().at(-1).body.sourceRevision === 'a-bybit-v1', 'Bybit imports only the Bybit connection from its chosen project');
  assert(await bybit.getByLabel('API Secret', { exact: true }).inputValue() === '', 'Bybit success clears its secret draft');
  assert(await binance.getByLabel('API Secret', { exact: true }).inputValue() === 'keep-on-failure-secret', 'Bybit import retains Binance draft');

  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); window.dispatchEvent(new Event('offline')); });
  await waitForText('网络已断开');
  assert(await binanceSource.isDisabled() && await bybitSource.isDisabled() && await importBinance.isDisabled() && await page.getByRole('button', { name: '刷新来源', exact: true }).isDisabled(), 'offline state disables import and source changes');
  const offlineMetadataCount = metadataCount(); await page.clock.runFor(15000);
  assert(metadataCount() === offlineMetadataCount, 'offline polling never reloads sources');
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')); });
  await page.waitForFunction(() => !document.querySelector('#trading-source-binance')?.disabled);
  assert(metadataCount() === offlineMetadataCount, 'network recovery does not choose or reload import sources');

  await binanceMode.selectOption('standard');
  await binance.getByRole('button', { name: '验证并替换连接', exact: true }).click();
  await waitForText('当前连接：普通 U 本位');
  assert(await binanceMode.inputValue() === 'standard', 'manual mode change follows the successful response');
  await binanceMode.selectOption('portfolio-margin');
  await binance.getByLabel('API Key', { exact: true }).fill('manual-portfolio-key');
  await binance.getByLabel('API Secret', { exact: true }).fill('manual-portfolio-secret');
  rejection = 'api';
  await binance.getByRole('button', { name: '验证并替换连接', exact: true }).click();
  await waitForText('Binance 组合保证金仓位读取失败（HTTP 401，Binance -2015）');
  assert(await binance.getByText('当前连接：普通 U 本位', { exact: true }).count() === 1, 'provider rejection displays stage and code without replacing active mode');
  rejection = null;
  await binance.getByRole('button', { name: '验证并替换连接', exact: true }).click();
  await waitForText('当前连接：组合保证金（Portfolio Margin）');
  assert(await binanceMode.inputValue() === 'portfolio-margin', 'manual Portfolio Margin connection uses selected mode');
  await binanceSource.selectOption('asset-b');
  await page.screenshot({ path: 'output/playwright/trading-import-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await binanceSource.scrollIntoViewIfNeeded();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '390px expanded connection forms have no page-wide overflow');
  assert(await binanceSource.evaluate(element => element.getBoundingClientRect().right <= innerWidth), 'long source labels stay within mobile viewport');
  await page.screenshot({ path: 'output/playwright/trading-import-mobile.png', fullPage: true });
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert(!/manual-binance|manual-bybit|keep-on-failure/.test(storage), 'draft credentials never enter browser storage');
  assert(imports().every(request => !/manual-binance|manual-bybit|keep-on-failure|apiKey|apiSecret/.test(JSON.stringify(request.body))), 'import requests never contain browser keys or secrets');
  assert(externalRequests.length === 0, `browser never contacts an Asset or exchange origin: ${externalRequests.join(', ')}`);
  assert(!pageErrors.length, `No uncaught browser errors: ${pageErrors.join('; ')}`);
  return { passed: true, scenarios: ['on-demand metadata', 'no sources', 'old and unconfigured source isolation', 'two source selection', 'exact revision and account mode payload', 'busy and offline lock', 'direct state success and draft clearing', 'permission failure preserves old account and mode', 'metadata revision invalidation', '409 source conflict', 'metadata refresh failure', 'Bybit exchange matching', 'manual ordinary and Portfolio Margin selection', 'provider error stage and code', '390px mobile', 'no imported credentials or external requests'], metadataRequests: metadataCount(), imports: imports().length };
}
