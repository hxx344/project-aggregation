// Run with playwright-cli run-code --filename against a production preview on port 4187.
async (page) => {
  const origin = 'http://hub.localhost:4187';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const applies = [], checks = [], errors = [], scenarios = [];
  let state, mode = 'reject', rejection = 409, holdRead = false, releaseRead, releaseApply;
  const fresh = async id => {
    const now = await page.evaluate(() => Date.now());
    state = { enabled: true, checking: false, checkedAt: new Date(now).toISOString(), checkError: null,
      planId: id, expiresAt: new Date(now + 3_600_000).toISOString(), job: null,
      modules: [{ id: 'workbench', name: '集序工作台', state: 'available', currentVersion: 'v1.0.0', latestVersion: 'v1.1.0',
        currentCommit: '1111111111111111111111111111111111111111', latestCommit: '2222222222222222222222222222222222222222' }] };
  };
  const advance = async ms => { await page.clock.runFor(ms); await page.waitForTimeout(40); };
  const emit = async () => {
    await page.waitForFunction(() => window.__retryStreams?.some(stream => !stream.closed));
    await page.evaluate(value => window.__retryStreams.filter(stream => !stream.closed).at(-1).emit({ type: 'snapshot', state: value }), state);
    await page.waitForTimeout(40);
  };
  const open = async () => {
    await page.goto(origin);
    await page.getByRole('button', { name: '系统更新：1 个可用更新', exact: true }).waitFor();
    await emit();
    await page.getByRole('button', { name: /^系统更新：/ }).click();
    await page.getByRole('dialog', { name: '系统更新', exact: true }).waitFor();
    await page.waitForTimeout(40);
  };
  const prepare = async () => {
    const before = applies.length;
    await page.getByRole('button', { name: '查看更新', exact: true }).click();
    await page.getByRole('heading', { name: '确认本次更新', exact: true }).waitFor();
    assert(applies.length === before, 'reviewing an update never submits it');
  };
  const checkSamePlan = async () => {
    const id = state.planId;
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await page.getByRole('button', { name: '正在检查', exact: true }).waitFor();
    state.checking = false;
    state.checkedAt = new Date(await page.evaluate(() => Date.now())).toISOString();
    await emit();
    await page.getByRole('button', { name: '检查更新', exact: true }).waitFor();
    assert(state.planId === id && !state.job, 'completed checks retain the same unsubmitted server plan');
  };
  const waitHeld = async getter => {
    for (let i = 0; i < 50 && !getter(); i++) await page.waitForTimeout(10);
    assert(!!getter(), 'expected response is held');
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install({ time: new Date('2026-10-14T08:00:00Z') });
  await page.addInitScript(() => {
    window.__retryStreams = [];
    window.EventSource = class {
      constructor(url) {
        this.closed = false;
        if (url === '/api/system/updates/events') {
          window.__retryStreams.push(this);
          this.timer = setInterval(() => this.emit({ type: 'heartbeat' }), 15_000);
        }
      }
      close() { this.closed = true; clearInterval(this.timer); }
      emit(value) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(value) }); }
    };
  });
  await page.route(`${origin}/api/**`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'retry-fixture-csrf' });
    if (path === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [] });
    if (path === '/api/health') return send({ ok: true });
    if (path === '/api/system/updates') {
      if (holdRead) { holdRead = false; await new Promise(resolve => { releaseRead = resolve; }); }
      return send(state);
    }
    if (path === '/api/system/updates/check') {
      checks.push(request.postDataJSON()); state.checking = true;
      return send(state, 202);
    }
    if (path === '/api/system/updates/apply') {
      const body = request.postDataJSON();
      applies.push({ body, csrf: request.headers()['x-csrf-token'], mode });
      assert(Object.keys(body).length === 1 && body.planId === state.planId, 'only the server plan id is submitted');
      assert(request.headers()['x-csrf-token'] === 'retry-fixture-csrf', 'each submission retains CSRF protection');
      if (mode === 'reject') return send({ error: `模拟明确拒绝 ${rejection}` }, rejection);
      if (mode === 'lose-no-job') return route.abort('connectionfailed');
      if (mode === 'hold' || mode === 'hold-reject') await new Promise(resolve => { releaseApply = resolve; });
      if (mode === 'hold-reject') return send({ error: '模拟迟到的 409 响应' }, 409);
      state.job = { id: `job-${applies.length}`, status: 'queued', startedAt: state.checkedAt, finishedAt: null,
        activeModule: null, message: '更新任务已接受', steps: [{ id: 'workbench', name: '更新集序工作台', status: 'pending' }] };
      if (mode === 'lose-accepted') return route.abort('connectionfailed');
      return send(state, 202);
    }
    return send({ error: `Unexpected API ${path}` }, 404);
  });

  for (const status of [403, 409]) {
    rejection = status; mode = 'reject';
    await fresh(`same-plan-${status}`); await open();
    const before = applies.length;
    await prepare();
    await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).click();
    await page.getByText(`模拟明确拒绝 ${status}`, { exact: true }).waitFor();
    assert(await page.locator('.update-review').count() === 0, 'explicit rejection requires a new review');
    await checkSamePlan();
    assert(await page.getByRole('button', { name: '查看更新', exact: true }).isEnabled(), `${status} rejection must not permanently block the same checked plan`);
    mode = 'hold'; await prepare();
    await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).click({ clickCount: 2 });
    await waitHeld(() => releaseApply);
    assert(applies.length === before + 2, 'retry requires confirmation and a double click submits once');
    assert(await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).isDisabled(), 'pending apply cannot be submitted twice');
    await emit(); await advance(105_000);
    assert(await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).isDisabled(), 'a slow precheck remains pending');
    assert(applies.length === before + 2, 'pending snapshots and timers never resubmit');
    const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/apply'));
    releaseApply(); releaseApply = null;
    await (await response).finished(); await emit();
    await page.getByRole('heading', { name: '更新已排队', exact: true }).waitFor();
    assert(await page.locator('.update-footer .primary').isDisabled(), 'an accepted job remains protected from duplicate updates');
    scenarios.push(`${status} same-plan retry, confirmation, CSRF, double click, 105-second precheck`);
  }

  mode = 'hold-reject'; await fresh('stream-job-before-rejection'); await open();
  await prepare();
  const beforeRace = applies.length;
  await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).click();
  await waitHeld(() => releaseApply);
  state.job = { id: 'stream-accepted-job', status: 'queued', startedAt: state.checkedAt, finishedAt: null,
    activeModule: null, message: '任务已通过推送确认', steps: [] };
  await emit();
  const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/apply'));
  releaseApply(); releaseApply = null;
  await (await lateResponse).finished(); await page.waitForTimeout(40);
  assert(await page.getByText('模拟迟到的 409 响应', { exact: true }).count() === 0, 'an accepted streamed job takes precedence over a late rejection');
  state.job = { ...state.job, status: 'succeeded', finishedAt: state.checkedAt, message: '服务器已确认任务完成' };
  await emit();
  await page.getByRole('heading', { name: '更新已完成', exact: true }).waitFor();
  assert(await page.locator('.update-footer .primary').isDisabled(), 'late rejection cannot unlock the accepted plan even after its job finishes');
  assert(applies.length === beforeRace + 1, 'a late rejection never repeats the streamed update');
  await page.getByText('更新已完成，正在刷新页面以载入新版本和重启后的模块连接。', { exact: true }).waitFor();
  const reloaded = page.waitForEvent('load'); await advance(1_600); await reloaded;
  scenarios.push('streamed accepted job wins over late 409, remains protected after completion and reloads the page');

  mode = 'lose-no-job'; await fresh('unknown-plan'); await open();
  await prepare(); holdRead = true;
  const beforeUnknown = applies.length;
  await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).click();
  await waitHeld(() => releaseRead);
  assert(await page.locator('.update-footer .primary').isDisabled(), 'a lost response cannot unlock another apply while the result is unknown');
  assert(await page.getByRole('button', { name: '检查更新', exact: true }).isDisabled(), 'checking is paused while the apply result is unknown');
  await emit();
  assert(await page.locator('.update-footer .primary').isDisabled(), 'a stream without a new job cannot resolve an unknown apply');
  releaseRead(); releaseRead = null;
  await page.getByText('已恢复连接。未发现新的更新任务，请重新检查版本后再试。', { exact: true }).waitFor();
  await checkSamePlan();
  assert(await page.locator('.update-footer .primary').isDisabled(), 'an inconclusive apply retains duplicate protection for the same plan');
  assert(applies.length === beforeUnknown + 1, 'unknown result never automatically resubmits');
  scenarios.push('lost response without job remains protected');

  mode = 'lose-accepted'; await fresh('accepted-response-lost'); await open();
  await prepare();
  const beforeAccepted = applies.length;
  await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).click();
  await advance(2_000);
  await page.getByRole('heading', { name: '更新已排队', exact: true }).waitFor();
  assert(await page.locator('.update-footer .primary').isDisabled(), 'the recovered job prevents duplicate apply');
  assert(applies.length === beforeAccepted + 1, 'recovering an accepted job only reads state');
  assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
  scenarios.push('lost response recovers accepted job without resubmission');
  return { passed: true, scenarios, checks: checks.length, confirmedUpdates: applies.length, errors };
}
