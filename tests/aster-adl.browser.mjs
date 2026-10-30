// Start: node --import ./tests/fixtures/aster-notices-workbench.mjs server/workbench.mjs
// Run: playwright-cli -s=aster-adl run-code --filename tests/aster-adl.browser.mjs
// Incremental compatibility only: first goto http://hub.localhost:39152/?adl-compat=1
// Real Hub login, launch, proxy, iframe and built ASTER UI; isolated API evidence.
async (page) => {
  const origin = 'http://hub.localhost:39152';
  const compatibilityOnly = new URL(page.url()).searchParams.get('adl-compat') === '1';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], consoleErrors = [], external = [], unexpectedWrites = [], writes = [], observations = [];
  const symbol = { symbol: 'XAUUSD1', display_name: '黄金 XAUUSD1', min_notional: '500',
    default_order_notional: '1000', default_threshold: '10000', default_spread_limit: '0.0005' };
  const pair = { id: 'gold', name: 'ADL 浏览器隔离配对', long_account_id: 'a', short_account_id: 'b', symbol: 'XAUUSD1',
    enabled: false, revision: 1,
    ordinary: { enabled: false, threshold: '10000', order_notional: '1000', min_open_leverage: 5, margin_limit: '0.5', spread_limit: '0.0005' },
    margin: { enabled: false, master_env_prefix: '', check_interval_seconds: 5, threshold: '10', min_transfer: '1', max_transfer: '1000', buffer_ratio: '0.05', cooldown_seconds: 30 },
    state: { phase: 'paused', reason: '浏览器隔离测试，策略已暂停', snapshots: {}, pending: null,
      adl: { monitoring: { status: 'waiting', reason: '等待两侧账户首次完成 ADL 历史补查', checked_at: null },
        incident: null, report_available: false, pending_event: false, configuration_locked: false, lock_reason: '' } } };
  const accounts = ['a', 'b'].map(id => ({ id, name: `隔离账户 ${id.toUpperCase()}`, pair_id: 'gold', mode: 'paper',
    env_prefix: `FIXTURE_${id.toUpperCase()}`, enabled: false, status: 'paused', reason: '', credential_ready: false, strategies: {},
    policy: { threshold: '50000', order_notional: '1000', margin_limit: '0.5', spread_limit: '0.0005', min_open_leverage: 5,
      ordinary_symbol: 'all', symbols: ['XAUUSD1'] } }));
  let moduleOrigin, failReads = false, rejectNext = false, failReport = false, reportReads = 0, feishuEnabled = true;
  const state = () => ({ workspaceManaged: true, ready: true, demo: false, accounts, pairs: [pair], markets: {}, events: [],
    updated_at: Date.now() / 1000, monitoring: { settings: { feishu_enabled: feishuEnabled }, symbols: [] },
    notification: { enabled: feishuEnabled, configured: true, pending: 0, routing_mode: 'split',
      channels: { event: { configured: true, source: 'dedicated', pending: 0 }, scheduled: { configured: false, pending: 0 } } } });
  await page.unrouteAll({ behavior: 'wait' });
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
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
    if (module && url.pathname === '/api/pairs/gold/adl-report' && request.method() === 'GET') {
      reportReads += 1;
      if (failReport) return route.fulfill({ status: 503, json: { detail: 'Fixture unavailable' } });
      return route.fulfill({ status: 200, json: { pair_id: 'gold', incident_id: pair.state.adl.incident.id,
        status: pair.state.adl.incident.status, generated_at: Date.now() / 1000,
        messages: ['ASTER ADL 隔离处理报告\n原单成交结果仍未知；最终残差待核实。\n账户 A LONG 2；账户 B SHORT 1。',
          '自动分批减仓记录：第 1 批；累计成交：未知。\n策略状态：保持暂停。'] } });
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      if (!module && (url.pathname === '/api/login' || /^\/api\/projects\/(?:aster|asset|monitor|crossex|greeks)\/(?:launch|check)$/.test(url.pathname))) return route.continue();
      if (module && request.method() === 'PATCH' && url.pathname === '/api/pairs/gold') {
        const body = request.postDataJSON(); writes.push(body);
        if (rejectNext) { rejectNext = false; return route.fulfill({ status: 409, json: { detail: '浏览器夹具：ADL 设置保存被拒绝' } }); }
        assert(!('enabled' in body), 'configuration patch must not enable trading');
        Object.assign(pair, body); pair.revision += 1;
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
    await panel.getByRole('heading', { name: 'ADL 应急处理', exact: true }).waitFor();
    await panel.screenshot({ path: 'output/playwright/aster-adl-panel-desktop.png' });
    assert((await panel.innerText()).includes('等待首次检查'), 'unseen scans must not appear healthy');
    assert(reportReads === 0, 'no eager report requests on the pair page');
    const refresh = async () => {
      const response = page.waitForResponse(response => response.url().startsWith(`${moduleOrigin}/api/state`));
      await app.getByRole('button', { name: '刷新数据', exact: true }).first().click();
      await (await response).finished();
      await page.waitForTimeout(100);
    };
    const compatibilityChecks = async () => {
      const modern = structuredClone(pair.state.adl);
      pair.state.adl = { id: 'legacy-six-field-state', status: 'active', symbols: ['BTCUSDT'],
        created_at: Date.now() / 1000 - 10, completed_at: null, reason: '旧服务摘要，没有 monitoring 字段' };
      await refresh();
      await panel.getByText('等待 ADL 状态', { exact: true }).waitFor();
      assert(await panel.getByRole('button', { name: 'ADL 设置', exact: true }).isVisible(), 'legacy state does not crash the permanent panel');
      pair.state.adl = { ...modern, incident: null, report_available: false, pending_event: true,
        configuration_locked: true, lock_reason: '已收到 ADL 成交事件，等待确认现场' };
      await refresh();
      await panel.getByText('已收到 ADL · 等待核实', { exact: true }).waitFor();
      assert(await app.getByRole('button', { name: '启动配对组', exact: true }).isDisabled(), 'unhandled ADL event blocks startup');
      await panel.getByRole('button', { name: 'ADL 设置', exact: true }).click();
      assert(await app.locator('.pair-settings-form').getByRole('button', { name: '保存设置，保持暂停', exact: true }).isDisabled(), 'unhandled ADL event locks configuration');
      pair.state.adl = { ...modern, pending_event: false, report_available: true, configuration_locked: true,
        lock_reason: 'ADL 完成后保持暂停观察', incident: { id: 'incremental-completed', status: 'completed', hold: true,
          halted: false, reason: '本次核对完成，保持暂停', symbols: ['BTCUSDT'], created_at: Date.now() / 1000 - 10,
          completed_at: Date.now() / 1000, batch_count: 1, config: { enabled: true, batch_notional: '1000' } } };
      await refresh();
      await panel.getByText('处理完成 · 保持暂停', { exact: true }).waitFor();
      assert((await panel.innerText()).includes('策略保持暂停观察；请先核对报告，再决定是否手动启动。'), 'completion does not instruct a compulsory restart');
      assert(!(await app.getByRole('button', { name: '启动配对组', exact: true }).isDisabled()), 'completed hold permits a deliberate manual start');
      observations.push('legacy six-field state fallback, pending ADL event label/start/config locks, completed-hold copy');
    };
    if (compatibilityOnly) {
      await compatibilityChecks();
      assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
      assert(external.length === 0 && unexpectedWrites.length === 0, 'compatibility checks make no external or trading requests');
      assert(writes.length === 0 && reportReads === 0, 'compatibility checks only read state');
      return { passed: true, incremental: true, entry: page.url(), moduleOrigin, tradingWrites: 0, browserErrors: 0, observations };
    }
    await panel.getByRole('button', { name: 'ADL 设置', exact: true }).click();
    const form = app.locator('.pair-settings-form');
    const toggle = form.getByRole('switch', { name: 'ADL 后自动减仓', exact: true });
    const amount = form.getByRole('textbox', { name: /^ADL 单批名义金额上限/ });
    const save = form.getByRole('button', { name: '保存设置，保持暂停', exact: true });
    assert(await toggle.getAttribute('aria-checked') === 'true', 'legacy default auto reduction is on');
    assert(await amount.inputValue() === '1000', 'legacy default batch notional is 1000');
    await form.locator('.pair-adl-settings').screenshot({ path: 'output/playwright/aster-adl-settings-desktop.png' });
    assert((await panel.innerText()).includes('1000 · 各合约计价币种'), 'amount unit is contract quote currency');
    await toggle.click(); await amount.fill('250.500000000000000001');
    rejectNext = true;
    await save.click();
    await app.getByRole('alert').filter({ hasText: 'ADL 设置保存被拒绝' }).first().waitFor();
    assert(await toggle.getAttribute('aria-checked') === 'false', '409 preserves disabled draft');
    assert(await amount.inputValue() === '250.500000000000000001', '409 preserves exact amount text');
    assert(!pair.adl, 'rejected save does not change the stored fixture');
    await save.click();
    await app.getByText('配对组设置已保存并保持暂停。', { exact: true }).waitFor();
    await refresh();
    assert(pair.adl.enabled === false && pair.adl.batch_notional === '250.500000000000000001', 'saved configuration is read back');
    assert((await panel.innerText()).includes('自动减仓关闭'), 'persistent panel reflects disabled mode');
    assert((await panel.innerText()).includes('不下单或撤单'), 'disabled mode remains explicit');
    const savedWrites = writes.length;
    for (const invalid of ['0', '1000001', '1e3', '１２']) {
      await amount.fill(invalid); await save.click();
      await app.locator('.pair-config').getByRole('alert').waitFor();
      assert(writes.length === savedWrites, `invalid amount ${invalid} cannot reach the API`);
    }
    await form.getByRole('button', { name: '撤销修改', exact: true }).click();
    assert(await amount.inputValue() === pair.adl.batch_notional, 'revert restores saved exact amount');
    observations.push('legacy defaults, disabled amount save/readback, rejected-save draft, invalid values blocked locally');

    const now = Date.now() / 1000;
    pair.state.adl.monitoring = { status: 'monitoring', reason: '两侧 ADL 历史补查已完成', checked_at: now };
    for (const [status, label] of [['active', '正在处理 ADL'], ['blocked', 'ADL 处理受阻'], ['completed', '处理完成 · 保持暂停']]) {
      pair.state.adl.incident = { id: `incident-${status}`, status, hold: true, halted: status === 'blocked',
        reason: '隔离事件，等待核实现场', symbols: ['BTCUSDT'], created_at: now - 15, completed_at: status === 'completed' ? now : null,
        batch_count: 1, config: { enabled: true, batch_notional: '1000' } };
      Object.assign(pair.state.adl, { report_available: true, configuration_locked: true, lock_reason: 'ADL 处理中或完成后保持暂停观察，暂不能修改设置' });
      await refresh();
      await panel.getByText(label, { exact: true }).waitFor();
      assert(await toggle.isDisabled() && await amount.isDisabled() && await save.isDisabled(), `${status} locks setting edits`);
      assert((await panel.innerText()).includes('本次事件固定配置') && (await panel.innerText()).includes('1000 · 各合约计价币种'), 'event displays frozen configuration');
      assert(await app.getByRole('button', { name: '启动配对组', exact: true }).isDisabled() === (status !== 'completed'), 'only completed incident permits manual start');
    }
    assert(reportReads === 0, 'status refreshes do not fetch reports');
    failReport = true;
    await panel.getByRole('button', { name: '查看处理报告', exact: true }).click();
    const dialog = app.getByRole('dialog', { name: 'ADL 处理报告', exact: true });
    await dialog.getByRole('alert').waitFor();
    assert(reportReads === 1, 'report is requested on demand');
    failReport = false;
    await dialog.getByRole('button', { name: '重新读取报告', exact: true }).click();
    await dialog.locator('pre').first().waitFor();
    assert(reportReads === 2 && await dialog.locator('pre').count() === 2, 'retry loads every report part');
    assert((await dialog.innerText()).includes('累计成交：未知'), 'unknown orders remain unknown in report');
    await page.screenshot({ path: 'output/playwright/aster-adl-report-desktop.png', fullPage: true });
    await dialog.getByRole('button', { name: '重新读取报告', exact: true }).press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    observations.push('active, blocked and completed hold states lock settings; event config frozen; report on-demand error and retry');

    feishuEnabled = false; await refresh();
    await panel.getByText('飞书通知总开关已关闭', { exact: true }).waitFor();
    pair.state.adl.incident = null;
    Object.assign(pair.state.adl, { report_available: false, configuration_locked: false, lock_reason: '' });
    await refresh();
    failReads = true; await refresh();
    await panel.getByText('连接中断 · 最近记录', { exact: true }).waitFor();
    assert(await toggle.isDisabled() && await amount.isDisabled() && await save.isDisabled(), 'offline state disables configuration');
    assert((await panel.innerText()).includes('（最近记录）'), 'cached monitoring is marked as previous evidence');
    failReads = false; await refresh();
    await panel.getByText('定期补查正常', { exact: true }).waitFor();
    assert(!(await save.isDisabled()), 'reconnect restores allowed settings');
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole('button', { name: 'ADL 设置', exact: true }).click();
    await amount.focus();
    const box = await amount.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 391, 'ADL input stays inside the mobile viewport');
    const frame = page.frames().find(frame => frame.url().startsWith(moduleOrigin));
    assert(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'module has no horizontal page overflow');
    await page.screenshot({ path: 'output/playwright/aster-adl-settings-mobile.png', fullPage: true });
    observations.push('Feishu global-off notice, offline stale label/write lock, reconnect and mobile input fit');
    await compatibilityChecks();
    assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
    assert(external.length === 0, `external requests: ${external.join('; ')}`);
    assert(unexpectedWrites.length === 0, `unexpected writes: ${unexpectedWrites.join('; ')}`);
    return { passed: true, entry: page.url(), moduleOrigin, configurationWrites: writes.length, reportReads,
      tradingWrites: 0, browserErrors: 0, observations };
  } catch (error) {
    await page.screenshot({ path: 'output/playwright/aster-adl-failure.png', fullPage: true });
    throw new Error(`${error.stack || error.message}\nBrowser errors:\n${errors.join('\n') || '(none)'}\nConsole errors:\n${consoleErrors.join('\n') || '(none)'}`, { cause: error });
  }
}
