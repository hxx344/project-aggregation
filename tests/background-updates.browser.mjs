// Run with playwright-cli run-code --filename against the isolated production preview.
async (page) => {
  const origin = 'http://127.0.0.1:4175';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const ids = ['aster', 'monitor', 'asset', 'crossex', 'variational', 'greeks'];
  const projects = ids.map((id, order) => ({ id, name: id, description: '', category: 'other', adapter: order > 2 ? 'standard' : id,
    enabled: true, accessMode: 'proxy', apiUrl: 'http://127.0.0.1:9000', url: '', mode: 'embed', hasCredentials: true, revision: 'one', staleAfterSeconds: 120, order }));
  let sample = 1, expire = false, hold = false;
  const reads = [], writes = [], errors = [], held = [], launches = new Map();
  const state = () => ({ generatedAt: new Date(Date.UTC(2026, 9, 9, 4, 0, sample)).toISOString(), projects: projects.map(project => ({ project,
    state: 'online', freshness: 'static', message: '', checkedAt: null, updatedAt: null, latencyMs: 1,
    metrics: [{ key: 'sample', label: `样本-${project.id}`, value: sample }] })) });
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-10-09T04:00:00Z') });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    window.__hidden = false; window.__online = true; window.__streams = [];
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__hidden ? 'hidden' : 'visible' });
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => window.__online });
    window.EventSource = class {
      constructor() { this.closed = false; window.__streams.push(this); }
      close() { this.closed = true; }
      emit(value) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(value) }); }
    };
  });
  const moduleHtml = () => `<!doctype html><body><output id="reads">0</output><script>
    const origin = ${JSON.stringify(origin)};
    window.fixture = { reads: 0, activity: [], allowed: false };
    const send = value => parent.postMessage({ channel: 'project-hub', version: 1, ...value }, origin);
    const ready = () => send({ type: 'ready', role: 'module', capabilities: ['activity', 'navigate', 'changed'] });
    addEventListener('message', event => {
      if (event.origin !== origin || event.source !== parent || event.data.channel !== 'project-hub') return;
      if (event.data.type === 'ready') ready();
      if (event.data.type === 'activity') { fixture.activity.push(event.data); fixture.allowed = event.data.active || event.data.backgroundUpdates === true; }
    });
    setInterval(() => { if (fixture.allowed) document.querySelector('output').textContent = String(++fixture.reads); }, 30000);
    ready();
    window.navigateHost = () => send({ type: 'navigate', projectId: 'monitor', query: {} });
    </script></body>`;
  await page.route(`${origin}/fixtures/**`, route => route.fulfill({ contentType: 'text/html', body: moduleHtml() }));
  await page.route(`${origin}/api/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (request.method() !== 'GET') writes.push(url.pathname);
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture' });
    const launch = url.pathname.match(/^\/api\/projects\/([^/]+)\/launch$/);
    if (launch) { launches.set(launch[1], (launches.get(launch[1]) || 0) + 1); return send({ url: `${origin}/fixtures/${launch[1]}` }); }
    if (url.pathname === '/api/overview') {
      reads.push(sample); const data = state();
      if (hold) { hold = false; await new Promise(resolve => held.push(resolve)); }
      return send(expire ? { error: '登录已过期' } : data, expire ? 401 : 200);
    }
    return send({ error: `Unexpected API ${url.pathname}` }, 404);
  });
  const emit = async () => page.evaluate(value => window.__streams.at(-1).emit(value), state());
  const checkSample = async () => {
    const expected = await page.evaluate(at => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(at)), state().generatedAt);
    assert(await page.locator('.refresh-label').innerText() === `总览读取于 ${expected}`, 'the current sample is rendered');
  };
  const advance = async ms => { await page.clock.runFor(ms); await page.waitForTimeout(30); };
  const readNow = async event => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/overview');
    await page.evaluate(event => window.dispatchEvent(new Event(event)), event);
    await (await response).finished(); await page.waitForTimeout(30);
  };
  await page.goto(origin);
  await page.waitForFunction(() => window.__streams?.length > 0);
  await emit();
  for (let i = 0; i < 10 && page.frames().length < 7; i++) await advance(300);
  assert(page.frames().length === 7, 'all six module frames preload');
  const frames = page.frames().filter(frame => frame !== page.mainFrame());
  await advance(300);
  for (const frame of frames) {
    assert(await frame.evaluate(() => fixture.activity.at(-1).active === false && fixture.activity.at(-1).backgroundUpdates === true), 'inactive module keeps explicit background permission');
  }
  await page.locator('.project-nav').filter({ hasText: 'aster' }).click();
  await page.locator('.project-nav').filter({ hasText: 'asset' }).click();
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await page.locator('.project-nav').filter({ hasText: 'aster' }).click();
  assert([...launches.values()].every(value => value === 1), 'module switches retain frame documents');
  const connections = await page.evaluate(() => window.__streams.length);
  const selectedUrl = page.url();
  await page.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  for (const frame of frames) assert(await frame.evaluate(() => fixture.activity.at(-1).active === false && fixture.activity.at(-1).backgroundUpdates === true), 'browser hiding preserves reads without foreground permission');
  for (let i = 0; i < 6; i++) { sample++; await advance(15_000); await emit(); }
  assert(await page.evaluate(() => window.__streams.length === 1 && !window.__streams[0].closed), 'hidden tab retains its healthy stream');
  assert(connections === 1, 'navigation does not recreate the stream');
  for (const frame of frames) assert(await frame.evaluate(() => fixture.reads >= 3), 'every hidden module advances multiple background rounds');
  await frames[0].evaluate(() => navigateHost()); await page.waitForTimeout(30);
  assert(page.url() === selectedUrl, 'hidden module cannot navigate the host');
  await checkSample();

  // A disconnected stream still gets bounded cache reads while hidden.
  let response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/overview');
  await page.evaluate(() => window.__streams.at(-1).onerror());
  await (await response).finished();
  const before = reads.length; sample++;
  await advance(30_000);
  assert(reads.length > before, 'hidden stream failure keeps thirty-second fallback polling');

  // Each wake replaces a held request; delayed old data may never win.
  for (const event of ['focus', 'pageshow', 'online']) {
    hold = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    for (let i = 0; i < 20 && !held.length; i++) await page.waitForTimeout(10);
    assert(held.length === 1, 'old read remains in flight');
    sample++; await readNow(event);
    held.shift()(); await page.waitForTimeout(30);
    await checkSample();
  }
  await page.evaluate(() => { window.__online = false; window.dispatchEvent(new Event('offline')); });
  const offlineReads = reads.length;
  await advance(60_000); assert(reads.length === offlineReads, 'offline suspends reads');
  await page.evaluate(() => { window.__online = true; });
  sample++; await readNow('online');
  response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/overview');
  await page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await (await response).finished();
  expire = true; await readNow('focus');
  await page.getByRole('heading', { name: '进入工作台', exact: true }).waitFor();
  const loggedOutReads = reads.length;
  await advance(60_000); assert(reads.length === loggedOutReads && page.frames().length === 1, 'expiry stops polling and removes modules');
  assert(writes.length === 6 && writes.every(path => path.endsWith('/launch')), 'automatic refresh sends no data mutations');
  assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
  return { passed: true, modules: ids.length, hiddenRounds: 3, overviewReads: reads.length, launches: Object.fromEntries(launches), scenarios: ['background stream', 'background fallback', 'retained modules', 'hidden navigation rejected', 'late read isolation', 'wake recovery', 'offline', 'session expiry'] };
}
