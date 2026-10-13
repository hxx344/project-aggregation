// Run with playwright-cli run-code --filename against the isolated production preview.
async (page) => {
  const origin = 'http://127.0.0.1:4175';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const firstToken = 'ghp_ui_fixture_only_12345678901234567890';
  const secondToken = 'github_pat_ui_fixture_only_09876543210987654321';
  const errors = [], writes = [], checks = [], applies = [];
  let reads = 0, tokenStatus = 200, holdToken = false, loseTokenResponse = false, holdRead = false;
  const heldTokens = [], heldReads = [];
  const initial = () => ({ enabled: true, checking: false, checkedAt: '2026-10-14T04:00:00.000Z', checkError: null,
    githubToken: { configured: false }, planId: null, expiresAt: '2026-10-14T07:00:00.000Z',
    modules: [{ id: 'workbench', name: '集序工作台', state: 'current', currentVersion: 'v1.0.0', latestVersion: 'v1.0.0', currentCommit: '1111111111111111111111111111111111111111', latestCommit: '1111111111111111111111111111111111111111' }], job: null });
  let state = initial();
  const advance = async ms => { await page.clock.runFor(ms); await page.waitForTimeout(40); };
  const openUpdates = async () => {
    if (await page.locator('.mobile-menu').isVisible()) await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await page.getByRole('button', { name: /^系统更新：/ }).click();
    await page.getByRole('dialog', { name: '系统更新', exact: true }).waitFor();
  };
  const emit = async () => {
    await page.waitForFunction(() => window.__tokenStreams?.some(stream => !stream.closed));
    await page.evaluate(value => window.__tokenStreams.filter(stream => !stream.closed).at(-1).emit({ type: 'snapshot', state: value }), state);
    await page.waitForTimeout(40);
  };
  const waitHeld = async held => {
    for (let i = 0; i < 50 && !held.length; i++) await page.waitForTimeout(10);
    assert(held.length === 1, 'the delayed response is held');
  };
  const tokenSection = page.locator('.update-token');
  const input = page.locator('#update-github-token');
  const expectEmpty = async () => assert(await input.inputValue() === '', 'the credential input is empty');
  const expectNoStoredTokens = async () => assert(await page.evaluate(tokens => {
    const persisted = JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]);
    return tokens.every(token => !persisted.includes(token) && !document.body.innerText.includes(token));
  }, [firstToken, secondToken]), 'credentials never appear in page text or browser storage');
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install({ time: new Date('2026-10-14T04:00:00Z') });
  await page.addInitScript(() => {
    window.__tokenStreams = [];
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.EventSource = class {
      constructor(url) {
        this.closed = false;
        if (url === '/api/system/updates/events') {
          window.__tokenStreams.push(this);
          this.timer = setInterval(() => this.emit({ type: 'heartbeat' }), 15_000);
        }
      }
      close() { this.closed = true; clearInterval(this.timer); }
      emit(value) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(value) }); }
    };
  });
  await page.route(`${origin}/api/**`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'token-fixture-csrf' });
    if (path === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [] });
    if (path === '/api/system/updates') {
      reads++;
      const data = structuredClone(state);
      if (holdRead) { holdRead = false; await new Promise(resolve => heldReads.push(resolve)); }
      return send(data);
    }
    if (path === '/api/system/updates/token') {
      const body = request.postDataJSON();
      writes.push({ body, csrf: request.headers()['x-csrf-token'], method: request.method() });
      assert(Object.keys(body).length === 1 && typeof body.token === 'string', 'the write contains only the submitted token');
      const status = tokenStatus; tokenStatus = 200;
      if (status !== 200) return send({ error: 'fixture failure' }, status);
      state.githubToken = { configured: !!body.token };
      const data = structuredClone(state);
      if (holdToken) { holdToken = false; await new Promise(resolve => heldTokens.push(resolve)); }
      if (loseTokenResponse) { loseTokenResponse = false; return route.abort('connectionfailed'); }
      return send(data);
    }
    if (path === '/api/system/updates/check') { checks.push(request.postDataJSON()); state.checking = true; return send(state, 202); }
    if (path === '/api/system/updates/apply') { applies.push(request.postDataJSON()); return send({ error: 'fixture does not install' }, 409); }
    return send({ error: `Unexpected API ${path}` }, 404);
  });

  await page.goto(origin);
  await page.getByRole('button', { name: '系统更新：已是最新正式版', exact: true }).waitFor();
  await emit(); await openUpdates();
  await tokenSection.getByText('未配置（可选）', { exact: true }).waitFor();
  assert(await input.getAttribute('type') === 'password', 'the token field is masked');
  assert(await input.getAttribute('autocomplete') === 'off', 'the form does not request stored credentials');
  assert(await tokenSection.getByRole('link', { name: '创建 GitHub Token', exact: true }).getAttribute('href') === 'https://github.com/settings/personal-access-tokens/new', 'token creation uses the GitHub settings page');
  assert((await tokenSection.innerText()).includes('只需公开仓库只读权限'), 'the required public read-only permissions are explained');
  assert(await tokenSection.getByRole('button', { name: '保存 Token', exact: true }).isDisabled(), 'an empty field cannot remove a token implicitly');
  await input.fill('invalid token');
  await tokenSection.getByRole('button', { name: '保存 Token', exact: true }).click();
  await tokenSection.getByRole('alert').waitFor();
  assert(writes.length === 0, 'invalid input fails before a write');

  // A pushed newer state cannot hide HTTP success or be replaced by its older response.
  await input.fill(`  ${firstToken}  `);
  holdToken = true;
  await tokenSection.getByRole('button', { name: '保存 Token', exact: true }).click({ clickCount: 2 });
  await waitHeld(heldTokens);
  assert(writes.length === 1 && writes[0].body.token === firstToken, 'save trims surrounding whitespace and submits once');
  assert(writes[0].method === 'POST' && writes[0].csrf === 'token-fixture-csrf', 'the mutation uses the existing CSRF-protected API');
  assert(await input.isDisabled(), 'pending saves prevent edits');
  assert(await page.getByRole('button', { name: '检查更新', exact: true }).isDisabled(), 'pending saves block update checks');
  state.planId = 'newer-stream-plan'; state.modules[0].state = 'available'; state.modules[0].latestVersion = 'v1.1.0'; state.modules[0].latestCommit = '2222222222222222222222222222222222222222';
  await emit();
  assert(await page.getByRole('button', { name: '查看更新', exact: true }).isDisabled(), 'a pending token write also blocks starting update review');
  assert(await input.inputValue() === `  ${firstToken}  `, 'a stream configuration flag alone does not claim save success');
  heldTokens.shift()();
  await tokenSection.getByText('Token 已保存，下次检查时生效；已有重试等待会保留。', { exact: true }).waitFor();
  await expectEmpty(); await expectNoStoredTokens();
  assert((await page.locator('.update-modules').innerText()).includes('v1.1.0'), 'the newer streamed release survives the late HTTP response');
  assert(await page.getByRole('button', { name: '查看更新', exact: true }).isEnabled(), 'update review is available after the write completes');
  await page.screenshot({ path: 'output/playwright/update-token-desktop.png' });

  // HTTP first, stream second: replacement remains a successful local action.
  await input.fill(secondToken);
  await tokenSection.getByRole('button', { name: '替换 Token', exact: true }).click();
  await tokenSection.getByText('Token 已保存，下次检查时生效；已有重试等待会保留。', { exact: true }).waitFor();
  await expectEmpty(); await emit();
  assert(writes.at(-1).body.token === secondToken, 'replacement submits the newly entered value');
  await tokenSection.getByText('已配置', { exact: true }).waitFor();
  await expectNoStoredTokens();

  // Failures stay in this section and do not mislabel the update service or check result.
  for (const [status, explanation] of [[400, 'Token 格式不正确'], [403, '保存未获授权'], [409, '正在检查版本或执行更新'], [404, '当前更新服务暂不支持 Token 配置']]) {
    await input.fill(firstToken); tokenStatus = status;
    await tokenSection.getByRole('button', { name: '替换 Token', exact: true }).click();
    await tokenSection.getByRole('alert').filter({ hasText: explanation }).waitFor();
    assert(await input.inputValue() === firstToken, 'a rejected write retains the unsaved input');
    assert((await page.locator('.update-summary').innerText()).includes('1 个可用更新'), 'token failures do not become update-check failures');
    assert(await page.getByText('先启用在线更新', { exact: true }).count() === 0, 'token endpoint failures do not claim the update service is absent');
  }

  // Closing the dialog clears the in-memory draft, even without saving.
  await page.keyboard.press('Escape'); await advance(20); await openUpdates(); await expectEmpty();
  state.checking = true; await emit();
  assert(await input.isDisabled(), 'an active check blocks token changes');
  state.checking = false;
  for (const status of ['queued', 'running']) {
    state.job = { id: 'busy-job', status, startedAt: '2026-10-14T04:00:00Z', finishedAt: null, activeModule: null, steps: [], message: '更新进行中' };
    await emit(); assert(await input.isDisabled(), 'queued and running updates block token changes');
  }
  state.job = null; await emit();
  await page.getByRole('button', { name: '关闭系统更新', exact: true }).click();
  holdRead = true; await openUpdates(); await waitHeld(heldReads);
  assert(await input.isDisabled(), 'an existing read keeps the shared request channel exclusive');
  heldReads.shift()(); await page.waitForTimeout(40);

  // Removal needs an explicit confirmation and never exposes the existing value.
  await tokenSection.getByRole('button', { name: '移除 Token', exact: true }).click();
  const beforeCancel = writes.length;
  await tokenSection.getByRole('button', { name: '取消移除', exact: true }).click();
  assert(writes.length === beforeCancel, 'cancelling removal makes no request');
  await tokenSection.getByRole('button', { name: '移除 Token', exact: true }).click();
  await tokenSection.getByRole('button', { name: '确认移除', exact: true }).click();
  await tokenSection.getByText('Token 已移除，下次检查将使用公开访问；已有重试等待会保留。', { exact: true }).waitFor();
  assert(writes.at(-1).body.token === '', 'only the explicit removal sends an empty token');
  await tokenSection.getByText('未配置（可选）', { exact: true }).waitFor(); await expectEmpty();

  // A lost response is never retried; the user can explicitly read the persisted flag.
  await input.fill(firstToken); loseTokenResponse = true;
  await tokenSection.getByRole('button', { name: '保存 Token', exact: true }).click();
  await tokenSection.getByText('保存结果尚未确认，请先刷新配置状态核对，确认后再操作。', { exact: true }).waitFor();
  const beforeRecovery = writes.length;
  await advance(16_000);
  assert(writes.length === beforeRecovery, 'a lost response does not trigger an automatic retry');
  assert(await input.isDisabled(), 'uncertain writes require a refresh before another edit');
  await tokenSection.getByRole('button', { name: '刷新配置状态', exact: true }).click();
  await tokenSection.getByText('已刷新服务器上的 Token 配置状态。', { exact: true }).waitFor();
  await tokenSection.getByText('已配置', { exact: true }).waitFor();
  assert(await input.isEnabled(), 'a successful explicit read permits another edit');
  assert(writes.length === beforeRecovery, 'refreshing configuration only reads server state');

  delete state.githubToken; await emit();
  await tokenSection.getByText('需升级更新服务', { exact: true }).waitFor();
  assert(await input.count() === 0, 'an old update service has no writable token form');
  assert(!(await tokenSection.innerText()).includes('未配置'), 'missing metadata is not misreported as an absent token');
  assert((await tokenSection.innerText()).includes('重新运行原一键部署命令'), 'old services get the first-upgrade instruction');
  state.githubToken = { configured: true }; await emit();

  // Refreshing never fills the saved token; mobile layout and draft cleanup stay usable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload(); await emit(); await openUpdates(); await expectEmpty();
  await tokenSection.getByText('已配置', { exact: true }).waitFor();
  await input.fill(secondToken);
  await expectNoStoredTokens();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile page has no horizontal overflow');
  assert(await page.locator('.update-dialog').evaluate(element => element.scrollWidth <= element.clientWidth), 'token form fits the mobile dialog');
  await tokenSection.getByRole('button', { name: '移除 Token', exact: true }).click();
  assert(await page.locator('.update-dialog').evaluate(element => element.scrollWidth <= element.clientWidth), 'removal confirmation fits the mobile dialog');
  await page.screenshot({ path: 'output/playwright/update-token-mobile.png' });
  await page.keyboard.press('Escape'); await advance(20); await openUpdates(); await expectEmpty();
  assert(await tokenSection.getByRole('button', { name: '确认移除', exact: true }).count() === 0, 'closing resets removal confirmation');

  // Authentication failure follows the existing expiry flow and unmounts credentials.
  await input.fill(firstToken); tokenStatus = 401;
  await tokenSection.getByRole('button', { name: '替换 Token', exact: true }).click();
  await page.getByRole('heading', { name: '进入工作台', exact: true }).waitFor();
  const beforeExpired = reads;
  await advance(30_000);
  assert(reads === beforeExpired, 'session expiry stops update polling');
  assert(await input.count() === 0, 'session expiry removes the credential form');
  assert(await page.evaluate(() => window.__tokenStreams.every(stream => stream.closed)), 'session expiry closes the update stream');
  await expectNoStoredTokens();
  assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
  assert(checks.length === 0 && applies.length === 0, 'token configuration never checks or installs releases');
  return { passed: true, reads, tokenWrites: writes.length, scenarios: ['save with CSRF', 'local validation', 'replacement', 'confirmed removal', 'local failures', 'session expiry', 'no saved token echo', 'close clears input', 'busy states', 'shared request channel', 'SSE before response', 'SSE after response', 'uncertain write recovery without retry', 'old update service', 'desktop and mobile layout'], screenshots: ['update-token-desktop.png', 'update-token-mobile.png'] };
}
