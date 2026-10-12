// All traffic is intercepted; use the isolated production preview on port 4175.
async (page) => {
  const origin = 'http://127.0.0.1:4175';
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const paths = ['/api/trading/positions', '/api/trading', '/api/trading/execution'];
  const errors = [], writes = [], held = [];
  let hold = false;
  await page.clock.install();
  await page.addInitScript(() => {
    window.__online = true; window.__hidden = false; window.__reads = [];
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => window.__online });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    window.EventSource = class { close() {} };
    const original = window.fetch;
    window.fetch = (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input, location.href);
      if (['/api/trading/positions', '/api/trading', '/api/trading/execution'].includes(url.pathname)) {
        const read = { path: url.pathname, pair: url.searchParams.get('pair'), aborted: false };
        window.__reads.push(read);
        options?.signal?.addEventListener('abort', () => { read.aborted = true; }, { once: true });
      }
      return original(input, options);
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route(`${origin}/api/**`, async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const send = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
    if (req.method() !== 'GET') { writes.push(path); return send({ error: 'Unexpected write' }); }
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'fixture' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [] });
    if (path === '/api/system/updates') return send({ enabled: true, checking: false, modules: [], job: null });
    if (paths.includes(path) && hold) await new Promise(resolve => held.push(resolve));
    const now = Date.now(), stamp = new Date(now).toISOString(), start = now - 7 * 86_400_000;
    if (path === '/api/trading/positions') return send({ generatedAt: stamp, sources: [] });
    if (path === '/api/trading/execution') return send({ generatedAt: stamp, connections: [], positions: [], jobs: [] });
    if (path === '/api/trading') return send({ mode: 'read-only', exchanges: (url.searchParams.get('pair') || 'binance,bybit').split(','), strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: stamp, period: { days: 7, start: new Date(start).toISOString(), end: stamp }, cache: { builtAt: stamp, servedAt: stamp, rebuilding: false }, accounts: [], legs: [], structure: { state: 'unknown', message: '尚未连接只读观察账户' }, pnl: { currency: 'USDT', intervalMs: 60_000, cumulativeStart: start, end: now, recordingStartedAt: null, pointCount: 0, points: [], latest: null, status: 'collecting' }, funding: { complete: false, income: null, expense: null, net: null, currency: 'USDT', events: [], pagination: { page: 0, pageSize: 50, total: 0, pages: 0 }, daily: [] } });
    return send({});
  });
  const advance = async ms => { await page.clock.runFor(ms); await page.waitForTimeout(40); };
  const reads = () => page.evaluate(() => window.__reads);
  const burst = () => page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    for (const event of ['focus', 'pageshow']) window.dispatchEvent(new Event(event));
  });
  const release = async () => { hold = false; held.splice(0).forEach(resolve => resolve()); await page.waitForTimeout(40); };
  const counts = (items, path) => items.filter(item => item.path === path).length;
  const setOnline = value => page.evaluate(value => { window.__online = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')); }, value);

  for (const section of ['positions', 'oil']) {
    await page.goto(`${origin}/?view=trading&tradingSection=${section}`);
    await page.getByRole('heading', { name: section === 'positions' ? '交易所仓位' : '组合交易', exact: true }).waitFor();
    await advance(100);
    const activePaths = section === 'positions' ? [paths[0]] : paths.slice(1);
    let before = (await reads()).length;
    hold = true;
    await burst(); await advance(1_100);
    let changes = (await reads()).slice(before);
    assert(activePaths.every(path => counts(changes, path) === 1) && changes.every(read => !read.aborted), `${section}: wake burst starts one uncancelled read per endpoint: ${JSON.stringify(changes)}`);
    await release();

    // A held read from before a later wake is replaced once, not repeatedly.
    hold = true; await burst(); await advance(1_100);
    before = (await reads()).length;
    await burst(); await advance(1_100);
    changes = (await reads()).slice(before);
    assert(activePaths.every(path => counts(changes, path) === 1) && changes.every(read => !read.aborted), `${section}: one replacement read per endpoint`);
    await release();

    before = (await reads()).length;
    await burst(); await advance(100); await setOnline(false); await advance(1_200);
    assert((await reads()).length === before, `${section}: offline cancels wake tasks`);
    await setOnline(true); await advance(1_100);
    changes = (await reads()).slice(before);
    assert(activePaths.every(path => counts(changes, path) === 1), `${section}: network recovery starts once`);

    if (section === 'oil') {
      // A new pair read started between wake events belongs to this recovery window.
      hold = true; before = (await reads()).length;
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await advance(100);
      await page.getByRole('group', { name: '交易所组合' }).getByRole('button', { name: 'Binance + OKX' }).click();
      await advance(100); await page.evaluate(() => window.dispatchEvent(new Event('pageshow'))); await advance(1_100);
      changes = (await reads()).slice(before).filter(read => read.path === paths[1]);
      assert(changes.length === 1 && changes[0].pair === 'binance,okx' && !changes[0].aborted, 'pair switch read survives later wake events');
      await release();
      before = (await reads()).length;
      for (let round = 0; round < 4; round++) await advance(3_000);
      changes = (await reads()).slice(before);
      assert(counts(changes, paths[2]) === 4, `execution has exactly one poll chain: ${counts(changes, paths[2])}`);

      // Offline during recovery followed by hidden reconnect must keep the 30s loop.
      await burst(); await advance(100); await setOnline(false);
      await page.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
      await setOnline(true); before = (await reads()).length;
      await advance(1_100);
      assert(counts((await reads()).slice(before), paths[2]) === 0, 'hidden execution does not force a wake read');
      await advance(30_000);
      assert(counts((await reads()).slice(before), paths[2]) === 1, 'hidden reconnect preserves one background poll chain');
      before = (await reads()).length;
      for (let round = 0; round < 6; round++) {
        await advance(10_000);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      }
      assert(counts((await reads()).slice(before), paths[2]) === 2, 'repeated hidden wake events cannot postpone background polling');
      await page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    }

    // Navigate out while a recovery task is waiting, then let multiple periods pass.
    await burst();
    await page.getByRole('button', { name: '总览', exact: true }).click();
    before = (await reads()).length;
    await advance(31_000);
    assert((await reads()).length === before, `${section}: unmount leaves no trading timers`);
  }
  assert(writes.length === 0, `automatic recovery never mutates: ${writes.join(', ')}`);
  assert(errors.length === 0, errors.join('; '));
  return { passed: true, mutationRequests: writes.length, scenarios: ['three-page wake bursts', 'replace prior read once', 'offline cancellation', 'online recovery', 'pair switch preserves new read', 'single execution poll chain', 'hidden reconnect', 'hidden wake preserves poll deadline', 'unmount cleanup'] };
}
