// Run with playwright-cli run-code --filename on the isolated production preview :4180.
// A faulted embedded module: restart, fast polling while it recovers, reload once ready, back to idle polling.
async (page) => {
  const origin = 'http://127.0.0.1:4180';
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [], reads = [], restarts = [], launches = [];
  let row = { moduleId: 'monitor', state: 'fault', consecutiveFailures: 3, faultReason: 'failures', waitingFor: null, maintenanceConfirmed: null }, failing = false;
  const onError = error => errors.push(error.message);
  const project = { id: 'monitor', name: 'monitor', description: '', category: 'other', adapter: 'monitor', enabled: true, embedded: true, accessMode: 'proxy',
    apiUrl: 'http://127.0.0.1:9000', url: '', mode: 'embed', hasCredentials: true, revision: 'recovery-fixture', staleAfterSeconds: 120, order: 0 };
  const handler = route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== origin) return route.abort('blockedbyclient');
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (path.startsWith('/_recovery-fixture/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><p>module fixture</p>' });
    if (path === '/api/projects/monitor/launch' && request.method() === 'POST') { launches.push(Date.now()); return send({ url: `${origin}/_recovery-fixture/${launches.length}` }); }
    if (path === '/api/system/modules/monitor/restart' && request.method() === 'POST') { restarts.push(Date.now()); row = { ...row, state: 'starting', faultReason: null }; return send({ accepted: true }, 202); }
    if (request.method() !== 'GET') return send({ error: 'Fixture rejects writes' }, 405);
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'recovery-fixture-only' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/system/modules') { reads.push(Date.now()); return failing ? send({ error: 'fixture failure' }, 503) : send({ schemaVersion: 1, enabled: true, modules: [row] }); }
    if (path === '/api/system/host') return send({ generatedAt: new Date().toISOString(), cpu: { usagePercent: 1, cores: 4, loadAverage: [0, 0, 0] }, memory: { usedPercent: 1, usedBytes: 1, totalBytes: 100, availableBytes: 99 }, disks: [], uptimeSeconds: 60 });
    if (path === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [{ project, state: 'online', freshness: 'static', message: '', checkedAt: null, updatedAt: null, latencyMs: 1, diagnostics: [], metrics: [] }] });
    if (path === '/api/system/updates') return send({ enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null });
    if (path.startsWith('/api/')) return send({ error: `Outside fixture scope ${path}` }, 404);
    return route.continue();
  };
  // Responses arrive in real time while the clock is fast-forwarded, so step one period at a time.
  const settle = async (count, label) => {
    for (let i = 0; i < 50 && reads.length < count; i++) await page.waitForTimeout(20);
    await page.waitForTimeout(200);
    assert(reads.length === count, `${label}: expected ${count} module reads, got ${reads.length}`);
  };
  page.on('pageerror', onError);
  await page.clock.install();
  await page.addInitScript(() => { window.EventSource = class { close() {} }; });
  await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?view=project&id=monitor`);
    await page.getByText('monitor 已停止运行', { exact: true }).waitFor();
    await settle(1, 'one read on open');
    await page.clock.runFor(15_100);
    await settle(2, 'a faulted module polls every 15 s');
    const launched = launches.length;

    await page.getByRole('button', { name: '重新启动模块', exact: true }).click();
    await page.getByText(/monitor 正在自动恢复/).waitFor();
    assert(restarts.length === 1, `one restart request: ${restarts.length}`);
    await settle(3, 'restart reads at once');
    await page.clock.runFor(2_100);
    await settle(4, 'a recovering module polls every 2 s');

    // A failed read stays silent and keeps the fast interval while recovering.
    failing = true;
    await page.clock.runFor(2_100);
    await settle(5, 'failed read while recovering');
    assert(await page.getByText(/monitor 正在自动恢复/).count() === 1, 'a failed read keeps the last known state');
    failing = false;

    row = { ...row, state: 'ready', consecutiveFailures: 0, maintenanceConfirmed: true };
    await page.clock.runFor(2_100);
    await settle(6, 'read that sees ready');
    await page.getByText(/monitor 正在自动恢复/).waitFor({ state: 'detached' });
    for (let i = 0; i < 50 && launches.length === launched; i++) await page.waitForTimeout(20);
    assert(launches.length === launched + 1, `ready after restart reloads the module once: ${launches.length - launched}`);

    await page.clock.runFor(2_100);
    await settle(6, 'a ready module leaves the 2 s interval');
    await page.clock.runFor(13_000);
    await settle(7, 'a ready module polls every 15 s');
    await page.clock.runFor(15_100);
    await settle(8, 'later ready reads do not reload again');
    assert(launches.length === launched + 1, `no second reload: ${launches.length - launched}`);
    assert(!errors.length, `page errors: ${errors.join('; ')}`);
    return { passed: true, scenarios: ['fault notice', '15 s idle', 'restart read', '2 s recovering', 'silent failure', 'reload once ready', 'back to 15 s'] };
  } finally {
    page.off('pageerror', onError);
    await page.unroute('**/*', handler).catch(() => {});
  }
}
