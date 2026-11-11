// Run with playwright-cli run-code --filename on the isolated production preview :4180.
// The topbar load badge and the server status page share one host read.
async (page) => {
  const origin = 'http://127.0.0.1:4180';
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [], hostReads = [], loopReads = [];
  let hostMode = 'normal';
  const onError = error => errors.push(error.message);
  const host = () => ({ schemaVersion: 1, generatedAt: new Date().toISOString(), cpu: { usagePercent: 12, cores: 2, model: null, loadAverage: [0.1, 0.2, 0.3] },
    memory: { totalBytes: 4e9, availableBytes: 3e9, usedBytes: 1e9, usedPercent: 25, swap: null }, disks: [], uptimeSeconds: 3600 });
  const loop = () => ({ schemaVersion: 1, generatedAt: new Date().toISOString(), monitoring: true, since: null, tickMs: 100, stallThresholdMs: 200,
    lastMinute: { maxMs: 12, stalls: 0 }, lastFiveMinutes: { maxMs: 30, stalls: 0 }, recentStalls: [] });
  const external = route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort();
  const handler = route => {
    const pathname = new URL(route.request().url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture' });
    if (pathname === '/api/health') return send({ status: 'ok' });
    if (pathname === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [] });
    if (pathname === '/api/system/updates') return send({ enabled: false, checking: false, modules: [] });
    if (pathname === '/api/system/host') { hostReads.push(Date.now()); return hostMode === 'failure' ? send({ error: 'fixture failure' }, 503) : send(host()); }
    if (pathname === '/api/system/event-loop') { loopReads.push(Date.now()); return send(loop()); }
    if (pathname === '/api/system/backup-readiness') return send({ error: 'Outside fixture scope' }, 503);
    return send({ error: 'Outside fixture scope' }, 503);
  };
  const setHidden = value => page.evaluate(hidden => { Object.defineProperty(document, 'hidden', { configurable: true, value: hidden }); document.dispatchEvent(new Event('visibilitychange')); }, value);
  const previousViewport = page.viewportSize();
  page.on('pageerror', onError);
  await page.clock.install();
  await page.addInitScript(() => { window.EventSource = class { close() {} }; });
  await page.route('**/*', external);
  await page.route(`${origin}/api/**`, handler);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(origin);
    const badge = page.locator('.host-status summary');
    await page.waitForFunction(() => document.querySelector('.host-status summary')?.getAttribute('aria-label')?.includes('CPU 12%'));
    assert(hostReads.length === 1, `badge reads once on load: ${hostReads.length}`);
    await page.clock.runFor(15_500);
    assert(hostReads.length === 2, `badge polls every 15 s: ${hostReads.length}`);

    await page.getByRole('button', { name: '服务器状态', exact: true }).click();
    await page.getByRole('heading', { name: '服务器状态', exact: true }).waitFor();
    await page.locator('.ss-card[aria-label="CPU"] .ss-value').filter({ hasText: '12.0%' }).waitFor();
    await page.locator('.ss-card[aria-label="数据面卡顿"] .ss-value').filter({ hasText: '12 ms' }).waitFor();
    const opened = hostReads.length;
    assert(opened === 2, `opening the page within 5 s of the badge read reuses it: ${opened}`);
    // Responses arrive in real time while the clock is fast-forwarded, so step one period at a time.
    const settle = async (count, label) => {
      for (let i = 0; i < 50 && hostReads.length < count; i++) await page.waitForTimeout(20);
      await page.waitForTimeout(200);
      assert(hostReads.length === count, `${label}: expected ${count} host reads, got ${hostReads.length}`);
    };
    const loopsBefore = loopReads.length;
    for (let cycle = 1; cycle <= 3; cycle++) {
      await page.clock.runFor(5_100);
      await settle(opened + cycle, `page and badge share one 5 s host poll (cycle ${cycle})`);
    }
    assert(loopReads.length - loopsBefore === 3, `event loop polls on its own: ${loopReads.length - loopsBefore}`);

    await setHidden(true);
    const hiddenAt = hostReads.length;
    await page.clock.runFor(31_000);
    assert(hostReads.length === hiddenAt, 'background tab stops polling');
    await setHidden(false);
    await page.clock.runFor(100);
    assert(hostReads.length === hiddenAt + 1, `returning reads at once: ${hostReads.length - hiddenAt}`);

    hostMode = 'failure';
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByText(/状态读取失败/).waitFor();
    assert((await page.locator('.ss-card[aria-label="CPU"] .ss-value').innerText()).includes('12.0%'), 'failed refresh keeps the last host values');
    assert((await badge.getAttribute('aria-label')).includes('显示的是旧数据'), 'badge shares the failure and marks its values as old');
    hostMode = 'normal';
    await page.clock.runFor(5_500);
    await page.waitForFunction(() => !document.body.innerText.includes('状态读取失败'));

    await page.getByRole('button', { name: '总览', exact: true }).click();
    await page.waitForTimeout(200);
    const left = hostReads.length;
    // The last read was at most 5 s ago: a surviving 5 s poll would read in the next 5.1 s.
    await page.clock.runFor(5_100);
    await settle(left, 'after leaving the page the 5 s poll stops');
    await page.clock.runFor(10_100);
    await settle(left + 1, 'the badge alone polls every 15 s');
    assert(!(await badge.getAttribute('aria-label')).includes('旧数据'), 'badge recovers after a successful read');
    assert(!errors.length, `page errors: ${errors.join('; ')}`);
    return { passed: true, scenarios: ['shared host read', '5 s while open', 'background pause', 'wake read', 'shared failure', 'back to 15 s'] };
  } finally {
    page.off('pageerror', onError);
    await page.unroute(`${origin}/api/**`, handler).catch(() => {});
    await page.unroute('**/*', external).catch(() => {});
    if (previousViewport) await page.setViewportSize(previousViewport).catch(() => {});
  }
}
