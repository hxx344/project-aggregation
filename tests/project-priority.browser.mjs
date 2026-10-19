// Run against an isolated production preview; every module and API is a fixture.
async (page) => {
  const origin = new URL(page.url()).origin;
  const ids = ['monitor', 'asset', 'crossex', 'greeks', 'aster'];
  const projects = ids.map((id, order) => ({ id, name: id, description: '', category: 'other',
    adapter: ['crossex', 'greeks'].includes(id) ? 'standard' : id, enabled: true, embedded: true,
    accessMode: 'proxy', apiUrl: 'http://127.0.0.1:9000', url: '', mode: 'embed', hasCredentials: true,
    revision: 'priority-fixture', staleAfterSeconds: 120, order }));
  const overview = { generatedAt: new Date().toISOString(), projects: projects.map(project => ({ project,
    state: 'online', freshness: 'static', message: '', checkedAt: null, updatedAt: null, latencyMs: 1, metrics: [], diagnostics: [] })) };
  const launches = [], releases = [], errors = [];
  let blocked = 'crossex';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const until = async (check, message) => {
    for (let i = 0; i < 100; i++) { if (await check()) return; await page.waitForTimeout(20); }
    throw new Error(message);
  };
  const moduleFrame = id => page.frames().find(frame => frame.url().startsWith(`${origin}/priority-fixture/${id}/`));
  const script = `
    window.fixture = { activity: [], reads: 0, allowed: false };
    const send = () => parent.postMessage({ channel: 'project-hub', version: 1, type: 'ready', role: 'module', capabilities: ['activity'] }, ${JSON.stringify(origin)});
    addEventListener('message', event => {
      if (event.origin !== ${JSON.stringify(origin)} || event.source !== parent || event.data?.channel !== 'project-hub') return;
      if (event.data.type === 'ready') send();
      if (event.data.type === 'activity') { fixture.activity.push(event.data); fixture.allowed = event.data.active || event.data.backgroundUpdates; }
    });
    setInterval(() => { if (fixture.allowed) fixture.reads++; }, 50);
    send();`;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(overview => {
    if (window !== window.top) return;
    window.EventSource = class {
      constructor(url) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(url.startsWith('/api/overview/events') ? overview : { type: 'snapshot', state: { enabled: false } }) })); }
      close() {}
    };
  }, overview);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/session') return json({ authenticated: true, csrfToken: 'priority-fixture' });
    if (url.pathname === '/api/overview') return json(overview);
    if (url.pathname === '/api/health') return json({ status: 'ok' });
    if (url.pathname === '/api/system/updates') return json({ enabled: false, checking: false, modules: [], job: null });
    const launch = url.pathname.match(/^\/api\/projects\/([^/]+)\/launch$/);
    if (launch) { launches.push(launch[1]); return json({ url: `${origin}/priority-fixture/${launch[1]}/index.html` }); }
    if (url.pathname.startsWith('/priority-fixture/')) {
      const id = url.pathname.split('/')[2];
      if (url.pathname.endsWith('.js')) {
        if (id === blocked) await new Promise(resolve => releases.push(resolve));
        return route.fulfill({ contentType: 'text/javascript', body: script }).catch(() => {});
      }
      return route.fulfill({ contentType: 'text/html', body: `<script src="./entry.js"></script>` });
    }
    if (url.pathname.startsWith('/api/')) throw new Error(`Unexpected API ${request.method()} ${url.pathname}`);
    return route.continue();
  });
  try {
    await page.goto(`${origin}/?view=project&id=crossex`, { waitUntil: 'domcontentloaded' });
    await until(() => releases.length > 0, 'foreground build did not start');
    await page.waitForTimeout(350);
    assert(launches.join(',') === 'crossex', 'opening a project must not download other modules before it is ready');
    blocked = ''; releases.splice(0).forEach(release => release());
    await until(async () => await moduleFrame('crossex')?.evaluate(() => typeof fixture !== 'undefined' && fixture.activity.some(item => item.active)), 'foreground project did not become ready');
    await page.waitForTimeout(250);
    assert(launches.join(',') === 'crossex', 'automatic warming must not compete with an open project');

    blocked = 'monitor';
    await page.getByRole('button', { name: '总览', exact: true }).click();
    await until(() => releases.length > 0, 'overview did not start bounded speculative warming');
    const cancelled = moduleFrame('monitor');
    await page.locator('.project-nav').filter({ hasText: 'aster' }).click();
    await until(async () => await moduleFrame('aster')?.evaluate(() => typeof fixture !== 'undefined' && fixture.activity.some(item => item.active)), 'explicit selection was held behind speculation');
    assert(cancelled.isDetached(), 'the unfinished background document must be released');
    blocked = ''; releases.splice(0).forEach(release => release());

    // A reload must pause existing background reads, then restore their original
    // low-frequency permission without replacing the retained documents.
    const retained = moduleFrame('crossex');
    blocked = 'aster';
    await page.locator('.project-screen[aria-label="aster"]').getByRole('button', { name: '重新载入', exact: true }).click();
    await until(() => releases.length > 0, 'reload did not reach the delayed asset');
    await until(() => retained.evaluate(() => fixture.activity.at(-1)?.backgroundUpdates === false), 'background reads were not paused for the foreground load');
    const before = await retained.evaluate(() => fixture.reads);
    await page.waitForTimeout(200);
    assert(await retained.evaluate(() => fixture.reads) === before, 'background reads continued to consume the foreground connection budget');
    blocked = ''; releases.splice(0).forEach(release => release());
    await until(() => retained.evaluate(() => fixture.activity.at(-1)?.backgroundUpdates === true), 'background permission was not restored after readiness');
    await until(async () => await retained.evaluate(() => fixture.reads) > before, 'retained background reads did not resume');
    assert(!retained.isDetached(), 'bandwidth priority must preserve existing documents');
    assert(errors.length === 0, errors.join('\n'));
    return { foregroundLaunches: 1, cancelledSpeculation: true, backgroundPausedDuringLoad: true, backgroundResumed: true };
  } finally {
    blocked = ''; releases.splice(0).forEach(release => release());
    await page.goto('about:blank');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
}
