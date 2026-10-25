// Start: node --import ./tests/fixtures/aster-notices-workbench.mjs server/workbench.mjs
// Run: playwright-cli -s=aster-margin-only run-code --filename tests/aster-margin-only.browser.mjs
// Real Hub login, launch, proxy and built ASTER UI; every trading API is isolated.
async (page) => {
  const origin = 'http://hub.localhost:39152';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], external = [], writes = [], unexpectedWrites = [], observations = [];
  const symbol = { symbol: 'XAUUSD1', display_name: '黄金 XAUUSD1', min_notional: '500',
    default_order_notional: '1000', default_threshold: '10000', default_spread_limit: '0.0005' };
  const pair = { id: 'gold', name: '仅保证金切换隔离配对', long_account_id: 'a', short_account_id: 'b', symbol: 'XAUUSD1',
    enabled: false, revision: 1,
    ordinary: { enabled: true, threshold: '10000', order_notional: '1000', min_open_leverage: 5, margin_limit: '0.5', spread_limit: '0.0005' },
    margin: { enabled: false, master_env_prefix: '', check_interval_seconds: 5, threshold: '10', min_transfer: '1', max_transfer: '1000', buffer_ratio: '0.05', cooldown_seconds: 30 },
    state: { phase: 'paused', reason: '隔离配对已暂停', snapshots: {}, pending: null,
      adl: { monitoring: { status: 'monitoring', reason: '两侧 ADL 补查已完成', checked_at: Date.now() / 1000 },
        incident: null, report_available: false, pending_event: false, configuration_locked: false, lock_reason: '' } } };
  const accounts = ['a', 'b'].map(id => ({ id, name: `隔离账户 ${id.toUpperCase()}`, pair_id: 'gold', mode: 'paper',
    env_prefix: `FIXTURE_${id.toUpperCase()}`, enabled: false, status: 'paused', reason: '', credential_ready: false, strategies: {},
    policy: { threshold: '50000', order_notional: '1000', margin_limit: '0.5', spread_limit: '0.0005', min_open_leverage: 5,
      ordinary_symbol: 'all', symbols: ['XAUUSD1'] } }));
  let moduleOrigin, failReads = false, ready = true, rejectNext = false, replyGate, releaseReply;
  const state = () => ({ workspaceManaged: true, ready, demo: false, accounts, pairs: [pair], markets: {}, events: [],
    updated_at: Date.now() / 1000, monitoring: { settings: { feishu_enabled: false }, symbols: [] },
    notification: { enabled: false, configured: false, pending: 0 } });
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
      if (module && request.method() === 'POST' && url.pathname === '/api/pairs/gold/margin-only') {
        const body = request.postDataJSON(); writes.push(body);
        assert(JSON.stringify(body) === '{}', 'dedicated switch must not submit the configuration draft');
        if (replyGate) await replyGate;
        if (rejectNext) { rejectNext = false; return route.fulfill({ status: 409, json: { detail: '隔离夹具：当前不能切换保证金管理' } }); }
        pair.ordinary.enabled = false; pair.margin.enabled = true;
        pair.revision += 1; pair.state.adl.margin_only_switch_allowed = false;
        return route.fulfill({ status: 200, json: { ok: true, pair } });
      }
      unexpectedWrites.push(`${request.method()} ${url.href}`);
      return route.fulfill({ status: 405, json: { detail: 'Other trading writes forbidden' } });
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
    const settings = app.locator('.pair-config');
    await settings.locator('summary').click();
    const button = settings.getByRole('button', { name: '切换为仅保证金管理', exact: true });
    const save = settings.getByRole('button', { name: '保存设置，保持暂停', exact: true });
    const name = settings.getByRole('textbox', { name: '配对组名称', exact: true });
    await button.waitFor();
    assert(await button.isDisabled(), 'old servers without a capability flag cannot switch');
    await name.fill('未保存的草稿不能发送');
    const refresh = async () => {
      const response = page.waitForResponse(response => response.url().startsWith(`${moduleOrigin}/api/state`));
      await app.getByRole('button', { name: '刷新数据', exact: true }).first().click();
      await (await response).finished();
      await page.waitForTimeout(100);
    };
    ready = false; await refresh();
    assert(await app.getByRole('button', { name: '启动配对组', exact: true }).isDisabled(), 'ordinary trading activation still waits for market readiness');
    ready = true; await refresh();
    pair.state.pending = { id: 'original-order', kind: 'ordinary', phase: 'open', orders: [], created_at: Date.now() / 1000 - 300 };
    pair.state.recovery_watch = { batches: [{ id: 'history-observation' }] };
    Object.assign(pair.state.adl, { configuration_locked: true, lock_reason: '订单或划转结果待核对，暂不能修改设置。', margin_only_switch_allowed: false });
    await refresh();
    assert(await button.isDisabled(), 'explicitly unavailable switch stays disabled');
    assert(await save.isDisabled() && await name.isDisabled(), 'pending orders continue to lock full configuration');
    pair.state.adl.margin_only_switch_allowed = true;
    await refresh();
    assert(!(await button.isDisabled()), 'server permits narrow switch while the ordinary configuration remains locked');
    assert(await save.isDisabled(), 'narrow capability must not unlock ordinary settings');
    assert((await settings.innerText()).includes('未保存的设置草稿会撤销'), 'draft cancellation is explained before switching');
    ready = false; await refresh();
    assert(await button.isDisabled(), 'unready service disables switch despite capability');
    ready = true; await refresh();
    failReads = true; await refresh();
    assert(await button.isDisabled(), 'offline stale capability cannot authorize switch');
    failReads = false; await refresh();
    assert(!(await button.isDisabled()), 'fresh server evidence restores the switch');
    observations.push('legacy capability fallback, full configuration lock, ready and offline guards');
    await settings.locator('.settings-lock').filter({ hasText: '切换为仅保证金管理' }).screenshot({ path: 'output/playwright/aster-margin-only-locked-settings.png' });

    rejectNext = true;
    replyGate = new Promise(resolve => { releaseReply = resolve; });
    const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/pairs/gold/margin-only');
    await button.click(); await request;
    assert(await button.isDisabled(), 'busy action prevents a duplicate switch');
    releaseReply(); replyGate = undefined;
    await app.getByRole('alert').filter({ hasText: '当前不能切换保证金管理' }).first().waitFor();
    assert(await name.inputValue() === '未保存的草稿不能发送', 'rejected switch preserves the draft');
    assert(pair.ordinary.enabled && !pair.margin.enabled && !pair.enabled, 'rejection preserves saved mode and pause');
    const originalRecords = JSON.stringify({ pending: pair.state.pending, history: pair.state.recovery_watch });
    await button.click();
    await app.getByText('已切换为仅保证金管理并保持暂停；点击“启动配对组”后才会按条件平衡保证金。原订单继续核对。', { exact: true }).waitFor();
    assert(await name.inputValue() === pair.name, 'successful switch clears the unsaved draft');
    assert(!pair.enabled && !pair.ordinary.enabled && pair.margin.enabled, 'switch changes only strategy mode and keeps paused');
    assert(await save.isDisabled(), 'pending evidence still locks the complete settings after switching');
    assert(!(await app.getByRole('button', { name: '启动配对组', exact: true }).isDisabled()), 'manual margin-only start is available after clearing the draft');
    ready = false; await refresh();
    assert(!(await app.getByRole('button', { name: '启动配对组', exact: true }).isDisabled()), 'funds-only activation does not require public market readiness');
    failReads = true; await refresh();
    assert(await app.getByRole('button', { name: '启动配对组', exact: true }).isDisabled(), 'funds-only activation still requires a connected service');
    failReads = false; await refresh();
    assert(!(await app.getByRole('button', { name: '启动配对组', exact: true }).isDisabled()), 'fresh service evidence restores funds-only activation while public markets remain unready');
    assert(JSON.stringify({ pending: pair.state.pending, history: pair.state.recovery_watch }) === originalRecords, 'original recovery evidence remains visible');
    assert(await button.count() === 0, 'already margin-only mode has no redundant switch');
    assert(writes.length === 2, 'only explicit rejected and successful switch requests were sent');
    assert(unexpectedWrites.length === 0, `no auto-start, order, transfer or full configuration writes: ${unexpectedWrites.join('; ')}`);
    assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
    assert(external.length === 0, `external requests: ${external.join('; ')}`);
    observations.push('busy duplicate guard, rejected draft preservation, successful draft reset, pause retained, no auto-start, original recovery records retained, funds-only start independent of public market readiness with offline guard retained');
    return { passed: true, entry: page.url(), moduleOrigin, switchRequests: writes.length, unexpectedWrites: 0, browserErrors: 0, observations };
  } catch (error) {
    releaseReply?.();
    await page.screenshot({ path: 'output/playwright/aster-margin-only-failure.png', fullPage: true });
    throw new Error(`${error.stack || error.message}\nBrowser errors:\n${errors.join('\n') || '(none)'}`, { cause: error });
  }
}
