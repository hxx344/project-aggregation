// Start the production Next server on 3189, then use Playwright CLI run-code --filename.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const ids = ['oil', 'hynix', 'perpetual'], titles = ['原油价差', '海力士 ADR', '合约价差'];
  const runtime = Object.fromEntries(ids.map(monitorId => [monitorId, { available: true, monitorId, enabled: true, running: true, revision: 0 }]));
  const counts = new Map(); let failSave = false, conflict = false, now = Date.UTC(2026, 8, 29);
  const check = (value, message) => { if (!value) throw new Error(message); };
  const marketReads = id => [...counts].filter(([key]) => key.startsWith(`/api/monitors/${id}/`) && !key.endsWith('/runtime')).reduce((sum, [, count]) => sum + count, 0);
  const toggle = index => page.getByRole('switch', { name: `${titles[index]}监控开关`, exact: true });
  const checked = async (index, value) => { await page.waitForFunction(({ label, value }) => document.querySelector(`[role="switch"][aria-label="${label}"]`)?.getAttribute('aria-checked') === String(value), { label: `${titles[index]}监控开关`, value }); };
  const tick = async duration => { now += duration; await page.clock.runFor(duration); };
  await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' });
  await page.clock.install({ time: new Date(now - 1000) }); await page.clock.pauseAt(new Date(now));
  try {
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (path === '/api/monitors') return route.fulfill({ json: { schemaVersion: 1, monitors: ids.map(id => ({ id, runtime: runtime[id] })) } });
      const match = /^\/api\/monitors\/(oil|hynix|perpetual)\/runtime$/.exec(path);
      if (match && request.method() === 'PUT') {
        const id = match[1], input = request.postDataJSON();
        if (failSave) return route.fulfill({ status: 500, json: { error: '测试：保存失败' } });
        if (conflict) { conflict = false; runtime[id] = { ...runtime[id], enabled: true, running: true, revision: runtime[id].revision + 1 }; }
        if (input.revision !== runtime[id].revision) return route.fulfill({ status: 409, json: { error: '测试：开关已被其他页面修改' } });
        runtime[id] = { ...runtime[id], enabled: input.enabled, running: input.enabled, revision: input.revision + 1 };
        return route.fulfill({ json: runtime[id] });
      }
      if (path === '/api/monitors/hynix/quote') return route.fulfill({ json: { status: 'live', fetchedAt: new Date(now).toISOString(), ordinary: 1000, adr: 120, equivalent: 100, spread: 20, premium: 20, funding: { fetchedAt: new Date(now).toISOString(), annualizedRate: .01 } } });
      if (path === '/api/monitors/hynix/history') return route.fulfill({ json: { status: 'live', fetchedAt: new Date(now).toISOString(), interval: '1h', firstAvailable: '2026-09-28T00:00:00.000Z', warnings: [], points: [0, 1, 2].map(index => ({ time: now - (3 - index) * 3600000, ordinary: 1000, adr: 120 + index, equivalent: 100, spread: 20 + index, premium: 20 + index })) } });
      return route.fulfill({ status: 503, json: { error: 'Controlled unavailable response' } });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('http://127.0.0.1:3189/?monitor=oil');
    await toggle(1).waitFor(); await page.getByRole('button', { name: /^海力士 ADR/ }).getByText('+20.00%').waitFor();
    await toggle(1).click(); await checked(1, false);
    check(new URL(page.url()).searchParams.get('monitor') === 'oil', 'Toggling must not select another panel');
    const pausedHynix = marketReads('hynix'); await tick(30000);
    check(marketReads('hynix') === pausedHynix, 'Disabled Hynix must stop all market and alert reads');
    await page.screenshot({ path: 'output/playwright/monitor-controls-desktop.png', fullPage: false });
    await toggle(1).click(); await checked(1, true);
    await page.waitForFunction(() => [...document.querySelectorAll('.hub-summary-card')].find(node => node.textContent.includes('海力士 ADR'))?.textContent.includes('实时'));
    check(marketReads('hynix') > pausedHynix, 'Re-enabling must immediately restore reads');
    for (const index of [0, 1, 2]) { await toggle(index).click(); await checked(index, false); }
    const stopped = ids.map(marketReads); await tick(60000);
    check(ids.every((id, index) => marketReads(id) === stopped[index]), 'All disabled modules must stop their business polling');
    await page.reload(); for (const index of [0, 1, 2]) await checked(index, false);
    const reloaded = ids.map(marketReads); await tick(20000);
    check(ids.every((id, index) => marketReads(id) === reloaded[index]), 'Reload must preserve disabled state');
    runtime.oil = { ...runtime.oil, enabled: true, running: true, revision: runtime.oil.revision + 1 };
    await tick(10000); await checked(0, true);
    failSave = true; await toggle(0).click(); await page.getByRole('alert').filter({ hasText: '测试：保存失败' }).waitFor();
    check(await toggle(0).getAttribute('aria-checked') === 'true', 'Failed saves must retain the confirmed switch state');
    failSave = false; conflict = true; await toggle(1).click(); await checked(1, true);
    await page.getByRole('alert').filter({ hasText: '测试：开关已被其他页面修改' }).waitFor();
    await toggle(1).click(); await checked(1, false);
    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile view must not overflow');
    const box = await toggle(2).boundingBox(); check(box.height >= 44, 'Switch touch target must be at least 44px tall');
    await toggle(2).focus(); await page.keyboard.press('Space'); await checked(2, true);
    await toggle(2).click(); await checked(2, false);
    await page.screenshot({ path: 'output/playwright/monitor-controls-mobile.png', fullPage: true });
    return { passed: true, states: runtime, checks: 'independent toggles, polling pause/resume, persistence, concurrent changes, save failure, mobile, keyboard' };
  } finally { await page.clock.resume(); }
}
