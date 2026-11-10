// Run against the isolated workbench preview on port 4175 (scripts/preview-position-metrics.mjs, after `pnpm run build`):
// playwright-cli -s=agent-feed run-code --filename tests/agent-feed.browser.mjs
// Every API is an isolated fixture; no token here is a real one.
async (page) => {
  const origin = 'http://hub.localhost:4175', root = '/api/system/agent-feed';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const secret = `paf_${'A'.repeat(43)}`, checks = [], errors = [], writes = [];
  let tokens = [{ id: '00000000-0000-4000-8000-000000000001', label: '旧令牌', scopes: ['system'], createdAt: '2026-11-01T00:00:00.000Z', lastUsedAt: null }];
  let maxTokens = 8, failCreate = false;
  const state = () => ({ schemaVersion: 1, tokens, corrupt: false, maxTokens, scopes: ['public', 'system'], requestsPerMinute: 120,
    datasets: [{ id: 'system.host', scope: 'system', title: '服务器负载' }, { id: 'market.monitor', scope: 'public', title: 'Monitor 行情指标' }] });
  const handler = async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'agent-feed-browser-fixture' });
    if (url.pathname === '/api/overview') return send({ projects: [], generatedAt: new Date().toISOString() });
    if (url.pathname === root && method === 'GET') return send(state());
    if (url.pathname === `${root}/tokens` && method === 'POST') {
      const body = request.postDataJSON(); writes.push(['create', body, request.headers()['x-csrf-token']]);
      if (failCreate) return send({ error: '已有同名令牌' }, 409);
      const entry = { id: '00000000-0000-4000-8000-000000000002', label: body.label, scopes: body.scopes, createdAt: new Date().toISOString(), lastUsedAt: null };
      tokens = [...tokens, entry]; return send({ token: secret, entry }, 201);
    }
    if (url.pathname.startsWith(`${root}/tokens/`) && method === 'DELETE') {
      const id = url.pathname.slice(`${root}/tokens/`.length); writes.push(['revoke', id]); tokens = tokens.filter(item => item.id !== id); return send({ revoked: true });
    }
    return send({ error: 'isolated fixture' }, 404);
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?view=agent-feed`);
    const name = page.getByPlaceholder('例如：巡检 agent'), create = page.getByRole('button', { name: '生成令牌', exact: true });
    await name.waitFor();
    await page.getByRole('cell', { name: '旧令牌', exact: true }).waitFor();
    assert(await create.isDisabled(), 'a token needs a name');
    assert(await page.getByText('system.host', { exact: true }).count() === 1 && await page.getByText('market.monitor', { exact: true }).count() === 1, 'the datasets are listed');
    checks.push('list and datasets');

    // No scope chosen: nothing can be created.
    await name.fill('  巡检 agent  ');
    const publicScope = page.getByRole('checkbox', { name: /公开行情/ }), systemScope = page.getByRole('checkbox', { name: /系统状态/ });
    await publicScope.uncheck(); await systemScope.uncheck();
    assert(await create.isDisabled(), 'a token needs a scope');
    await publicScope.check(); await create.click();
    await page.getByRole('heading', { name: '令牌「巡检 agent」已创建' }).waitFor();
    assert(JSON.stringify(writes[0]) === JSON.stringify(['create', { label: '巡检 agent', scopes: ['public'] }, 'agent-feed-browser-fixture']), 'the trimmed name and the chosen scope are sent with the CSRF token');
    assert(await page.getByText(secret, { exact: true }).count() === 1, 'the new token is shown');
    assert((await page.locator('.af-token').nth(1).textContent()).includes(`Bearer ${secret}`), 'the example uses the new token');
    assert(await name.inputValue() === '', 'the form is cleared');
    await page.getByRole('cell', { name: '巡检 agent', exact: true }).waitFor();
    checks.push('create shows the token once');

    // Dismissed: the token is gone from the page, and a reload cannot bring it back.
    await page.getByRole('button', { name: '我已保存', exact: true }).click();
    assert(!(await page.content()).includes(secret), 'a dismissed token leaves the page');
    await page.reload(); await name.waitFor();
    await page.getByRole('cell', { name: '巡检 agent', exact: true }).waitFor();
    assert(!(await page.content()).includes(secret), 'a reload does not show the token');
    checks.push('token is not shown again');

    // A refused create keeps what was typed and says why.
    failCreate = true; await name.fill('巡检 agent'); await create.click();
    await page.getByRole('alert').filter({ hasText: '已有同名令牌' }).waitFor();
    assert(await name.inputValue() === '巡检 agent', 'the name survives a refused create');
    failCreate = false;
    checks.push('refused create');

    // Revoking asks first; declining sends nothing.
    const revoke = page.getByRole('row', { name: /旧令牌/ }).getByRole('button', { name: '撤销' });
    page.once('dialog', dialog => dialog.dismiss()); await revoke.click();
    assert(!writes.some(([kind]) => kind === 'revoke'), 'a declined confirmation revokes nothing');
    page.once('dialog', dialog => dialog.accept()); await revoke.click();
    await page.getByRole('cell', { name: '旧令牌', exact: true }).waitFor({ state: 'detached' });
    assert(JSON.stringify(writes.at(-1)) === JSON.stringify(['revoke', '00000000-0000-4000-8000-000000000001']), 'the chosen token is revoked');
    checks.push('revoke after confirmation');

    // At the limit the form explains why it is disabled.
    maxTokens = 1; await page.reload(); await name.waitFor(); await name.fill('再来一个');
    await page.getByText('已达上限，请先撤销不用的令牌', { exact: true }).waitFor();
    assert(await create.isDisabled(), 'no token past the limit');
    checks.push('limit');
    assert(!errors.length, `page errors: ${errors.join('; ')}`);
    return { ok: true, checks };
  } finally { await page.unroute('**/*', handler); }
}
