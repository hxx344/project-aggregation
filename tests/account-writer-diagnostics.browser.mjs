// Run with playwright-cli run-code --filename against production preview :4175.
async (page) => {
  const origin = 'http://127.0.0.1:4175';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], writes = [];
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.on('pageerror', error => errors.push(error.message));
  let reads = 0, mode = 'available', hold = null;
  const releaseHeld = async () => {
    for (let tries = 0; !hold && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(hold, 'expected a held diagnostic request');
    await hold(); hold = null;
  };
  const observed = {
    schemaVersion: 1, generatedAt: Date.now(), registry: 'available', completeness: 'complete', scope: 'observed-registry', rowLimit: 200, totalRows: 1, truncated: false,
    recovery: { state: 'quarantine', since: null },
    modules: [
      { moduleId: 'hub', ownerEvidence: 'observed', reachability: 'unknown', activeOwners: 1, closedOwners: 0, lastSeenAt: Date.now(), unverifiedBindings: 0 },
      { moduleId: 'aster', ownerEvidence: 'unknown', reachability: 'unknown', activeOwners: 0, closedOwners: 0, lastSeenAt: null, unverifiedBindings: 0 },
    ],
    rows: [{ accountRef: 'account-0123456789abcdef0123', moduleRef: 'module-0123456789abcdef0123', moduleId: 'hub', authority: 'binance', environment: 'mainnet',
      lease: { state: 'expired', until: Date.now() - 1000, moduleId: 'hub' }, owner: { ref: 'owner-0123456789abcdef0123', state: 'active', lastSeenAt: Date.now() - 61_000 },
      pending: { sending: 1, unknown: 2, oldestAt: Date.now() - 90_000, latestAt: Date.now() - 10_000 }, isolation: { reason: 'legacy-conflict', since: Date.now() - 5000 },
      unverifiedModules: ['aster'], reasons: ['recovery-quarantine', 'lease-expired', 'sending', 'unknown-result', 'account-isolated', 'unverified-binding'] }],
  };
  await page.clock.install();
  await page.addInitScript(() => { window.EventSource = class { close() {} }; });
  await page.route(`${origin}/api/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (!['GET', 'HEAD'].includes(route.request().method())) writes.push(path);
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'fixture' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [] });
    if (path === '/api/system/updates') return send({ enabled: false, checking: false, modules: [] });
    if (path === '/api/system/accounts') {
      reads++;
      if (mode === 'hold') { hold = () => send({ diagnostics: observed }); return; }
      if (mode === 'failure') return send({ error: 'fixture failure' }, 503);
      if (mode === 'expired') return send({ error: 'fixture expired' }, 401);
      if (mode === 'legacy') return send({ accounts: [] });
      if (mode === 'disabled') return send({ diagnostics: { ...observed, registry: 'disabled', completeness: 'unknown', totalRows: null, recovery: { state: 'unknown', since: null }, rows: [], modules: [] } });
      if (mode === 'truncated') return send({ diagnostics: { ...observed, rowLimit: 1, totalRows: 2, truncated: true, completeness: 'truncated' } });
      return send({ diagnostics: observed });
    }
    return send({ error: 'Outside this fixture scope' }, 503);
  });
  await page.goto(origin);
  await page.getByRole('button', { name: '请求诊断', exact: true }).waitFor();
  await page.clock.runFor(31_000);
  assert(reads === 0, 'hidden persistent diagnostic section must not read');
  await page.getByRole('button', { name: '请求诊断', exact: true }).click();
  const panel = page.locator('.account-writer-diagnostics');
  await panel.locator('[data-writer-status="available"]').waitFor();
  assert(await panel.getByText('Owner 记录', { exact: true }).count() === 1, 'owner evidence displayed');
  assert(await panel.getByText('未知：未读到 Owner 记录', { exact: true }).count() === 1, 'unobserved modules stay unknown');
  assert((await panel.innerText()).includes('发送中 1 · 结果未知 2'), 'pending states remain separate');
  assert((await panel.innerText()).includes('同交易所环境未验证绑定：ASTER'), 'unverified binding is associated with the affected account and module');
  assert((await panel.innerText()).includes('开始时间未记录'), 'unrecorded recovery times stay unknown');
  assert(await panel.getByRole('button').count() === 1, 'read-only panel only permits refresh');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const beforeBackground = reads;
  await page.clock.runFor(31_000);
  assert(reads === beforeBackground, 'background tab stops polling');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await panel.locator('[data-writer-status="available"]').waitFor();
  await page.getByRole('button', { name: '总览', exact: true }).click();
  const beforeHidden = reads;
  await page.clock.runFor(31_000);
  assert(reads === beforeHidden, 'inactive page stops polling');
  mode = 'hold';
  await page.getByRole('button', { name: '请求诊断', exact: true }).click();
  await panel.locator('[data-writer-status="loading"]').waitFor();
  assert((await panel.innerText()).includes('上次证据（当前状态未知）'), 'page resume cannot restore previous ready evidence');
  await releaseHeld();
  await panel.locator('[data-writer-status="available"]').waitFor();
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); dispatchEvent(new Event('offline')); });
  await panel.locator('[data-writer-status="offline"]').waitFor();
  const beforeOffline = reads;
  await page.clock.runFor(31_000);
  assert(reads === beforeOffline, 'offline stops polling');
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); dispatchEvent(new Event('online')); });
  await panel.locator('[data-writer-status="loading"]').waitFor();
  assert((await panel.innerText()).includes('上次证据（当前状态未知）'), 'online waits for new GET');
  await releaseHeld();
  await panel.locator('[data-writer-status="available"]').waitFor();
  mode = 'failure';
  await panel.getByRole('button', { name: '刷新保护诊断' }).click();
  await panel.locator('[data-writer-status="error"]').waitFor();
  assert((await panel.innerText()).includes('上次证据（当前状态未知）'), 'failed refresh retains only historical evidence');
  mode = 'legacy';
  await panel.getByRole('button', { name: '刷新保护诊断' }).click();
  await panel.locator('[data-writer-status="error"]').waitFor();
  mode = 'disabled';
  await panel.getByRole('button', { name: '刷新保护诊断' }).click();
  await panel.getByText('账户写入保护未启用，状态未知', { exact: true }).waitFor();
  mode = 'truncated';
  await panel.getByRole('button', { name: '刷新保护诊断' }).click();
  await panel.getByText('共 2 条账户/模块记录，仅显示前 1 条；未展示部分的状态未知。', { exact: true }).waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'account table is locally scrollable on mobile');
  assert(writes.length === 0, `diagnostics must issue no writes: ${writes.join(',')}`);
  mode = 'expired';
  await panel.getByRole('button', { name: '刷新保护诊断' }).click();
  await page.getByRole('heading', { name: '进入工作台' }).waitFor();
  assert(errors.length === 0, errors.join('\n'));
  return { passed: true, scenarios: ['readonly', 'account reasons', 'module unknown', 'inactive polling', 'offline recovery', 'failure history', 'legacy response', 'disabled', 'truncation', 'mobile', 'expired session'] };
}
