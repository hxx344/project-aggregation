// Run with playwright-cli run-code --filename against an isolated production preview
// (default 127.0.0.1:4175; open the session on another preview origin to override).
async (page) => {
  const origin = page.url() === 'about:blank' ? 'http://127.0.0.1:4175' : new URL(page.url()).origin;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin)) throw new Error('Update notice fixture requires an isolated local preview');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], checks = [];
  const base = () => ({ enabled: true, checking: false, checkedAt: '2026-10-23T04:00:00.000Z', checkError: null, planId: null, expiresAt: null, job: null,
    modules: [
      { id: 'workbench', name: '集序工作台', state: 'current', currentVersion: 'v1.0.0', latestVersion: 'v1.0.0', currentCommit: '1'.repeat(40), latestCommit: '1'.repeat(40) },
      { id: 'monitor', name: '市场监控', state: 'current', currentVersion: 'v2.0.0', latestVersion: 'v2.0.0', currentCommit: '3'.repeat(40), latestCommit: '3'.repeat(40) },
    ] });
  let state = base();
  const offer = async (version, commit, notes = '修复更新提醒') => {
    state = base(); state.planId = `plan-${version}`;
    state.expiresAt = new Date(await page.evaluate(() => Date.now() + 3_600_000)).toISOString();
    state.modules[0] = { ...state.modules[0], state: 'available', latestVersion: version, latestCommit: commit.repeat(40), releaseNotes: notes };
  };
  const emit = async () => {
    await page.waitForFunction(() => window.__updateStreams?.some(stream => !stream.closed));
    await page.evaluate(value => window.__updateStreams.filter(stream => !stream.closed).at(-1).emit({ type: 'snapshot', state: value }), state);
    await page.waitForTimeout(60);
  };
  const notice = () => page.getByRole('dialog', { name: '发现新版本', exact: true });
  const full = () => page.getByRole('dialog', { name: '系统更新', exact: true });

  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    window.__updateStreams = [];
    window.EventSource = class {
      constructor(url) { this.closed = false; if (url === '/api/system/updates/events') window.__updateStreams.push(this); }
      close() { this.closed = true; }
      emit(value) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(value) }); }
    };
  });
  await page.route(`${origin}/api/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'notice-fixture-csrf' });
    if (path === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [] });
    if (path === '/api/system/updates') return send(structuredClone(state));
    if (path === '/api/system/updates/check') { checks.push(path); return send(structuredClone(state), 202); }
    return send({ error: `Unexpected API ${path}` }, 404);
  });

  await page.goto(origin);
  await page.evaluate(() => localStorage.removeItem('workbench.update-notice.dismissed'));
  await page.reload();
  await page.getByRole('button', { name: '系统更新：已是最新正式版', exact: true }).waitFor();
  await emit();
  assert(await page.getByRole('dialog').count() === 0, 'no notice while every module is current');

  await offer('v1.1.0', '2'); await emit();
  await notice().waitFor();
  const text = await notice().innerText();
  assert(text.includes('1 个模块有新的正式版本') && text.includes('集序工作台') && text.includes('v1.1.0'), 'the notice names the module and the new release');
  assert(!text.includes('市场监控'), 'unchanged modules stay out of the notice');
  assert(await page.evaluate(() => document.querySelector('.update-notice')?.matches(':modal')), 'the notice is a modal dialog');
  await page.screenshot({ path: 'output/playwright/update-notice-desktop.png' });

  await notice().getByRole('button', { name: '稍后', exact: true }).click();
  assert(await page.getByRole('dialog').count() === 0, 'later closes the notice');
  await emit();
  assert(await page.getByRole('dialog').count() === 0, 'the same release is not offered again after dismissal');
  await page.reload(); await emit();
  assert(await page.getByRole('dialog').count() === 0, 'the dismissal survives a reload');
  await page.getByRole('button', { name: '系统更新：1 个可用更新', exact: true }).waitFor();

  await offer('v1.2.0', '4'); await emit();
  await notice().waitFor();
  await page.keyboard.press('Escape');
  assert(await page.getByRole('dialog').count() === 0, 'escape dismisses the notice');

  await offer('v1.3.0', '5'); await emit();
  await notice().getByRole('button', { name: '查看更新', exact: true }).click();
  await full().waitFor();
  assert(await notice().count() === 0, 'viewing the update replaces the notice with the full dialog');
  assert(await full().getByRole('button', { name: '查看更新', exact: true }).isVisible(), 'the full dialog keeps the two-step update flow');
  await offer('v1.4.0', '6'); await emit();
  assert(await notice().count() === 0, 'releases seen in the open update dialog do not pop up a notice');
  await full().getByRole('button', { name: '关闭系统更新', exact: true }).click();
  await page.waitForTimeout(60);
  assert(await page.getByRole('dialog').count() === 0, 'closing the update dialog counts the release as seen');

  await page.evaluate(() => { const d = document.createElement('dialog'); d.id = 'other-modal'; d.textContent = '下单确认'; document.body.append(d); d.showModal(); });
  await offer('v1.5.0', '7'); await emit();
  await page.waitForTimeout(300);
  assert(await notice().count() === 0, 'the notice never stacks over another open modal');
  await page.evaluate(() => { const d = document.getElementById('other-modal'); d.close(); d.remove(); });
  await notice().waitFor({ timeout: 4_000 });
  await notice().getByRole('button', { name: '关闭更新提醒', exact: true }).click();

  await offer('v1.6.0', '8');
  state.job = { id: 'job-running', status: 'running', startedAt: new Date().toISOString(), finishedAt: null, activeModule: 'workbench', message: '正在更新', steps: [] };
  await emit();
  assert(await notice().count() === 0, 'no notice while an update is already running');
  state.job = null; state.modules[0].recovery = true; await emit();
  await page.getByRole('dialog', { name: '有未完成的更新', exact: true }).waitFor();
  await page.getByRole('button', { name: '稍后', exact: true }).click();

  await offer('v1.7.0', '9'); await page.setViewportSize({ width: 390, height: 844 }); await emit();
  await notice().waitFor();
  assert(await page.locator('.update-notice').evaluate(element => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().right <= window.innerWidth), 'the mobile notice has no horizontal overflow');
  await page.screenshot({ path: 'output/playwright/update-notice-mobile.png' });
  await notice().getByRole('button', { name: '稍后', exact: true }).click();

  assert(checks.length === 0, 'the notice never triggers a release check');
  assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
  return { passed: true, scenarios: ['current no notice', 'available notice', 'later persists', 'newer release reappears', 'escape', 'view update', 'open dialog marks seen', 'other modal defers', 'running job', 'recovery title', 'mobile overflow'] };
}
