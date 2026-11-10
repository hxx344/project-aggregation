// Run against the root production preview on localhost:4175:
// playwright-cli -s=positions-invalidate run-code --filename tests/hub-positions-invalidation.browser.mjs
// Every API and embedded document is isolated; no real account is contacted.
async (page) => {
  const origin = new URL(page.url()).origin;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):4175$/.test(origin)) throw new Error('Positions invalidation fixture requires localhost:4175');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const stamp = '2026-11-10T12:00:00.000Z';
  const projects = ['monitor', 'asset'].map((id, order) => ({ id, name: id, description: '', category: 'other', adapter: id, enabled: true, embedded: true,
    accessMode: 'proxy', apiUrl: 'http://127.0.0.1:9000', url: '', mode: 'embed', hasCredentials: true, revision: 'unchanged-project-revision', staleAfterSeconds: 120, order }));
  const overview = () => ({ generatedAt: new Date().toISOString(), projects: projects.map(project => ({ project, state: 'online', freshness: 'static', message: '',
    checkedAt: null, updatedAt: null, latencyMs: 1, diagnostics: [], metrics: [] })) });
  const position = symbol => ({ id: `old-${symbol}`, symbol, instrumentId: symbol, side: 'long', quantity: '7', quantityUnit: 'contracts', contractSize: '1',
    entryPrice: '70', markPrice: '71', notional: '497', unrealizedPnl: '7', leverage: '3', liquidationPrice: null, priceCurrency: 'USDT', notionalCurrency: 'USDT',
    pnlCurrency: 'USDT', marginMode: 'cross', sourceUpdatedAt: stamp });
  let accountRemoved = false, holdCheck = false, holdLegs = false, legQuantity = '40';
  let sampleTime = new Date().toISOString();
  const positions = () => ({ generatedAt: sampleTime, sources: [{ projectId: 'asset', name: 'Asset 测试账本', status: 'ready', error: null, checkedAt: sampleTime,
    data: { schemaVersion: 1, generatedAt: sampleTime, exchanges: [{ id: 'binance', name: 'Binance', accounts: accountRemoved ? [] : [{ id: 'old-account',
      name: '待删除账户', configured: true, revision: 'old-account-revision', scopes: [{ id: 'perp', label: 'U 本位合约', status: 'live', refreshing: false,
        fetchedAt: sampleTime, error: null, positions: [position('CLUSDT'), position('ANTHROPICUSDT')] }] }] }] } }] });
  const legs = () => ({ schema: 1, generatedAt: sampleTime, sources: [{ exchange: 'hyperliquid', connected: true, state: 'live', fetchedAt: sampleTime,
    error: null, refreshing: false, positions: [{ id: 'hyperliquid:xyz:ANT:long', exchange: 'hyperliquid', symbol: 'xyz:ANT', side: 'long', quantity: legQuantity,
      quantityUnit: null, entryPrice: '71.2', markPrice: '72.5', unrealizedPnl: '52' }] }] });
  const requests = [], external = [], unexpected = [], errors = [], heldChecks = [], heldLegs = [];
  const launches = new Map();
  const moduleHtml = id => `<!doctype html><meta charset="utf-8"><body>${id} fixture<script>
    const origin = ${JSON.stringify(origin)};
    window.fixture = { ready: 0, replies: [] };
    fixture.send = value => parent.postMessage({ channel: 'project-hub', version: 1, ...value }, origin);
    function ready() { fixture.send({ type: 'ready', role: 'module', capabilities: ['activity', 'navigate', 'changed', 'positions', 'open-trading'] }); }
    addEventListener('message', event => {
      if (event.origin !== origin || event.source !== parent || event.data?.channel !== 'project-hub' || event.data.version !== 1) return;
      if (event.data.type === 'ready') { fixture.ready++; ready(); }
      if (event.data.type === 'positions') fixture.replies.push(event.data);
    }); ready();
  </script></body>`;
  const handler = async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== origin) { external.push(url.href); return route.abort('blockedbyclient'); }
    requests.push({ method: request.method(), path });
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.startsWith('/_positions-invalidation/')) return route.fulfill({ contentType: 'text/html', body: moduleHtml(path.split('/')[2]) });
    const launch = path.match(/^\/api\/projects\/(monitor|asset)\/launch$/);
    if (request.method() === 'POST' && launch) {
      const id = launch[1], count = (launches.get(id) ?? 0) + 1; launches.set(id, count);
      return send({ url: `${origin}/_positions-invalidation/${id}/${count}` });
    }
    if (request.method() === 'POST' && path === '/api/projects/asset/check') {
      if (holdCheck) await new Promise(resolve => heldChecks.push(resolve));
      return send({ snapshot: overview().projects.find(item => item.project.id === 'asset') });
    }
    if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${path}`); return send({ error: 'Fixture rejects writes' }, 405); }
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'positions-invalidation-fixture' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/system/modules') return send({ enabled: false, modules: [] });
    if (path === '/api/system/host') return send({ generatedAt: sampleTime, cpu: { usagePercent: 1, cores: 4, loadAverage: [0, 0, 0] },
      memory: { usedPercent: 1, usedBytes: 1, totalBytes: 100, availableBytes: 99 }, disks: [], uptimeSeconds: 60 });
    if (path === '/api/overview/events' || path === '/api/system/updates/events') return route.abort();
    if (path === '/api/overview') return send(overview());
    if (path === '/api/system/updates') return send({ enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null });
    if (path === '/api/trading/positions') return send(positions());
    if (path === '/api/trading/anthropic') {
      if (holdLegs) await new Promise(resolve => heldLegs.push(resolve));
      return send(legs());
    }
    if (path.startsWith('/api/')) { unexpected.push(`${request.method()} ${path}`); return send({ error: `Unexpected API ${path}` }, 404); }
    return route.continue();
  };
  const releaseChecks = () => { for (const resolve of heldChecks.splice(0)) resolve(); };
  const releaseLegs = () => { for (const resolve of heldLegs.splice(0)) resolve(); };
  const reads = () => requests.filter(request => request.path === '/api/trading/positions').length;
  const legReads = () => requests.filter(request => request.path === '/api/trading/anthropic').length;
  const checks = () => requests.filter(request => request.path === '/api/projects/asset/check').length;
  const eventually = async (check, message) => { for (let i = 0; i < 150; i++) { if (await check()) return; await page.waitForTimeout(40); } throw new Error(message); };
  const frameFor = id => page.frames().find(frame => frame.url().startsWith(`${origin}/_positions-invalidation/${id}/`));
  const connect = async id => {
    await eventually(async () => { const frame = frameFor(id); return !!frame && await frame.evaluate(() => !!window.fixture?.ready).catch(() => false); }, `${id} bridge not ready`);
    return frameFor(id);
  };
  const ask = (frame, requestId, market = 'oil') => frame.evaluate(({ requestId, market }) => fixture.send({ type: 'positions-request', requestId, market,
    symbols: market === 'anthropic' ? ['ANTHROPIC', 'XYZANT'] : ['CL'] }), { requestId, market });
  const changed = asset => asset.evaluate(() => fixture.send({ type: 'changed', scope: 'summary' }));
  const reply = async (frame, requestId) => {
    let value;
    await eventually(async () => (value = await frame.evaluate(id => fixture.replies.find(reply => reply.requestId === id), requestId)), `missing reply ${requestId}`);
    return value;
  };
  const showProject = async id => { await page.locator('.project-nav').filter({ hasText: id }).click(); return connect(id); };
  const freshSession = async () => {
    accountRemoved = false; holdCheck = false; holdLegs = false; legQuantity = '40'; sampleTime = new Date().toISOString();
    await page.goto(`${origin}/?view=project&id=monitor`);
    await connect('monitor'); const asset = await showProject('asset'), monitor = await showProject('monitor');
    await ask(monitor, 'seed'); const seeded = await reply(monitor, 'seed');
    assert(seeded.status === 'ok' && seeded.items.length === 1 && seeded.items[0].symbol === 'CLUSDT' && !seeded.items[0].stale, 'seed must provide a live real bridge snapshot');
    return { asset, monitor };
  };
  const onPageError = error => errors.push(error.message);
  page.on('pageerror', onPageError);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    window.fixtureOnline = true;
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => window.fixtureOnline });
    localStorage.setItem('workbench:trading-section:v1', JSON.stringify('positions'));
  });
  await page.route('**/*', handler);
  try {
    // The account list changes inside Asset; the Hub project revision stays identical.
    let { asset, monitor } = await freshSession();
    const initialRevision = projects.find(project => project.id === 'asset').revision;
    const before = reads(); holdCheck = true; const checkBefore = checks();
    await changed(asset);
    await eventually(() => checks() === checkBefore + 1 && heldChecks.length === 1, 'account change did not start its acknowledgement');
    await ask(monitor, 'during-check');
    await page.getByRole('button', { name: '交易中心', exact: true }).click();
    await page.getByRole('heading', { name: '交易中心', exact: true }).waitFor();
    await eventually(async () => await page.locator('.positions-page').count() === 1, 'all positions did not mount');
    await page.waitForTimeout(350);
    assert(reads() === before, `positions GET escaped the held account-change acknowledgement: ${reads()} vs ${before}`);
    assert(await page.locator('.positions-page [data-position-id]').count() === 0, 'removed account positions returned while the acknowledgement was held');
    assert(!(await page.locator('.positions-page').innerText()).includes('待删除账户'), 'removed account identity returned while the acknowledgement was held');
    assert(!await monitor.evaluate(() => fixture.replies.some(reply => reply.requestId === 'during-check')), 'bridge must wait for account-change acknowledgement');
    accountRemoved = true; holdCheck = false; releaseChecks();
    const removed = await reply(monitor, 'during-check');
    await eventually(() => reads() === before + 1, 'acknowledgement must lead to one shared positions GET');
    assert(removed.status === 'ok' && removed.items.length === 0, `removed account survived acknowledgement: ${JSON.stringify(removed)}`);
    assert(projects.find(project => project.id === 'asset').revision === initialRevision, 'scenario must not rely on a project revision change');
    assert(await page.locator('.positions-page [data-position-id]').count() === 0, 'the empty refreshed directory must replace old positions');

    // An already-resolved Asset snapshot must be re-read after a slower leg resolves.
    ({ asset, monitor } = await freshSession());
    holdLegs = true; const clearLegsBefore = legReads();
    await ask(monitor, 'legs-after-clear', 'anthropic');
    await eventually(() => legReads() === clearLegsBefore + 1 && heldLegs.length === 1, 'supplemental leg did not wait');
    holdCheck = true; const clearCheckBefore = checks(), clearReadsBefore = reads();
    await changed(asset);
    await eventually(() => checks() === clearCheckBefore + 1 && heldChecks.length === 1, 'clear scenario did not enter acknowledgement barrier');
    holdLegs = false; releaseLegs();
    const cleared = await reply(monitor, 'legs-after-clear');
    assert(cleared.status === 'unavailable' && cleared.items.length === 0, `late legs resurrected a cleared snapshot: ${JSON.stringify(cleared)}`);
    assert(reads() === clearReadsBefore, 'late supplemental completion must not bypass the acknowledgement barrier');
    accountRemoved = true; holdCheck = false; releaseChecks();
    await eventually(() => reads() === clearReadsBefore + 1, 'clear recovery did not fetch the new directory');
    await ask(monitor, 'after-clear-recovery');
    const recovered = await reply(monitor, 'after-clear-recovery');
    assert(recovered.status === 'ok' && recovered.items.length === 0, 'clear recovery must use the empty current directory');

    ({ monitor } = await freshSession());
    holdLegs = true; const offlineLegsBefore = legReads(), offlineReadsBefore = reads();
    await ask(monitor, 'legs-after-offline', 'anthropic');
    await eventually(() => legReads() === offlineLegsBefore + 1 && heldLegs.length === 1, 'offline supplemental leg did not wait');
    await page.evaluate(() => { window.fixtureOnline = false; window.dispatchEvent(new Event('offline')); });
    holdLegs = false; releaseLegs();
    const offline = await reply(monitor, 'legs-after-offline');
    assert(offline.status === 'ok' && offline.items.length === 1 && offline.items[0].symbol === 'ANTHROPICUSDT' && offline.items[0].stale,
      `late legs revived live Asset evidence after offline: ${JSON.stringify(offline)}`);
    assert(offline.sourcesIncomplete === true && !offline.items.some(item => item.exchangeId === 'hyperliquid'), 'the old generation supplemental legs must be discarded');
    assert(offline.items[0].updatedAt === sampleTime && offline.generatedAt === sampleTime, 'offline evidence must retain its source timestamps');
    assert(reads() === offlineReadsBefore, 'going offline must not start another positions GET');
    const recoveredLegsBefore = legReads(), recoveredAt = Date.now(); legQuantity = '93';
    await page.evaluate(() => { window.fixtureOnline = true; window.dispatchEvent(new Event('online')); });
    const assetRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trading/positions' && response.status() === 200);
    await ask(monitor, 'asset-after-reconnect'); await assetRefresh; await reply(monitor, 'asset-after-reconnect');
    await ask(monitor, 'asset-after-reconnect-fresh');
    const assetRecovered = await reply(monitor, 'asset-after-reconnect-fresh');
    assert(assetRecovered.status === 'ok' && assetRecovered.items.length === 1 && !assetRecovered.items[0].stale && reads() === offlineReadsBefore + 1,
      'a successful new Asset read must precede the next supplemental request');
    await ask(monitor, 'legs-after-reconnect', 'anthropic');
    const reconnected = await reply(monitor, 'legs-after-reconnect');
    assert(Date.now() - recoveredAt < 20_000 && legReads() === recoveredLegsBefore + 1, 'reconnect must refresh supplemental legs before their ordinary 20s cache expires');
    const currentLeg = reconnected.items.find(item => item.exchangeId === 'hyperliquid');
    assert(reconnected.status === 'ok' && currentLeg?.quantity === '93' && currentLeg.stale === false,
      `reconnect reused pre-disconnect supplemental evidence: ${JSON.stringify(reconnected)}`);
    assert(!errors.length && !external.length && !unexpected.length, JSON.stringify({ errors, external, unexpected }));
    assert(requests.every(request => request.method === 'GET' || request.method === 'POST' && /^\/api\/projects\/(?:monitor|asset)\/(?:launch|check)$/.test(request.path)), 'fixture must never send account or execution writes');
    return { passed: true, positionReads: reads(), checks: checks(), legReads: legReads(), scenarios: ['same-project-revision account removal', 'acknowledgement blocks GET and bridge publication',
      'all positions drops the old account during acknowledgement', 'one shared empty-directory refresh', 'late supplemental legs after clear', 'late supplemental legs after offline',
      'source timestamps preserved', 'reconnect refreshes supplemental cache before 20s'] };
  } finally {
    holdCheck = false; holdLegs = false; releaseChecks(); releaseLegs();
    await page.goto('about:blank').catch(() => {});
    await page.unroute('**/*', handler); page.off('pageerror', onPageError);
  }
}
