// Production workbench preview on 4175 and Monitor tests/ssr-browser-server.mjs (default 3189; start the
// session on another fixture origin such as http://127.0.0.1:3190 to override).
// Run via playwright-cli run-code --filename tests/monitor-embed-hydration.browser.mjs.
// Every API is an isolated fixture. #224: first opening either market through the proxy iframe must hydrate
// without React #418, and a module whose host never answers must not start any market read.
async page => {
  const current = page.url().startsWith('http://127.0.0.1:') ? new URL(page.url()).origin : null;
  const origin = 'http://hub.localhost:4175', moduleOrigin = 'http://p-0123456789abcdef01234567.hub.localhost:4175';
  const monitorBuild = current ?? 'http://127.0.0.1:3189', hour = 3_600_000;
  const now = Date.now(), end = Math.floor(now / hour) * hour - hour, stamp = new Date(now).toISOString();
  const iso = time => new Date(time).toISOString();
  const check = (value, message) => { if (!value) throw new Error(message); };
  const project = { id: 'monitor', name: 'monitor', description: '', category: 'other', adapter: 'monitor', enabled: true, embedded: true, accessMode: 'proxy', apiUrl: 'http://127.0.0.1:9000', url: '', mode: 'embed', hasCredentials: true, revision: 'embed-hydration-fixture', staleAfterSeconds: 120, order: 0 };
  const overview = { generatedAt: stamp, projects: [{ project, state: 'online', freshness: 'static', message: '', checkedAt: null, updatedAt: null, latencyMs: 1, diagnostics: [], metrics: [] }] };
  const samples = Array.from({ length: 10 * 96 }, (_, index) => ({ time: end - (10 * 96 - 1 - index) * 900_000, brent: 110, wti: 100 }));
  const candles = { status: 'live', metadata: { source: 'Binance', currency: 'USDT', symbols: ['BZUSDT', 'CLUSDT'], interval: '15m', timezone: 'UTC', priceBasis: 'Paired completed 15-minute trade candle closes', fetchedAt: stamp, firstCommonObservation: iso(samples[0].time), lastCommonObservation: iso(end), pairedObservationRows: samples.length, expectedObservationRows: samples.length, missingObservationRows: 0 }, data: samples };
  const points = samples.filter(item => item.time % hour === 0).map(item => ({ time: item.time, adr: 45, ordinary: 400, equivalent: 40, spread: 5, premium: 12.5 }));
  const titles = { oil: '原油价差', hynix: '海力士 ADR' }, details = { oil: '/api/monitors/oil/candles/15m', hynix: '/api/monitors/hynix/history' };
  const report = {};
  async function visit(market, silentHost) {
    const errors = [], reads = [], listener = error => errors.push(error.stack ?? error.message);
    const handler = async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      const send = (json, status = 200) => route.fulfill({ status, json });
      if (url.origin === moduleOrigin) {
        if (request.method() !== 'GET') throw new Error(`Unexpected module write: ${path}`);
        if (!path.startsWith('/api/')) return route.fulfill({ response: await route.fetch({ url: monitorBuild + path + url.search }) });
        reads.push(path);
        if (path === '/api/monitors') return send({ schemaVersion: 1, monitors: ['oil', 'hynix', 'perpetual'].map(id => ({ id, runtime: { available: true, monitorId: id, enabled: true, running: true, revision: 0 } })) });
        if (path === details.oil) return send(candles);
        if (path === details.hynix) return send({ points, status: 'live', fetchedAt: stamp, interval: '1h', firstAvailable: iso(points[0].time), warnings: [] });
        return send({ error: 'Controlled unavailable fixture' }, 503);
      }
      if (url.origin !== origin) return route.abort('blockedbyclient');
      if (path === '/silent-host') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><iframe title="silent" style="width:1400px;height:1000px" src="${moduleOrigin}/?monitor=${market}"></iframe>` });
      if (path === '/api/projects/monitor/launch' && request.method() === 'POST') return send({ url: `${moduleOrigin}/?monitor=${market}` });
      if (request.method() !== 'GET') throw new Error(`Unexpected host write: ${path}`);
      if (path === '/api/session') return send({ authenticated: true, csrfToken: 'embed-hydration-fixture-only' });
      if (path === '/api/health') return send({ status: 'ok' });
      if (path === '/api/overview/events' || path === '/api/system/updates/events') return route.abort();
      if (path === '/api/overview') return send(overview);
      if (path === '/api/system/updates') return send({ enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null });
      if (path === '/api/trading/fills' || path === '/api/trading/positions') return send({ generatedAt: stamp, sources: [] });
      if (path.startsWith('/api/')) return send({ error: 'Controlled unavailable fixture' }, 503);
      return route.continue();
    };
    await page.goto('about:blank');
    await page.unrouteAll({ behavior: 'wait' });
    await page.setViewportSize({ width: 1440, height: 1050 });
    page.on('pageerror', listener);
    await page.route('**/*', handler);
    try {
      if (silentHost) {
        await page.goto(`${origin}/silent-host`);
        const frame = page.frameLocator('iframe[title="silent"]');
        await frame.locator('.hub-summary-card').first().waitFor();
        // Long enough for every poller's first read and the bridge's ready probe to have run.
        await page.waitForTimeout(3000);
        check(reads.length === 0, `${market}: an unanswered embed must not read before the host replies: ${reads.join(', ')}`);
        check(await frame.locator('[role="tabpanel"]:not([hidden]) .chart-panel').count() === 0, `${market}: inactive charts stay unmounted until the first real visit`);
      } else {
        await page.goto(`${origin}/?view=project&id=monitor`);
        const panel = page.frameLocator('iframe[title="monitor模块"]').getByRole('tabpanel', { name: titles[market], exact: true });
        await panel.getByRole('region', { name: '历史价差图表', exact: true }).waitFor();
        await page.waitForTimeout(1000);
        check(reads.includes(details[market]), `${market}: the detail history must load through the bridge`);
      }
      check(errors.length === 0, `${market}${silentHost ? ' (silent host)' : ''}: ${errors.join('\n')}`);
      report[`${market}${silentHost ? 'SilentHost' : ''}`] = { errors: errors.length, reads: [...new Set(reads)].length };
    } finally {
      page.off('pageerror', listener);
      await page.unroute('**/*', handler);
    }
  }
  for (const market of ['oil', 'hynix']) { await visit(market, false); await visit(market, true); }
  return { passed: true, monitorBuild, report };
}
