// Run with playwright-cli run-code --filename against the production preview on 4175.
async (page) => {
  const origin = 'http://hub.localhost:3100';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  let helperReads = 0;
  await page.clock.install();
  await page.addInitScript(() => {
    window.__hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    window.EventSource = class { close() {} };
  });
  await page.route('http://127.0.0.1:3101/**', route => { helperReads++; return route.abort('connectionrefused'); });
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    const send = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture' });
    if (url.pathname === '/api/health') return send({ status: 'ok' });
    if (url.pathname === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [] });
    if (url.pathname.startsWith('/api/')) return send({});
    return route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:4175${url.pathname}${url.search}` }) });
  });
  await page.goto(origin);
  await page.locator('.connection-latency').waitFor();
  await page.clock.runFor(31_000);
  for (const hidden of [true, false]) {
    await page.evaluate(value => { window.__hidden = value; document.dispatchEvent(new Event('visibilitychange')); }, hidden);
  }
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await page.locator('.connection-latency').waitFor();
  assert(helperReads === 0, 'local helper is not polled initially, periodically or on wake');
  assert(await page.locator('.connection-route, .local-route-details').count() === 0, 'retired route detection is absent');
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('.connection-status summary').click();
    assert(await page.evaluate(() => {
      const popup = document.querySelector('.connection-details').getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth + 1 && popup.left >= 0 && popup.right <= innerWidth;
    }), `HTTP connection details fit ${width}px`);
    await page.locator('.connection-status summary').click();
  }
  return { passed: true, helperReads, scenarios: ['no helper polling', 'HTTP latency retained', 'wake', 'desktop and mobile details'] };
}
