// Production Next server: localhost:3189. Playwright CLI run-code --filename.
// Isolated fixtures exercise CL/BZ switching and never send notifications.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- CLI evaluates this function.
async page => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const now = Date.UTC(2026, 9, 7, 12), interval = 900000, errors = [], pending = [], requests = [];
  let holdBz = true, failBz = false;
  const counts = { cl: { quote: 0, history: 0, funding: 0 }, bz: { quote: 0, history: 0, funding: 0 } };
  const configs = { cl: { revision: 2, config: { enabled: false, rules: [] } }, bz: { revision: 8, config: { enabled: false, rules: [] } } };
  const saved = [];
  const runtime = Object.fromEntries(['oil', 'cl-xau', 'hynix', 'perpetual'].map(id => [id, { available: true, monitorId: id, enabled: true, running: true, revision: 0, error: '' }]));
  const common = oilType => ({ oilType, source: 'Binance', currency: 'USDT', priceBasis: 'mark', status: 'live', fetchedAt: new Date(now).toISOString() });
  const quote = oilType => {
    const base = common(oilType), oil = oilType === 'bz' ? 100 : 80;
    const terms = (rate, intervalHours) => ({ rate, intervalHours, nextFundingAt: new Date(now + intervalHours * 3600000).toISOString() });
    return { ...base, oil: { symbol: oilType === 'bz' ? 'BZUSDT' : 'CLUSDT', price: oil, updatedAt: base.fetchedAt },
      xau: { symbol: 'XAUUSDT', price: 4000, updatedAt: base.fetchedAt }, ratio: 4000 / oil,
      funding: { oil: terms(oilType === 'bz' ? 0.0016 : 0.0004, 4), xau: terms(0.0016, 8) } };
  };
  const fixture = Object.fromEntries(['cl', 'bz'].map(oilType => {
    const size = oilType === 'bz' ? 320 : 400, start = now - size * interval, oil = oilType === 'bz' ? 100 : 80;
    return [oilType, { quote: quote(oilType),
      history: { ...common(oilType), interval: '15m', coverageStart: start, points: Array.from({ length: size }, (_, index) => ({
        time: start + index * interval, oil, xau: 4000 + Math.sin(index / 20) * 80, ratio: (4000 + Math.sin(index / 20) * 80) / oil,
      })) },
      funding: { ...common(oilType), coverageStart: start, coverageEnd: now, points: Array.from({ length: Math.floor(size / 16) }, (_, index) => ({
        time: start + index * 16 * interval, oil: oilType === 'bz' ? 0.0005 : 0.0001, xau: 0.0003,
      })) },
    }];
  }));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' });
  await page.clock.install({ time: new Date(now - 1000) }); await page.clock.pauseAt(new Date(now));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/monitors') return route.fulfill({ json: { schemaVersion: 1, monitors: Object.entries(runtime).map(([id, value]) => ({ id, runtime: value })) } });
    const match = path.match(/^\/api\/monitors\/cl-xau\/(bz\/)?(quote|history|funding|status|config|events)$/);
    if (!match) return route.fulfill({ status: 503, json: { error: 'unrelated fixture' } });
    const oilType = match[1] ? 'bz' : 'cl', action = match[2];
    requests.push({ oilType, action });
    if (action === 'status') return route.fulfill({ json: { available: true, webhookConfigured: true, stale: false, lastAttemptAt: common(oilType).fetchedAt, lastSuccessAt: common(oilType).fetchedAt, market: fixture[oilType].quote } });
    if (action === 'events') return route.fulfill({ json: { events: [] } });
    if (action === 'config') {
      if (route.request().method() === 'PUT') {
        const input = route.request().postDataJSON();
        check(input.revision === configs[oilType].revision, 'Save uses the selected oil revision');
        saved.push({ oilType, input });
        configs[oilType] = { revision: input.revision + 1, config: input.config };
      }
      return route.fulfill({ json: configs[oilType] });
    }
    counts[oilType][action]++;
    if (oilType === 'bz' && holdBz) await new Promise(resolve => pending.push(resolve));
    return route.fulfill(oilType === 'bz' && failBz ? { status: 503, json: { error: 'BZ fixture outage' } } : { json: fixture[oilType][action] }).catch(() => {});
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto('http://127.0.0.1:3189/?monitor=cl-xau&goldOil=cl&goldOilExchange=binance');
    const panel = page.getByRole('tabpanel', { name: '金油比', exact: true }).locator('.oil-panel');
    const select = oilType => panel.getByRole('button', { name: oilType === 'bz' ? 'BZ · 布伦特原油' : 'CL · WTI 原油', exact: true });
    const metric = panel.locator('.metric.featured'), priceSvg = panel.locator('.gold-chart .gold-chart-svg');
    const overview = page.getByRole('article', { name: '金油比', exact: true });
    const editor = oilType => page.locator('[data-alert-monitor="' + (oilType === 'bz' ? 'cl-xau-bz' : 'cl-xau') + '"]');
    await metric.getByText('50.000', { exact: false }).waitFor(); await priceSvg.waitFor();
    check((await panel.locator('.funding-metrics').innerText()).includes('+43.80%'), 'CL current funding uses CL terms');
    await panel.getByRole('button', { name: '全部', exact: true }).click();
    await panel.getByRole('button', { name: '黄金 / 原油价格', exact: true }).click();
    await panel.getByRole('slider').press('Home');
    await panel.locator('.data-details summary').click();
    await panel.getByRole('button', { name: '下一页', exact: true }).click();
    await editor('cl').getByRole('button', { name: /飞书告警梯度/ }).click();
    await editor('cl').getByRole('button', { name: '添加梯度' }).click();
    await editor('cl').getByLabel('档位名称').fill('CL 未保存');
    await editor('cl').getByLabel('阈值（桶/盎司）').fill('50');
    const clReads = { ...counts.cl };
    await select('bz').click();
    await panel.getByText('正在读取共同历史，首次采集需要回补…', { exact: true }).waitFor();
    check(!(await metric.innerText()).includes('50.000'), 'BZ loading never displays CL quote');
    check(!(await overview.locator('.hub-card-metrics').innerText()).includes('50.000'), 'BZ overview never displays CL quote');
    check((await overview.locator('.hub-card-heading').innerText()).includes('XAU / BZ'), 'Overview subtitle follows BZ immediately');
    await select('cl').click();
    await metric.getByText('50.000', { exact: false }).waitFor();
    check(JSON.stringify(counts.cl) === JSON.stringify(clReads), 'Fresh CL cache paints without duplicate reads');
    check(await editor('cl').getByLabel('档位名称').inputValue() === 'CL 未保存', 'CL unsaved draft survives rapid oil switch');
    holdBz = false; pending.splice(0).forEach(resolve => resolve());
    await page.clock.runFor(50);
    check((await metric.innerText()).includes('50.000'), 'Late cancelled BZ responses cannot replace CL');
    await select('bz').click(); await metric.getByText('40.000', { exact: false }).waitFor(); await priceSvg.waitFor();
    check((await panel.locator('.funding-metrics').innerText()).includes('-87.60%'), 'BZ current funding uses BZ terms');
    check(await panel.getByRole('button', { name: '全部', exact: true }).getAttribute('aria-pressed') === 'true', 'Oil switch preserves selected range');
    check(await panel.getByRole('button', { name: '黄金 / 原油价格', exact: true }).getAttribute('aria-pressed') === 'true', 'Oil switch preserves price view');
    check((await panel.locator('.table-pagination').innerText()).includes('第 1 / 2 页'), 'Oil switch resets detail pagination');
    check(await panel.getByRole('slider').inputValue() === '319', 'Oil switch resets full-record cursor to latest BZ point');
    check((await panel.locator('thead').innerText()).includes('布伦特原油'), 'BZ details identify the correct oil');
    check((await panel.locator('tbody tr').first().innerText()).includes('100.000'), 'BZ details contain BZ prices');
    check((await panel.locator('.funding-history-section').innerText()).includes('BZ 20 次'), 'BZ historic funding uses its own event count');
    await priceSvg.evaluate(node => { node.dataset.retained = 'bz'; });
    await editor('bz').getByRole('button', { name: /飞书告警梯度/ }).click();
    check(await editor('bz').getByRole('group', { name: '第 1 档', exact: true }).count() === 0, 'BZ starts with its own empty rules');
    await editor('bz').getByRole('button', { name: '添加梯度' }).click();
    await editor('bz').getByLabel('档位名称').fill('BZ 独立规则');
    await editor('bz').getByLabel('阈值（桶/盎司）').fill('40');
    await select('cl').click();
    check(await editor('cl').getByLabel('档位名称').inputValue() === 'CL 未保存', 'Both editors preserve independent drafts');
    await select('bz').click();
    check(await editor('bz').getByLabel('档位名称').inputValue() === 'BZ 独立规则', 'BZ draft is retained');
    check(await priceSvg.getAttribute('data-retained') === 'bz', 'Cached oil switches retain the SVG node');
    await editor('bz').getByRole('button', { name: '保存配置', exact: true }).click();
    await editor('bz').getByText('配置已保存，下一轮后台检查时生效。', { exact: true }).waitFor();
    check(saved.length === 1 && saved[0].oilType === 'bz' && saved[0].input.revision === 8, 'BZ save goes only to BZ endpoint and revision');
    check(configs.cl.revision === 2 && configs.cl.config.rules.length === 0, 'BZ save leaves CL backend rules untouched');
    await select('cl').click(); await editor('cl').getByRole('button', { name: '保存配置', exact: true }).click();
    await editor('cl').getByText('配置已保存，下一轮后台检查时生效。', { exact: true }).waitFor();
    check(saved.length === 2 && saved[1].oilType === 'cl' && saved[1].input.revision === 2, 'CL saves its independent revision');
    await select('bz').click();
    failBz = true; await panel.getByRole('button', { name: '刷新数据 ↻', exact: true }).click();
    await panel.getByText('更新中断 · 保留数据', { exact: true }).waitFor();
    check((await metric.innerText()).includes('40.000'), 'BZ errors retain BZ data');
    await select('cl').click();
    check((await panel.locator('.stamp-label').innerText()).includes('实时'), 'BZ error state does not leak to CL');
    failBz = false; await select('bz').click(); await panel.getByText('实时 · 每 30 秒更新', { exact: true }).waitFor();
    const beforeHidden = structuredClone(counts);
    await page.getByRole('tab', { name: '海力士 ADR', exact: true }).click();
    await page.clock.runFor(30000);
    check(counts.bz.quote === beforeHidden.bz.quote + 1 && counts.cl.quote === beforeHidden.cl.quote, 'Only selected oil quote polls in the overview');
    check(counts.bz.history === beforeHidden.bz.history && counts.cl.history === beforeHidden.cl.history, 'Hidden gold-oil panel pauses both histories');
    await page.getByRole('tab', { name: '金油比', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 }); await page.clock.runFor(100);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'BZ chart and detail table fit mobile viewport');
    await select('cl').click(); await select('bz').click();
    check(new URL(page.url()).searchParams.get('goldOil') === 'bz', 'Selection is encoded in URL');
    await page.reload(); await metric.getByText('40.000', { exact: false }).waitFor();
    check(await select('bz').getAttribute('aria-pressed') === 'true', 'Reload restores BZ from URL');
    await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set('goldOil', 'cl'); history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate')); });
    await metric.getByText('50.000', { exact: false }).waitFor();
    check(await select('cl').getAttribute('aria-pressed') === 'true', 'Popstate restores the URL oil');
    await page.evaluate(() => history.back());
    await metric.getByText('40.000', { exact: false }).waitFor();
    await page.goto('http://127.0.0.1:3189/?monitor=cl-xau');
    await metric.getByText('40.000', { exact: false }).waitFor();
    check(new URL(page.url()).searchParams.get('goldOil') === 'bz', 'Local preference restores BZ when URL omits oil');
    await page.screenshot({ path: 'output/playwright/gold-oil-bz-mobile.png', fullPage: true });
    check(errors.length === 0, errors.join('; '));
    return { passed: true, counts, saved: saved.map(item => ({ oilType: item.oilType, revision: item.input.revision })), requests: requests.length };
  } finally { holdBz = false; pending.splice(0).forEach(resolve => resolve()); await page.clock.resume(); }
}
