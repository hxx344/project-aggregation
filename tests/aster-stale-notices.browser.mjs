// Start: node --import ./tests/fixtures/aster-notices-workbench.mjs server/workbench.mjs
// Run: playwright-cli -s=aster-notices run-code --filename tests/aster-stale-notices.browser.mjs
// Uses the actual Hub login/launch/proxy/iframe and modules/aster/dashboard/dist/client.
// All state reads are synthetic. Real elapsed time is used; no browser clock is mocked.
async (page) => {
  const origin = 'http://hub.localhost:39152';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const modes = { alpha: { stale: new Set() }, beta: { stale: new Set() } };
  const errors = [], writes = [], external = [], requests = [], observations = [];
  const names = { alpha: '持续窗口 A', beta: '隔离观察 B' };
  const apiText = '浏览器夹具：API 预算暂不可用';
  const executionText = '浏览器夹具：原订单结果待核验';
  let moduleOrigin;
  await page.unrouteAll({ behavior: 'wait' });
  page.on('pageerror', error => errors.push(error.message));
  const snapshot = (stamp) => ({ timestamp: stamp, equity: '1000', available: '800', wallet: '1000',
    maintenance: '1', occupied_margin: '200', unrealized: '0', ratio: '0.2', margin_ratio: '0.001',
    positions: [], mode_checks: { cross: true, hedge: true, single_asset: true } });
  const pair = (id, now) => {
    const mode = modes[id], stamp = source => mode.stale.has(source) ? mode.stamp : now;
    return { id, name: names[id], long_account_id: `${id}-long`, short_account_id: `${id}-short`,
      symbol: 'XAUUSD1', enabled: true,
      ordinary: { enabled: !mode.funds, threshold: '50000', order_notional: '100', min_open_leverage: 5, margin_limit: '0.5', spread_limit: '0.1' },
      margin: { enabled: Boolean(mode.funds), master_env_prefix: '', check_interval_seconds: 5, threshold: '10', min_transfer: '1',
        max_transfer: '1000', buffer_ratio: '0.05', cooldown_seconds: 30 },
      state: { phase: mode.execution ? 'reconciling' : 'monitoring', reason: mode.execution ? executionText : '',
        updated_at: stamp('runtime'), snapshots: mode.funds ? {} : { long: snapshot(stamp('long')), short: snapshot(stamp('short')) },
        margin_balances: mode.funds ? { long: snapshot(stamp('long')), short: snapshot(stamp('short')) } : undefined,
        api_notice: mode.api ? { kind: 'budget', text: apiText } : null,
        pending: mode.execution ? { kind: 'ordinary', id: 'fixture-original-order' } : null,
        owned: { LONG: '0', SHORT: '0' } } };
  };
  const state = () => {
    const now = Date.now() / 1000;
    return { workspaceManaged: true, ready: true, demo: true, accounts: [], pairs: [pair('alpha', now), pair('beta', now)],
      markets: {}, events: [], updated_at: now, notification: { configured: false, pending: 0 } };
  };
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.port !== '39152' || !(url.hostname === 'hub.localhost' || /^p-[a-f0-9]+\.hub\.localhost$/.test(url.hostname))) {
      external.push(url.href); return route.abort('blockedbyclient');
    }
    requests.push({ method: req.method(), url: url.href });
    if (!['GET', 'HEAD'].includes(req.method())) {
      if (url.origin === origin && (url.pathname === '/api/login' || /^\/api\/projects\/(?:aster|asset|monitor|crossex|greeks)\/launch$/.test(url.pathname))) return route.continue();
      writes.push(`${req.method()} ${url.href}`); return route.fulfill({ status: 405, json: { error: 'Trading writes forbidden' } });
    }
    if (url.origin !== origin && url.pathname === '/api/state') {
      moduleOrigin = url.origin;
      return route.fulfill({ status: 200, json: state() });
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  try {
    await page.goto(`${origin}/?view=project&id=aster`);
    const password = page.getByRole('textbox', { name: '工作台密码', exact: true });
    if (await password.isVisible()) {
      await password.fill('aster-notices-browser-fixture');
      await page.getByRole('button', { name: '登录', exact: true }).click();
    }
    const iframe = page.locator('iframe[title="Aster 5x模块"]');
    await iframe.waitFor();
    const app = page.frameLocator('iframe[title="Aster 5x模块"]');
    await app.getByRole('heading', { name: '两子账户配对 · XAUUSD1', exact: true }).waitFor();
    const frame = page.frames().find(frame => frame.url().startsWith(moduleOrigin));
    assert(frame, 'actual ASTER module frame loaded');
    const notices = app.getByRole('region', { name: '配对组最近提示', exact: true });
    const noticeItems = notices.locator('.pair-notice-item');
    const currentData = notices.locator('.pair-notice-item').filter({ hasText: '两侧数据未齐' })
      .filter({ hasText: '当前提示' });
    const longSide = app.getByRole('region', { name: 'A 多仓账户风险', exact: true });
    const shortSide = app.getByRole('region', { name: 'B 空仓账户风险', exact: true });
    const runtime = app.getByRole('region', { name: '配对数量与执行进度', exact: true }).locator('.small-note').first();
    const refresh = async () => {
      const response = page.waitForResponse(response => response.url().startsWith(`${moduleOrigin}/api/state`));
      await app.getByRole('button', { name: '刷新数据', exact: true }).click();
      await (await response).finished();
      await page.waitForTimeout(80);
    };
    const set = async (id, stale = [], extra = {}) => {
      modes[id] = { stale: new Set(stale), stamp: Date.now() / 1000 - 9, ...extra };
      const started = Date.now(); await refresh(); return started;
    };
    const select = async id => {
      await app.getByRole('combobox', { name: '选择配对组', exact: true }).click();
      await app.getByRole('option', { name: `${names[id]} · XAUUSD1 · 执行已启用`, exact: true }).click();
      await page.waitForTimeout(60);
    };
    const hasExpiry = async locator => /过期/.test(await locator.innerText());
    const noCurrent = async message => assert(await currentData.count() === 0, message);
    assert(await noticeItems.count() === 0, 'fresh groups start with no current or past notices');
    assert(requests.some(req => req.method === 'POST' && req.url === `${origin}/api/projects/aster/launch`), 'real Hub launch was exercised');

    // A short stale response is recovered before the three-second display threshold.
    await set('alpha', ['runtime', 'long', 'short']);
    await page.waitForTimeout(1200);
    await noCurrent('a brief stale response must not display a current notice');
    assert(await noticeItems.count() === 0, 'brief expiry must not enter history');
    assert(!await hasExpiry(longSide) && !await hasExpiry(shortSide) && !await hasExpiry(runtime), 'all expiry labels share the grace period');
    await set('alpha');
    assert(await noticeItems.count() === 0, 'short recovery leaves no history');
    observations.push('transient expiry recovers without notices or history');

    const started = await set('alpha', ['runtime', 'long', 'short']);
    await page.waitForTimeout(2100);
    await noCurrent('no warning may appear before three continuous seconds');
    await currentData.waitFor({ timeout: 5000 });
    const elapsed = Date.now() - started;
    assert(elapsed >= 2900 && elapsed < 5500, `continuous expiry appears near three seconds (${elapsed} ms)`);
    assert(await hasExpiry(longSide) && await hasExpiry(shortSide) && await hasExpiry(runtime), 'confirmed expiry labels are visible');
    await page.screenshot({ path: 'output/playwright/aster-stale-confirmed.png', fullPage: true });
    observations.push(`continuous expiry confirmed after ${elapsed} ms`);

    await set('alpha');
    await notices.getByText('历史提示 · 数据已恢复', { exact: true }).waitFor();
    await set('alpha', ['runtime', 'long', 'short']);
    await page.waitForTimeout(1200);
    await noCurrent('a second short lapse cannot revive the confirmed warning immediately');
    assert(!(await notices.innerText()).includes('共出现 2 次'), 'a short lapse does not increase occurrences');
    await set('alpha');
    assert(!(await notices.innerText()).includes('共出现 2 次'), 'recovery after a short lapse preserves the original count');
    observations.push('recovery resets the timer and short recurrence preserves occurrence count');

    await select('beta');
    assert(await noticeItems.count() === 0, 'group B does not inherit group A history');
    await set('alpha', ['long']);
    await page.waitForTimeout(3250);
    assert(await noticeItems.count() === 0, 'unselected group expiry does not leak to selected group');
    await select('alpha');
    await currentData.waitFor();
    assert(await hasExpiry(longSide) && !await hasExpiry(shortSide) && await hasExpiry(runtime), 'A-side expiry marks group incompleteness without expiring B-side data');
    assert((await notices.innerText()).includes('共出现 2 次'), 'unselected group still records a confirmed recurrence');
    await set('alpha', ['long', 'short']);
    await page.waitForTimeout(1200);
    assert(await hasExpiry(longSide) && !await hasExpiry(shortSide), 'a confirmed A-side lapse does not bypass B-side delay');
    await set('alpha', ['long']);
    observations.push('group switching retains independent timers, histories and source-specific labels');

    const errorStarted = await set('alpha', [], { api: true, execution: true });
    await notices.getByText(apiText, { exact: false }).waitFor();
    await notices.getByText(executionText, { exact: false }).waitFor();
    assert(Date.now() - errorStarted < 2000, 'API and execution errors remain immediate');
    await notices.getByRole('button', { name: '清除历史提示', exact: true }).click();
    assert(await noticeItems.filter({ hasText: '两侧数据未齐' }).count() === 0, 'clearing history removes recovered data warning');
    assert((await notices.innerText()).includes(apiText) && (await notices.innerText()).includes(executionText), 'clearing history retains active errors');
    observations.push('API/execution errors remain immediate; clear removes only historical notices');

    await set('alpha');
    await notices.getByRole('button', { name: '清除历史提示', exact: true }).click();
    assert(await noticeItems.count() === 0, 'resolved errors can be cleared');
    await set('alpha', [], { funds: true });
    const longBalance = app.getByRole('region', { name: 'A 账户保证金', exact: true });
    const shortBalance = app.getByRole('region', { name: 'B 账户保证金', exact: true });
    await longBalance.getByText('余额已更新', { exact: false }).waitFor();
    await set('alpha', ['long'], { funds: true });
    await page.waitForTimeout(1200);
    await noCurrent('funds-only brief expiry does not enter current notices');
    assert(!(await longBalance.innerText()).includes('等待余额检查'), 'funds-only pending warning uses neutral wording');
    await set('alpha', [], { funds: true });
    assert(await noticeItems.count() === 0, 'funds-only short recovery leaves no history');
    await set('alpha', ['long'], { funds: true });
    await longBalance.getByText('等待余额检查', { exact: false }).waitFor({ timeout: 5000 });
    assert((await shortBalance.innerText()).includes('余额已更新'), 'funds-only stale balance does not affect the other side');
    await set('alpha', [], { funds: true });
    await notices.getByRole('button', { name: '清除历史提示', exact: true }).click();
    await set('alpha');
    observations.push('funds-only balances retain independent delay and recover without position snapshots');

    await page.screenshot({ path: 'output/playwright/aster-stale-recovered.png', fullPage: true });
    assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
    assert(writes.length === 0, `unexpected writes: ${writes.join('; ')}`);
    assert(external.length === 0, `external requests: ${external.join('; ')}`);
    return { passed: true, entry: page.url(), moduleOrigin, realClock: true, tradingWrites: 0, browserErrors: 0, observations };
  } catch (error) {
    await page.screenshot({ path: 'output/playwright/aster-stale-failure.png', fullPage: true });
    throw error;
  }
}
