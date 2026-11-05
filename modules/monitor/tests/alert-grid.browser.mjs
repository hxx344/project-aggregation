// Windows: pnpm --dir modules/monitor build
// Serve the production createPageHandler({ services: new Map() }) on 127.0.0.1:3197.
// Use Playwright CLI run-code --filename modules/monitor/tests/alert-grid.browser.mjs from the repository root.
// All APIs are mocked; the preview must not start market collectors or notification services.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3197', levels = [3, 3.5, 4, 4.5, 5];
  const now = new Date().toISOString(), saves = [], pageErrors = [];
  const check = (value, message) => { if (!value) throw new Error(message); };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`);
  const originalBrent = { id: 'keep-brent', label: '布伦特下限', metric: 'brent', operator: 'lte', threshold: 80, cooldownMinutes: 60, hysteresis: 0.2, enabled: true };
  let oil = { revision: 7, config: { enabled: true, rules: [
    { id: 'keep-4', label: '现有价差 4', metric: 'spread', operator: 'gte', threshold: 4, cooldownMinutes: 30, hysteresis: 0.1, enabled: true },
    originalBrent,
  ] } };
  const errorListener = error => pageErrors.push(error.message);
  const editorFor = id => page.locator(`[data-alert-monitor="${id}"]`);
  const openGrid = async editor => {
    await editor.getByRole('button', { name: /飞书告警梯度/ }).click();
    await editor.locator('summary').filter({ hasText: '按范围批量生成档位' }).click();
    await editor.getByRole('combobox', { name: '批量生成的监控指标', exact: true }).waitFor();
    return editor.locator('.monitor-alert-grid');
  };
  const readRows = editor => editor.locator('.monitor-alert-rule').evaluateAll(rows => rows.map(row => {
    const inputs = [...row.querySelectorAll('input')], selects = [...row.querySelectorAll('select')];
    return { name: inputs.find(input => input.type === 'text').value, metric: selects[0].value, direction: selects[1].value, threshold: Number(inputs.find(input => input.type === 'number').value) };
  }));
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1100 });
  page.on('pageerror', errorListener);
  try {
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/monitors' && request.method() === 'GET') return route.fulfill({ json: { schemaVersion: 1, monitors: ['oil', 'hynix', 'perpetual'].map(id => ({ id, runtime: { available: true, monitorId: id, enabled: true, running: true, revision: 0 } })) } });
      if (path === '/api/monitors/oil/status' && request.method() === 'GET') return route.fulfill({ json: { available: true, webhookConfigured: true, lastAttemptAt: now, lastSuccessAt: now, stale: false, market: { brent: { markPx: 83 }, wti: { markPx: 79 } } } });
      if (path === '/api/monitors/oil/config' && request.method() === 'GET') return route.fulfill({ json: oil });
      if (path === '/api/monitors/oil/config' && request.method() === 'PUT') {
        const input = request.postDataJSON();
        saves.push(input);
        oil = { revision: input.revision + 1, config: input.config };
        return route.fulfill({ json: oil });
      }
      if (path === '/api/monitors/oil/events' && request.method() === 'GET') return route.fulfill({ json: { events: [] } });
      if (path === '/api/monitors/hynix/alerts' && request.method() === 'GET') return route.fulfill({ json: { available: true, revision: 0, config: { enabled: true, cooldownSeconds: 300, hysteresis: 0.5, rules: [], webhookConfigured: true, signingSecretConfigured: false }, status: { checkedAt: now, lastSuccessAt: now, lastError: '', lastQuote: null }, ruleStates: {}, history: [] } });
      return route.fulfill({ status: 503, json: { error: '浏览器验收夹具：此接口暂不可用' } });
    });
    await page.goto(`${origin}/?monitor=oil`);
    const editor = editorFor('oil'), grid = await openGrid(editor);
    for (const [label, value] of [['下限', '4'], ['上限', '4'], ['步长', '0.5']]) equal(await grid.getByRole('spinbutton', { name: `批量生成的${label}`, exact: true }).inputValue(), value, `原油单档恢复的${label}错误`);
    await grid.getByRole('spinbutton', { name: '批量生成的下限', exact: true }).fill('3');
    await grid.getByRole('spinbutton', { name: '批量生成的上限', exact: true }).fill('5');
    const direction = editor.getByRole('combobox', { name: '触发方向', exact: true }).first();
    equal(await direction.inputValue(), 'above', '原有 gte 档位应显示向上方向');
    equal(await direction.locator('option[value="both"]').textContent(), '双向穿越', '单档方向应提供双向穿越选项');
    await direction.selectOption({ label: '双向穿越' });
    equal(await direction.inputValue(), 'both', '单档方向应能改为双向穿越');
    await grid.getByRole('combobox', { name: '批量生成的触发方向', exact: true }).selectOption('below');
    await grid.getByRole('combobox', { name: '批量生成的触发方向', exact: true }).selectOption({ label: '双向穿越' });
    const preview = grid.getByRole('status'), generate = grid.getByRole('button', { name: '生成并替换该指标档位', exact: true });
    await preview.filter({ hasText: /^将生成 5 档：3、3.5、4、4.5、5$/ }).waitFor();
    await grid.getByRole('spinbutton', { name: '批量生成的步长', exact: true }).fill('0');
    await preview.filter({ hasText: '步长须大于 0。' }).waitFor();
    check(await generate.isDisabled(), '步长为零时生成按钮必须禁用');
    await grid.getByRole('spinbutton', { name: '批量生成的步长', exact: true }).fill('0.5');
    await grid.getByRole('spinbutton', { name: '批量生成的上限', exact: true }).fill('2');
    await preview.filter({ hasText: '上限不能小于下限。' }).waitFor();
    check(await generate.isDisabled(), '上限小于下限时生成按钮必须禁用');
    await grid.getByRole('spinbutton', { name: '批量生成的上限', exact: true }).fill('5');
    await preview.filter({ hasText: /^将生成 5 档：3、3.5、4、4.5、5$/ }).waitFor();
    check(await generate.isEnabled(), '恢复有效范围后生成按钮必须启用');
    await generate.click();
    await editor.getByRole('status').filter({ hasText: '已生成 5 档' }).waitFor();
    const expectedSpread = levels.map(threshold => ({ name: `双向 ${threshold} USDT/桶`, metric: 'spread', direction: 'both', threshold }));
    const rows = await readRows(editor);
    equal(rows.filter(row => row.metric === 'spread'), expectedSpread, '批量生成后的价差档位不正确');
    equal(rows.filter(row => row.metric === 'brent'), [{ name: originalBrent.label, metric: 'brent', direction: 'below', threshold: 80 }], '批量生成必须保留布伦特档位');
    check(saves.length === 0, '生成只修改草稿，保存前不得发送 PUT');
    await editor.getByRole('button', { name: '保存配置', exact: true }).click();
    await editor.getByRole('status').filter({ hasText: '配置已保存，下一轮后台检查时生效。' }).waitFor();
    check(saves.length === 1, '保存配置应只发送一次 PUT');
    const saved = saves[0], spread = saved.config.rules.filter(rule => rule.metric === 'spread');
    equal(saved.revision, 7, 'PUT 必须提交加载时的配置版本');
    check(saved.config.enabled === true, '保存必须保留告警总开关');
    equal(spread.map(rule => rule.threshold), levels, 'PUT 必须包含精确的五个阈值');
    check(spread.length === 5 && spread.every(rule => rule.operator === 'both'), 'PUT 的五条价差规则必须使用 both');
    check(spread.every(rule => rule.cooldownMinutes === 30 && rule.hysteresis === 0.1 && rule.enabled), 'PUT 必须使用生成区的冷却、回差与启用状态');
    equal(spread.find(rule => rule.threshold === 4)?.id, 'keep-4', '同阈值同方向的旧档位必须保留编号');
    equal(saved.config.rules.filter(rule => rule.metric === 'brent'), [originalBrent], 'PUT 必须完整保留布伦特规则');
    check(saved.config.rules.length === 6 && new Set(saved.config.rules.map(rule => rule.id)).size === 6, '所有档位编号必须唯一');
    await grid.getByRole('spinbutton', { name: '批量生成的步长', exact: true }).fill('-1');
    await preview.filter({ hasText: '步长须大于 0。' }).waitFor();
    await editor.getByRole('checkbox', { name: '启用飞书告警', exact: true }).uncheck();
    await editor.getByRole('button', { name: '保存配置', exact: true }).click();
    for (let attempt = 0; attempt < 50 && saves.length < 2; attempt++) await page.waitForTimeout(100);
    check(saves.length === 2 && saves[1].config.enabled === false, '未应用的无效生成参数不得阻止保存其他草稿修改');
    await grid.getByRole('spinbutton', { name: '批量生成的步长', exact: true }).fill('0.5');
    await grid.evaluate(node => window.scrollTo(0, node.getBoundingClientRect().top + window.scrollY - 16));
    await page.screenshot({ path: 'output/playwright/alert-grid-desktop.png', fullPage: false });
    await page.setViewportSize({ width: 390, height: 1100 });
    check(await grid.evaluate(node => node.open), '移动视口下生成区必须保持展开');
    const mobile = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    check(mobile.scrollWidth <= mobile.innerWidth, `移动视口不得出现横向溢出：${JSON.stringify(mobile)}`);
    await grid.evaluate(node => window.scrollTo(0, node.getBoundingClientRect().top + window.scrollY - 16));
    await page.screenshot({ path: 'output/playwright/alert-grid-mobile.png', fullPage: false });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`${origin}/?monitor=hynix`);
    const hynixGrid = await openGrid(editorFor('hynix'));
    for (const [label, value] of [['下限', '30'], ['上限', '50'], ['步长', '5']]) equal(await hynixGrid.getByRole('spinbutton', { name: `批量生成的${label}`, exact: true }).inputValue(), value, `海力士默认${label}错误`);
    await hynixGrid.getByRole('status').filter({ hasText: /^将生成 5 档：30、35、40、45、50$/ }).waitFor();
    check(pageErrors.length === 0, `页面不得发生未捕获异常：${pageErrors.join('；')}`);
    return { passed: true, checks: ['原油单档恢复与双向预览', '步长为零及上下限倒置均禁用生成', '单档双向选项', '生成仅修改草稿', '五档双向价差保存', '旧编号与其他指标保留', '无效生成参数不阻止保存', '390px 无横向溢出', '海力士默认范围预览'], thresholds: spread.map(rule => rule.threshold), retainedId: spread.find(rule => rule.threshold === 4).id, putCount: saves.length, mobile, screenshots: ['output/playwright/alert-grid-desktop.png', 'output/playwright/alert-grid-mobile.png'] };
  } finally {
    page.off('pageerror', errorListener);
    await page.goto('about:blank');
    await page.unrouteAll({ behavior: 'wait' });
    await page.setViewportSize({ width: 1440, height: 1100 });
  }
}
