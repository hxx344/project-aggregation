// Run with playwright-cli run-code --filename tests/attention.browser.mjs.
// Use a local preview; every API response is an isolated fixture.
async (page) => {
  const origin = new URL(page.url()).origin;
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  let scenario = 'mixed', blockUpdates = false, timerStarted = 0;
  const snapshot = (id, name, diagnostics, state = 'partial') => ({
    project: { id, name, description: '提醒规则浏览器验收', category: 'trading', adapter: 'aster', enabled: true, accessMode: 'direct', mode: 'external', url: '', apiUrl: origin, staleAfterSeconds: 3600, order: 1, hasCredentials: false },
    state, message: '源摘要保留真实状态', checkedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(),
    metrics: [{ key: 'daily_volume', label: '今日成交量', value: null, unit: 'USD1' }], diagnostics,
  });
  const diagnostic = (id, kind, message, age = 0) => ({ id, kind, message, firstSeenAt: new Date(Date.now() - age).toISOString() });
  const overview = () => ({ generatedAt: new Date().toISOString(), projects: scenario === 'timer'
    ? [snapshot('timer', '短暂核对', [{ id: 'pair:timer', kind: 'fault', message: '配对组正在核对', firstSeenAt: new Date(timerStarted - 118000).toISOString() }])]
    : scenario === 'recovered'
      ? [snapshot('aster', 'ASTER 5X', [diagnostic('pair:alpha', 'notice', '黄金配对：历史订单观察正常，成交统计稍后补齐')])]
      : [snapshot('aster', 'ASTER 5X', [diagnostic('pair:alpha', 'notice', '黄金配对：历史订单观察正常，成交统计稍后补齐'), diagnostic('pair:beta', 'action', '白银配对：发现旧订单新增成交，需要人工核对')]),
        snapshot('transient', '短暂核对', [diagnostic('pair:gamma', 'fault', '短暂配对正在核对')]),
        snapshot('persistent', '持续异常项目', [diagnostic('pair:delta', 'fault', '持续配对快照读取失败', 180000)]),
        snapshot('auth', '认证异常项目', [diagnostic('hub:auth', 'action', '登录凭据失效')], 'unauthorized')] });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET') writes.push(url.pathname);
    const send = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture' });
    if (url.pathname === '/api/overview/events') return route.abort();
    if (url.pathname === '/api/overview') return blockUpdates ? route.abort() : send(overview());
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Unexpected fixture endpoint"}' });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin);
  await page.locator('.attention-item').first().waitFor();
  assert(await page.locator('.attention-item').count() === 3, 'only action and sustained faults appear');
  const panelText = await page.locator('.attention-panel').innerText();
  assert(!panelText.includes('历史订单观察正常') && !panelText.includes('短暂配对'), 'notices and transient faults stay out of homepage');
  const aster = page.locator('.attention-item').filter({ hasText: 'ASTER 5X' });
  assert(await aster.locator('p').count() === 1, 'a pair has one merged message');
  assert((await page.locator('.project-card').filter({ hasText: 'ASTER 5X' }).innerText()).includes('—'), 'missing volume remains missing');
  await page.screenshot({ path: 'output/playwright/attention-desktop.png', fullPage: true });
  await page.locator('.attention-item').filter({ hasText: '认证异常项目' }).getByRole('button', { name: '检查连接' }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await aster.getByRole('button', { name: '进入项目' }).click();
  assert(new URL(page.url()).searchParams.get('id') === 'aster', 'business issue navigates to project');
  const details = page.locator('.project-screen:not([hidden]) .diagnostic-details');
  await details.locator('summary').click();
  assert((await details.innerText()).includes('历史订单观察正常'), 'notice remains available in project details');
  assert(await details.locator('li').count() === 2, 'notice and action both remain in details');
  await page.screenshot({ path: 'output/playwright/attention-details.png', fullPage: true });
  await page.goto(origin + '/?view=projects');
  await page.locator('.diagnostic-details').first().waitFor();
  await page.locator('.diagnostic-details').first().locator('summary').click();
  assert((await page.locator('.diagnostic-details').first().innerText()).includes('历史订单观察正常'), 'management retains details');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await page.locator('.attention-item').first().waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile homepage has no horizontal overflow');
  await page.screenshot({ path: 'output/playwright/attention-mobile.png', fullPage: true });
  scenario = 'recovered';
  await page.getByRole('button', { name: '刷新总览' }).click();
  await page.getByRole('heading', { name: '暂无需要处理的问题' }).waitFor();
  assert(await page.locator('.attention-item').count() === 0, 'recovery clears homepage while notice remains');
  scenario = 'timer'; timerStarted = Date.now();
  await page.getByRole('button', { name: '刷新总览' }).click();
  await page.getByRole('heading', { name: '短暂核对', exact: true }).waitFor();
  assert(await page.locator('.attention-item').count() === 0, 'fault is initially below two minutes');
  blockUpdates = true;
  await page.locator('.attention-item').filter({ hasText: '配对组正在核对' }).waitFor({ timeout: 5000 });
  assert(!writes.length, 'inspection never issues a mutation');
  assert(!errors.length, 'no uncaught browser errors: ' + errors.join('; '));
  return { passed: true, scenarios: ['notice and transient filtering', 'sustained and immediate action', 'missing metric', 'connection vs business navigation', 'details in project and management', '390px mobile', 'recovery clears', 'two-minute maturity without new summary'], writes };
}
