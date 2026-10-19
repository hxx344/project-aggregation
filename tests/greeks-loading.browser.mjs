// Copy modules/greeks/app/static/hub.js to the preview's __greeks_hub_fixture.js.
// Run from http://hub.localhost:<isolated preview port>; API/module traffic is mocked.
async (page) => {
  const origin = new URL(page.url()).origin;
  const fixtureUrl = new URL('/__greeks_hub_fixture.js', origin);
  fixtureUrl.hostname = '127.0.0.1'; // Node's request client does not resolve Chrome's .localhost aliases.
  const response = await page.request.get(fixtureUrl.href);
  const hubScript = await response.text();
  if (!response.ok() || !hubScript.includes('window.ProjectHub = bridge')) throw new Error('Copy the real Greeks hub.js into the isolated preview before running');
  const greekOrigin = origin.replace('hub.localhost', 'p-0123456789abcdef01234567.hub.localhost');
  if (greekOrigin === origin) throw new Error('This bridge fixture needs a hub.localhost preview');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const until = async (check, message) => {
    for (let i = 0; i < 100; i++) { if (await check()) return; await page.waitForTimeout(20); }
    throw new Error(message);
  };
  const projects = ['monitor', 'greeks'].map((id, order) => ({ id, name: id, description: '', category: 'other',
    adapter: id === 'monitor' ? id : 'standard', embedded: true, enabled: true, accessMode: 'proxy',
    apiUrl: 'http://127.0.0.1:9000', url: '', mode: 'embed', hasCredentials: true, revision: 'split-scripts', staleAfterSeconds: 120, order }));
  const overview = { generatedAt: new Date().toISOString(), projects: projects.map(project => ({ project, state: 'online',
    freshness: 'static', message: '', metrics: [], diagnostics: [], checkedAt: null, updatedAt: null, latencyMs: 1 })) };
  const errors = [];
  let releaseMain, requestedMain = false;
  const main = new Promise(resolve => { releaseMain = resolve; });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(overview => {
    if (window !== window.top) return;
    window.EventSource = class {
      constructor(url) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(url.startsWith('/api/overview/events') ? overview : { type: 'snapshot', state: { enabled: false } }) })); }
      close() {}
    };
  }, overview);
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (![origin, greekOrigin].includes(url.origin)) return route.abort('blockedbyclient');
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/session') return json({ authenticated: true, csrfToken: 'split-script-fixture' });
    if (url.pathname === '/api/overview') return json(overview);
    if (url.pathname === '/api/health') return json({ status: 'ok' });
    if (url.pathname === '/api/system/updates') return json({ enabled: false, checking: false, modules: [], job: null });
    if (url.pathname === '/api/projects/monitor/launch') return json({ url: origin + '/retained-monitor' });
    if (url.pathname === '/api/projects/greeks/launch') return json({ url: greekOrigin + '/split-greeks' });
    if (url.pathname === '/retained-monitor') return route.fulfill({ contentType: 'text/html', body: `<script>
      window.fixture = { reads: 0, activity: [], allowed: false };
      const ready = () => parent.postMessage({ channel: 'project-hub', version: 1, type: 'ready', role: 'module', capabilities: ['activity'] }, ${JSON.stringify(origin)});
      addEventListener('message', event => {
        if (event.origin !== ${JSON.stringify(origin)} || event.source !== parent || event.data?.channel !== 'project-hub') return;
        if (event.data.type === 'ready') ready();
        if (event.data.type === 'activity') { fixture.activity.push(event.data); fixture.allowed = event.data.active || event.data.backgroundUpdates; }
      });
      setInterval(() => { if (fixture.allowed) fixture.reads++; }, 50); ready();
      </script>` });
    if (url.pathname === '/split-greeks') return route.fulfill({ contentType: 'text/html', body: '<script src="/static/hub.js"></script><script src="/static/app.js"></script>' });
    if (url.pathname === '/static/hub.js') return route.fulfill({ contentType: 'text/javascript', body: hubScript });
    if (url.pathname === '/static/app.js') {
      requestedMain = true; await main;
      return route.fulfill({ contentType: 'text/javascript', body: 'window.ProjectHub.register("fixture", 1000, () => {}); window.ProjectHub.start();' }).catch(() => {});
    }
    return route.continue();
  });
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await until(() => requestedMain, 'the real Greeks bridge did not precede its main script');
    const monitor = page.frames().find(frame => frame.url() === origin + '/retained-monitor');
    await page.locator('.project-nav').filter({ hasText: 'greeks' }).click();
    await until(() => monitor.evaluate(() => fixture.activity.at(-1)?.backgroundUpdates === false), 'early bridge readiness resumed background reads before the main script');
    const before = await monitor.evaluate(() => fixture.reads);
    await page.waitForTimeout(250);
    assert(await monitor.evaluate(() => fixture.reads) === before, 'background polling competed with the pending main script');
    releaseMain();
    await until(() => monitor.evaluate(() => fixture.activity.at(-1)?.backgroundUpdates === true), 'main initialization did not restore background permission');
    await until(async () => await monitor.evaluate(() => fixture.reads) > before, 'background reads did not resume');
    assert(errors.length === 0, errors.join('\n'));
    return { earlyHandshakeKeptPriority: true, resumedAfterMainScript: true };
  } finally {
    releaseMain(); await page.goto('about:blank'); await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
}
