// Production Next server: localhost:3189. Playwright CLI run-code --filename.
// All market/config endpoints are isolated fixtures; no real notifications or writes.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- CLI evaluates this function.
async page => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const now = Date.UTC(2026, 9, 7, 12), interval = 900000, errors = [], pending = [], saved = [];
  const variants = ['binance/cl', 'binance/bz', 'bybit/cl', 'bybit/bz'];
  const counts = Object.fromEntries(variants.map(key => [key, { quote: 0, history: 0, funding: 0 }]));
  const configs = Object.fromEntries(variants.map((key, index) => [key, { revision: index * 7 + 2, config: { enabled: false, rules: [] } }]));
  const originalRevisions = Object.fromEntries(variants.map(key => [key, configs[key].revision]));
  let hold = 'bybit/cl', wrongSource = '', failed = '';
  const runtime = Object.fromEntries(['oil', 'cl-xau', 'hynix', 'perpetual'].map(id => [id, { available: true, monitorId: id, enabled: true, running: true, revision: 0, error: '' }]));
  const identity = key => { const [exchange, oilType] = key.split('/'); return { exchange, oilType, source: exchange === 'bybit' ? 'Bybit' : 'Binance' }; };
  const fixture = Object.fromEntries(variants.map((key, index) => {
    const { exchange, oilType, source } = identity(key), oil = oilType === 'bz' ? 100 : 80, xau = exchange === 'bybit' ? 4800 : 4000;
    const size = 400 - index * 40, start = now - size * interval;
    const common = { oilType, source, currency: 'USDT', priceBasis: 'mark', status: 'live', fetchedAt: new Date(now).toISOString() };
    const terms = (rate, intervalHours) => ({ rate, intervalHours, nextFundingAt: new Date(now + intervalHours * 3600000).toISOString() });
    return [key, {
      quote: { ...common, oil: { symbol: oilType === 'bz' ? 'BZUSDT' : 'CLUSDT', price: oil, updatedAt: common.fetchedAt },
        xau: { symbol: 'XAUUSDT', price: xau, updatedAt: common.fetchedAt }, ratio: xau / oil,
        funding: { oil: terms([0.0004, 0.0016, 0.0008, 0.002][index], 4), xau: terms(0.0016, 8) } },
      history: { ...common, interval: '15m', coverageStart: start,
        points: Array.from({ length: size }, (_, i) => ({ time: start + i * interval, oil, xau: xau + Math.sin(i / 20) * 80, ratio: (xau + Math.sin(i / 20) * 80) / oil })) },
      funding: { ...common, coverageStart: start, coverageEnd: now,
        points: Array.from({ length: Math.floor(size / 16) }, (_, i) => ({ time: start + i * 16 * interval, oil: (index + 1) * 0.0001, xau: 0.0003 })) },
    }];
  }));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' });
  await page.clock.install({ time: new Date(now - 1000) }); await page.clock.pauseAt(new Date(now));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/monitors') return route.fulfill({ json: { schemaVersion: 1, monitors: Object.entries(runtime).map(([id, value]) => ({ id, runtime: value })) } });
    const match = path.match(/^\/api\/monitors\/cl-xau\/(bybit\/)?(bz\/)?(quote|history|funding|status|config|events)$/);
    if (!match) return route.fulfill({ status: 503, json: { error: 'unrelated fixture' } });
    const key = `${match[1] ? 'bybit' : 'binance'}/${match[2] ? 'bz' : 'cl'}`, action = match[3];
    if (action === 'status') return route.fulfill({ json: { ...identity(key), available: true, webhookConfigured: true, stale: false,
      lastAttemptAt: fixture[key].quote.fetchedAt, lastSuccessAt: fixture[key].quote.fetchedAt, market: fixture[key].quote } });
    if (action === 'events') return route.fulfill({ json: { ...identity(key), events: [] } });
    if (action === 'config') {
      if (route.request().method() === 'PUT') {
        const input = route.request().postDataJSON();
        check(input.revision === configs[key].revision, `${key} save uses only its own revision`);
        saved.push({ key, input }); configs[key] = { revision: input.revision + 1, config: input.config };
      }
      return route.fulfill({ json: { ...identity(key), ...configs[key] } });
    }
    counts[key][action]++;
    if (key === hold) await new Promise(resolve => pending.push(resolve));
    const payload = wrongSource === key ? { ...fixture[key][action], source: identity(key).source === 'Bybit' ? 'Binance' : 'Bybit' } : fixture[key][action];
    return route.fulfill(key === failed ? { status: 503, json: { error: 'isolated outage' } } : { json: payload }).catch(() => {});
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto('http://127.0.0.1:3189/?monitor=cl-xau&goldOil=cl&goldOilExchange=binance');
    const panel = page.getByRole('tabpanel', { name: '金油比', exact: true }).locator('.oil-panel');
    const metric = panel.locator('.metric.featured'), chart = panel.locator('.gold-chart .gold-chart-svg');
    const overview = page.getByRole('article', { name: '金油比', exact: true });
    const sourceButton = exchange => panel.getByRole('button', { name: exchange === 'bybit' ? 'Bybit' : 'Binance', exact: true });
    const oilButton = oilType => panel.getByRole('button', { name: oilType === 'bz' ? 'BZ · 布伦特原油' : 'CL · WTI 原油', exact: true });
    const editor = key => { const { exchange, oilType } = identity(key); return page.locator(`[data-alert-monitor="cl-xau${exchange === 'bybit' ? '-bybit' : ''}${oilType === 'bz' ? '-bz' : ''}"]`); };
    const select = async key => { const { exchange, oilType } = identity(key); await sourceButton(exchange).click(); await oilButton(oilType).click(); };
    const expectMarket = async key => {
      const { source, oilType } = identity(key), quote = fixture[key].quote;
      await metric.getByText(quote.ratio.toFixed(3), { exact: false }).waitFor(); await chart.waitFor();
      check((await overview.locator('.hub-card-heading').innerText()).includes(`${oilType.toUpperCase()} · ${source}`), `${key} overview source and oil match`);
      check((await panel.locator('.stamp-source').innerText()).startsWith(source), `${key} stamp follows source`);
      check((await panel.locator('footer').innerText()).includes(`来源：${source}`), `${key} footer follows source`);
      check((await chart.getAttribute('aria-label')).startsWith(source), `${key} chart accessibility label follows source`);
      const urls = await panel.locator('.metrics a').evaluateAll(nodes => nodes.map(node => node.href));
      check(urls.every(url => new URL(url).hostname === (source === 'Bybit' ? 'www.bybit.com' : 'www.binance.com')), `${key} contract links follow source`);
    };
    await expectMarket('binance/cl');
    await panel.getByRole('button', { name: '全部', exact: true }).click();
    await panel.getByRole('button', { name: '黄金 / 原油价格', exact: true }).click();
    await panel.getByRole('slider').press('Home');
    await panel.locator('.data-details summary').click();
    await panel.getByRole('button', { name: '下一页', exact: true }).click();
    const originalReads = { ...counts['binance/cl'] };
    await sourceButton('bybit').click();
    await panel.getByText('正在读取共同历史，首次采集需要回补…', { exact: true }).waitFor();
    check(!(await metric.innerText()).includes('50.000'), 'Held Bybit request never exposes Binance quote');
    check(!(await overview.locator('.hub-card-metrics').innerText()).includes('50.000'), 'Held Bybit request never exposes Binance overview');
    await sourceButton('binance').click(); await expectMarket('binance/cl');
    check(JSON.stringify(counts['binance/cl']) === JSON.stringify(originalReads), 'Fresh Binance cache paints without duplicate reads');
    hold = ''; pending.splice(0).forEach(resolve => resolve()); await page.clock.runFor(50);
    check((await metric.innerText()).includes('50.000'), 'Late Bybit replies cannot replace current Binance data');
    await sourceButton('bybit').click(); await expectMarket('bybit/cl');
    check(await panel.getByRole('button', { name: '全部', exact: true }).getAttribute('aria-pressed') === 'true', 'Exchange switch preserves range');
    check(await panel.getByRole('button', { name: '黄金 / 原油价格', exact: true }).getAttribute('aria-pressed') === 'true', 'Exchange switch preserves chart view');
    check(await panel.getByRole('slider').inputValue() === '319', 'Exchange switch resets full-record cursor');
    check((await panel.locator('.table-pagination').innerText()).includes('第 1 / 2 页'), 'Exchange switch resets detail page');
    check((await panel.locator('tbody tr').first().innerText()).includes('80.000'), 'Bybit CL details use CL prices');
    check((await panel.locator('caption').innerText()).startsWith('Bybit'), 'Detail table identifies Bybit');
    check((await panel.locator('.funding-metrics').innerText()).includes('0.00%'), 'Bybit CL live funding uses its own terms');
    check((await panel.locator('.funding-history-section').innerText()).includes('CL 20 次'), 'Bybit CL historic funding uses its own events');

    // Visit all four editors, leave four distinct drafts, then save them independently.
    for (const key of variants) {
      await select(key); await expectMarket(key);
      const settings = editor(key);
      await settings.getByRole('button', { name: /飞书告警梯度/ }).click();
      await settings.getByRole('button', { name: '添加梯度' }).waitFor();
      check(await settings.getByRole('group', { name: '第 1 档', exact: true }).count() === 0, `${key} has independent empty defaults`);
      check(!await settings.getByLabel('启用飞书告警', { exact: true }).isChecked(), `${key} defaults to disabled`);
      await settings.getByRole('button', { name: '添加梯度' }).click();
      await settings.getByLabel('档位名称').fill(`${key} 草稿`);
      await settings.getByLabel(key === 'bybit/bz' ? '阈值（报价比）' : '阈值（桶/盎司）').fill(String(fixture[key].quote.ratio));
    }
    check((await metric.innerText()).includes('报价比'), 'Bybit BZ uses the verified raw quotation ratio label');
    check((await panel.locator('.metrics').innerText()).includes('USDT/BZ'), 'Bybit BZ does not assert an unverified barrel multiplier');
    check((await panel.locator('.funding-metrics').innerText()).includes('-131.40%'), 'Bybit BZ live funding stays distinct');
    const retainedReads = structuredClone(counts);
    await chart.evaluate(node => { node.dataset.retained = 'four-combinations'; });
    for (const key of variants) {
      await select(key); await expectMarket(key);
      check(await editor(key).getByLabel('档位名称').inputValue() === `${key} 草稿`, `${key} draft survives other combinations`);
    }
    check(JSON.stringify(counts) === JSON.stringify(retainedReads), 'All four fresh caches avoid duplicate data reads');
    check(await chart.getAttribute('data-retained') === 'four-combinations', 'Cached combination switches retain SVG node');
    for (const key of [...variants].reverse()) {
      await select(key);
      const untouched = Object.fromEntries(variants.filter(other => other !== key).map(other => [other, JSON.stringify(configs[other])]));
      await editor(key).getByRole('button', { name: '保存配置', exact: true }).click();
      await editor(key).getByText('配置已保存，下一轮后台检查时生效。', { exact: true }).waitFor();
      check(saved.at(-1).key === key && saved.at(-1).input.revision === originalRevisions[key], `${key} saves to correct endpoint and revision`);
      check(Object.entries(untouched).every(([other, value]) => value === JSON.stringify(configs[other])), `${key} save leaves other backend configurations untouched`);
    }
    check(saved.length === 4, 'Exactly four requested configuration saves');

    await select('bybit/bz'); await expectMarket('bybit/bz');
    wrongSource = 'bybit/bz'; await panel.getByRole('button', { name: '刷新数据 ↻', exact: true }).click();
    await panel.getByText('更新中断 · 保留数据', { exact: true }).waitFor();
    check((await metric.innerText()).includes('48.000'), 'Wrong-source data cannot replace retained Bybit BZ quote');
    check(await chart.isVisible(), 'Wrong-source history retains existing chart');
    await select('binance/bz'); await expectMarket('binance/bz');
    check((await panel.locator('.stamp-label').innerText()).includes('实时'), 'Bybit errors do not leak to Binance BZ');
    wrongSource = ''; await select('bybit/bz'); await panel.getByText('实时 · 每 30 秒更新', { exact: true }).waitFor();
    failed = 'bybit/bz'; await panel.getByRole('button', { name: '刷新数据 ↻', exact: true }).click();
    await panel.getByText('更新中断 · 保留数据', { exact: true }).waitFor();
    check((await metric.innerText()).includes('48.000'), 'Network outage retains matching source and oil data');
    failed = ''; await panel.getByRole('button', { name: '刷新数据 ↻', exact: true }).click();
    await panel.getByText('实时 · 每 30 秒更新', { exact: true }).waitFor();
    const hiddenReads = structuredClone(counts);
    await page.getByRole('tab', { name: '海力士 ADR', exact: true }).click(); await page.clock.runFor(30000);
    check(counts['bybit/bz'].quote === hiddenReads['bybit/bz'].quote + 1, 'Selected Bybit BZ quote polls for overview');
    check(variants.every(key => counts[key].history === hiddenReads[key].history && counts[key].funding === hiddenReads[key].funding), 'Hidden gold-oil panel pauses histories for all combinations');
    check(variants.filter(key => key !== 'bybit/bz').every(key => counts[key].quote === hiddenReads[key].quote), 'Unselected source/oil quotes do not poll');
    await page.getByRole('tab', { name: '金油比', exact: true }).click();

    await page.setViewportSize({ width: 390, height: 844 }); await page.clock.runFor(100);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Source selector and charts fit mobile portrait');
    await sourceButton('binance').click(); await expectMarket('binance/bz');
    await page.evaluate(() => history.back()); await expectMarket('bybit/bz');
    check(await sourceButton('bybit').getAttribute('aria-pressed') === 'true', 'Browser Back restores exchange');
    await oilButton('cl').click(); await expectMarket('bybit/cl');
    await page.evaluate(() => history.back()); await expectMarket('bybit/bz');
    check(await oilButton('bz').getAttribute('aria-pressed') === 'true', 'Browser Back restores oil');
    check(new URL(page.url()).searchParams.get('goldOilExchange') === 'bybit' && new URL(page.url()).searchParams.get('goldOil') === 'bz', 'URL encodes both dimensions');
    await page.reload(); await expectMarket('bybit/bz');
    await page.goto('http://127.0.0.1:3189/?monitor=cl-xau'); await expectMarket('bybit/bz');
    check(new URL(page.url()).searchParams.get('goldOilExchange') === 'bybit' && new URL(page.url()).searchParams.get('goldOil') === 'bz', 'Local preferences restore both dimensions when query is absent');
    await page.goto('http://127.0.0.1:3189/?monitor=cl-xau&goldOil=cl&goldOilExchange=binance'); await expectMarket('binance/cl');
    check(await page.evaluate(() => localStorage.getItem('market-monitor.goldOilExchange')) === 'binance', 'Explicit URL overrides saved source preference');
    await select('bybit/bz'); await expectMarket('bybit/bz');
    await page.screenshot({ path: 'output/playwright/gold-oil-bybit-mobile.png', fullPage: true });
    check(errors.length === 0, errors.join('; '));
    return { passed: true, counts, saved: saved.map(({ key, input }) => ({ key, revision: input.revision })), checkedSources: variants };
  } finally { hold = ''; pending.splice(0).forEach(resolve => resolve()); await page.clock.resume(); }
}
