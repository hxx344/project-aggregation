// Run with playwright-cli run-code --filename against a production preview on port 4188.
async (page) => {
  const origin = 'http://hub.localhost:4188';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], applies = [], scenarios = [];
  let state, holdApply = false, releaseApply, rejectApply = false;
  const fresh = async (id, deploymentModes = ['source', 'ci']) => {
    const now = await page.evaluate(() => Date.now());
    state = {
      enabled: true, checking: false, checkedAt: new Date(now).toISOString(), checkError: null,
      deploymentModes, planId: id, expiresAt: new Date(now + 3_600_000).toISOString(), job: null,
      modules: [{ id: 'workbench', name: '集序工作台', state: 'available', currentVersion: 'v1.0.0', latestVersion: 'v1.1.0',
        currentCommit: '1111111111111111111111111111111111111111', latestCommit: '2222222222222222222222222222222222222222' }],
    };
  };
  const emit = async () => {
    await page.waitForFunction(() => window.__modeStreams?.some(stream => !stream.closed));
    await page.evaluate(value => window.__modeStreams.filter(stream => !stream.closed).at(-1).emit({ type: 'snapshot', state: value }), state);
    await page.waitForTimeout(40);
  };
  const open = async () => {
    if (await page.locator('.mobile-menu').isVisible()) await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await page.getByRole('button', { name: /^系统更新：/ }).click();
    await page.getByRole('dialog', { name: '系统更新', exact: true }).waitFor();
  };
  const reload = async () => {
    await page.goto(origin);
    await emit(); await open();
  };
  const prepare = async label => {
    const before = applies.length;
    await page.getByRole('button', { name: '查看更新', exact: true }).click();
    await page.getByRole('heading', { name: '确认本次更新', exact: true }).waitFor();
    assert(await page.locator('.update-review-mode').innerText() === `更新方式：${label}`, 'review freezes the chosen deployment mode');
    assert(await page.getByRole('radio').count() === 0, 'mode cannot change inside confirmation');
    assert(applies.length === before, 'selecting a mode and reviewing never submit an update');
  };
  const confirm = () => page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).click();
  const source = () => page.getByRole('radio', { name: /^下载源码构建/ });
  const ci = () => page.getByRole('radio', { name: /^下载 CI 构建包/ });
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install({ time: new Date('2026-10-16T08:00:00Z') });
  await page.addInitScript(() => {
    window.__modeStreams = [];
    window.EventSource = class {
      constructor(url) {
        this.closed = false;
        if (url === '/api/system/updates/events') {
          window.__modeStreams.push(this);
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
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'mode-fixture-csrf' });
    if (path === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [] });
    if (path === '/api/health') return send({ ok: true });
    if (path === '/api/system/updates') return send(state);
    if (path === '/api/system/updates/apply') {
      const body = request.postDataJSON();
      applies.push(body);
      assert(body.planId === state.planId, 'the checked server plan remains authoritative');
      assert(request.headers()['x-csrf-token'] === 'mode-fixture-csrf', 'mode submission retains CSRF protection');
      assert(Object.keys(body).every(key => key === 'planId' || key === 'deployMode'), 'only the fixed plan and optional mode are submitted');
      if (holdApply) await new Promise(resolve => { releaseApply = resolve; });
      if (rejectApply) return send({ error: '更新方式暂不可用，请重试' }, 409);
      state.job = { id: `mode-job-${applies.length}`, status: 'queued', startedAt: state.checkedAt, finishedAt: null,
        activeModule: null, message: '更新任务已接受', steps: [], ...(state.deploymentModes ? { deployMode: body.deployMode } : {}) };
      return send(state, 202);
    }
    return send({ error: `Unexpected API ${path}` }, 404);
  });

  await fresh('source-plan'); await reload();
  assert(await source().isChecked(), 'source remains the default mode');
  assert(await ci().isEnabled(), 'CI is available only when the server advertises it');
  await prepare('下载源码构建'); await confirm();
  await page.getByRole('heading', { name: '更新已排队', exact: true }).waitFor();
  assert(applies.at(-1).deployMode === 'source', 'new services receive the selected source mode');
  assert(await page.locator('.update-job-mode').innerText() === '本次方式：下载源码构建', 'accepted task shows its server-recorded source mode');
  assert(await page.getByRole('radio').count() === 0, 'an active update cannot change deployment mode');
  scenarios.push('default source, frozen confirmation, protected apply and actual task mode');

  await fresh('ci-plan'); await reload(); await ci().check();
  await prepare('下载 CI 构建包');
  state.deploymentModes = ['ci', 'source']; await emit();
  assert(await page.locator('.update-review-mode').innerText() === '更新方式：下载 CI 构建包', 'a reordered capability snapshot does not alter confirmation');
  holdApply = true;
  const before = applies.length;
  await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).click({ clickCount: 2 });
  for (let i = 0; i < 50 && !releaseApply; i++) await page.waitForTimeout(10);
  assert(!!releaseApply, 'the apply response is held');
  assert(applies.length === before + 1 && applies.at(-1).deployMode === 'ci', 'double click submits the frozen CI choice once');
  assert(await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).isDisabled(), 'pending requests cannot resubmit');
  assert(await page.getByRole('radio').count() === 0, 'pending requests cannot change mode');
  const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/apply'));
  releaseApply(); releaseApply = undefined; holdApply = false;
  await (await response).finished();
  await page.getByRole('heading', { name: '更新已排队', exact: true }).waitFor();
  assert(await page.locator('.update-job-mode').innerText() === '本次方式：下载 CI 构建包', 'job displays the accepted CI mode');
  await reload();
  assert(await page.locator('.update-job-mode').innerText() === '本次方式：下载 CI 构建包', 'reloading reads actual task mode independently of the default selection');
  scenarios.push('CI selection, reordered capabilities, double click and task reload');

  await fresh('legacy-plan'); delete state.deploymentModes; await reload();
  assert(await page.getByRole('radio').count() === 0, 'legacy services do not advertise invented CI capability');
  assert((await page.locator('.update-mode-help').innerText()).includes('升级更新服务后可选择 CI 构建包'), 'legacy service explains how to gain mode selection');
  await prepare('下载源码构建'); await confirm();
  await page.getByRole('heading', { name: '更新已排队', exact: true }).waitFor();
  assert(JSON.stringify(applies.at(-1)) === JSON.stringify({ planId: 'legacy-plan' }), 'legacy service receives its original plan-only request');
  assert(await page.locator('.update-job-mode').count() === 0, 'legacy task without a recorded mode is not relabeled');
  scenarios.push('legacy capability and request compatibility');

  await fresh('changed-capability-plan'); await reload(); await ci().check(); await prepare('下载 CI 构建包');
  const beforeCapabilityChange = applies.length;
  state.deploymentModes = ['source']; await emit();
  assert(await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).isDisabled(), 'withdrawn CI support invalidates the frozen review');
  assert((await page.locator('.update-review [role=alert]').innerText()).includes('更新方式支持情况已变化'), 'capability changes explain why re-confirmation is needed');
  assert(applies.length === beforeCapabilityChange, 'capability changes do not trigger another update');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  assert(await source().isChecked() && await ci().count() === 0, 'returning uses only the currently supported mode');
  scenarios.push('capability withdrawal invalidates review without submitting');

  await fresh('retry-mode-plan'); await reload(); await ci().check(); await prepare('下载 CI 构建包');
  rejectApply = true; await confirm();
  await page.getByText('更新方式暂不可用，请重试', { exact: true }).waitFor();
  assert(await ci().isChecked(), 'explicit rejection preserves the choice for review');
  await source().check(); await prepare('下载源码构建'); rejectApply = false; await confirm();
  await page.getByRole('heading', { name: '更新已排队', exact: true }).waitFor();
  assert(applies.at(-1).deployMode === 'source', 'a rejected plan can be explicitly confirmed with a different mode');
  scenarios.push('explicit rejection unlocks mode choice and same-plan retry');

  await fresh('mobile-mode-plan'); await page.setViewportSize({ width: 390, height: 844 }); await reload();
  await ci().check();
  assert(await page.locator('.update-dialog').evaluate(element => element.scrollWidth <= element.clientWidth), 'mode choices fit the narrow dialog');
  await prepare('下载 CI 构建包');
  assert(await page.locator('.update-dialog').evaluate(element => element.scrollWidth <= element.clientWidth), 'frozen confirmation fits the narrow dialog');
  assert(await page.evaluate(() => window.__modeStreams.filter(stream => !stream.closed).length === 1), 'mode selection keeps one shared status subscription');
  assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
  scenarios.push('narrow layout and shared status subscription');
  return { passed: true, scenarios, confirmedUpdates: applies.length, errors };
}
