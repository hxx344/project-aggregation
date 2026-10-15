// Start: node --import ./tests/fixtures/aster-notices-workbench.mjs server/index.mjs
// Run: playwright-cli -s=aster-capacity run-code --filename tests/aster-monitor-capacity.browser.mjs
// Focused capacity-table checks through the real Hub login, proxy and ASTER iframe.
async (page) => {
  const origin = 'http://hub.localhost:39152';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], consoleErrors = [], external = [], unexpectedWrites = [], observations = [];
  const settings = { schema_version: 2, monitoring_enabled: true, auto_discover: true,
    discovery_enabled: true, auto_monitor_new: true, feishu_enabled: false,
    default_notification_types: [], hourly_summary_alerts: false, relay_health_alerts: false,
    hourly_summary_interval_minutes: 60, new_listing_alerts: false, strategy_capacity_alerts: false,
    listing_capacity_alerts: false, trade_summary_alerts: false, position_imbalance_alerts: false };
  const symbols = ['XAUUSD1', 'BTCUSD1', 'ETHUSD1', 'XRPUSD1', 'SOLUSD1'].map(symbol => ({ symbol,
    monitor_enabled: symbol !== 'ETHUSD1', monitor: symbol !== 'ETHUSD1', alerts: false,
    notification_types: [], max_capacity_alert: false, can_watch: true, strategy_market: symbol === 'XAUUSD1',
    required_by: [], effective_monitor: symbol !== 'ETHUSD1', detail_enabled: symbol !== 'ETHUSD1', status: 'TRADING' }));
  let moduleOrigin, revision = 0, failReads = false;
  let tierOverrides = {};
  const sampleTime = Date.now() / 1000 - 1;
  const state = () => {
    const now = Date.now() / 1000;
    return { workspaceManaged: true, ready: true, demo: false, accounts: [], pairs: [],
      markets: {}, events: [], updated_at: now,
      monitoring: { settings, revision, symbols, strategy_capacity_environment_enabled: true },
      listings: { enabled: true, initialized: true, monitoring_enabled: settings.monitoring_enabled,
        discovery_enabled: true, checked_at: now - 1, poll_seconds: 60, stale_seconds: 180,
        rows: Object.fromEntries(symbols.map(({ symbol }, index) => [symbol, {
          symbol, status: 'TRADING', onboard_at: now - 86400 * (index + 1), detected_at: now - 3600,
          max_leverage: 100, capacity: symbol === 'XAUUSD1' ? null : '1000',
          remaining: '2000', bracket_cap: '1000', checked_at: symbol === 'XAUUSD1' ? null : sampleTime,
          brackets_checked_at: sampleTime, error: symbol === 'XAUUSD1' ? '最大杠杆额度缺失' : null,
          ...(symbol === 'SOLUSD1' ? {} : {
            tier_capacities: symbol === 'XAUUSD1' ? { '10': '12345.67', '20': '0', '50': null }
              : symbol === 'XRPUSD1' ? { '10': '5000', '20': '1000', '50': '500' }
              : { '10': '5000', '20': '2500', '50': '1000' },
            tier_checked_at: symbol === 'BTCUSD1' ? sampleTime - 200 : sampleTime,
            tier_brackets_checked_at: sampleTime,
            tier_error: symbol === 'XRPUSD1' ? '公开杠杆或额度暂不可用，等待重试' : null,
          }),
          ...tierOverrides[symbol],
        }])) },
      notification: { enabled: false, configured: false, pending: 0,
        channels: { event: { configured: false, source: 'none', pending: 0 },
          scheduled: { configured: false, source: 'none', pending: 0 } } },
    };
  };
  await page.unrouteAll({ behavior: 'wait' });
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.port !== '39152' || !(url.hostname === 'hub.localhost' || /^p-[a-f0-9]+\.hub\.localhost$/.test(url.hostname))) {
      external.push(url.href); return route.abort('blockedbyclient');
    }
    if (url.origin !== origin && url.pathname === '/api/state') {
      moduleOrigin = url.origin;
      return route.fulfill(failReads ? { status: 503, json: { detail: 'Fixture disconnected' } } : { status: 200, json: state() });
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      if (url.origin === origin && (url.pathname === '/api/login' || /^\/api\/projects\/(?:aster|asset|monitor|crossex|greeks)\/launch$/.test(url.pathname))) return route.continue();
      if (url.origin !== origin && request.method() === 'PATCH' && /^\/api\/monitoring(?:\/symbols\/[^/]+)?$/.test(url.pathname)) {
        const body = request.postDataJSON(), symbol = url.pathname.split('/')[4];
        if (symbol) {
          const control = symbols.find(row => row.symbol === symbol);
          assert(control, 'only fixture monitoring symbols may be edited');
          Object.assign(control, body);
          control.monitor = control.monitor_enabled;
        } else Object.assign(settings, body);
        revision += 1;
        return route.fulfill({ status: 200, json: { ok: true } });
      }
      unexpectedWrites.push(`${request.method()} ${url.href}`);
      return route.fulfill({ status: 405, json: { detail: 'Trading writes forbidden' } });
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  try {
    await page.goto(`${origin}/?view=project&id=aster`);
    const password = page.getByRole('textbox', { name: '工作台密码', exact: true });
    await password.or(page.locator('iframe[title="Aster 5x模块"]')).first().waitFor();
    if (await password.isVisible()) {
      await password.fill('aster-notices-browser-fixture');
      await page.getByRole('button', { name: '登录', exact: true }).click();
    }
    await page.locator('iframe[title="Aster 5x模块"]').waitFor();
    const app = page.frameLocator('iframe[title="Aster 5x模块"]');
    await app.getByRole('tab', { name: '币种监控中心', exact: true }).click();
    const region = app.getByRole('region', { name: '监控额度', exact: true });
    await region.waitFor();
    const table = region.locator('.monitor-tier-table');
    const row = symbol => table.locator(`tr[data-symbol="${symbol}"]`);
    const refresh = async () => {
      const response = page.waitForResponse(response => response.url().startsWith(`${moduleOrigin}/api/state`));
      await app.getByRole('button', { name: '刷新数据', exact: true }).first().click();
      await (await response).finished();
      await page.waitForTimeout(150);
    };
    for (const leverage of ['10x', '20x', '50x']) {
      assert(await table.getByRole('columnheader', { name: leverage, exact: true }).count() === 1, `${leverage} column visible`);
    }
    assert((await region.innerText()).includes('USD1') && /1 分钟|60 秒/.test(await region.innerText()), 'unit and one-minute cadence visible');
    assert(await table.locator('tr[data-symbol]').count() === 4 && await row('ETHUSD1').count() === 0, 'only monitor-enabled symbols listed');
    const gold = await row('XAUUSD1').innerText();
    assert(gold.includes('12,345.67') && gold.includes('0.00') && gold.includes('暂不可用'), 'exact tiers, true zero and missing tier distinguished');
    assert(!gold.includes('上次采样') && !gold.includes('采样失败'), 'missing maximum-leverage capacity does not invalidate fresh tier data');
    assert((await row('BTCUSD1').innerText()).includes('上次采样'), 'stale tier values retain historical label');
    assert((await row('XRPUSD1').innerText()).includes('上次采样'), 'failed tier read retains historical label');
    assert((await row('SOLUSD1').innerText()).includes('等待首次采样'), 'old records await first tier sample');
    observations.push('three exact leverage columns, enabled-only rows, independent tier health, zero/missing/stale/failure states');

    const order = () => table.locator('tr[data-symbol]').evaluateAll(rows => rows.map(row => row.dataset.symbol));
    const expectOrder = async (expected, message) => assert(JSON.stringify(await order()) === JSON.stringify(expected), message);
    const sortBy = async (label, direction, expected) => {
      await table.getByRole('button', { name: label, exact: true }).click();
      assert(await table.locator(`th[aria-sort="${direction}"]`).count() === 1, `${label} ${direction} is announced`);
      assert(await table.locator('th[aria-sort]').count() === 1, 'only the active column announces sorting');
      await expectOrder(expected, `${label} ${direction} row order`);
    };
    const sortingRevision = revision;
    await expectOrder(['BTCUSD1', 'SOLUSD1', 'XAUUSD1', 'XRPUSD1'], 'default symbol ascending');
    await sortBy('币种', 'descending', ['XRPUSD1', 'XAUUSD1', 'SOLUSD1', 'BTCUSD1']);
    await sortBy('币种', 'ascending', ['BTCUSD1', 'SOLUSD1', 'XAUUSD1', 'XRPUSD1']);
    await sortBy('10x', 'descending', ['XAUUSD1', 'BTCUSD1', 'XRPUSD1', 'SOLUSD1']);
    const ten = table.getByRole('button', { name: '10x', exact: true });
    await ten.focus();
    await ten.press('Enter');
    assert(await table.getByRole('columnheader', { name: '10x', exact: true }).getAttribute('aria-sort') === 'ascending', 'Enter reverses sorting');
    await expectOrder(['BTCUSD1', 'XRPUSD1', 'XAUUSD1', 'SOLUSD1'], 'keyboard ascending keeps missing last');
    await ten.press('Space');
    await expectOrder(['XAUUSD1', 'BTCUSD1', 'XRPUSD1', 'SOLUSD1'], 'Space reverses sorting');
    tierOverrides = { BTCUSD1: { tier_capacities: { '10': '20000', '20': '2500', '50': '1000' } } };
    await refresh();
    await expectOrder(['BTCUSD1', 'XAUUSD1', 'XRPUSD1', 'SOLUSD1'], 'refresh reorders updated values without resetting the chosen column');
    assert(await table.getByRole('columnheader', { name: '10x', exact: true }).getAttribute('aria-sort') === 'descending', 'refresh preserves direction');
    tierOverrides = {};
    await refresh();
    await sortBy('20x', 'descending', ['BTCUSD1', 'XRPUSD1', 'XAUUSD1', 'SOLUSD1']);
    await sortBy('20x', 'ascending', ['XAUUSD1', 'XRPUSD1', 'BTCUSD1', 'SOLUSD1']);
    await sortBy('50x', 'descending', ['BTCUSD1', 'XRPUSD1', 'SOLUSD1', 'XAUUSD1']);
    await sortBy('50x', 'ascending', ['XRPUSD1', 'BTCUSD1', 'SOLUSD1', 'XAUUSD1']);
    await sortBy('采样时间', 'descending', ['XAUUSD1', 'XRPUSD1', 'BTCUSD1', 'SOLUSD1']);
    await sortBy('采样时间', 'ascending', ['BTCUSD1', 'XAUUSD1', 'XRPUSD1', 'SOLUSD1']);
    await sortBy('10x', 'descending', ['XAUUSD1', 'BTCUSD1', 'XRPUSD1', 'SOLUSD1']);
    assert(revision === sortingRevision, 'sorting sends no monitoring writes');
    observations.push('all column directions, keyboard Enter/Space, stable ties, missing-last ordering, sample-time sorting and refresh-preserved selection');

    await app.getByRole('switch', { name: 'XAUUSD1 监控', exact: true }).click();
    await row('XAUUSD1').waitFor({ state: 'hidden' });
    await app.getByRole('switch', { name: 'XAUUSD1 监控', exact: true }).click();
    await row('XAUUSD1').waitFor();
    await app.getByRole('switch', { name: '独立币种监控', exact: true }).click();
    await row('XAUUSD1').getByText('已暂停', { exact: true }).waitFor();
    assert((await row('XAUUSD1').innerText()).includes('12,345.67'), 'global pause retains last sampled amounts');
    await app.getByRole('switch', { name: '独立币种监控', exact: true }).click();
    failReads = true;
    await refresh();
    assert((await row('XAUUSD1').innerText()).includes('上次采样'), 'disconnect keeps visible old tier data with status');
    failReads = false;
    await refresh();
    observations.push('single-symbol toggle, global pause/resume and reconnect preserve sampling semantics');

    const enabled = symbols.map(symbol => symbol.monitor_enabled);
    symbols.forEach(symbol => { symbol.monitor_enabled = false; });
    await refresh();
    assert(await table.locator('tr[data-symbol]').count() === 0, 'empty selection has no capacity rows');
    assert(/暂无|尚未|没有/.test(await region.innerText()), 'empty selection has explanatory text');

    const originalTierOverrides = tierOverrides;
    const selectedSymbols = ['XAUUSD1', 'BTCUSD1', 'ETHUSD1'];
    const unsampled = { tier_capacities: null, tier_checked_at: null,
      tier_brackets_checked_at: null, tier_error: null };
    tierOverrides = Object.fromEntries(selectedSymbols.map(symbol => [symbol, unsampled]));
    const toggleSymbol = async (symbol, checked) => {
      const response = page.waitForResponse(response => response.url() === `${moduleOrigin}/api/monitoring/symbols/${symbol}`
        && response.request().method() === 'PATCH');
      await app.getByRole('switch', { name: `${symbol} 监控`, exact: true }).click();
      const saved = await response;
      assert(saved.ok(), `${symbol} monitor switch saves successfully`);
      await saved.finished();
      await row(symbol).waitFor({ state: checked ? 'visible' : 'hidden' });
      assert(symbols.find(control => control.symbol === symbol).monitor_enabled === checked, `${symbol} saved monitor selection`);
      assert(await app.getByRole('switch', { name: `${symbol} 监控`, exact: true }).getAttribute('aria-checked') === String(checked), `${symbol} switch reflects saved selection`);
    };
    for (const symbol of selectedSymbols) {
      await toggleSymbol(symbol, true);
      await row(symbol).getByText('等待首次采样', { exact: true }).waitFor();
      assert(await row(symbol).getByText('暂不可用', { exact: true }).count() === 3, `${symbol} waits for all three first samples`);
      assert(await table.getByRole('columnheader', { name: '50x', exact: true }).count() === 1, 'capacity table remains usable after each new selection');
    }
    const freshTime = Date.now() / 1000 - 1;
    tierOverrides = {
      XAUUSD1: { tier_capacities: { '10': '1.234567e4', '20': '0', '50': null } },
      BTCUSD1: { tier_capacities: { '10': '9007199254740993', '20': '1.00000000000000000002', '50': '1e-100' } },
      ETHUSD1: { tier_capacities: { '10': '9007199254740992', '20': '1.00000000000000000001', '50': '2.5e3' } },
    };
    for (const override of Object.values(tierOverrides)) {
      Object.assign(override, { tier_checked_at: freshTime, tier_brackets_checked_at: freshTime, tier_error: null });
    }
    await refresh();
    for (const symbol of selectedSymbols) {
      await row(symbol).getByText('有效采样', { exact: true }).waitFor();
    }
    assert((await row('XAUUSD1').innerText()).includes('12,345.67')
      && (await row('XAUUSD1').innerText()).includes('0.00')
      && (await row('XAUUSD1').innerText()).includes('暂不可用'), 'newly enabled sample handles scientific amounts, zero and missing tiers');
    assert(await row('BTCUSD1').locator('[data-tier="20"]').innerText() === '1.00', 'high-precision amount uses the established two-decimal display');
    assert(await row('BTCUSD1').locator('[data-tier="50"]').innerText() === '0.00', 'small scientific amount renders without throwing');
    assert(await row('ETHUSD1').locator('[data-tier="50"]').innerText() === '2,500.00', 'scientific amount renders at its numeric magnitude');
    await sortBy('20x', 'descending', ['BTCUSD1', 'ETHUSD1', 'XAUUSD1']);

    await page.reload();
    await page.locator('iframe[title="Aster 5x模块"]').waitFor();
    await app.getByRole('tab', { name: '币种监控中心', exact: true }).click();
    await region.waitFor();
    assert(await table.locator('tr[data-symbol]').count() === selectedSymbols.length, 'reloading the workbench retains all saved monitoring selections');
    for (const symbol of selectedSymbols) {
      await row(symbol).getByText('有效采样', { exact: true }).waitFor();
      assert(await app.getByRole('switch', { name: `${symbol} 监控`, exact: true }).getAttribute('aria-checked') === 'true', `${symbol} remains selected after reload`);
    }
    observations.push('empty-to-multiple real switch saves, first-sample waiting, scientific/high-precision/zero/missing amounts and saved selection after workbench reload');

    const originalSymbolCount = symbols.length;
    const extraSymbols = Array.from({ length: 250 }, (_, index) => ({
      ...symbols.find(symbol => symbol.symbol === 'ETHUSD1'),
      symbol: `TEST${String(index).padStart(3, '0')}USD1`,
      notification_types: ['new_listing', 'listing_capacity'],
      listing_capacity_leverage: null, listing_capacity_threshold: '0',
      monitor_enabled: index < 247, monitor: index < 247,
      effective_monitor: index < 247, detail_enabled: index < 247,
    }));
    symbols.push(...extraSymbols);
    for (const control of extraSymbols.slice(-3)) tierOverrides[control.symbol] = unsampled;
    await refresh();
    await row(extraSymbols[246].symbol).waitFor();
    assert(await table.locator('tr[data-symbol]').count() === selectedSymbols.length + 247, 'large monitoring selection renders before adding more symbols');
    assert(await app.locator('.monitor-center-table .notification-capacity-summary').count() === extraSymbols.length, 'all catalog symbols retain their zero-threshold capacity notification summaries');
    for (const control of extraSymbols.slice(-3)) {
      await toggleSymbol(control.symbol, true);
      await row(control.symbol).getByText('等待首次采样', { exact: true }).waitFor();
    }
    assert(await table.locator('tr[data-symbol]').count() === selectedSymbols.length + extraSymbols.length, 'adding more symbols to a large selection keeps the full capacity table available');
    for (const control of extraSymbols.slice(-2)) await toggleSymbol(control.symbol, false);
    assert(await table.locator('tr[data-symbol]').count() === selectedSymbols.length + extraSymbols.length - 2, 'large selection also permits removing monitored symbols');
    assert(errors.length === 0, `large monitoring selection browser errors: ${errors.join('\n')}`);
    observations.push('250 additional catalog symbols with capacity notifications and zero thresholds, 247 preselected plus three real switch enables and two disables');
    symbols.splice(originalSymbolCount);
    tierOverrides = originalTierOverrides;
    symbols.forEach((symbol, index) => { symbol.monitor_enabled = enabled[index]; });
    await refresh();
    await region.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/aster-monitor-capacity-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    const frame = page.frames().find(frame => frame.url().startsWith(moduleOrigin));
    assert(frame, 'real embedded module is loaded');
    assert(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'module has no page-level horizontal overflow');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'Hub has no page-level horizontal overflow');
    assert(await table.getByRole('columnheader', { name: '50x', exact: true }).count() === 1, 'all tier columns remain available on narrow screens');
    await sortBy('50x', 'descending', ['BTCUSD1', 'XRPUSD1', 'SOLUSD1', 'XAUUSD1']);
    await sortBy('50x', 'ascending', ['XRPUSD1', 'BTCUSD1', 'SOLUSD1', 'XAUUSD1']);
    await sortBy('10x', 'descending', ['XAUUSD1', 'BTCUSD1', 'XRPUSD1', 'SOLUSD1']);
    await region.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/aster-monitor-capacity-mobile.png', fullPage: true });
    observations.push('empty selection and 390px layout retain readable values without page overflow');
    assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
    assert(unexpectedWrites.length === 0, `unexpected writes: ${unexpectedWrites.join('; ')}`);
    assert(external.length === 0, `external requests: ${external.join('; ')}`);
    return { passed: true, entry: page.url(), moduleOrigin, tradingWrites: 0, browserErrors: 0, observations };
  } catch (error) {
    await page.screenshot({ path: 'output/playwright/aster-monitor-capacity-failure.png', fullPage: true });
    throw new Error(`${error.stack || error.message || String(error)}\nBrowser page errors:\n${errors.join('\n') || '(none)'}\nBrowser console errors:\n${consoleErrors.join('\n') || '(none)'}`, { cause: error });
  }
}
