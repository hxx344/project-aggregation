// Run: playwright-cli -s=<session> open http://127.0.0.1:4175 then
// playwright-cli -s=<session> run-code --filename tests/hub-positions.browser.mjs
// Requires the root production preview at http://127.0.0.1:4175. Every API and
// module document is an isolated fixture; no real account is ever contacted.
async (page) => {
  const origin = new URL(page.url()).origin;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):4175$/.test(origin)) throw new Error('Hub positions fixture requires isolated localhost:4175');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const hostBase = ['activity', 'navigate', 'changed'];
  const ids = ['monitor', 'asset'];
  const projects = ids.map((id, order) => ({ id, name: id, description: '', category: 'other', adapter: id, enabled: true, embedded: true, accessMode: 'proxy',
    apiUrl: 'http://127.0.0.1:9000', url: '', mode: 'embed', hasCredentials: true, revision: 'bridge-fixture', staleAfterSeconds: 120, order }));
  const overview = () => ({ generatedAt: new Date().toISOString(), projects: projects.map(project => ({ project, state: 'online', freshness: 'static', message: '',
    checkedAt: null, updatedAt: null, latencyMs: 1, diagnostics: [], metrics: [] })) });
  const stamp = () => new Date().toISOString();
  const position = (symbol, overrides = {}) => ({ id: `secret-position-${symbol}`, symbol, instrumentId: symbol, side: 'long', quantity: '0.123456789012345678', quantityUnit: 'contracts',
    contractSize: '0.1', entryPrice: '71.5', markPrice: '72.25', notional: '7.2', unrealizedPnl: '-0.000000000000000001', leverage: '3', liquidationPrice: null,
    priceCurrency: 'USDT', notionalCurrency: 'USDT', pnlCurrency: 'USDT', marginMode: 'cross', sourceUpdatedAt: stamp(), ...overrides });
  const scope = (id, status, positions) => ({ id, label: 'U 本位合约', status, refreshing: false, fetchedAt: stamp(), error: '敏感错误 apiKey=leaked-detail', positions });
  const positionsState = () => ({ generatedAt: stamp(), sources: [{ projectId: 'asset-secret-project', name: 'Asset 主账本', status: 'ready', error: null, checkedAt: stamp(), data: { schemaVersion: 1, generatedAt: stamp(), exchanges: [
    { id: 'binance', name: 'Binance', accounts: [{ id: 'account-secret-1', name: '机密账户名', configured: true, revision: 'revision-secret-7', scopes: [
      scope('scope-secret-9', 'live', [position('CLUSDT'), position('BZUSDT', { side: 'short', entryPrice: null, unrealizedPnl: null }), position('CLOUDUSDT'), position('XAUUSDT')]),
      scope('scope-secret-stale', 'stale', [position('CL-USDT-SWAP')])] }] }] } },
    { projectId: 'asset-secret-missing', name: 'Asset 备用账本', status: 'unavailable', error: '来源暂不可用', checkedAt: stamp(), data: null }] });
  const errors = [], external = [], unexpected = [], requests = [], held = [];
  const launches = new Map();
  let expire = false, holdRead = false, neverRespond = false;
  page.on('pageerror', error => errors.push(error.message));
  const moduleHtml = id => `<!doctype html><meta charset="utf-8"><body><p>${id} fixture</p><script>
    const origin = ${JSON.stringify(origin)};
    window.fixture = { hostReady: [], replies: [] };
    fixture.send = value => parent.postMessage({ channel: 'project-hub', version: 1, ...value }, origin);
    // Like the real bridges, answer each host ready so the load-time revalidation reconnects.
    function sendReady() { fixture.send({ type: 'ready', role: 'module', capabilities: ['activity', 'navigate', 'changed', 'positions', 'open-trading'] }); }
    addEventListener('message', event => {
      if (event.origin !== origin || event.source !== parent || event.data?.channel !== 'project-hub' || event.data.version !== 1) return;
      if (event.data.type === 'ready') { fixture.hostReady.push(event.data.capabilities); sendReady(); }
      if (event.data.type === 'positions') fixture.replies.push(event.data);
    });
    sendReady();
  </script></body>`;
  const handler = async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== origin) { external.push(url.href); return route.abort('blockedbyclient'); }
    requests.push({ method: request.method(), path });
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const launch = path.match(/^\/api\/projects\/([^/]+)\/launch$/);
    if (path.startsWith('/_bridge-fixture/')) return route.fulfill({ contentType: 'text/html', body: moduleHtml(path.split('/')[2]) });
    if (request.method() !== 'GET' && !(request.method() === 'POST' && launch)) { unexpected.push(`${request.method()} ${path}`); return send({ error: 'Fixture rejects writes' }, 405); }
    if (launch) { const id = launch[1], count = (launches.get(id) || 0) + 1; launches.set(id, count); return send({ url: `${origin}/_bridge-fixture/${id}/${count}` }); }
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'bridge-fixture-only' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/overview/events' || path === '/api/system/updates/events') return route.abort();
    if (path === '/api/overview') return send(overview());
    if (path === '/api/system/updates') return send({ enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null });
    if (path === '/api/trading/positions') {
      if (neverRespond) { await new Promise(resolve => held.push(resolve)); try { await send(positionsState()); } catch { /* page navigated away */ } return; }
      if (holdRead) await new Promise(resolve => held.push(resolve));
      if (expire) return send({ error: '登录已过期' }, 401);
      return send(positionsState());
    }
    if (path.startsWith('/api/')) { unexpected.push(`${request.method()} ${path}`); return send({ error: `Unexpected API ${path}` }, 404); }
    return route.continue();
  };
  const release = () => { for (const resume of held.splice(0)) resume(); };
  const reads = () => requests.filter(request => request.path === '/api/trading/positions').length;
  const eventually = async (check, message, tries = 150) => { for (let i = 0; i < tries; i++) { if (await check()) return; await page.waitForTimeout(40); } throw new Error(message); };
  const frameFor = id => page.frames().find(frame => frame.url().startsWith(`${origin}/_bridge-fixture/${id}/`));
  const connect = async id => {
    await eventually(async () => { const frame = frameFor(id); return !!frame && await frame.evaluate(() => !!window.fixture?.hostReady.length).catch(() => false); }, `${id} fixture did not receive host ready`);
    return frameFor(id);
  };
  const ask = (frame, value) => frame.evaluate(value => fixture.send(value), value);
  const reply = async (frame, requestId, tries) => {
    let found;
    await eventually(async () => (found = await frame.evaluate(id => fixture.replies.find(item => item.requestId === id), requestId)), `no reply for ${requestId}`, tries);
    return found;
  };
  const noReply = async (frame, requestIds) => {
    await page.waitForTimeout(400);
    const seen = await frame.evaluate(ids => fixture.replies.filter(item => ids.includes(item.requestId)).map(item => item.requestId), requestIds);
    assert(!seen.length, `ignored messages were answered: ${seen.join(', ')}`);
  };
  const request = (requestId, overrides = {}) => ({ type: 'positions-request', requestId, market: 'oil', symbols: ['CL', 'BZ'], ...overrides });
  const loginVisible = () => page.getByRole('heading', { name: '进入工作台', exact: true }).count();
  await page.route('**/*', handler);
  await page.setViewportSize({ width: 1280, height: 900 });
  try {
    await page.goto(`${origin}/?view=project&id=monitor`);
    let monitor = await connect('monitor');
    const capabilities = await monitor.evaluate(() => fixture.hostReady);
    assert(capabilities.every(value => JSON.stringify(value) === JSON.stringify([...hostBase, 'positions', 'open-trading'])), `monitor host capabilities: ${JSON.stringify(capabilities)}`);

    holdRead = true;
    await ask(monitor, request('oil-1')); await ask(monitor, request('oil-2'));
    await eventually(() => reads() === 1, 'request did not start');
    await page.waitForTimeout(200); holdRead = false; release();
    const [first, second] = [await reply(monitor, 'oil-1'), await reply(monitor, 'oil-2')];
    assert(reads() === 1, `concurrent requests share one read (${reads()})`);
    assert(first.status === 'ok' && second.status === 'ok' && first.market === 'oil' && typeof first.generatedAt === 'string', 'oil replies are ok');
    assert(first.incomplete === true && second.incomplete === true, 'an unavailable source without data marks the reply incomplete');
    assert(JSON.stringify(first.items.map(item => [item.symbol, item.base, item.stale])) === JSON.stringify([['CLUSDT', 'CL', false], ['BZUSDT', 'BZ', false], ['CL-USDT-SWAP', 'CL', true]]), `oil items ${JSON.stringify(first.items)}`);
    const bz = first.items.find(item => item.symbol === 'BZUSDT');
    assert(bz.entryPrice === null && bz.unrealizedPnl === null && bz.side === 'short' && bz.quantity === '0.123456789012345678', 'null stays null and decimals stay strings');
    const serialized = await monitor.evaluate(() => JSON.stringify(fixture.replies));
    for (const secret of ['account-secret-1', '机密账户名', 'revision-secret-7', 'scope-secret', 'leaked-detail', 'secret-position', 'asset-secret-project', 'asset-secret-missing'])
      assert(!serialized.includes(secret), `reply leaks ${secret}`);
    assert(first.items.every(item => !('accountId' in item) && !('name' in item) && !('revision' in item) && Object.keys(item).length === 15 && item.exchangeId === 'binance'), 'items carry only protocol fields');
    assert(JSON.stringify(Object.keys(first).sort()) === JSON.stringify(['channel', 'generatedAt', 'incomplete', 'items', 'market', 'requestId', 'status', 'type', 'version']), `reply fields ${Object.keys(first)}`);

    await ask(monitor, request('gold-1', { market: 'cl-xau', symbols: ['XAU', 'CL', 'BZ'] }));
    const gold = await reply(monitor, 'gold-1');
    assert(gold.status === 'ok' && gold.items.some(item => item.symbol === 'XAUUSDT' && item.base === 'XAU') && reads() === 1, 'cached response serves another market');

    for (const value of [request('bad-market', { market: 'gold' }), request('bad-empty', { symbols: [] }), request('bad-lower', { symbols: ['cl'] }),
      request('bad-many', { symbols: Array.from({ length: 21 }, (_, i) => `B${i}`) }), request('bad id'), { type: 'positions-request', requestId: 'bad-missing', market: 'oil' }])
      await ask(monitor, value);
    await monitor.evaluate(() => parent.postMessage({ channel: 'project-hub', version: 2, type: 'positions-request', requestId: 'bad-version', market: 'oil', symbols: ['CL'] }, location.origin));
    await page.evaluate(() => {
      const current = document.querySelector('iframe[title="monitor模块"]').contentWindow;
      const data = { channel: 'project-hub', version: 1, type: 'positions-request', market: 'oil', symbols: ['CL'] };
      window.dispatchEvent(new MessageEvent('message', { data: { ...data, requestId: 'forged-origin' }, origin: 'https://untrusted.invalid', source: current }));
      window.postMessage({ ...data, requestId: 'forged-source' }, location.origin);
    });
    await noReply(monitor, ['bad-market', 'bad-empty', 'bad-lower', 'bad-many', 'bad id', 'bad-missing', 'bad-version', 'forged-origin', 'forged-source']);

    await ask(monitor, { type: 'open-trading', market: 'gold' });
    await page.waitForTimeout(300);
    assert(new URL(page.url()).searchParams.get('view') === 'project', 'open-trading with an unknown market is ignored');

    await page.getByRole('button', { name: '总览', exact: true }).click();
    await ask(monitor, request('hidden-cached'));
    const hidden = await reply(monitor, 'hidden-cached');
    assert(hidden.status === 'ok' && reads() === 1, 'inactive page answers from cache without a read');
    await ask(monitor, { type: 'open-trading', market: 'oil' });
    await page.waitForTimeout(300);
    assert(new URL(page.url()).searchParams.get('view') === null, 'inactive open-trading is ignored');

    await page.locator('.project-nav').filter({ hasText: 'asset' }).click();
    const asset = await connect('asset');
    const assetCapabilities = await asset.evaluate(() => fixture.hostReady);
    assert(assetCapabilities.every(value => JSON.stringify(value) === JSON.stringify(hostBase)), `asset host capabilities: ${JSON.stringify(assetCapabilities)}`);
    await ask(asset, request('asset-1')); await ask(asset, { type: 'open-trading', market: 'oil' });
    await noReply(asset, ['asset-1']);
    assert(new URL(page.url()).searchParams.get('id') === 'asset' && reads() === 1, 'non-monitor projects cannot read positions or open trading');

    // A fresh document: 401 answers the module without expiring the hub session.
    expire = true;
    await page.goto(`${origin}/?view=project&id=monitor`);
    monitor = await connect('monitor');
    const readsBefore = reads();
    await ask(monitor, request('expired-1'));
    const expired = await reply(monitor, 'expired-1');
    assert(expired.status === 'unauthorized' && expired.items.length === 0 && expired.generatedAt === null && expired.incomplete === false, 'background 401 replies unauthorized');
    await ask(monitor, request('expired-2'));
    assert((await reply(monitor, 'expired-2')).status === 'unauthorized' && reads() === readsBefore + 1, 'unauthorized outcome is cached, not retried');
    await page.waitForTimeout(300);
    assert(await loginVisible() === 0 && !!frameFor('monitor'), 'background 401 must not log out or replace the module');
    expire = false;

    // Background preload of Monitor from the overview: no network without an active page.
    await page.goto(`${origin}/`);
    monitor = await connect('monitor');
    const coldReads = reads();
    await ask(monitor, request('cold-hidden'));
    const cold = await reply(monitor, 'cold-hidden');
    assert(cold.status === 'unavailable' && cold.incomplete === false && reads() === coldReads, 'inactive page with no cache answers unavailable without reading');

    // Timeout: no retry, unavailable after ten seconds.
    neverRespond = true;
    await page.goto(`${origin}/?view=project&id=monitor`);
    monitor = await connect('monitor');
    const slowReads = reads();
    const started = Date.now();
    await ask(monitor, request('slow-1'));
    const slow = await reply(monitor, 'slow-1', 400);
    const waited = Date.now() - started;
    assert(slow.status === 'unavailable' && waited >= 9_500 && waited < 14_000 && reads() === slowReads + 1, `timeout reply ${slow.status} after ${waited}ms`);
    neverRespond = false; release();

    await ask(monitor, { type: 'open-trading', market: 'oil' });
    await page.getByRole('heading', { name: '交易所仓位', exact: true }).waitFor();
    const target = new URL(page.url()).searchParams;
    assert(target.get('view') === 'trading' && target.get('tradingSection') === 'positions' && [...target.keys()].length === 2, `open-trading url ${page.url()}`);

    assert(!unexpected.length && !external.length && !errors.length, JSON.stringify({ unexpected, external, errors }));
    assert(requests.every(request => request.method === 'GET' || (request.method === 'POST' && /\/api\/projects\/(monitor|asset)\/launch$/.test(request.path))), 'only launch POSTs are sent');
    return { passed: true, positionReads: reads(), scenarios: ['monitor capabilities', 'single in-flight read', 'redacted items', 'cache across markets', 'invalid and forged messages ignored', 'inactive cache and open-trading ignored', 'non-monitor ignored', '401 unauthorized without logout', 'inactive cold unavailable', '10s timeout without retry', 'open-trading to positions'] };
  } finally {
    neverRespond = false; holdRead = false; release();
    await page.goto('about:blank').catch(() => {});
    await page.unroute('**/*', handler);
  }
}
