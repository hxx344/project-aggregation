// Run with playwright-cli run-code --filename on the isolated production preview :4180.
async (page) => {
  const origin = 'http://127.0.0.1:4180';
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  const now = new Date().toISOString();
  const project = (id, name, category, order) => ({ project: { id, name, description: '', category, adapter: 'standard', url: '', apiUrl: '', mode: 'embed', enabled: true, staleAfterSeconds: 120, order, hasCredentials: true, accessMode: 'direct' },
    state: 'online', message: '', checkedAt: now, updatedAt: now, latencyMs: 10, metrics: [] });
  const projects = [project('aster', 'Aster 5x', 'trading', 1), project('monitor', 'Market Monitor', 'monitoring', 2), project('asset', 'Asset Ledger', 'assets', 3), project('crossex', 'Gate CrossEx', 'trading', 4), project('greeks', 'Greeks', 'trading', 5), project('notes', 'Notes', 'other', 6)];
  const handler = route => {
    const pathname = new URL(route.request().url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture' });
    if (pathname === '/api/health') return send({ status: 'ok' });
    if (pathname === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects });
    if (pathname === '/api/system/updates') return send({ enabled: false, checking: false, modules: [] });
    return send({ error: 'Outside fixture scope' }, 503);
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route(`${origin}/api/**`, handler);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${origin}/`);
    const nav = page.getByRole('navigation', { name: '主导航', exact: true });
    await nav.getByRole('button', { name: /^Asset Ledger/ }).waitFor();
    const groups = await nav.getByRole('group').evaluateAll(nodes => nodes.map(node => [node.getAttribute('aria-label'), [...node.querySelectorAll('button.nav-item')].map(button => button.textContent.trim())]));
    const expected = [['总览与资产', ['总览', 'Asset Ledger']], ['市场与机会', ['Market Monitor']], ['交易中心', ['交易中心', 'Gate CrossEx']], ['策略与风险', ['Aster 5x']], ['期权', ['Greeks']], ['链上', ['Aero']], ['研究室', ['对冲成本研究']], ['其他', ['Notes']], ['系统', ['模块设置', '飞书汇总', '服务器状态', 'Agent 数据接口', '接口实测', '请求诊断']]];
    assert(JSON.stringify(groups.map(([label, items]) => [label, items.filter(text => !/^(检查更新|系统更新)/.test(text))])) === JSON.stringify(expected), `workspace groups: ${JSON.stringify(groups)}`);
    const crumb = () => page.locator('.breadcrumb').innerText();
    assert((await crumb()).includes('总览与资产'), 'overview breadcrumb names its workspace');
    await nav.getByRole('button', { name: '对冲成本研究', exact: true }).click();
    await page.getByRole('heading', { name: '对冲成本研究', exact: true }).waitFor();
    assert((await crumb()).includes('研究室'), 'research breadcrumb');
    assert(new URL(page.url()).searchParams.get('view') === 'cost-lab', 'route address is unchanged');
    assert(!errors.length, `page errors: ${errors.join('; ')}`);
  } finally {
    await page.unroute(`${origin}/api/**`, handler).catch(() => {});
  }
}
