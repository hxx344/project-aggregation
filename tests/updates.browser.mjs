// Run with playwright-cli run-code --filename against the isolated production preview.
async (page) => {
  const origin = 'http://127.0.0.1:4175';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], applies = [], checks = [];
  let reads = 0, unavailable = false, disconnected = false, expireSession = false, loseApplyResponse = false, loseCheckResponse = false;
  let holdRead = false, holdCheck = false, holdApply = false;
  const heldReads = [], heldChecks = [], heldApplies = [];
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
  const readNow = async (event = 'online') => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/system/updates');
    await page.evaluate(event => window.dispatchEvent(new Event(event)), event);
    await (await response).finished(); await page.waitForTimeout(40);
  };
  const emit = async () => {
    await page.waitForFunction(() => window.__updateStreams?.some(stream => !stream.closed));
    await page.evaluate(value => window.__updateStreams.filter(stream => !stream.closed).at(-1).emit({ type: 'snapshot', state: value }), state);
    await page.waitForTimeout(40);
  };
  const streamError = async () => page.evaluate(() => window.__updateStreams.filter(stream => !stream.closed).at(-1).onerror());
  const waitHeld = async held => {
    for (let i = 0; i < 50 && !held.length; i++) await page.waitForTimeout(10);
    assert(held.length === 1, 'the delayed response is held');
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install({ time: new Date('2026-10-09T04:00:00Z') });
  await page.addInitScript(() => {
    window.__updateHidden = false; window.__updateOnline = true; window.__updateSilent = false; window.__updateFailConnect = false; window.__updateStreams = [];
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__updateHidden });
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => window.__updateOnline });
    window.EventSource = class {
      constructor(url) {
        this.closed = false;
        if (url === '/api/system/updates/events') {
          window.__updateStreams.push(this);
          this.timer = setInterval(() => { if (!window.__updateSilent) this.emit({ type: 'heartbeat' }); }, 15_000);
          if (window.__updateFailConnect) setTimeout(() => { if (!this.closed) this.onerror?.(); }, 0);
        }
      }
      close() { this.closed = true; clearInterval(this.timer); }
      emit(value) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(value) }); }
    };
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
      const data = structuredClone(state);
      if (holdRead) { holdRead = false; await new Promise(resolve => heldReads.push(resolve)); }
      return send(data);
    }
    if (path === '/api/system/updates/check') {
      checks.push(request.postDataJSON());
      if (loseCheckResponse) { loseCheckResponse = false; return route.abort('connectionfailed'); }
      state.checking = true;
      const data = structuredClone(state);
      if (holdCheck) { holdCheck = false; await new Promise(resolve => heldChecks.push(resolve)); }
      return send(data, 202);
    }
    if (path === '/api/system/updates/apply') {
      const body = request.postDataJSON();
      applies.push({ body, csrf: request.headers()['x-csrf-token'] });
      assert(Object.keys(body).length === 1 && body.planId === state.planId, 'only the server plan id is submitted');
      state.job = { id: `job-${applies.length}`, status: 'queued', startedAt: new Date().toISOString(), finishedAt: null,
        activeModule: null, message: '更新任务已接受', steps: [{ id: 'workbench', name: '更新集序工作台', status: 'pending' }] };
      if (loseApplyResponse) { loseApplyResponse = false; return route.abort('connectionfailed'); }
      const data = structuredClone(state);
      if (holdApply) { holdApply = false; await new Promise(resolve => heldApplies.push(resolve)); }
      return send(data, 202);
    }
    return send({ error: `Unexpected API ${path}` }, 404);
  });

  await page.goto(origin);
  await page.getByRole('button', { name: '系统更新：已是最新正式版', exact: true }).waitFor();
  await emit();
  await openUpdates();
  assert(await page.getByText('最新正式版', { exact: true }).count() === 1, 'current and stable target versions are shown');
  assert(checks.length === 0, 'opening the page never triggers a remote check');
  await page.getByRole('button', { name: '关闭系统更新', exact: true }).click();
  const beforeHidden = reads;
  await page.evaluate(() => { window.__updateHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  await advance(900_000);
  assert(reads === beforeHidden, 'healthy hidden stream needs no fallback reads');
  assert(checks.length === 0, 'even stale state never triggers an automatic POST check');
  await makeAvailable('hidden-plan'); await emit();
  await page.getByRole('button', { name: '系统更新：1 个可用更新', exact: true }).waitFor();
  assert(await page.evaluate(() => window.__updateStreams.length === 1 && !window.__updateStreams[0].closed), 'hidden page retains its live update stream');
  await page.evaluate(() => { window.__updateFailConnect = true; });
  await streamError(); await page.waitForTimeout(40);
  const beforeFallback = reads;
  state.modules[0].latestVersion = 'v1.1.1';
  await advance(15_000);
  assert(reads === beforeFallback + 1, 'repeated stream failures retain one idle fallback read per fifteen seconds');
  assert(checks.length === 0, 'stream reconnection and fallback never check releases');
  await page.evaluate(() => { window.__updateFailConnect = false; }); await advance(5_000);
  await emit();
  await page.evaluate(() => { window.__updateHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(40);
  assert(reads > beforeFallback, 'visible page refreshes the server state');

  // A newly pushed plan wins over a GET that was already in flight.
  await openUpdates();
  await page.waitForTimeout(40);
  holdRead = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitHeld(heldReads);
  await makeAvailable('stream-newer-than-get'); state.modules[0].latestVersion = 'v1.2.0'; await emit();
  heldReads.shift()(); await page.waitForTimeout(40);
  assert((await page.locator('.update-modules').innerText()).includes('v1.2.0'), 'an old GET cannot replace the pushed version');
  await page.getByRole('button', { name: '关闭系统更新', exact: true }).click();

  // A silent open socket is unhealthy even while the browser stays hidden.
  const beforeSilent = await page.evaluate(() => window.__updateStreams.length);
  await page.evaluate(() => { window.__updateSilent = true; window.__updateHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  await advance(60_000);
  assert(await page.evaluate(() => window.__updateStreams.length) > beforeSilent, 'missing heartbeats recreate the hidden stream');
  await page.evaluate(() => { window.__updateSilent = false; }); await emit();
  await page.evaluate(() => { window.__updateOnline = false; window.dispatchEvent(new Event('offline')); });
  const beforeOffline = reads;
  await advance(60_000);
  assert(reads === beforeOffline, 'offline pauses fallback reads');
  await page.evaluate(() => { window.__updateOnline = true; }); await readNow(); await emit();
  await readNow('pageshow');
  assert(checks.length === 0, 'offline recovery and page restoration stay read-only');

  await makeAvailable('plan-one');
  await page.reload(); await emit(); await openUpdates();
  await page.screenshot({ path: 'output/playwright/updates-desktop.png' });
  await page.getByRole('button', { name: '查看更新', exact: true }).click();
  assert(applies.length === 0, 'reviewing changes never starts an update');
  await page.getByRole('heading', { name: '确认本次更新', exact: true }).waitFor();
  assert((await page.locator('.update-review').innerText()).includes('集序工作台'), 'review names the modules to update');
  assert(!(await page.locator('.update-review').innerText()).includes('市场监控'), 'unchanged modules are not included in the update');
  state.checking = true; await emit();
  assert(await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).isDisabled(), 'background checks temporarily pause confirmation');
  assert(!(await page.locator('.update-review').innerText()).includes('已变化或过期'), 'an unchanged plan being checked is not reported as replaced');
  state.checking = false; state.checkedAt = await now(); await emit();
  assert(await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).isEnabled(), 'identical candidates resume the existing confirmation');
  await page.screenshot({ path: 'output/playwright/updates-review.png' });
  holdApply = true;
  await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).click({ clickCount: 2 });
  await waitHeld(heldApplies);
  assert(applies.length === 1 && applies[0].csrf === 'update-fixture-csrf', 'single confirmed update retains CSRF protection');
  state.job.status = 'running'; state.job.activeModule = 'workbench'; state.job.steps[0].status = 'running'; state.job.message = '正在安装集序工作台';
  await emit();
  heldApplies.shift()(); await page.waitForTimeout(40);
  await page.getByRole('heading', { name: '正在更新', exact: true }).waitFor();
  assert(await page.getByRole('heading', { name: '更新已排队', exact: true }).count() === 0, 'late apply response cannot roll back streamed progress');
  await page.screenshot({ path: 'output/playwright/updates-progress.png' });
  disconnected = true; await streamError(); await advance(2_000);
  await page.getByText('连接暂时中断，正在重连并核实更新进度。', { exact: true }).waitFor();
  disconnected = false; await advance(2_000);
  assert(applies.length === 1, 'connection recovery never resubmits an accepted update');
  await page.reload(); await emit(); await openUpdates();
  await page.getByRole('heading', { name: '正在更新', exact: true }).waitFor();
  assert(applies.length === 1, 'reload resumes the persisted server job');
  state.job.status = 'succeeded'; state.job.finishedAt = await now(); state.job.steps[0].status = 'succeeded'; state.job.message = '所有变更模块更新完成';
  state.modules[0] = { ...state.modules[0], state: 'current', currentVersion: 'v1.1.0', currentCommit: state.modules[0].latestCommit };
  state.planId = null;
  await emit();
  await page.getByRole('heading', { name: '更新已完成', exact: true }).waitFor();

  await makeAvailable('plan-two'); loseApplyResponse = true;
  await page.reload(); await emit(); await openUpdates();
  await page.getByRole('button', { name: '查看更新', exact: true }).click();
  await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).click();
  await advance(2_000);
  await page.getByRole('heading', { name: '更新已排队', exact: true }).waitFor();
  assert(applies.length === 2, 'lost apply response is recovered by reading the job without retrying the POST');

  state = initial(); state.checkedAt = await now();
  await page.reload(); await emit(); await openUpdates();
  holdCheck = true;
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await waitHeld(heldChecks);
  await makeAvailable('stream-newer-than-check'); await emit();
  heldChecks.shift()(); await page.waitForTimeout(40);
  assert((await page.locator('.update-summary').innerText()).includes('1 个可用更新'), 'late check response cannot restore checking after the completed push');
  assert(await page.getByRole('button', { name: '查看更新', exact: true }).isEnabled(), 'a pushed completed plan is usable after the manual check response');

  state = initial(); state.checkedAt = await now(); loseCheckResponse = true;
  await page.reload(); await emit(); await openUpdates();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByText('上次检查请求未完成，当前显示的是已有记录。', { exact: true }).waitFor();
  await readNow();
  assert((await page.locator('.update-summary').innerText()).includes('检查失败'), 'reading an old cache cannot erase a failed check request');
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  state.checking = false; state.checkedAt = await now(); await emit();
  await page.locator('.update-summary').getByText('已是最新正式版', { exact: true }).waitFor();

  state = initial(); state.checkedAt = await now(); state.checkError = '正式版本信息暂时无法获取'; state.modules = [];
  await page.reload(); await emit(); await openUpdates();
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
  state.planId = 'replacement-plan'; await emit();
  assert(await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).isDisabled(), 'a changed server plan invalidates an open confirmation');
  assert(applies.length === 2, 'stale confirmation does not write');
  state.planId = 'plan-mobile'; state.expiresAt = new Date(await page.evaluate(() => Date.now() + 1_000)).toISOString(); await emit();
  assert(await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).isEnabled(), 'the original unexpired plan can still be reviewed');
  await advance(2_000);
  assert(await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).isDisabled(), 'the confirmation expires even without another snapshot');
  assert((await page.locator('.update-review').innerText()).includes('已变化或过期'), 'actual expiry explains why confirmation is disabled');
  await page.keyboard.press('Escape');
  assert(await page.getByRole('dialog').count() === 0, 'escape closes the update dialog');
  await advance(20);
  assert(await page.getByRole('button', { name: '打开导航', exact: true }).evaluate(element => element === document.activeElement), 'closing on mobile restores focus to navigation');

  expireSession = true; await streamError();
  await page.getByRole('heading', { name: '进入工作台', exact: true }).waitFor();
  const beforeExpired = reads;
  await advance(60_000);
  assert(reads === beforeExpired, 'session expiry stops update polling');
  assert(await page.evaluate(() => window.__updateStreams.every(stream => stream.closed)), 'session expiry closes all update streams');
  assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
  assert(checks.length === 3, 'only the three explicit manual clicks send check requests');
  return { passed: true, reads, checks: checks.length, confirmedUpdates: applies.length, scenarios: ['stable versions', 'no automatic checks', 'hidden stream', 'hidden fallback', 'heartbeat timeout', 'offline recovery', 'stale GET isolation', 'two-step confirmation', 'unchanged plan while checking', 'double-click protection', 'late apply response', 'structured progress', 'restart reconnect', 'refresh recovery', 'lost apply response', 'late check response', 'failed check with old cache', 'check failure', 'legacy setup', 'mobile focus', 'seven-module confirmation', 'stale plan', 'plan expiry', 'session expiry'], screenshots: ['updates-desktop.png', 'updates-review.png', 'updates-progress.png', 'updates-mobile.png', 'updates-mobile-review.png'] };
}
