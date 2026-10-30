// Start: node --import ./tests/fixtures/aster-notices-workbench.mjs server/workbench.mjs
// Run: playwright-cli -s=aster-adl-margin run-code --filename tests/aster-adl-margin.browser.mjs
// Real Hub login, proxy and embedded built UI; only isolated API evidence is supplied.
async (page) => {
  const origin = 'http://hub.localhost:39152';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], external = [], writes = [], unexpectedWrites = [], observations = [];
  const now = Date.now() / 1000;
  const pair = {
    id: 'gold', name: 'ADL 保证金独立运行', long_account_id: 'a', short_account_id: 'b', symbol: 'XAUUSD1',
    enabled: false, revision: 1,
    ordinary: { enabled: true, threshold: '10000', order_notional: '1000', min_open_leverage: 5, margin_limit: '0.5', spread_limit: '0.0005' },
    margin: { enabled: true, master_env_prefix: '', check_interval_seconds: 5, threshold: '10', min_transfer: '1', max_transfer: '1000', buffer_ratio: '0.05', cooldown_seconds: 30 },
    state: {
      phase: 'paused', reason: 'ADL 自动暂停策略', snapshots: {}, pending: null,
      margin: { running: true, status: 'balanced', reason: '保证金平衡继续检查' },
      adl: {
        monitoring: { status: 'monitoring', reason: 'ADL 补查正常', checked_at: now },
        incident: null, report_available: false, pending_event: false,
        configuration_locked: true, lock_reason: 'ADL 处理中或完成后保持暂停观察', margin_start_allowed: false,
      },
    },
  };
  const symbol = { symbol: 'XAUUSD1', display_name: '黄金 XAUUSD1', min_notional: '500',
    default_order_notional: '1000', default_threshold: '10000', default_spread_limit: '0.0005' };
  const accounts = ['a', 'b'].map(id => ({ id, name: `隔离账户 ${id}`, pair_id: 'gold', mode: 'paper',
    env_prefix: `FIXTURE_${id.toUpperCase()}`, enabled: false, status: 'paused', credential_ready: false, strategies: {},
    policy: { threshold: '50000', order_notional: '1000', margin_limit: '0.5', spread_limit: '0.0005',
      min_open_leverage: 5, ordinary_symbol: 'all', symbols: ['XAUUSD1'] } }));
  const incident = status => ({ id: `incident-${status}`, status, hold: true, halted: status === 'blocked',
    reason: '隔离 ADL 现场', symbols: ['BTCUSDT'], created_at: now - 15,
    completed_at: status === 'completed' ? now : null, batch_count: 1,
    config: { enabled: true, batch_notional: '1000' } });
  pair.state.adl.incident = incident('active');
  let moduleOrigin, failReads = false, rejectNext = true;
  const state = () => ({ workspaceManaged: true, ready: true, demo: false, accounts, pairs: [pair],
    markets: {}, events: [], updated_at: Date.now() / 1000 });
  await page.unrouteAll({ behavior: 'wait' });
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.port !== '39152' || !(url.hostname === 'hub.localhost' || /^p-[a-f0-9]+\.hub\.localhost$/.test(url.hostname))) {
      external.push(url.href); return route.abort('blockedbyclient');
    }
    const module = url.origin !== origin;
    if (module && url.pathname === '/api/state') {
      moduleOrigin = url.origin;
      return route.fulfill(failReads ? { status: 503, json: { detail: 'Fixture unavailable' } } : { status: 200, json: state() });
    }
    if (module && url.pathname === '/api/pairs/supported-symbols') return route.fulfill({ status: 200, json: { symbols: [symbol] } });
    if (!['GET', 'HEAD'].includes(request.method())) {
      if (!module && (url.pathname === '/api/login' || /^\/api\/projects\/(?:aster|asset|monitor|crossex|greeks)\/(?:launch|check)$/.test(url.pathname))) return route.continue();
      if (module && request.method() === 'POST' && url.pathname === '/api/pairs/gold/pause') {
        writes.push('pause'); pair.state.margin.running = false; pair.state.adl.margin_start_allowed = true;
        return route.fulfill({ status: 200, json: { ok: true, pair } });
      }
      if (module && request.method() === 'POST' && url.pathname === '/api/pairs/gold/adl-margin-enable') {
        writes.push('adl-margin-enable');
        assert(JSON.stringify(request.postDataJSON()) === '{}', 'funds-only activation sends only an empty request body');
        assert(!pair.enabled && pair.state.adl.margin_start_allowed, 'fixture allows only paused ADL funds activation');
        if (rejectNext) {
          rejectNext = false;
          return route.fulfill({ status: 409, json: { detail: '隔离夹具：保证金启动前置检查被拒绝' } });
        }
        pair.state.margin.running = true; pair.state.adl.margin_start_allowed = false;
        return route.fulfill({ status: 200, json: { ok: true, pair } });
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
    const iframe = page.locator('iframe[title="Aster 5x模块"]');
    await password.or(iframe).first().waitFor();
    if (await password.isVisible()) {
      await password.fill('aster-notices-browser-fixture');
      await page.getByRole('button', { name: '登录', exact: true }).click();
    }
    await iframe.waitFor();
    const app = page.frameLocator('iframe[title="Aster 5x模块"]');
    await app.getByRole('tab', { name: '配对组', exact: true }).click();
    const panel = app.getByRole('region', { name: 'ADL 应急处理', exact: true });
    const running = app.getByRole('heading', { name: '策略保持暂停 · 保证金平衡运行中', exact: true });
    const strategyStart = app.getByRole('button', { name: '启动配对组', exact: true });
    const fundsStart = app.getByRole('button', { name: '启动保证金平衡', exact: true });
    const pause = app.getByRole('button', { name: '暂停配对组', exact: true });
    await running.waitFor();
    const refresh = async () => {
      const response = page.waitForResponse(response => response.url().startsWith(`${moduleOrigin}/api/state`));
      await app.getByRole('button', { name: '刷新数据', exact: true }).first().click();
      await (await response).finished();
      await page.waitForTimeout(100);
    };
    for (const [status, label] of [['active', '正在处理 ADL'], ['blocked', 'ADL 处理受阻'], ['completed', '处理完成 · 保持暂停']]) {
      pair.state.adl.incident = incident(status);
      await refresh();
      await panel.getByText(label, { exact: true }).waitFor();
      await running.waitFor();
      assert(!await pause.isDisabled(), `${status}: manually pausing funds remains available while strategy is paused`);
      assert(await fundsStart.count() === 0, `${status}: running funds do not show an activation button`);
      assert(await strategyStart.isDisabled() === (status !== 'completed'), `${status}: existing strategy startup restriction is retained`);
      await pause.click();
      await fundsStart.waitFor();
      assert(await pause.isDisabled(), `${status}: manual pause stops new transfers`);
      assert(pair.state.adl.incident.status === status, `${status}: manual pause does not cancel or change ADL processing`);
      assert(!pair.enabled, `${status}: manual pause does not restart strategy`);
      if (status === 'active') {
        // A legacy incident lacks the new runtime field but can independently restore funds.
        delete pair.state.margin.running;
        await refresh();
        await fundsStart.click();
        await app.getByText('隔离夹具：保证金启动前置检查被拒绝', { exact: true }).first().waitFor();
        assert(!await fundsStart.isDisabled(), 'explicit rejection releases busy state and permits retry');
        assert(!pair.enabled && pair.state.margin.running !== true, 'rejected activation preserves strategy and funds pause');
      }
      await fundsStart.click();
      await running.waitFor();
      assert(!pair.enabled && pair.state.margin.running, `${status}: funds activation leaves strategy paused`);
      assert(await fundsStart.count() === 0, `${status}: successful activation removes its button after refresh`);
      assert(!await pause.isDisabled(), `${status}: resumed funds can be paused again`);
      observations.push(`${status}: running funds visible, manual pause, funds-only restore, original strategy restriction`);
    }
    await panel.getByRole('button', { name: 'ADL 设置', exact: true }).click();
    assert(await app.getByRole('button', { name: '保存设置，保持暂停', exact: true }).isDisabled(), 'funds activation never unlocks ADL configuration');
    assert((await panel.innerText()).includes('策略保持暂停观察；'), 'completed hold describes paused strategy precisely');
    await pause.click();
    await fundsStart.waitFor();
    failReads = true; await refresh();
    await panel.getByText('连接中断 · 最近记录', { exact: true }).waitFor();
    assert(await fundsStart.isDisabled(), 'offline state cannot start funds from cached permission');
    failReads = false; await refresh();
    assert(!await fundsStart.isDisabled(), 'reconnected current permission restores funds activation');
    pair.state.adl.margin_start_allowed = false; await refresh();
    assert(await fundsStart.count() === 0, 'server false permission hides funds activation even during ADL hold');
    delete pair.state.adl.margin_start_allowed; await refresh();
    assert(await fundsStart.count() === 0, 'missing server permission cannot expose funds activation');
    pair.state.adl.margin_start_allowed = true; await refresh();
    await page.setViewportSize({ width: 390, height: 844 });
    await fundsStart.scrollIntoViewIfNeeded();
    const box = await fundsStart.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 391, 'funds activation fits the narrow embedded viewport');
    const frame = page.frames().find(frame => frame.url().startsWith(moduleOrigin));
    assert(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'new controls do not overflow the embedded page');
    await page.screenshot({ path: 'output/playwright/aster-adl-margin-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await fundsStart.click(); await running.waitFor();
    await app.getByRole('region', { name: '配对组运行状态', exact: true }).screenshot({ path: 'output/playwright/aster-adl-margin-running-desktop.png' });
    observations.push('legacy runtime compatibility, rejected activation retry, settings lock, offline lock, explicit server permission, narrow viewport');
    assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
    assert(external.length === 0, `external requests: ${external.join('; ')}`);
    assert(unexpectedWrites.length === 0, `unexpected writes: ${unexpectedWrites.join('; ')}`);
    return { passed: true, entry: page.url(), moduleOrigin, writes, strategyWrites: 0, browserErrors: 0, observations };
  } catch (error) {
    await page.screenshot({ path: 'output/playwright/aster-adl-margin-failure.png', fullPage: true });
    throw new Error(`${error.stack || error.message}\nBrowser errors:\n${errors.join('\n') || '(none)'}`, { cause: error });
  }
}
