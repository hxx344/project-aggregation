// Playwright CLI run-code --filename against production Next at localhost:3189.
// Requests are intercepted: this verifies the editor without sending notifications.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const check = (value, message) => { if (!value) throw Error(message); };
  let config = { enabled: false, rules: [] }, revision = 0, conflict = false, writes = 0, preview = false;
  const reads = [], errors = [], now = new Date().toISOString();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET') reads.push(path);
    if (path === '/api/monitors') return route.fulfill({ json: { schemaVersion: 1, monitors: ['oil', 'cl-xau', 'hynix', 'perpetual'].map(id => ({ id, runtime: { available: true, monitorId: id, enabled: true, running: true, revision: 0, error: '' } })) } });
    if (path === '/api/monitors/cl-xau/status') return route.fulfill({ json: preview ? { available: false, reason: '当前为网页预览，告警需常驻后台。' } : { available: true, webhookConfigured: true, lastAttemptAt: now, lastSuccessAt: now, stale: false, market: { source: 'Binance', currency: 'USDT', priceBasis: 'mark', status: 'live', fetchedAt: now, cl: { symbol: 'CLUSDT', price: 80, updatedAt: now }, xau: { symbol: 'XAUUSDT', price: 4000, updatedAt: now }, ratio: 50, funding: null } } });
    if (path === '/api/monitors/cl-xau/config') {
      if (route.request().method() === 'PUT') {
        writes++;
        const input = route.request().postDataJSON();
        if (conflict || input.revision !== revision) return route.fulfill({ status: 409, json: { error: 'conflict' } });
        config = input.config; revision++;
      }
      return route.fulfill({ json: { config, revision } });
    }
    if (path === '/api/monitors/cl-xau/events') return route.fulfill({ json: { events: [{ id: 'fixture-event', time: now, status: 'sent', rules: [{ label: '历史上沿', metric: 'ratio', operator: 'gte', threshold: 50, value: 51 }] }] } });
    if (path.endsWith('/status') || path.endsWith('/alerts')) return route.fulfill({ json: { available: false, reason: '无关模块' } });
    return route.fulfill({ status: 503, json: { error: 'fixture unavailable' } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:3189/?monitor=cl-xau&goldOil=cl&goldOilExchange=binance');
  const alerts = page.locator('[data-alert-monitor="cl-xau"]');
  await alerts.getByText('金油比 · Binance CL · 未启用', { exact: true }).waitFor();
  await alerts.getByRole('button', { name: /飞书告警梯度/ }).click();
  await alerts.getByRole('button', { name: '添加梯度' }).click();
  const first = alerts.getByRole('group', { name: '第 1 档', exact: true });
  await first.getByLabel('档位名称').fill('黄金相对偏强');
  await first.getByLabel('阈值（桶/盎司）').fill('50');
  await first.getByLabel('冷却（分钟）').fill('30');
  await first.getByLabel('回差（桶/盎司）').fill('0.5');
  await alerts.getByRole('button', { name: '添加梯度' }).click();
  const second = alerts.getByRole('group', { name: '第 2 档', exact: true });
  await second.getByLabel('档位名称').fill('黄金相对偏弱');
  await second.getByLabel('触发方向').selectOption('below');
  await second.getByLabel('阈值（桶/盎司）').fill('45');
  await second.getByLabel('冷却（分钟）').fill('0.5');
  await page.getByRole('tab', { name: '原油价差', exact: true }).click();
  await page.getByRole('tab', { name: '金油比', exact: true }).click();
  check(await first.getByLabel('阈值（桶/盎司）').inputValue() === '50', 'Switching modules preserves unsaved tiers');
  await alerts.getByLabel('启用飞书告警', { exact: true }).check();
  await alerts.getByRole('button', { name: '保存配置', exact: true }).click();
  await alerts.getByText('配置已保存，下一轮后台检查时生效。').waitFor();
  check(config.enabled && config.rules.length === 2 && config.rules[1].operator === 'lte', 'Saved both directions');
  check(config.rules.every(rule => rule.metric === 'ratio'), 'Ratio remains independent of oil metrics');
  check(config.rules[1].cooldownMinutes === 0.5, 'Fractional minute cooldown preserved');
  await alerts.locator('.monitor-alert-history summary').click();
  await alerts.getByText(/历史上沿 · 金油比 51.0000 ≥ 50 桶\/盎司/).waitFor();
  await alerts.screenshot({ path: 'output/playwright/gold-oil-alerts-desktop.png' });
  await page.reload();
  await alerts.getByText('金油比 · Binance CL · 已启用 · 2 档', { exact: true }).waitFor();
  await alerts.getByRole('button', { name: /飞书告警梯度/ }).click();
  check(await second.getByLabel('阈值（桶/盎司）').inputValue() === '45', 'Reload reads saved config');
  conflict = true; await first.getByLabel('阈值（桶/盎司）').fill('52');
  await alerts.getByRole('button', { name: '保存配置', exact: true }).click();
  await alerts.getByText(/另一页面已更新配置/).waitFor();
  check(await first.getByLabel('阈值（桶/盎司）').inputValue() === '52', 'Conflict keeps draft');
  await alerts.getByRole('button', { name: '放弃修改并重载', exact: true }).click();
  await alerts.getByRole('button', { name: '放弃修改并重载', exact: true }).waitFor({ state: 'hidden' });
  check(await first.getByLabel('阈值（桶/盎司）').inputValue() === '50', 'Explicit reload restores canonical config');
  await page.setViewportSize({ width: 390, height: 844 }); await alerts.scrollIntoViewIfNeeded();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile editor fits viewport');
  await alerts.screenshot({ path: 'output/playwright/gold-oil-alerts-mobile.png' });
  preview = true; reads.length = 0; await page.reload();
  await alerts.getByRole('button', { name: /飞书告警梯度/ }).click();
  await alerts.getByText('当前为网页预览，告警需常驻后台。').waitFor();
  check(!reads.includes('/api/monitors/cl-xau/config'), 'Preview does not pretend it can save');
  check(errors.length === 0, `No page errors: ${errors.join('; ')}`);
  return { passed: true, writes, tiers: config.rules.length, realNotifications: 0 };
}
