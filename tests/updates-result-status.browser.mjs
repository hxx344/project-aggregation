// Run with playwright-cli run-code --filename against a production preview on port 4187.
async (page) => {
  const origin = 'http://hub.localhost:4187';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const applies = [], checks = [], errors = [], scenarios = [];
  const version = '2222222222222222222222222222222222222222';
  const timestamp = '2026-10-15T08:00:00.000Z';
  const job = (status, message = '') => ({
    id: `previous-${status}`, status, startedAt: '2026-10-15T07:50:00.000Z', finishedAt: timestamp,
    activeModule: 'workbench', message,
    steps: [{ id: 'workbench', name: '更新集序工作台', status: status === 'failed' ? 'failed' : 'pending', message }],
  });
  const current = status => ({
    enabled: true, checking: false, checkedAt: timestamp, checkError: null, planId: null,
    expiresAt: '2026-10-15T09:00:00.000Z', job: status ? job(status) : null,
    modules: [{ id: 'workbench', name: '集序工作台', state: 'current', currentVersion: 'v1.1.0', latestVersion: 'v1.1.0', currentCommit: version, latestCommit: version }],
  });
  let state = current('failed');
  const emit = async () => {
    await page.waitForFunction(() => window.__resultStreams?.some(stream => !stream.closed));
    await page.evaluate(value => window.__resultStreams.filter(stream => !stream.closed).at(-1).emit({ type: 'snapshot', state: value }), state);
    await page.waitForTimeout(40);
  };
  const expectSummary = async text => {
    await page.locator('.update-summary').getByText(text, { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: `系统更新：${text}`, exact: true }).count() === 1, 'navigation and dialog share the update result');
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install({ time: new Date(timestamp) });
  await page.addInitScript(() => {
    window.__resultStreams = [];
    window.EventSource = class {
      constructor(url) {
        this.closed = false;
        if (url === '/api/system/updates/events') {
          window.__resultStreams.push(this);
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
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'result-fixture-csrf' });
    if (path === '/api/overview') return send({ generatedAt: timestamp, projects: [] });
    if (path === '/api/health') return send({ ok: true });
    if (path === '/api/system/updates') return send(state);
    if (path === '/api/system/updates/check') { checks.push(request.postDataJSON()); return send(state); }
    if (path === '/api/system/updates/apply') {
      const body = request.postDataJSON();
      applies.push({ body, csrf: request.headers()['x-csrf-token'] });
      assert(Object.keys(body).length === 1 && body.planId === state.planId, 'recovery submits only the server plan id');
      state.job = { ...job('queued', '恢复任务已接受'), id: 'accepted-recovery', finishedAt: null };
      return send(state, 202);
    }
    return send({ error: `Unexpected API ${path}` }, 404);
  });

  await page.goto(origin);
  await page.getByRole('button', { name: '系统更新：版本已对齐，上次更新未完成', exact: true }).waitFor();
  await emit();
  await page.getByRole('button', { name: /^系统更新：/ }).click();
  await page.getByRole('dialog', { name: '系统更新', exact: true }).waitFor();
  for (const [status, label] of [['failed', '上次更新未完成'], ['interrupted', '上次更新已中断']]) {
    state = current(status); await emit();
    await expectSummary(`版本已对齐，${label}`);
    await page.getByRole('heading', { name: label, exact: true }).waitFor();
    assert(await page.locator('.update-summary.attention').count() === 1, 'matching commits cannot turn an unfinished task into green success');
    assert(await page.locator('.update-tag.current').count() === 0, 'module versions do not claim completed installation');
    assert(await page.locator('.update-tag').innerText() === '版本已对齐', 'matching module versions remain visible');
    assert(!(await page.locator('.update-progress').innerText()).includes('正在处理'), 'a historical active module is not presented as currently running');
    assert(await page.locator('.update-footer .primary').count() === 0, 'a failure alone cannot invent an executable recovery plan');
    scenarios.push(`aligned versions with historical ${status}`);
  }

  state = current('failed');
  state.job = { ...job('failed', '旧目标 v0.9.0 安装失败'), startedAt: '2026-10-13T07:50:00.000Z', finishedAt: '2026-10-13T08:00:00.000Z' };
  await emit();
  await expectSummary('版本已对齐，上次更新未完成');
  assert((await page.locator('.update-progress').innerText()).includes('旧目标 v0.9.0 安装失败'), 'the original historical reason remains visible');
  await page.getByText('此处保留上次更新结果，当前版本见下方“本机模块”。', { exact: true }).waitFor();
  assert((await page.locator('.update-versions').innerText()).includes('v1.1.0'), 'a failed older target does not replace the current installed identity');
  scenarios.push('older failed target remains historical');

  state = current('failed');
  state.planId = 'recovery-plan';
  state.modules[0] = { ...state.modules[0], state: 'available', recovery: true, reason: '安装收尾未完成，需要恢复更新。' };
  await emit();
  await expectSummary('1 个待完成更新');
  assert(await page.locator('.update-tag').innerText() === '待完成更新', 'server recovery is distinguished from a new version');
  await page.getByRole('button', { name: '恢复未完成更新', exact: true }).click();
  await page.getByRole('heading', { name: '确认本次更新', exact: true }).waitFor();
  assert(applies.length === 0, 'opening a recovery review does not submit');
  assert((await page.locator('.update-review').innerText()).includes('集序工作台 将恢复未完成的更新'), 'confirmation explains the recovery scope');
  await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).click({ clickCount: 2 });
  await page.getByRole('heading', { name: '更新已排队', exact: true }).waitFor();
  assert(applies.length === 1 && applies[0].csrf === 'result-fixture-csrf', 'recovery requires confirmation, preserves CSRF and rejects double submission');
  assert(await page.locator('.update-footer .primary').isDisabled(), 'accepted recovery remains locked');
  state.job = { ...state.job, status: 'failed', finishedAt: timestamp };
  await emit();
  await page.getByRole('heading', { name: '上次更新未完成', exact: true }).waitFor();
  assert(await page.getByRole('button', { name: '请先重新检查', exact: true }).isDisabled(), 'recovery flag never unlocks a submitted plan after failure');
  scenarios.push('recovery confirmation, CSRF, double-click and submitted-plan lock');

  state.planId = 'new-recovery-plan'; await emit();
  await page.getByRole('button', { name: '恢复未完成更新', exact: true }).click();
  state.planId = 'replacement-recovery-plan'; await emit();
  assert(await page.getByRole('button', { name: '确认更新 1 个模块', exact: true }).isDisabled(), 'recovery still rejects a replaced confirmation');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  state = current(); state.job = { ...job('succeeded', '所有变更模块更新完成'), steps: [] }; await emit();
  await expectSummary('已是最新正式版');
  assert(await page.locator('.update-tag.current').count() === 1, 'successful recovery restores the normal current-version indicator');
  assert(checks.length === 0 && applies.length === 1, 'state updates never check or apply automatically');
  assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
  scenarios.push('changed recovery plan protection and successful result');
  return { passed: true, scenarios, confirmedUpdates: applies.length, errors };
}
