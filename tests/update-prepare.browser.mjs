// Run with playwright-cli run-code --filename against a production preview on port 4188.
async (page) => {
  const origin = 'http://hub.localhost:4188';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], applies = [], scenarios = [];
  let state, reloads = 0;
  const fresh = async (id, extra = {}) => {
    const now = await page.evaluate(() => Date.now());
    state = {
      enabled: true, checking: false, checkedAt: new Date(now).toISOString(), checkError: null,
      deploymentModes: ['source', 'ci'], planId: id, expiresAt: new Date(now + 3_600_000).toISOString(), job: null,
      planScopes: { source: 'full', ci: 'full' }, planPrepare: true, prepared: null,
      modules: [{ id: 'workbench', name: '集序工作台', state: 'available', currentVersion: 'v1.0.0', latestVersion: 'v1.1.0',
        currentCommit: '1111111111111111111111111111111111111111', latestCommit: '2222222222222222222222222222222222222222' }],
      ...extra,
    };
  };
  const emit = async () => {
    await page.waitForFunction(() => window.__prepareStreams?.some(stream => !stream.closed));
    await page.evaluate(value => window.__prepareStreams.filter(stream => !stream.closed).at(-1).emit({ type: 'snapshot', state: value }), state);
    await page.waitForTimeout(40);
  };
  const open = async () => {
    const notice = page.getByRole('button', { name: '稍后', exact: true });
    if (await notice.isVisible()) await notice.click();
    await page.getByRole('button', { name: /^系统更新：/ }).click();
    await page.getByRole('dialog', { name: '系统更新', exact: true }).waitFor();
  };
  const reload = async () => { await page.goto(origin); reloads = 0; await emit(); await open(); };
  const dialogText = () => page.getByRole('dialog', { name: '系统更新', exact: true }).innerText();
  const finish = async (status = 'succeeded') => {
    state.job = { ...state.job, status, finishedAt: state.checkedAt, message: status === 'succeeded' ? '完成' : '失败' };
    await emit();
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install({ time: new Date('2026-10-28T08:00:00Z') });
  await page.addInitScript(() => {
    window.__prepareStreams = [];
    window.EventSource = class {
      constructor(url) {
        this.closed = false;
        if (url === '/api/system/updates/events') {
          window.__prepareStreams.push(this);
          this.timer = setInterval(() => this.emit({ type: 'heartbeat' }), 15_000);
        }
      }
      close() { this.closed = true; clearInterval(this.timer); }
      emit(value) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(value) }); }
    };
  });
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) reloads++; });
  await page.route(`${origin}/api/**`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'prepare-fixture-csrf' });
    if (path === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [] });
    if (path === '/api/health') return send({ ok: true });
    if (path === '/api/system/updates') return send(state);
    if (path === '/api/system/updates/apply') {
      const body = request.postDataJSON();
      applies.push(body);
      assert(body.planId === state.planId, 'the checked server plan remains authoritative');
      assert(Object.keys(body).every(key => ['planId', 'deployMode', 'phase'].includes(key)), 'only fixed fields are submitted');
      state.job = { id: `prepare-job-${applies.length}`, status: 'running', startedAt: state.checkedAt, finishedAt: null,
        activeModule: 'hub', message: '正在执行', steps: [], deployMode: body.deployMode, scope: 'full', phase: body.phase || 'activate' };
      return send(state, 202);
    }
    return send({ error: `Unexpected API ${path}` }, 404);
  });

  await fresh('prepare-plan'); await reload();
  await page.getByRole('radio', { name: /^下载 CI 构建包/ }).check();
  await page.getByRole('button', { name: '查看更新', exact: true }).click();
  assert((await dialogText()).includes('期间交易、行情和实盘任务照常运行'), 'prepare review explains trading keeps running');
  await page.getByRole('button', { name: '开始准备 1 个模块', exact: true }).click();
  await page.getByRole('heading', { name: '正在准备新版本', exact: true }).waitFor();
  assert(JSON.stringify(applies.at(-1)) === JSON.stringify({ planId: 'prepare-plan', deployMode: 'ci', phase: 'prepare' }), 'a full plan that supports it is prepared first');
  state.prepared = { planId: 'prepare-plan', deployMode: 'ci' };
  await finish();
  await page.getByRole('heading', { name: '新版本已准备好', exact: true }).waitFor();
  await page.waitForTimeout(400);
  assert(reloads === 0, 'a finished prepare job switched nothing, so the page does not reload');
  assert((await dialogText()).includes('新版本已准备好，待切换'), 'the summary waits for the switch');
  assert((await dialogText()).includes('前切换，之后需重新检查并准备'), 'the prepared banner states the switch deadline');
  assert(await page.getByRole('radio').count() === 0, 'the prepared mode cannot change before the switch');
  await page.getByRole('button', { name: '切换到新版本', exact: true }).click();
  assert((await page.locator('.update-review-mode').innerText()) === '更新方式：下载 CI 构建包', 'the switch keeps the prepared mode');
  assert((await dialogText()).includes('交易模块进入维护并核对停机状态'), 'the switch review explains the brief trading pause');
  await page.getByRole('button', { name: '确认切换', exact: true }).click();
  await page.getByRole('heading', { name: '正在更新', exact: true }).waitFor();
  assert(JSON.stringify(applies.at(-1)) === JSON.stringify({ planId: 'prepare-plan', deployMode: 'ci' }), 'the switch is the ordinary full update of the same plan');
  scenarios.push('prepare without reload, then switch the same plan in the prepared mode');

  await fresh('elsewhere-plan'); await reload();
  await page.getByRole('button', { name: '查看更新', exact: true }).click();
  state.prepared = { planId: 'elsewhere-plan', deployMode: 'source' };
  state.job = { id: 'other-tab-job', status: 'succeeded', startedAt: state.checkedAt, finishedAt: state.checkedAt, activeModule: null,
    message: '完成', steps: [], deployMode: 'source', scope: 'full', phase: 'prepare' };
  await emit();
  assert(await page.getByRole('button', { name: '开始准备 1 个模块', exact: true }).isDisabled(), 'a preparation finished elsewhere invalidates the prepare review');
  assert((await dialogText()).includes('新版本已在其他页面准备好'), 'the review explains the change of phase');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  state.planId = 'replacement-plan'; await emit();
  assert(await page.getByRole('heading', { name: '新版本已准备好', exact: true }).count() === 0, 'a replaced plan no longer shows the preparation as ready');
  scenarios.push('preparation finished elsewhere and replaced plan');

  await fresh('api-plan', { planScopes: { source: 'api', ci: 'api' } }); await reload();
  await page.getByRole('button', { name: '查看更新', exact: true }).click();
  await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).click();
  assert(!('phase' in applies.at(-1)), 'an API-only plan never asks for a prepare phase');
  scenarios.push('API-only plan keeps the single-step update');

  await fresh('legacy-plan', { planPrepare: undefined, prepared: undefined }); delete state.planPrepare; delete state.prepared; await reload();
  await page.getByRole('button', { name: '查看更新', exact: true }).click();
  await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).click();
  assert(!('phase' in applies.at(-1)), 'an older updater receives its original request');
  scenarios.push('older updater keeps the single-step update');

  await fresh('failed-prepare-plan'); await reload();
  await page.getByRole('button', { name: '查看更新', exact: true }).click();
  await page.getByRole('button', { name: '开始准备 1 个模块', exact: true }).click();
  await finish('failed');
  await page.waitForTimeout(100);
  assert(!(await dialogText()).includes('新版本已准备好'), 'a failed preparation is not shown as ready');
  assert(await page.getByRole('button', { name: '切换到新版本', exact: true }).count() === 0, 'a failed preparation offers no switch');
  assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
  scenarios.push('failed preparation offers no switch');
  return { passed: true, scenarios, submitted: applies.length, errors };
}
