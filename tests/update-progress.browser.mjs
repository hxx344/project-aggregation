// Run with playwright-cli run-code --filename against a production preview on port 4188.
async (page) => {
  const origin = 'http://hub.localhost:4188';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const startedAt = '2026-10-15T08:00:00.000Z';
  const timestamp = Date.parse(startedAt) + 1000;
  const errors = [], requests = [], scenarios = [];
  let expired = false, reads = 0;
  const job = (id = 'progress-job-1') => ({ id, status: 'running', startedAt, finishedAt: null, activeModule: 'workbench', message: '更新进行中', steps: [{ id: 'workbench', name: '更新工作台', status: 'running' }] });
  let state = {
    enabled: true, checking: false, checkedAt: startedAt, checkError: null, planId: null, expiresAt: null, modules: [],
    job: { ...job(), progress: { stage: 'download', progress: 0.25, downloaded: 1024, total: 4096, speed: 2097152, eta: 21, timestamp } },
  };
  const advance = async ms => { await page.clock.runFor(ms); await page.waitForTimeout(40); };
  const emit = async () => {
    await page.waitForFunction(() => window.__progressStreams?.some(stream => !stream.closed && stream.url === '/api/system/updates/events'));
    await page.evaluate(value => window.__progressStreams.filter(stream => !stream.closed && stream.url === '/api/system/updates/events').at(-1).emit({ type: 'snapshot', state: value }), state);
    await page.waitForTimeout(40);
  };
  const openUpdates = async () => {
    // The automatic release notice is covered by update-notice.browser.mjs.
    if (await page.locator('.update-notice').count()) await page.getByRole('button', { name: '稍后', exact: true }).click();
    if (await page.locator('.mobile-menu').isVisible()) await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await page.getByRole('button', { name: /^系统更新：/ }).click();
    await page.getByRole('dialog', { name: '系统更新', exact: true }).waitFor();
  };
  const expectNoProgress = async message => assert(await page.locator('.download-progress').count() === 0, message);
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install({ time: new Date(timestamp + 10_000) });
  await page.addInitScript(() => {
    window.__progressStreams = [];
    window.EventSource = class {
      constructor(url) {
        this.url = url; this.closed = false;
        window.__progressStreams.push(this);
        if (url === '/api/system/updates/events') this.timer = setInterval(() => this.emit({ type: 'heartbeat' }), 15_000);
      }
      close() { this.closed = true; clearInterval(this.timer); }
      emit(value) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(value) }); }
    };
  });
  await page.route(`${origin}/api/**`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    requests.push({ path, method: request.method() });
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'progress-fixture-csrf' });
    if (path === '/api/overview') return send({ generatedAt: startedAt, projects: [] });
    if (path === '/api/health') return send({ ok: true });
    if (path === '/api/system/updates') { reads++; return expired ? send({ error: '登录已过期' }, 401) : send(state); }
    return send({ error: `Unexpected API ${path}` }, 404);
  });

  await page.goto(origin);
  await page.getByRole('button', { name: '系统更新：更新进行中', exact: true }).waitFor();
  await openUpdates();
  await page.locator('.download-progress').waitFor();
  assert(await page.locator('.download-progress-percent').innerText() === '本阶段 25%', 'HTTP status carries the measured download percentage');
  assert(await page.getByRole('progressbar').getAttribute('aria-valuenow') === '25', 'assistive technology receives measured progress');
  assert(await page.locator('.download-progress-speed').innerText() === '2.0 MiB/s', 'download speed uses binary byte units');
  assert(await page.locator('.download-progress-bytes').innerText() === '已下载 1.0 KiB / 4.0 KiB', 'download byte counts are visible');
  assert((await page.locator('.download-progress-eta').innerText()).includes('21秒'), 'download ETA is shown');
  scenarios.push('initial HTTP progress and accessible measured percentage');

  state.job.progress.progress = 0.5; await emit();
  assert(await page.locator('.download-progress-percent').innerText() === '本阶段 50%', 'existing status SSE updates progress');
  for (const stage of ['preflight', 'prepare', 'build', 'verify', 'extract', 'switch', 'finalize']) {
    state.job.progress = { stage, timestamp }; await emit();
    assert(await page.locator('.download-progress-message').innerText(), `${stage} has a readable phase`);
    assert(await page.locator('.download-progress-percent').innerText() === '进行中', `${stage} does not invent a percentage`);
    assert(await page.getByRole('progressbar').getAttribute('aria-valuenow') === null, `${stage} has an indeterminate progress bar without an invented percentage`);
    assert(await page.locator('.download-progress-bar-container.indeterminate').count() === 1, `${stage} keeps an active progress bar`);
    assert(await page.locator('.download-progress-speed, .download-progress-eta, .download-progress-bytes').count() === 0, `${stage} clears old download details`);
  }
  scenarios.push('source installation stages without estimated totals');

  state.job.progress = { stage: 'download', detail: 'source-receive', progress: 0.42, downloaded: 2097152, speed: 1024, eta: 30, timestamp }; await emit();
  assert(await page.locator('.download-progress-percent').innerText() === '对象接收 42%', 'Git percentage explicitly counts objects');
  assert(await page.locator('.download-progress-bytes').innerText() === '已下载 2.0 MiB', 'source bytes do not invent a total from object count');
  assert(await page.locator('.download-progress-speed').innerText() === '1.0 KiB/s', 'source measured transfer speed stays visible');
  assert(await page.locator('.download-progress-eta').count() === 0, 'unknown byte total suppresses ETA');
  state.job.progress = { stage: 'download', detail: 'source-retry', timestamp }; await emit();
  assert(await page.locator('.download-progress-message').innerText() === '正在重试源码下载…', 'retry reports the actual download phase');
  assert(await page.locator('.download-progress-speed, .download-progress-eta, .download-progress-bytes').count() === 0, 'retry clears the preceding measured transfer');
  for (const [stage, detail, message] of [['prepare', 'dependencies', '正在准备项目依赖…'], ['build', 'build-workbench', '正在构建工作台…'], ['build', 'build-aster', '正在构建 Aster 模块…'], ['verify', 'typecheck', '正在检查代码类型…'], ['finalize', 'updater', '正在安装更新服务…']]) {
    state.job.progress = { stage, detail, timestamp }; await emit();
    assert(await page.locator('.download-progress-message').innerText() === message, `${detail} reports the specific step`);
    assert(await page.getByRole('progressbar').getAttribute('aria-valuenow') === null, `${detail} remains indeterminate`);
  }
  scenarios.push('source object receipt, measured bytes, unknown ETA, retries and detailed build steps');

  for (const progress of [{ stage: 'unknown', progress: 0.5, timestamp }, { stage: 'download', progress: 1.2, timestamp }, { stage: 'download', progress: 0.5, timestamp: Date.parse(startedAt) - 1 }]) {
    state.job.progress = progress; await emit();
    await expectNoProgress('malformed or old progress is hidden');
  }
  state.job.progress = { stage: 'download', progress: 0.75, timestamp }; await emit();
  state.job = { ...job('progress-job-2'), startedAt: new Date(timestamp + 1000).toISOString() }; await emit();
  await expectNoProgress('a new job with no progress cannot retain the prior job');
  state.job.progress = { stage: 'download', progress: 0.75, timestamp }; await emit();
  await expectNoProgress('a stale preceding-job sample is rejected');
  const currentTimestamp = timestamp + 2000;
  state.job.progress = { stage: 'download', progress: 0, timestamp: currentTimestamp }; await emit();
  assert(await page.locator('.download-progress-percent').innerText() === '本阶段 0%', 'zero is a valid fresh measurement');
  for (const status of ['succeeded', 'failed', 'interrupted']) {
    state.job.status = status; await emit();
    await expectNoProgress(`${status} clears live progress`);
    assert(await page.locator('.update-progress').count() === 1, 'historical job result remains visible');
  }
  scenarios.push('malformed samples, job replacement and terminal cleanup');

  state.job.status = 'running';
  state.job.progress = { stage: 'download', progress: 0.6, downloaded: 3072, total: 5120, speed: 512, eta: 0, timestamp: currentTimestamp };
  const beforeFallback = reads;
  await page.evaluate(() => window.__progressStreams.filter(stream => !stream.closed && stream.url === '/api/system/updates/events').at(-1).onerror());
  await page.waitForFunction(() => document.querySelector('.download-progress-percent')?.textContent === '本阶段 60%');
  assert(reads > beforeFallback, 'stream failure falls back to the real status URL');
  assert((await page.locator('.download-progress-eta').innerText()).includes('不足1秒'), 'zero ETA remains visible');
  await advance(10_100);
  state.job.progress.progress = 0.8; await emit();
  assert(await page.locator('.download-progress-percent').innerText() === '本阶段 80%', 'reconnected status SSE resumes progress');
  assert(await page.evaluate(() => window.__progressStreams.filter(stream => !stream.closed && stream.url.startsWith('/api/system/updates')).length === 1), 'one update subscription remains after recovery');
  assert(await page.evaluate(() => window.__progressStreams.every(stream => stream.url !== '/api/system/updates/progress')), 'there is no separate progress connection');
  scenarios.push('status fallback, reconnect and one shared subscription');

  await page.getByRole('button', { name: '关闭系统更新', exact: true }).click();
  state.job.progress.progress = 0.9; await emit();
  await page.setViewportSize({ width: 390, height: 844 });
  await openUpdates();
  assert(await page.locator('.download-progress-percent').innerText() === '本阶段 90%', 'reopening reads current task progress');
  assert(await page.locator('.update-dialog').evaluate(element => element.scrollWidth <= element.clientWidth), 'mobile progress stays within the dialog');
  assert(await page.evaluate(() => window.__progressStreams.filter(stream => !stream.closed && stream.url.startsWith('/api/system/updates')).length === 1), 'closing and reopening does not add a progress stream');
  scenarios.push('reopen current progress and mobile layout');

  state.job.stageTimings = { entries: [
    { stage: 'preflight', durationMs: 500 }, { stage: 'download', detail: 'source-receive', durationMs: 20000 },
    { stage: 'build', detail: 'build-workbench', durationMs: 40000 }, { stage: 'finalize', detail: 'healthcheck', durationMs: 500 },
  ] };
  await emit();
  assert(await page.locator('.update-timings').count() === 0, 'running tasks do not present a completed timing summary');
  state.job.status = 'succeeded';
  state.job.message = '所选正式版本更新完成';
  state.job.finishedAt = new Date(Date.parse(state.job.startedAt) + 61000).toISOString();
  state.job.steps[0].status = 'succeeded';
  await emit();
  await expectNoProgress('completion clears live progress and retains measured stage timings');
  assert(await page.locator('.update-timing-total strong').innerText() === '1 分 1 秒', 'task total uses durable start and finish timestamps');
  assert(await page.locator('.update-timings dt').allTextContents().then(values => values.join('|')) === '更新条件检查|源码接收|工作台构建|服务健康检查', 'source completion displays recorded detail labels');
  assert(await page.locator('.update-timings dd').allTextContents().then(values => values.join('|')) === '不足 1 秒|20 秒|40 秒|不足 1 秒', 'completed phases show their actual durations');
  await page.getByText('更新已完成，正在刷新页面以载入新版本和重启后的模块连接。', { exact: true }).waitFor();
  const reloaded = page.waitForEvent('load'); await advance(1_600); await reloaded;
  await openUpdates();
  assert(await page.locator('.update-timings dt').count() === 4, 'the automatic reload obtains the completed timing summary');
  assert(await page.getByText('更新已完成，正在刷新页面以载入新版本和重启后的模块连接。', { exact: true }).count() === 0, 'a page loaded after completion does not reload again');
  await page.getByRole('button', { name: '关闭系统更新', exact: true }).click();
  await openUpdates();
  assert(await page.locator('.update-timings dt').count() === 4, 'closing and reopening preserves timings');
  await page.reload();
  await openUpdates();
  await page.locator('.update-timings').waitFor();
  assert(await page.locator('.update-timing-total strong').innerText() === '1 分 1 秒', 'reload obtains the completed timing summary from status');
  assert(await page.locator('.update-dialog').evaluate(element => element.scrollWidth <= element.clientWidth), 'mobile timing labels and durations stay inside the dialog');
  await page.screenshot({ path: 'output/playwright/update-stage-timings-mobile.png', fullPage: true });
  scenarios.push('terminal SSE summary, automatic reload, reopen, persisted HTTP reload and narrow timing layout');

  state.job.deployMode = 'ci';
  state.job.stageTimings = { entries: [{ stage: 'download', durationMs: 45000 }, { stage: 'verify', durationMs: 15000 }] };
  await emit();
  assert(await page.locator('.update-timings dt').count() === 2, 'CI results only list stages that were actually recorded');
  assert(!(await page.locator('.update-timings').innerText()).includes('构建'), 'CI results do not invent a skipped build stage');
  for (const status of ['failed', 'interrupted']) {
    state.job.status = status;
    state.job.message = status === 'failed' ? '更新未完成' : '更新进程已中断';
    state.job.stageTimings.entries[1].durationMs = null;
    await emit();
    assert(await page.locator('.update-timings dd').last().innerText() === '未完整记录', 'unclosed timing is not zero or elapsed time until recovery');
    assert(!(await page.locator('#update-progress-title').innerText()).includes('更新已完成'), 'failed and interrupted jobs remain unsuccessful');
  }
  delete state.job.stageTimings;
  await emit();
  assert(await page.locator('.update-timings dt').count() === 0, 'old tasks do not fabricate timing rows');
  assert((await page.locator('.update-timings').innerText()).includes('本次任务未记录阶段耗时'), 'legacy task timing absence is explicit');
  scenarios.push('CI skipped phases, partial failures and legacy completion');

  expired = true;
  await page.evaluate(() => window.__progressStreams.filter(stream => !stream.closed && stream.url === '/api/system/updates/events').at(-1).onerror());
  await page.getByRole('heading', { name: '进入工作台', exact: true }).waitFor();
  const afterExpired = reads;
  await advance(20_000);
  assert(reads === afterExpired, 'unmount stops update polling');
  assert(await page.evaluate(() => window.__progressStreams.filter(stream => stream.url.startsWith('/api/system/updates')).every(stream => stream.closed)), 'unmount closes all update streams');
  assert(requests.every(request => request.method === 'GET'), 'passive progress never submits update actions');
  assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
  scenarios.push('session expiry cleanup without write requests');
  return { passed: true, reads, scenarios };
}
