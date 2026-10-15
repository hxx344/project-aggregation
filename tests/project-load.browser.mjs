// Run: playwright-cli -s=project-load run-code --filename tests/project-load.browser.mjs
// Requires the root production preview at http://127.0.0.1:4175. All APIs and
// module documents are isolated fixtures; only the built host assets reach it.
// Optional: open /?load-case=delayed-hydration before running to select one case.
// The baseline is expected to fail late-ready and delayed-hydration separately.
async (page) => {
  const origin = 'http://127.0.0.1:4175';
  const selectedCase = new URL(page.url()).searchParams.get('load-case');
  const timeoutText = '项目页面加载超时，请重新载入或检查该项目服务。';
  const ids = ['monitor', 'asset', 'crossex', 'greeks', 'aster'];
  const adapters = { monitor: 'monitor', asset: 'asset', crossex: 'standard', greeks: 'standard', aster: 'aster' };
  const projects = ids.map((id, order) => ({ id, name: id, description: '', category: 'other', adapter: adapters[id],
    enabled: true, embedded: true, accessMode: 'proxy', apiUrl: 'http://127.0.0.1:9000', url: '', mode: 'embed',
    hasCredentials: true, revision: 'load-fixture', staleAfterSeconds: 120, order }));
  const overview = { generatedAt: '2026-10-15T04:00:00.000Z', projects: projects.map(project => ({ project,
    state: 'online', freshness: 'static', message: '', checkedAt: null, updatedAt: null, latencyMs: 1,
    diagnostics: [], metrics: [] })) };
  const ready = { channel: 'project-hub', version: 1, type: 'ready', role: 'module', capabilities: ['activity', 'navigate', 'changed'] };
  const errors = [], external = [], unexpected = [], writes = [], results = [];
  const launches = new Map(), gates = new Map();
  let currentCase = '', holdMonitorLoad = true;
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const section = () => page.locator('.project-screen[aria-label="monitor"]');
  const alertCount = () => section().getByRole('alert').filter({ hasText: timeoutText }).count();
  const frameFor = id => page.frames().find(frame => frame.url().startsWith(`${origin}/_load-fixture/${currentCase}/${id}/`));
  const eventually = async (check, message) => {
    // Node-side polling stays live while the browser's virtual clock is paused.
    for (let i = 0; i < 100; i++) { if (await check()) return; await page.waitForTimeout(20); }
    throw new Error(message);
  };
  const advance = async ms => { await page.clock.runFor(ms); await page.waitForTimeout(30); };
  const releaseLoads = () => { for (const release of gates.values()) release(); gates.clear(); };
  const pageError = error => errors.push({ case: currentCase, message: error.message, stack: error.stack });
  page.on('pageerror', pageError);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install({ time: new Date('2026-10-15T04:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-15T04:00:01Z'));
  await page.addInitScript(({ overview }) => {
    if (window !== window.top) return;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.__loadStreams = [];
    window.EventSource = class {
      constructor(url) {
        this.url = url; this.closed = false; window.__loadStreams.push(this);
        const isOverview = url.startsWith('/api/overview/events');
        queueMicrotask(() => this.emit(isOverview ? { ...overview, type: 'snapshot', sequence: 0 }
          : { type: 'snapshot', state: { enabled: true, checking: false, modules: [], job: null } }));
        this.timer = setInterval(() => this.emit({ type: 'heartbeat', sequence: 0, generatedAt: new Date().toISOString() }), 10_000);
      }
      close() { this.closed = true; clearInterval(this.timer); }
      emit(value) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(value) }); }
    };
  }, { overview });
  const moduleHtml = (token, holdLoad, automatic) => `<!doctype html><meta charset="utf-8"><body>
    <button id="interact">继续操作</button><output id="interactions">0</output>
    <script>
      const origin = ${JSON.stringify(origin)};
      window.fixture = { token: ${JSON.stringify(token)}, loaded: false, hydrated: false, activity: [], interactions: 0 };
      const sendReady = () => parent.postMessage(${JSON.stringify(ready)}, origin);
      fixture.hydrate = () => { fixture.hydrated = true; sendReady(); };
      addEventListener('load', () => { fixture.loaded = true; });
      addEventListener('message', event => {
        if (event.origin !== origin || event.source !== parent || event.data?.channel !== 'project-hub' || event.data.version !== 1) return;
        if (event.data.type === 'ready' && fixture.hydrated) sendReady();
        if (event.data.type === 'activity') fixture.activity.push(event.data);
      });
      document.querySelector('#interact').onclick = () => {
        if (fixture.hydrated) document.querySelector('#interactions').textContent = String(++fixture.interactions);
      };
      ${automatic ? 'fixture.hydrate();' : ''}
    </script>${holdLoad ? `<img src="${origin}/_load-fixture/${token}/pending.svg" alt="">` : ''}</body>`;
  const routeHandler = async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== origin) { external.push(url.href); return route.abort('blockedbyclient'); }
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const launch = path.match(/^\/api\/projects\/([^/]+)\/launch$/);
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push({ case: currentCase, method: request.method(), path });
      if (request.method() !== 'POST' || !launch || !ids.includes(launch[1])) {
        unexpected.push(`${request.method()} ${path}`); return send({ error: 'Fixture rejects data mutations' }, 405);
      }
    }
    if (path.startsWith('/_load-fixture/')) {
      if (path.endsWith('/pending.svg')) {
        await new Promise(resolve => gates.set(path, resolve));
        try { await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }); }
        catch { /* Navigation can cancel a deliberately held old document. */ }
        return;
      }
      const token = path.slice('/_load-fixture/'.length), id = token.split('/')[1];
      assert(ids.includes(id), `unexpected fixture module ${id}`);
      return route.fulfill({ contentType: 'text/html', body: moduleHtml(token, id === 'monitor' && holdMonitorLoad, id !== 'monitor') });
    }
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'load-fixture' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/system/updates') return send({ enabled: true, checking: false, modules: [], job: null });
    if (path === '/api/overview') return send(overview);
    if (launch) {
      const id = launch[1], count = (launches.get(id) || 0) + 1;
      launches.set(id, count);
      return send({ url: `${origin}/_load-fixture/${currentCase}/${id}/${count}` });
    }
    if (path.startsWith('/api/')) { unexpected.push(`${request.method()} ${path}`); return send({ error: `Unexpected API ${path}` }, 404); }
    return route.continue();
  };
  await page.route('**/*', routeHandler);
  const start = async (name, { active = true, holdLoad = true } = {}) => {
    releaseLoads(); await page.goto('about:blank');
    currentCase = name; holdMonitorLoad = holdLoad; launches.clear();
    await page.goto(`${origin}/?${active ? 'view=project&id=monitor&' : ''}fixture=${name}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.project-nav').filter({ hasText: 'monitor' }).waitFor();
    if (!active) await advance(250);
    await eventually(async () => !!frameFor('monitor') && await frameFor('monitor').evaluate(() => !!window.fixture), 'monitor document did not initialize');
    const frame = frameFor('monitor');
    if (holdLoad) await eventually(() => gates.size > 0, 'load-blocking image request did not start');
    else await eventually(() => frame.evaluate(() => fixture.loaded), 'fixture did not produce a real document load');
    await page.waitForTimeout(30);
    return frame;
  };
  const assertTimeout = async message => assert(await alertCount() === 1, message);
  const injectRejectedReady = async (kind) => {
    // Only rejection tests synthesize MessageEvent: an unloaded WindowProxy
    // cannot execute JS. Every successful handshake below uses postMessage in
    // the actual current iframe, never a forged positive readiness event.
    await page.evaluate(({ kind, ready, origin }) => {
      const current = document.querySelector('iframe[title="monitor模块"]').contentWindow;
      window.dispatchEvent(new MessageEvent('message', {
        data: ready, origin: kind === 'origin' ? 'https://untrusted.invalid' : origin,
        source: kind === 'retired-source' ? window.__retiredLoadSource : current,
      }));
    }, { kind, ready, origin });
    await page.waitForTimeout(30);
  };
  const cases = {
    'late-ready': async () => {
      const frame = await start('late-ready');
      const token = await frame.evaluate(() => fixture.token);
      await advance(29_000);
      assert(await alertCount() === 0 && (await section().getByRole('status').innerText()).includes('正在打开项目'), 'before 30 seconds the genuinely loading document must remain pending');
      assert(await frame.evaluate(() => !fixture.loaded && !fixture.hydrated), 'neither native load nor module readiness has occurred');
      await advance(2_000); await assertTimeout('after 30 seconds an unresponsive document must show the load timeout');
      await injectRejectedReady('origin'); await assertTimeout('a ready message with the wrong origin must not clear the timeout');
      await page.evaluate(ready => window.postMessage(ready, location.origin), ready);
      await page.waitForTimeout(30); await assertTimeout('a real ready message from the host window must not clear another frame\'s timeout');
      await advance(15_000); await assertTimeout('a truly unresponsive active document must remain failed without an automatic reload');
      assert(launches.get('monitor') === 1, 'timeout must not relaunch the module');
      await frame.evaluate(() => fixture.hydrate());
      await eventually(() => frame.evaluate(() => fixture.activity.some(item => item.active && item.backgroundUpdates)), 'the current module did not complete the real activity handshake');
      assert(await frame.evaluate(token => !fixture.loaded && fixture.token === token, token), 'late readiness must recover the same document before native load');
      assert(await alertCount() === 0, 'valid late activity-ready must clear the existing timeout error');
      await frame.getByRole('button', { name: '继续操作', exact: true }).click();
      assert(await frame.locator('#interactions').innerText() === '1', 'the recovered module remains interactive');
      releaseLoads();
      await eventually(() => frame.evaluate(() => fixture.loaded && fixture.activity.length > 1), 'native load must revalidate the hydrated module');
      await page.getByRole('button', { name: '总览', exact: true }).click();
      await page.locator('.project-nav').filter({ hasText: 'monitor' }).click();
      assert(frameFor('monitor') === frame && launches.get('monitor') === 1, 'navigation after recovery must retain the recovered document');
      assert(await alertCount() === 0, 'the timeout must stay cleared after native load and module switches');
    },
    'retired-source': async () => {
      const oldFrame = await start('retired-source');
      await page.evaluate(() => { window.__retiredLoadSource = document.querySelector('iframe[title="monitor模块"]').contentWindow; });
      await section().getByRole('button', { name: '重新载入', exact: true }).click();
      await eventually(async () => launches.get('monitor') === 2 && !!frameFor('monitor') && frameFor('monitor') !== oldFrame
        && await frameFor('monitor').evaluate(() => !!window.fixture), 'reload did not replace the iframe document');
      assert(oldFrame.isDetached(), 'the original frame must be detached before its source is replayed');
      await advance(31_000); await assertTimeout('the replacement document must have its own loading deadline');
      await injectRejectedReady('retired-source');
      await assertTimeout('a valid-origin ready message from the retired source must not recover the replacement document');
      assert(await frameFor('monitor').evaluate(() => fixture.activity.length === 0 && !fixture.hydrated && !fixture.loaded), 'retired readiness must not acknowledge or initialize the current module');
      await advance(15_000); await assertTimeout('rejected stale readiness must leave the current unresponsive document failed');
      assert(launches.get('monitor') === 2, 'only the explicit reload may request a second launch');
    },
    'delayed-hydration': async () => {
      const frame = await start('delayed-hydration', { active: false, holdLoad: false });
      const token = await frame.evaluate(() => fixture.token);
      await advance(4_000);
      assert(!frame.isDetached() && frameFor('monitor') === frame, 'known embedded preload must survive document load followed by more than 3 seconds of hydration delay');
      assert(launches.get('monitor') === 1 && await frame.evaluate(() => fixture.loaded && !fixture.hydrated), 'the original loaded document must remain available for its delayed handshake');
      await advance(24_000);
      assert(!frame.isDetached(), 'the known embedded module must retain its document throughout the 30-second readiness window');
      await frame.evaluate(() => fixture.hydrate());
      await eventually(() => frame.evaluate(() => fixture.activity.some(item => !item.active && item.backgroundUpdates)), 'delayed background hydration must receive background activity permission');
      await eventually(async () => launches.size === ids.length && page.frames().filter(item => item !== page.mainFrame()).length === ids.length, 'successful hydration must allow all five current modules to preload');
      await page.locator('.project-nav').filter({ hasText: 'monitor' }).click();
      assert(frameFor('monitor') === frame && await frame.evaluate(token => fixture.token === token, token), 'opening the hydrated module must reuse its original document');
      assert(launches.get('monitor') === 1 && await alertCount() === 0, 'delayed hydration must not cause an extra launch or leave an error');
    },
    'unresponsive-preload': async () => {
      const frame = await start('unresponsive-preload', { active: false, holdLoad: false });
      await advance(31_000);
      assert(frame.isDetached(), 'an embedded preload that never handshakes must be released after the bounded readiness window');
      await eventually(() => launches.size === ids.length && page.frames().filter(item => item !== page.mainFrame()).length === ids.length - 1,
        'failed preload must not block the remaining four modules indefinitely');
      assert(launches.get('monitor') === 1 && !frameFor('monitor'), 'an unresponsive background module must not enter an automatic relaunch loop');
      assert(page.frames().filter(item => item !== page.mainFrame()).length === ids.length - 1, 'only the four responsive modules should remain resident');
    },
  };
  try {
    assert(!selectedCase || Object.hasOwn(cases, selectedCase), `unknown load-case ${selectedCase}`);
    for (const [name, run] of Object.entries(cases)) {
      if (selectedCase && selectedCase !== name) continue;
      const errorsBefore = errors.length;
      try {
        await run();
        assert(errors.length === errorsBefore, 'browser raised an uncaught page error');
        results.push({ name, passed: true, launches: Object.fromEntries(launches) });
      } catch (error) {
        results.push({ name, passed: false, message: error.message, stack: error.stack,
          pageerrors: errors.slice(errorsBefore), launches: Object.fromEntries(launches), frames: page.frames().map(frame => frame.url()) });
      }
    }
    const failed = results.filter(result => !result.passed);
    assert(!failed.length && !unexpected.length && !external.length && !errors.length,
      JSON.stringify({ failed, pageerrors: errors, unexpected, external, results }, null, 2));
    assert(writes.every(write => write.method === 'POST' && /^\/api\/projects\/(monitor|asset|crossex|greeks|aster)\/launch$/.test(write.path)), 'the regression must send only launch writes');
    return { passed: true, cases: results, pageerrors: errors, dataMutations: 0, launchRequests: writes.length };
  } finally {
    releaseLoads();
    await page.clock.resume();
    await page.goto('about:blank');
    await page.unroute('**/*', routeHandler);
    page.off('pageerror', pageError);
  }
}
