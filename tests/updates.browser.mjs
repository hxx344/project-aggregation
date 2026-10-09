// Run with playwright-cli run-code --filename against the isolated production preview.
async (page) => {
  const origin = 'http://127.0.0.1:4175';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], applies = [], checks = [];
  let reads = 0, unavailable = false, disconnected = false, expireSession = false, loseApplyResponse = false, loseCheckResponse = false;
  const initial = () => ({ enabled: true, checking: false, checkedAt: '2026-10-09T04:00:00.000Z', checkError: null,
    planId: null, expiresAt: '2026-10-09T06:00:00.000Z',
    modules: [{ id: 'workbench', name: '集序工作台', state: 'current', currentVersion: 'v1.0.0', latestVersion: 'v1.0.0', currentCommit: '1111111111111111111111111111111111111111', latestCommit: '1111111111111111111111111111111111111111' }], job: null });
  let state = initial();
  const now = async () => new Date(await page.evaluate(() => Date.now())).toISOString();
  const makeAvailable = async id => {
    state = initial(); state.planId = id; state.checkedAt = await now();
    state.expiresAt = new Date(await page.evaluate(() => Date.now() + 3_600_000)).toISOString();
    state.modules[0] = { ...state.modules[0], state: 'available', latestVersion: 'v1.1.0', latestCommit: '2222222222222222222222222222222222222222' };
    state.modules.push({ id: 'monitor', name: '市场监控', state: 'current', currentVersion: 'v2.0.0', latestVersion: 'v2.0.0', currentCommit: null, latestCommit: null });
  };
  const advance = async ms => { await page.clock.runFor(ms); await page.waitForTimeout(40); };
  const openUpdates = async () => {
    if (await page.locator('.mobile-menu').isVisible()) await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await page.getByRole('button', { name: /^系统更新：/ }).click();
    await page.getByRole('dialog', { name: '系统更新', exact: true }).waitFor();
  };
  const readNow = async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/system/updates');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await (await response).finished(); await page.waitForTimeout(40);
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install({ time: new Date('2026-10-09T04:00:00Z') });
  await page.addInitScript(() => {
    window.__updateHidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__updateHidden });
    window.EventSource = class { close() {} };
  });
  await page.route(`${origin}/api/**`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'update-fixture-csrf' });
    if (path === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [] });
    if (path === '/api/system/updates') {
      reads++;
      if (expireSession) return send({ error: '登录已过期' }, 401);
      if (unavailable) return send({ error: 'Not found' }, 404);
      if (disconnected) return route.abort('connectionfailed');
      return send(state);
    }
    if (path === '/api/system/updates/check') {
      checks.push(request.postDataJSON());
      if (loseCheckResponse) { loseCheckResponse = false; return route.abort('connectionfailed'); }
      state.checking = true;
      return send(state, 202);
    }
    if (path === '/api/system/updates/apply') {
      const body = request.postDataJSON();
      applies.push({ body, csrf: request.headers()['x-csrf-token'] });
      assert(Object.keys(body).length === 1 && body.planId === state.planId, 'only the server plan id is submitted');
      state.job = { id: `job-${applies.length}`, status: 'queued', startedAt: new Date().toISOString(), finishedAt: null,
        activeModule: null, message: '更新任务已接受', steps: [{ id: 'workbench', name: '更新集序工作台', status: 'pending' }] };
      if (loseApplyResponse) { loseApplyResponse = false; return route.abort('connectionfailed'); }
      return send(state, 202);
    }
    return send({ error: `Unexpected API ${path}` }, 404);
  });

  await page.goto(origin);
  await page.getByRole('button', { name: '系统更新：已是最新正式版', exact: true }).waitFor();
  await openUpdates();
  assert(await page.getByText('最新正式版', { exact: true }).count() === 1, 'current and stable target versions are shown');
  assert(checks.length === 0, 'fresh server check is reused');
  await page.getByRole('button', { name: '关闭系统更新', exact: true }).click();
  const beforeHidden = reads;
  await page.evaluate(() => { window.__updateHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  await advance(180_000);
  assert(reads === beforeHidden, 'hidden idle page pauses status polling');
  await page.evaluate(() => { window.__updateHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(40);
  assert(reads > beforeHidden, 'visible page restores status polling');
  await advance(60_000);
  assert(checks.length === 0, 'one-minute status reads do not trigger remote checks');
  await page.clock.fastForward(900_000); await page.waitForTimeout(50);
  assert(checks.length === 1, 'remote check runs after fifteen minutes');
  state.checking = false; state.checkedAt = await now();
  await advance(2_000);

  await makeAvailable('plan-one');
  await page.reload(); await openUpdates();
  await page.screenshot({ path: 'output/playwright/updates-desktop.png' });
  await page.getByRole('button', { name: '查看更新', exact: true }).click();
  assert(applies.length === 0, 'reviewing changes never starts an update');
  await page.getByRole('heading', { name: '确认本次更新', exact: true }).waitFor();
  assert((await page.locator('.update-review').innerText()).includes('集序工作台'), 'review names the modules to update');
  assert(!(await page.locator('.update-review').innerText()).includes('市场监控'), 'unchanged modules are not included in the update');
  await page.screenshot({ path: 'output/playwright/updates-review.png' });
  await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).click({ clickCount: 2 });
  await page.getByRole('heading', { name: '更新已排队', exact: true }).waitFor();
  assert(applies.length === 1 && applies[0].csrf === 'update-fixture-csrf', 'single confirmed update retains CSRF protection');
  state.job.status = 'running'; state.job.activeModule = 'workbench'; state.job.steps[0].status = 'running'; state.job.message = '正在安装集序工作台';
  await advance(2_000);
  await page.getByRole('heading', { name: '正在更新', exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/updates-progress.png' });
  disconnected = true; await advance(2_000);
  await page.getByText('连接暂时中断，正在重连并核实更新进度。', { exact: true }).waitFor();
  disconnected = false; await advance(2_000);
  assert(applies.length === 1, 'connection recovery never resubmits an accepted update');
  await page.reload(); await openUpdates();
  await page.getByRole('heading', { name: '正在更新', exact: true }).waitFor();
  assert(applies.length === 1, 'reload resumes the persisted server job');
  state.job.status = 'succeeded'; state.job.finishedAt = await now(); state.job.steps[0].status = 'succeeded'; state.job.message = '所有变更模块更新完成';
  state.modules[0] = { ...state.modules[0], state: 'current', currentVersion: 'v1.1.0', currentCommit: state.modules[0].latestCommit };
  state.planId = null;
  await advance(2_000);
  await page.getByRole('heading', { name: '更新已完成', exact: true }).waitFor();

  await makeAvailable('plan-two'); loseApplyResponse = true;
  await page.reload(); await openUpdates();
  await page.getByRole('button', { name: '查看更新', exact: true }).click();
  await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).click();
  await advance(2_000);
  await page.getByRole('heading', { name: '更新已排队', exact: true }).waitFor();
  assert(applies.length === 2, 'lost apply response is recovered by reading the job without retrying the POST');

  state = initial(); state.checkedAt = await now(); loseCheckResponse = true;
  await page.reload(); await openUpdates();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByText('上次检查请求未完成，当前显示的是已有记录。', { exact: true }).waitFor();
  await readNow();
  assert((await page.locator('.update-summary').innerText()).includes('检查失败'), 'reading an old cache cannot erase a failed check request');
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  state.checking = false; state.checkedAt = await now(); await advance(2_000);
  await page.locator('.update-summary').getByText('已是最新正式版', { exact: true }).waitFor();

  state = initial(); state.checkedAt = await now(); state.checkError = '正式版本信息暂时无法获取'; state.modules = [];
  await page.reload(); await openUpdates();
  await page.getByText('版本检查未完成', { exact: true }).waitFor();
  assert(!(await page.locator('.update-summary').innerText()).includes('已是最新'), 'check failures cannot claim the installation is current');
  unavailable = true;
  await page.reload(); await openUpdates();
  await page.getByText('先启用在线更新', { exact: true }).waitFor();
  assert((await page.getByRole('dialog').innerText()).includes('重新运行原一键部署命令'), 'legacy installation has a clear first-upgrade instruction');
  unavailable = false;

  await makeAvailable('plan-mobile');
  state.modules.push(...[['aster', 'ASTER 5X'], ['asset', 'Asset Ledger'], ['crossex', 'Gate CrossEx'], ['variational', 'Variational Grid'], ['greeks', 'Greeks · BTC 期权']].map(([id, name]) => ({ id, name, state: 'current', currentVersion: 'v2026.10.09', latestVersion: 'v2026.10.09', currentCommit: 'abcdef0123456789abcdef0123456789abcdef0123', latestCommit: 'abcdef0123456789abcdef0123456789abcdef0123' })));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload(); await openUpdates();
  assert(await page.locator('.sidebar.open').count() === 0, 'opening the modal closes the mobile navigation');
  await page.keyboard.press('Tab');
  assert(await page.evaluate(() => !!document.querySelector('.update-dialog')?.contains(document.activeElement)), 'keyboard focus stays inside the update dialog');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile page has no horizontal overflow');
  assert(await page.locator('.update-dialog').evaluate(element => element.scrollWidth <= element.clientWidth), 'seven-module dialog has no horizontal overflow');
  await page.screenshot({ path: 'output/playwright/updates-mobile.png' });
  await page.getByRole('button', { name: '查看更新', exact: true }).click();
  assert(await page.locator('.update-review').evaluate(element => { const item = element.getBoundingClientRect(), body = element.closest('.update-body').getBoundingClientRect(); return item.top >= body.top && item.bottom <= body.bottom; }), 'confirmation details scroll into view for seven-module mobile lists');
  assert(await page.locator('.update-review').evaluate(element => element === document.activeElement), 'confirmation focus announces the actual changes');
  await page.screenshot({ path: 'output/playwright/updates-mobile-review.png' });
  state.planId = 'replacement-plan'; await readNow();
  assert(await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).isDisabled(), 'a changed server plan invalidates an open confirmation');
  assert(applies.length === 2, 'stale confirmation does not write');
  await page.keyboard.press('Escape');
  assert(await page.getByRole('dialog').count() === 0, 'escape closes the update dialog');
  await advance(20);
  assert(await page.getByRole('button', { name: '打开导航', exact: true }).evaluate(element => element === document.activeElement), 'closing on mobile restores focus to navigation');

  expireSession = true; await readNow();
  await page.getByRole('heading', { name: '进入工作台', exact: true }).waitFor();
  const beforeExpired = reads;
  await advance(60_000);
  assert(reads === beforeExpired, 'session expiry stops update polling');
  assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
  return { passed: true, reads, checks: checks.length, confirmedUpdates: applies.length, scenarios: ['stable versions', 'fifteen-minute checks', 'hidden pause', 'two-step confirmation', 'double-click protection', 'structured progress', 'restart reconnect', 'refresh recovery', 'lost apply response', 'failed check with old cache', 'check failure', 'legacy setup', 'mobile focus', 'seven-module confirmation', 'stale plan', 'session expiry'], screenshots: ['updates-desktop.png', 'updates-review.png', 'updates-progress.png', 'updates-mobile.png', 'updates-mobile-review.png'] };
}
