// Use playwright-cli run-code --filename; isolated production preview on 4177 serves the real CSP.
async (page) => {
  const origin = 'http://hub.localhost:3100', helper = 'http://127.0.0.1:3101/route';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [];
  let mode = 'direct', reads = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__routeHidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__routeHidden });
    window.EventSource = class { close() {} };
  });
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    const send = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'must-stay-on-hub' });
    if (url.pathname === '/api/health') return send({ status: 'ok' });
    if (url.pathname === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [] });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    const response = await route.fetch({ url: `http://127.0.0.1:4177${url.pathname}${url.search}` });
    if (url.pathname === '/') assert(response.headers()['content-security-policy'].includes("connect-src 'self' http://127.0.0.1:3101;"), 'actual production CSP allows only the fixed helper');
    return route.fulfill({ response });
  });
  await page.route(helper, async route => {
    reads++;
    const headers = route.request().headers();
    assert(!headers.cookie && !headers['x-csrf-token'] && !headers.authorization && !headers.referer, 'local probe contains no hub credentials');
    if (mode === 'unavailable') return route.abort('connectionrefused');
    await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origin, 'Cache-Control': 'no-store' }, body: JSON.stringify({
      service: 'project-aggregation-local-route', schema: 1, state: mode === 'direct' ? 'direct' : 'unknown',
      reason: mode === 'direct' ? 'verified-direct' : 'clash-tun-enabled', server: '203.0.113.10', sshPort: 22, checkedAt: new Date().toISOString(),
    }) });
  });
  const routeLabel = page.locator('.connection-route');
  const waitText = text => page.waitForFunction(text => document.querySelector('.connection-route')?.textContent === text, text);
  const refresh = () => page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin); await waitText('SSH 直连');
  assert(await page.locator('.connection-latency').isVisible(), 'HTTP RTT remains visible independently');
  await page.locator('.connection-status summary').click();
  assert((await page.locator('.local-route-details').innerText()).includes('203.0.113.10:22'), 'details identify the observed SSH target');
  await page.screenshot({ path: 'output/local-route-desktop.png' });
  await page.locator('.connection-status summary').click();
  mode = 'unknown'; await refresh(); await waitText('线路未确认');
  assert(!await routeLabel.evaluate(el => el.classList.contains('verified')), 'uncertain routing never stays green');
  mode = 'unavailable'; await refresh(); await waitText('线路未确认'); await page.waitForTimeout(100);
  await page.locator('.connection-status summary').click();
  assert((await page.locator('.local-route-details').innerText()).includes('start-local-route.ps1'), 'missing helper explains how to start it');
  await page.locator('.connection-status summary').click();
  mode = 'direct'; await refresh(); await waitText('SSH 直连');
  await page.evaluate(() => { window.__routeHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  await waitText('线路未确认');
  const pausedReads = reads;
  await page.waitForTimeout(100);
  assert(reads === pausedReads, 'background transition does not issue a local probe');
  await page.evaluate(() => { window.__routeHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await waitText('SSH 直连');
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    await page.locator('.connection-status summary').click();
    assert(await page.evaluate(() => {
      const popup = document.querySelector('.connection-details').getBoundingClientRect();
      const status = document.querySelector('.connection-status summary').getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth + 1 && popup.left >= 0 && popup.right <= innerWidth && status.left >= 0 && status.right <= innerWidth;
    }), `route badge and details fit ${width}px`);
    if (width === 375) await page.screenshot({ path: 'output/local-route-mobile.png' });
    await page.locator('.connection-status summary').click();
  }
  await page.goto(`${origin}/?view=trading`); await waitText('SSH 直连');
  assert(errors.length === 0, `unexpected browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ passed: true, reads }));
}
