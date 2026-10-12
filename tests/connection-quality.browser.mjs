// Run with playwright-cli run-code --filename against a production preview on port 4176.
async (page) => {
  const origin = 'http://127.0.0.1:4176';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], held = [];
  let mode = 'good', healthCalls = 0;
  const project = { id: 'fixture', name: '连接质量验收项目', description: '', category: 'other', adapter: 'standard',
    enabled: true, accessMode: 'proxy', apiUrl: `${origin}/fixtures/module`, url: `${origin}/fixtures/module`, mode: 'embed', hasCredentials: true,
    revision: 'one', staleAfterSeconds: 120, order: 0 };
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.addInitScript(() => {
    if (window !== window.top) return;
    window.__connectionHidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__connectionHidden });
    window.EventSource = class { close() {} };
  });
  await page.route(`${origin}/fixtures/module`, route => route.fulfill({ contentType: 'text/html', body: '<p>隔离项目页面</p>' }));
  await page.route(`${origin}/api/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
    if (path === '/api/health') {
      healthCalls++;
      if (mode === 'hang') { held.push(route); return; }
      if (mode === 'slow') await page.waitForTimeout(700);
      if (mode === 'error') return send({ error: 'Unavailable' }, 503);
      if (mode === 'invalid') return send({ status: 'not-ok' });
      return send({ status: 'ok' });
    }
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'fixture' });
    if (path === '/api/logout') return send({ ok: true });
    if (path === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [{ project,
      state: 'online', freshness: 'static', message: '', checkedAt: null, updatedAt: null, latencyMs: 9999, metrics: [] }] });
    if (path === '/api/projects/fixture/launch') return send({ url: `${origin}/fixtures/module` });
    return send({ error: 'Not configured in this fixture' }, 404);
  });
  const quality = value => page.locator(`.connection-${value}`).waitFor();
  const refresh = () => page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  const hidden = value => page.evaluate(value => {
    window.__connectionHidden = value; document.dispatchEvent(new Event('visibilitychange'));
  }, value);
  const noOverflow = async () => assert(await page.evaluate(() => {
    const box = document.querySelector('.connection-status summary').getBoundingClientRect();
    return document.documentElement.scrollWidth <= innerWidth + 1 && box.x >= 0 && box.right <= innerWidth;
  }), 'connection status fits the viewport');
  const releaseHeld = async () => {
    while (held.length) await held.shift().fulfill({ contentType: 'application/json', body: '{"status":"ok"}' }).catch(() => {});
  };

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin);
  await quality('good');
  assert(await page.locator('.connection-latency').innerText() !== '9999 ms', 'client latency is independent of upstream project latency');
  await noOverflow();
  await page.locator('.connection-status summary').click();
  assert(await page.locator('.connection-details').isVisible(), 'measurement explanation is accessible');
  await page.screenshot({ path: 'output/playwright/connection-quality-desktop.png' });
  await page.locator('.connection-status summary').click();

  mode = 'slow'; await refresh(); await quality('slow');
  assert(parseInt(await page.locator('.connection-latency').innerText()) >= 500, 'slow RTT is displayed');
  mode = 'error'; await refresh(); await quality('unreachable');
  assert(await page.locator('.connection-latency').count() === 0, 'errors do not retain a healthy latency');
  mode = 'invalid'; await refresh(); await quality('unreachable');
  await page.waitForTimeout(100);
  mode = 'hang'; await refresh();
  await page.waitForFunction(() => !document.querySelector('.connection-latency'));
  await page.waitForTimeout(3200);
  await quality('unreachable');
  assert(held.length === 1, 'only one health request is active');
  await releaseHeld();
  mode = 'good'; await refresh(); await quality('good');

  await page.context().setOffline(true); await quality('offline');
  assert(await page.locator('.connection-latency').count() === 0, 'offline clears latency');
  mode = 'hang'; await page.context().setOffline(false); await quality('checking');
  await page.waitForTimeout(100);
  await hidden(true); await quality('paused');
  const pausedCalls = healthCalls;
  await page.clock.runFor(20_000);
  assert(healthCalls === pausedCalls, 'hidden pages stop health polling');
  await releaseHeld(); await quality('paused');
  mode = 'good'; await hidden(false); await quality('good');

  await page.goto(`${origin}/?view=trading`); await quality('good');
  assert(await page.locator('.topbar .connection-status').isVisible(), 'trading keeps the connection indicator');
  await page.goto(`${origin}/?view=project&id=fixture`); await quality('good');
  await page.locator('iframe.original-project-frame').waitFor();
  await page.setViewportSize({ width: 375, height: 812 }); await noOverflow();
  assert(await page.locator('.connection-status').isVisible(), 'embedded projects keep the indicator on mobile');
  await page.locator('.connection-status summary').click();
  assert(await page.locator('.connection-details').evaluate(el => {
    const rect = el.getBoundingClientRect(); return rect.x >= 0 && rect.right <= innerWidth;
  }), 'mobile details stay inside the viewport');
  await page.screenshot({ path: 'output/playwright/connection-quality-mobile.png' });
  await page.locator('.connection-status summary').click();
  await page.setViewportSize({ width: 320, height: 740 }); await noOverflow();
  await page.goto(origin); await quality('good'); await noOverflow();
  await page.locator('.connection-status summary').click();
  assert(await page.locator('.connection-details').evaluate(el => {
    const rect = el.getBoundingClientRect(); return rect.x >= 0 && rect.right <= innerWidth;
  }), '320px overview details stay inside the viewport');
  await page.locator('.connection-status summary').click();
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('heading', { name: '进入工作台' }).waitFor();
  const loggedOutCalls = healthCalls;
  await page.clock.runFor(20_000);
  assert(healthCalls === loggedOutCalls, 'logout disposes polling');
  assert(errors.length === 0, `unexpected browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ passed: true, healthCalls, scenarios: ['normal', 'slow', 'server-error', 'invalid-body', 'timeout', 'offline-recovery', 'background-resume', 'trading', 'embedded-mobile', 'logout-cleanup'] }));
}
