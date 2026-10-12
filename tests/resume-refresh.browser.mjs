// Run with playwright-cli run-code --filename against the production preview on 4175.
async (page) => {
  const origin = 'http://hub.localhost:3100';
  const paths = ['/api/overview', '/api/system/updates'];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], held = [];
  let hold = false, helperReads = 0;
  const overview = { generatedAt: new Date().toISOString(), projects: [] };
  const updates = { enabled: true, checking: false, modules: [], job: null, checkedAt: null, planId: null, expiresAt: null };
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.addInitScript(() => {
    window.__online = true; window.__streams = []; window.__reads = [];
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => window.__online });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    const original = window.fetch;
    window.fetch = (input, options) => {
      const path = new URL(input instanceof Request ? input.url : input, location.href).pathname;
      if (['/api/overview', '/api/system/updates'].includes(path)) {
        const read = { path, aborted: false }; window.__reads.push(read);
        options?.signal?.addEventListener('abort', () => { read.aborted = true; }, { once: true });
      }
      return original(input, options);
    };
    window.EventSource = class {
      constructor(url) { this.url = url; this.closed = false; window.__streams.push(this); }
      close() { this.closed = true; }
      emit(data) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(data) }); }
    };
  });
  await page.route('http://127.0.0.1:3101/**', route => { helperReads++; return route.abort(); });
  await page.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const send = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'fixture' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/logout') return send({ ok: true });
    if (paths.includes(path)) {
      if (hold) await new Promise(resolve => held.push(resolve));
      return send(path === paths[0] ? overview : updates);
    }
    if (path.startsWith('/api/')) return send({});
    return route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:4175${path}` }) });
  });
  const advance = async ms => { await page.clock.runFor(ms); await page.waitForTimeout(50); };
  const reads = () => page.evaluate(() => window.__reads);
  const burst = () => page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    for (const event of ['focus', 'pageshow']) window.dispatchEvent(new Event(event));
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.__streams.length === 2);
  await advance(2_000);
  let before = (await reads()).length;
  hold = true;
  await burst(); await advance(1_100);
  let changes = (await reads()).slice(before);
  assert(paths.every(path => changes.filter(read => read.path === path).length === 1) && changes.every(read => !read.aborted), `wake burst must issue one uncancelled read per endpoint: ${JSON.stringify(changes)}`);
  hold = false; held.splice(0).forEach(resolve => resolve()); await page.waitForTimeout(50);

  // A stream snapshot that arrives during the grace period suppresses fallback reads.
  before = (await reads()).length;
  await burst();
  await page.evaluate(({ overview, updates }) => {
    for (const stream of window.__streams.filter(stream => !stream.closed)) {
      stream.emit(stream.url.includes('/system/') ? { type: 'snapshot', state: updates } : overview);
    }
  }, { overview, updates });
  await advance(1_100);
  assert((await reads()).length === before, 'healthy streams suppress redundant wake reads');

  // Losing the network during the grace period cancels both scheduled reads.
  await page.evaluate(() => window.__streams.filter(stream => !stream.closed).forEach(stream => stream.onerror?.()));
  await page.waitForTimeout(50); before = (await reads()).length;
  await burst();
  await page.evaluate(() => { window.__online = false; window.dispatchEvent(new Event('offline')); });
  await advance(1_100);
  assert((await reads()).length === before, 'offline cancels pending wake reads');
  await page.evaluate(() => { window.__online = true; });
  await burst(); await advance(1_100);
  changes = (await reads()).slice(before);
  assert(paths.every(path => changes.filter(read => read.path === path).length === 1), 'network recovery reads each endpoint once');

  // A fallback started after the wake event must be reused, not cancelled at 1s.
  hold = true; before = (await reads()).length;
  await burst();
  await page.evaluate(() => window.__streams.findLast(stream => !stream.closed && stream.url.includes('/overview/')).onerror?.());
  await advance(1_100);
  changes = (await reads()).slice(before);
  assert(paths.every(path => changes.filter(read => read.path === path).length === 1) && changes.every(read => !read.aborted), 'wake reuses fallback reads started during the grace period');
  hold = false; held.splice(0).forEach(resolve => resolve()); await page.waitForTimeout(50);

  before = (await reads()).length;
  await burst();
  await page.getByRole('button', { name: /退出/ }).click();
  await page.getByRole('heading', { name: '进入工作台', exact: true }).waitFor();
  await advance(1_100);
  assert((await reads()).length === before, 'logout cancels pending wake reads');
  assert(helperReads === 0, 'the workbench no longer polls the local route helper');
  assert(errors.length === 0, errors.join('; '));
  return { passed: true, scenarios: ['wake burst', 'stream wins', 'offline cancellation', 'online recovery', 'reuse new fallback', 'logout cleanup', 'no local helper polling'] };
}
