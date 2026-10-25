// Start: node --import ./tests/fixtures/aster-notices-workbench.mjs server/workbench.mjs
// Run: playwright-cli -s=aster-monitor run-code --filename tests/aster-monitor-center.browser.mjs
// Real Hub login/launch/proxy/iframe and built ASTER assets, with isolated API data.
async (page) => {
  const origin = 'http://hub.localhost:39152';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], consoleErrors = [], unexpectedWrites = [], external = [], writes = [], observations = [];
  const defaults = ['new_listing', 'strategy_capacity', 'trade_summary', 'position_imbalance'];
  const settings = { schema_version: 2, monitoring_enabled: true, auto_discover: true, discovery_enabled: true,
    auto_monitor_new: true, feishu_enabled: true, default_notification_types: [...defaults],
    hourly_summary_alerts: true, relay_health_alerts: true, hourly_summary_interval_minutes: 60,
    new_listing_alerts: true, strategy_capacity_alerts: true, listing_capacity_alerts: true,
    trade_summary_alerts: true, position_imbalance_alerts: true };
  const symbols = ['XAUUSD1', 'BTCUSD1', 'ETHUSD1', 'SOLUSD1', 'XRPUSD1'].map(symbol => ({ symbol,
    monitor_enabled: symbol !== 'ETHUSD1', monitor: symbol !== 'ETHUSD1', alerts: true,
    notification_types: defaults.filter(type => type !== 'strategy_capacity' || symbol === 'XAUUSD1'),
    max_capacity_alert: false, can_watch: true, strategy_market: symbol === 'XAUUSD1',
    required_by: symbol === 'ETHUSD1' ? ['fixture-account'] : [], effective_monitor: true,
    detail_enabled: symbol !== 'ETHUSD1', status: symbol === 'SOLUSD1' ? 'CLOSE' : 'TRADING' }));
  let moduleOrigin, rejectNext = false, failReads = false, demo = false, withAccount = false, frozenAt;
  let revision = 0;
  let marketState = () => ({});
  const state = () => {
    const now = Date.now() / 1000;
    return { workspaceManaged: true, ready: true, demo,
      accounts: withAccount ? [{ id: 'fixture-account', name: '浏览器隔离账户', mode: 'paper', env_prefix: 'FIXTURE',
        enabled: false, status: 'paused', reason: '', credential_ready: false, strategies: {},
        policy: { threshold: '50000', order_notional: '1000', margin_limit: '0.5', spread_limit: '0.1',
          min_open_leverage: 5, ordinary_symbol: 'all', symbols: ['XAUUSD1'] } }] : [],
      pairs: [], markets: marketState(now), events: [], updated_at: now,
      monitoring: { settings, revision, symbols, strategy_capacity_environment_enabled: true },
      listings: { enabled: !demo, initialized: true, monitoring_enabled: settings.monitoring_enabled,
        discovery_enabled: settings.auto_discover, checked_at: now - 2, poll_seconds: 60, stale_seconds: 180,
        rows: Object.fromEntries(symbols.map((symbol, index) => [symbol.symbol, { symbol: symbol.symbol,
          status: symbol.status, onboard_at: now - 86400 * (index + 1), detected_at: now - 3600,
          max_leverage: 20, capacity: '150000', remaining: '200000', bracket_cap: '150000',
          checked_at: symbol.symbol === 'BTCUSD1' ? now - 181 : symbol.symbol === 'XAUUSD1' && frozenAt ? frozenAt : now - 1,
          brackets_checked_at: now - 2, error: symbol.symbol === 'XRPUSD1' ? '浏览器夹具：公开额度读取失败' : null }])) },
      notification: { enabled: settings.feishu_enabled, configured: true, pending: 3, routing_mode: 'split',
        channels: { event: { configured: true, source: 'dedicated', pending: 2 },
          scheduled: { configured: true, source: 'dedicated', pending: 1, error: '浏览器夹具：定时机器人等待重试' } },
        hourly_summary: { interval_seconds: settings.hourly_summary_interval_minutes * 60,
          next_due_at: now + 600, last_sent_at: now - 3000, pending: true } } };
  };
  await page.unrouteAll({ behavior: 'wait' });
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.port !== '39152' || !(url.hostname === 'hub.localhost' || /^p-[a-f0-9]+\.hub\.localhost$/.test(url.hostname))) {
      external.push(url.href); return route.abort('blockedbyclient');
    }
    if (url.origin !== origin && url.pathname === '/api/state') {
      moduleOrigin = url.origin;
      return route.fulfill(failReads ? { status: 503, json: { detail: 'Fixture unavailable' } } : { status: 200, json: state() });
    }
    if (!['GET', 'HEAD'].includes(req.method())) {
      if (url.origin === origin && (url.pathname === '/api/login' || /^\/api\/projects\/(?:aster|asset|monitor|crossex|greeks)\/launch$/.test(url.pathname))) return route.continue();
      if (url.origin !== origin && req.method() === 'PATCH' && /^\/api\/monitoring(?:\/symbols\/[^/]+)?$/.test(url.pathname)) {
        const body = req.postDataJSON(); writes.push({ path: url.pathname, body });
        if (rejectNext) { rejectNext = false; return route.fulfill({ status: 409, json: { detail: '浏览器夹具：本次保存被拒绝' } }); }
        const name = url.pathname.split('/')[4];
        if (name) {
          const row = symbols.find(item => item.symbol === name);
          assert(row, 'only fixture symbols may be edited');
          Object.assign(row, body);
          row.monitor = row.monitor_enabled;
        } else Object.assign(settings, body);
        revision += 1;
        return route.fulfill({ status: 200, json: { ok: true } });
      }
      unexpectedWrites.push(`${req.method()} ${url.href}`);
      return route.fulfill({ status: 405, json: { detail: 'Trading writes forbidden' } });
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  try {
    await page.goto(`${origin}/?view=project&id=aster`);
    const password = page.getByRole('textbox', { name: '工作台密码', exact: true });
    const iframe = page.locator('iframe[title="Aster 5x模块"]');
    await password.or(iframe).first().waitFor();
    if (await password.isVisible()) {
      await password.fill('aster-notices-browser-fixture');
      await page.getByRole('button', { name: '登录', exact: true }).click();
    }
    await iframe.waitFor();
    const app = page.frameLocator('iframe[title="Aster 5x模块"]');
    await app.getByRole('tab', { name: '币种监控中心', exact: true }).click();
    await app.getByRole('heading', { name: '币种监控中心', exact: true }).waitFor();
    const frame = page.frames().find(frame => frame.url().startsWith(moduleOrigin));
    assert(frame, 'actual module iframe loaded');
    const table = app.locator('.monitor-center-table');
    const row = symbol => table.locator(`tr[data-symbol="${symbol}"]`);
    const refresh = async () => {
      const response = page.waitForResponse(response => response.url().startsWith(`${moduleOrigin}/api/state`));
      await app.getByRole('button', { name: '刷新数据', exact: true }).first().click();
      await (await response).finished();
      await page.waitForTimeout(100);
    };
    assert(await app.getByRole('tab', { name: 'USD1 上新', exact: true }).count() === 0, 'old listings tab removed');
    assert(await app.getByRole('tab', { name: '监控与告警', exact: true }).count() === 0, 'old monitoring tab removed');
    for (const [symbol, status] of [['XAUUSD1', '监控中'], ['BTCUSD1', '数据过期'], ['ETHUSD1', '已暂停'], ['SOLUSD1', '非交易中'], ['XRPUSD1', '采样失败']]) {
      assert((await row(symbol).innerText()).includes(status), `${symbol}: ${status}`);
    }
    assert((await row('ETHUSD1').innerText()).includes('交易保留采样'), 'required sampling is separate from independent pause');
    const channels = app.getByRole('region', { name: '通知通道状态', exact: true });
    assert((await channels.innerText()).includes('2 条待发送') && (await channels.innerText()).includes('1 条待发送'), 'channel counts remain separate');
    observations.push('unified account-free entry, all five statuses and separate notification channels');

    const search = app.getByRole('textbox', { name: '搜索监控币种', exact: true });
    await search.fill('xau');
    assert(await table.locator('tr[data-symbol]').count() === 1, 'case-insensitive symbol search');
    await search.fill('');
    await app.getByRole('combobox', { name: '筛选监控状态', exact: true }).selectOption('paused');
    assert(await table.locator('tr[data-symbol]').count() === 1, 'status filter');
    await app.getByRole('combobox', { name: '筛选监控状态', exact: true }).selectOption('all');

    const pickerButton = app.getByRole('button', { name: 'XAUUSD1 配置通知', exact: true });
    const picker = app.getByRole('form', { name: 'XAUUSD1 配置通知', exact: true });
    const before = writes.length;
    await pickerButton.click();
    await picker.getByRole('button', { name: '清空', exact: true }).click();
    await picker.getByRole('button', { name: '取消', exact: true }).click();
    assert(writes.length === before, 'cancel does not write');
    await pickerButton.click();
    assert(await picker.getByRole('checkbox', { checked: true }).count() === 4, 'reopen restores saved selections');
    await picker.getByRole('button', { name: '清空', exact: true }).click();
    rejectNext = true;
    await picker.getByRole('button', { name: '应用', exact: true }).click();
    await picker.getByRole('alert').waitFor();
    assert(await picker.getByRole('checkbox', { checked: true }).count() === 0, 'failure preserves draft');
    await picker.getByRole('button', { name: '全选', exact: true }).click();
    await picker.getByRole('button', { name: '应用', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
    assert(symbols[0].notification_types.length === 5, 'success saves canonical notification_types');
    assert(symbols[0].listing_capacity_leverage === null && symbols[0].listing_capacity_threshold === '0', 'old missing conditions default to maximum leverage >0');

    await pickerButton.click();
    await picker.getByRole('combobox', { name: '通知杠杆', exact: true }).selectOption('fixed');
    await picker.getByRole('textbox', { name: '指定杠杆倍数', exact: true }).fill('25');
    await picker.getByRole('textbox', { name: '公开额度超过（USD1）', exact: true }).fill('9000');
    const beforeCancel = writes.length;
    await picker.getByRole('button', { name: '取消', exact: true }).click();
    assert(writes.length === beforeCancel, 'condition cancellation never writes');
    await pickerButton.click();
    assert(await picker.getByRole('combobox', { name: '通知杠杆', exact: true }).inputValue() === 'maximum', 'cancel restores saved leverage mode');
    assert(await picker.getByRole('textbox', { name: '公开额度超过（USD1）', exact: true }).inputValue() === '0', 'cancel restores saved threshold');
    await picker.getByRole('combobox', { name: '通知杠杆', exact: true }).selectOption('fixed');
    await picker.getByRole('textbox', { name: '指定杠杆倍数', exact: true }).fill('20.5');
    const preciseThreshold = '5000.000000000000000001';
    await picker.getByRole('textbox', { name: '公开额度超过（USD1）', exact: true }).fill(preciseThreshold);
    const beforeInvalid = writes.length;
    await picker.getByRole('button', { name: '应用', exact: true }).click();
    await picker.getByRole('alert').waitFor();
    assert(writes.length === beforeInvalid, 'fractional leverage is rejected before an API write');
    await picker.getByRole('textbox', { name: '指定杠杆倍数', exact: true }).fill('20');
    rejectNext = true;
    await picker.getByRole('button', { name: '应用', exact: true }).click();
    await picker.getByRole('alert').waitFor();
    assert(await picker.getByRole('textbox', { name: '指定杠杆倍数', exact: true }).inputValue() === '20', 'failed save retains selected leverage');
    assert(await picker.getByRole('textbox', { name: '公开额度超过（USD1）', exact: true }).inputValue() === preciseThreshold, 'failed save retains exact threshold text');
    await picker.getByRole('button', { name: '应用', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
    const savedCondition = writes.at(-1).body;
    assert(savedCondition.notification_types.length === 5 && savedCondition.listing_capacity_leverage === 20 && savedCondition.listing_capacity_threshold === preciseThreshold, 'notification selection and condition use one atomic PATCH');
    await row('XAUUSD1').getByText(`20x · 公开额度 > ${preciseThreshold} USD1`, { exact: true }).waitFor();

    await app.getByRole('button', { name: 'BTCUSD1 配置通知', exact: true }).click();
    const btcPicker = app.getByRole('form', { name: 'BTCUSD1 配置通知', exact: true });
    await btcPicker.getByRole('button', { name: '全选', exact: true }).click();
    assert(await btcPicker.getByRole('checkbox', { checked: true }).count() === 4, 'non-strategy symbol cannot select strategy-only event');
    await btcPicker.getByRole('combobox', { name: '通知杠杆', exact: true }).selectOption('fixed');
    await btcPicker.getByRole('textbox', { name: '指定杠杆倍数', exact: true }).fill('50');
    await btcPicker.getByRole('textbox', { name: '公开额度超过（USD1）', exact: true }).fill('12500');
    await btcPicker.getByRole('button', { name: '应用', exact: true }).click();
    await btcPicker.waitFor({ state: 'hidden' });
    assert(symbols[1].listing_capacity_leverage === 50 && symbols[1].listing_capacity_threshold === '12500', 'second symbol has its own saved condition');
    assert(symbols[0].listing_capacity_leverage === 20 && symbols[0].listing_capacity_threshold === preciseThreshold, 'second symbol does not overwrite the first');
    await app.getByRole('button', { name: 'BTCUSD1 配置通知', exact: true }).click();
    await btcPicker.getByRole('checkbox', { name: /^公开额度达标/ }).uncheck();
    await btcPicker.getByRole('button', { name: '应用', exact: true }).click();
    await btcPicker.waitFor({ state: 'hidden' });
    assert(!('listing_capacity_threshold' in writes.at(-1).body) && symbols[1].listing_capacity_threshold === '12500', 'disabling capacity notification preserves its configured condition');
    await pickerButton.click();
    await picker.getByRole('combobox', { name: '通知杠杆', exact: true }).selectOption('maximum');
    await picker.getByRole('button', { name: '应用', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
    assert(symbols[0].listing_capacity_leverage === null, 'maximum mode sends explicit null');
    observations.push('condition cancel, invalid input, rejected-save draft, exact atomic PATCH, independent symbols and explicit maximum mode');

    await app.getByRole('switch', { name: 'XAUUSD1 监控', exact: true }).click();
    await row('XAUUSD1').getByText('已暂停', { exact: true }).waitFor();
    assert(symbols[0].monitor_enabled === false, 'monitor switch uses canonical field');
    await app.getByRole('switch', { name: 'XAUUSD1 监控', exact: true }).click();
    await row('XAUUSD1').getByText('监控中', { exact: true }).waitFor();
    await app.getByRole('switch', { name: '独立币种监控', exact: true }).click();
    await row('XAUUSD1').getByText('已暂停', { exact: true }).waitFor();
    await app.getByRole('switch', { name: '独立币种监控', exact: true }).click();
    await row('XAUUSD1').getByText('监控中', { exact: true }).waitFor();
    await app.getByText('默认通知与定时设置', { exact: false }).first().click();
    await app.getByRole('spinbutton', { name: '摘要间隔（分钟）', exact: true }).fill('30');
    await app.getByRole('button', { name: '保存间隔', exact: true }).click();
    await app.getByText('已保存：每 30 分钟发送一次。', { exact: true }).waitFor();
    await app.getByRole('button', { name: '配置默认通知', exact: true }).click();
    const defaultPicker = app.getByRole('form', { name: '配置默认通知', exact: true });
    assert(await defaultPicker.getByRole('combobox', { name: '通知杠杆', exact: true }).count() === 0, 'future-symbol defaults do not expose per-symbol conditions');
    await defaultPicker.getByRole('button', { name: '清空', exact: true }).click();
    await defaultPicker.getByRole('button', { name: '应用', exact: true }).click();
    await defaultPicker.waitFor({ state: 'hidden' });
    assert(settings.default_notification_types.length === 0 && symbols[0].notification_types.length === 5, 'default editor only sends the defaults field');
    observations.push('single/global monitoring pause and resume, summary interval and future-symbol defaults');

    frozenAt = Date.now() / 1000 - 178;
    await refresh();
    await row('XAUUSD1').getByText('监控中', { exact: true }).waitFor();
    await row('XAUUSD1').getByText('数据过期', { exact: true }).waitFor({ timeout: 5000 });
    frozenAt = undefined;
    await refresh();
    failReads = true;
    await refresh();
    await app.getByText('连接中断，显示上次数据；配置不可修改。', { exact: true }).waitFor();
    assert(await pickerButton.isDisabled(), 'disconnected writes are disabled');
    failReads = false;
    await refresh();
    demo = true;
    await refresh();
    assert(await pickerButton.isDisabled(), 'demo writes are disabled');
    demo = false;
    withAccount = true;
    // The account branch keeps the ordinary workspace mounted while monitoring
    // is visible. Public feeds may create a market row before capacities exist.
    marketState = () => ({ XAUUSD1: { status: 'error', error: '浏览器夹具：首次公开额度读取失败' } });
    await refresh();
    await app.getByRole('tab', { name: '币种监控中心', exact: true }).click();
    await app.getByRole('heading', { name: '币种监控中心', exact: true }).waitFor();
    assert(await app.getByRole('tab', { name: 'USD1 上新', exact: true }).count() === 0, 'account-present tab branch also unified');
    observations.push('real-clock expiry, reconnect, demo write guard, account-present entry');

    const marketRow = app.locator('.market-table tbody tr').filter({ hasText: 'XAUUSD1' });
    const verifyMarket = async (label, expected, highlighted) => {
      await app.getByRole('heading', { name: '币种监控中心', exact: true }).waitFor();
      await pickerButton.click();
      await picker.waitFor();
      await picker.getByRole('button', { name: '取消', exact: true }).click();
      await app.getByRole('tab', { name: '普通开仓', exact: true }).click();
      const marketDisclosure = app.locator('details').filter({ has: app.getByText('全部市场额度与深度', { exact: true }) });
      if (await marketDisclosure.getAttribute('open') === null) {
        await app.getByText('全部市场额度与深度', { exact: true }).click();
      }
      await marketRow.waitFor();
      for (const [index, leverage] of [5, 10, 20].entries()) {
        const cell = marketRow.locator('td').nth(index + 1);
        assert((await cell.innerText()).trim().endsWith(expected[index]), `${label}: ${leverage}x capacity display`);
        assert((await cell.getAttribute('class')).split(/\s+/).includes('mint') === highlighted[index], `${label}: ${leverage}x threshold highlight`);
      }
      await app.getByRole('tab', { name: '币种监控中心', exact: true }).click();
      await app.getByRole('heading', { name: '币种监控中心', exact: true }).waitFor();
    };
    await verifyMarket('first capacity failure without a capacity map', ['—', '—', '—'], [false, false, false]);
    const partialMarkets = [
      ['book-only market row', now => ({ book: { bid: '100', ask: '100.01', mark: '100', spread: '0.0001', timestamp: now - 1 } })],
      ['book-error-only market row', () => ({ book_error: '浏览器夹具：首次盘口读取失败' })],
      ['depth-only market row', now => ({ depth: { timestamp: now - 1, levels_limit: 1000,
        spreads: { '10000': { status: 'ok', buy_average: '100.01', sell_average: '100', spread: '0.0001' },
          '50000': { status: 'insufficient', buy_average: null, sell_average: null, spread: null } } } })],
      ['depth-error-only market row', () => ({ depth_error: '浏览器夹具：首次深度读取失败' })],
    ];
    for (const [label, market] of partialMarkets) {
      marketState = now => ({ XAUUSD1: market(now) });
      await refresh();
      await verifyMarket(label, ['—', '—', '—'], [false, false, false]);
    }
    const recoveredMarket = now => ({ status: 'ok', checked_at: now - 1,
      capacities: { '5': '75000', '10': '50000', '20': '25000' },
      capacity_checked_at: { '5': now - 1, '10': now - 1, '20': now - 1 } });
    marketState = now => ({ XAUUSD1: recoveredMarket(now) });
    await refresh();
    await verifyMarket('capacity recovery', ['75,000', '50,000', '25,000'], [true, false, false]);
    marketState = now => ({ XAUUSD1: { status: 'ok', checked_at: now - 1,
      capacities: { '5': '0', '10': '75000' } } });
    await refresh();
    await verifyMarket('zero capacity and a missing tier', ['0', '75,000', '—'], [false, true, false]);
    marketState = now => ({ XAUUSD1: { ...recoveredMarket(now), status: 'error', error: '浏览器夹具：后续额度读取失败' } });
    await refresh();
    await verifyMarket('retained capacity after a failed read', ['—', '—', '—'], [false, false, false]);
    observations.push('account-present first-capacity failure, independent book/depth success and failure, recovery threshold display and failed-read history never highlighted');

    await pickerButton.click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: 'output/playwright/aster-monitor-center-desktop.png', fullPage: true });
    await picker.getByRole('button', { name: '取消', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    await pickerButton.click();
    await picker.getByRole('combobox', { name: '通知杠杆', exact: true }).selectOption('fixed');
    await picker.getByRole('textbox', { name: '指定杠杆倍数', exact: true }).fill('20');
    await picker.getByRole('textbox', { name: '公开额度超过（USD1）', exact: true }).fill('5000');
    await picker.getByRole('textbox', { name: '公开额度超过（USD1）', exact: true }).focus();
    const dialogBox = await app.getByRole('dialog', { name: 'XAUUSD1 配置通知', exact: true }).boundingBox();
    const thresholdBox = await picker.getByRole('textbox', { name: '公开额度超过（USD1）', exact: true }).boundingBox();
    assert(dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= 390, 'mobile editor stays within viewport');
    assert(thresholdBox.x >= dialogBox.x && thresholdBox.x + thresholdBox.width <= dialogBox.x + dialogBox.width, 'mobile threshold input is fully visible');
    assert(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'module has no page-level horizontal overflow');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'Hub has no page-level horizontal overflow');
    await page.screenshot({ path: 'output/playwright/aster-monitor-center-mobile.png', fullPage: true });
    const beforeEscape = writes.length;
    await picker.getByRole('textbox', { name: '公开额度超过（USD1）', exact: true }).press('Escape');
    await picker.waitFor({ state: 'hidden' });
    assert(writes.length === beforeEscape, 'Escape closes a condition draft without saving');
    assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
    assert(unexpectedWrites.length === 0, `unexpected writes: ${unexpectedWrites.join('; ')}`);
    assert(external.length === 0, `external requests: ${external.join('; ')}`);
    return { passed: true, entry: page.url(), moduleOrigin, monitoringWrites: writes.length,
      tradingWrites: 0, browserErrors: 0, observations };
  } catch (error) {
    await page.screenshot({ path: 'output/playwright/aster-monitor-center-failure.png', fullPage: true });
    throw new Error(`${error.stack || error.message || String(error)}\nBrowser page errors:\n${errors.join('\n') || '(none)'}\nBrowser console errors:\n${consoleErrors.join('\n') || '(none)'}`, { cause: error });
  }
}
