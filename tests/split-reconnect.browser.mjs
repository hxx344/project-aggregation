// Start (Linux, Hub built): node tests/fixtures/split-browser.mjs
// Run: playwright-cli -s=split run-code --filename tests/split-reconnect.browser.mjs
// The real Hub frontend against the real runtime and API as separate
// processes (fake modules). Covers, without reloading the page:
// - the API restarting alone: the overview stream reconnects to the new API,
//   the session stays valid and events flow again;
// - a runtime fault: the API keeps the browser stream open with heartbeats,
//   marks every module stale, and once the next runtime instance is up its
//   socket subscription reconnects, so events reach the same browser stream.
// Takes about two minutes: the API marks modules stale after 30 s without the
// runtime and checks every 15 s, and its subscription retries with backoff.
async (page) => {
  const origin = 'http://hub.localhost:39154', control = 'http://127.0.0.1:39155';
  const password = 'split-browser-fixture-password';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], overviewReads = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.origin === origin && url.pathname === '/api/overview') overviewReads.push(Date.now()); });
  const call = async (route, method = 'POST') => {
    const response = await page.request.fetch(control + route, { method });
    const body = await response.json();
    assert(response.ok(), `fixture control ${route}: ${response.status()} ${JSON.stringify(body)}`);
    return body;
  };
  const until = async (predicate, ms, message) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await predicate()) return; await page.waitForTimeout(250); }
    throw new Error(`Timed out after ${ms} ms: ${message}`);
  };
  // Every EventSource the page opens, with its open, message and error counts.
  await page.addInitScript(() => {
    const Native = window.EventSource, streams = window.__streams = [];
    window.EventSource = class extends Native {
      constructor(url, init) {
        super(url, init);
        const record = { url: String(url), opens: 0, messages: 0, errors: 0 }; streams.push(record);
        this.addEventListener('open', () => { record.opens += 1; });
        this.addEventListener('message', () => { record.messages += 1; });
        this.addEventListener('error', () => { record.errors += 1; });
      }
    };
  });
  const overviewStreams = () => page.evaluate(() => window.__streams.filter(stream => stream.url.startsWith('/api/overview/events')).map(stream => ({ ...stream })));
  const opens = async () => (await overviewStreams()).reduce((sum, stream) => sum + stream.opens, 0);
  const rows = () => page.locator('.module-row:not(.module-head)').allTextContents();
  const names = { greeks: 'Greeks', monitor: 'Market Monitor', asset: 'Asset Ledger', crossex: 'Gate CrossEx', aster: 'Aster 5x' };
  // Orders are absolute, so a fixture left over from an earlier run starts the same way.
  let next = 50;
  const moveFirst = async (id, label) => {
    await call(`/order/${id}?value=${next--}`);
    await until(async () => (await rows())[0]?.startsWith(names[id]), 15_000, `${label}: ${names[id]} first through the overview stream`);
  };

  await page.goto(origin);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await until(async () => (await overviewStreams()).some(stream => stream.opens === 1 && stream.messages >= 1), 15_000, 'the overview stream is open');
  for (const id of Object.keys(names)) await call(`/order/${id}?value=100`);
  await moveFirst('crossex', 'baseline');
  await page.evaluate(() => { window.__sameDocument = true; });

  // 1. The API restarts alone: the browser stream reconnects, the session stays.
  const before = await call('/state', 'GET');
  const opensBeforeApi = await opens();
  await call('/kill/api');
  await until(async () => { const state = await call('/state', 'GET'); return state.api.ready && state.api.starts === before.api.starts + 1; }, 20_000, 'the API is started again');
  await until(async () => await opens() > opensBeforeApi, 20_000, 'the overview stream reconnects to the new API');
  await moveFirst('aster', 'after the API restart');
  const afterApi = await call('/state', 'GET');
  assert(afterApi.runtime.pid === before.runtime.pid && afterApi.runtime.starts === before.runtime.starts, 'the runtime kept running while the API restarted');
  assert(await page.locator('#password').count() === 0, 'the session outlived the API restart');
  assert(await page.evaluate(() => window.__sameDocument === true), 'the page was not reloaded');

  // 2. The runtime fails: the API keeps the stream and reports every module stale.
  const opensBeforeRuntime = await opens(), readsBeforeRuntime = overviewReads.length;
  await call('/kill/runtime?hold=1');
  await until(async () => { const current = await rows(); return current.length === 5 && current.every(row => row.includes('数据过期')); }, 60_000, 'every module is shown stale without the runtime');
  const down = await call('/state', 'GET');
  assert(down.api.pid === afterApi.api.pid && down.api.running && !down.runtime.running, 'only the runtime is down');

  // 3. The next runtime instance: the API's socket subscription reconnects and
  // its events reach the browser over the stream that stayed open.
  await call('/start/runtime');
  await until(async () => (await call('/state', 'GET')).runtime.ready, 20_000, 'the runtime is started again');
  await until(async () => { const current = await rows(); return current.length === 5 && current.every(row => !row.includes('数据过期')); }, 45_000, 'the next instance\'s overview replaces the stale one');
  await moveFirst('monitor', 'after the runtime restart');
  const after = await call('/state', 'GET');
  assert(after.api.pid === afterApi.api.pid && after.api.starts === afterApi.api.starts, 'the API kept running while the runtime restarted');
  assert(await opens() === opensBeforeRuntime, 'the browser stream stayed open through the runtime restart');
  assert(overviewReads.length === readsBeforeRuntime, `the page did not fall back to overview reads (${overviewReads.length - readsBeforeRuntime})`);
  assert(await page.locator('#password').count() === 0 && await page.evaluate(() => window.__sameDocument === true), 'the session and page outlived the runtime restart');
  assert(errors.length === 0, `Browser page errors:\n${errors.join('\n')}`);
}
