// Use tests/fixtures/aster-notices-workbench.mjs on 39152 after rebuilding ASTER.
// playwright-cli -s=p2-aster run-code --filename tests/p2-aster-margin.browser.mjs
async page => {
  const origin = 'http://hub.localhost:39152', now = Date.now() / 1000, writes = [], errors = [], external = [];
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const pair = { id: 'gold', name: '归档核对夹具', long_account_id: 'a', short_account_id: 'b', symbol: 'XAUUSD1', enabled: false, revision: 1,
    margin: { enabled: true, master_env_prefix: '', check_interval_seconds: 5, threshold: '10', min_transfer: '1', max_transfer: '1000', buffer_ratio: '0.05', cooldown_seconds: 30, absolute_reserve_enabled: false, long_reserve: '0', short_reserve: '0' },
    state: { phase: 'paused', updated_at: now, reason: '隔离夹具', margin: { running: false, status: 'paused' }, adl: { incident: null, configuration_locked: false, report_available: false, monitoring: { status: 'disabled' } } } };
  const accounts = ['a', 'b'].map(id => ({ id, name: `账户 ${id}`, pair_id: 'gold', mode: 'paper', env_prefix: `FIXTURE_${id.toUpperCase()}`, enabled: false, status: 'paused', credential_ready: false, strategies: {}, policy: { threshold: '50000', order_notional: '1000', margin_limit: '0.5', spread_limit: '0.0005', min_open_leverage: 5, ordinary_symbol: 'all', symbols: ['XAUUSD1'] } }));
  const entry = { request_id: 'original-request', original: { amount: '2', source: 'long', destination: 'short', created_at: now - 120 }, basis: '流水读取失败，到账结果未知', shared_outcome: 'rejected', settled_at: now - 10, receipts: [], notes: [] };
  let failArchive = false;
  const handler = async route => {
    const request = route.request(), url = new URL(request.url()), module = url.origin !== origin;
    if (url.port !== '39152' || !(url.hostname === 'hub.localhost' || /^p-[a-f0-9]+\.hub\.localhost$/.test(url.hostname))) { external.push(url.href); return route.abort('blockedbyclient'); }
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (module && url.pathname === '/api/state') return send({ workspaceManaged: true, ready: true, demo: false, accounts, pairs: [pair], markets: {}, events: [], updated_at: Date.now() / 1000 });
    if (module && url.pathname === '/api/pairs/supported-symbols') return send({ symbols: [{ symbol: 'XAUUSD1', display_name: '黄金 XAUUSD1' }] });
    if (module && url.pathname === '/api/pairs/gold/margin-archive') return failArchive ? send({ detail: '读取失败' }, 503) : send({ items: [entry], next: null, notice: '共享 rejected 不代表交易所明确拒绝' });
    if (module && url.pathname === '/api/pairs/gold/margin-archive/original-request/notes' && request.method() === 'POST') {
      const body = request.postDataJSON(); assert(Object.keys(body).sort().join(',') === 'note,source', 'note request cannot modify settlement'); writes.push('note');
      entry.notes.push({ id: 'review', at: now, actor: 'authenticated_admin', note: body.note, source: body.source }); return send({ ok: true });
    }
    if (module && url.pathname === '/api/pairs/gold' && request.method() === 'PATCH') {
      const body = request.postDataJSON(); writes.push('config'); Object.assign(pair.margin, body.margin); return send({ ok: true, pair });
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      if (!module && (url.pathname === '/api/login' || /^\/api\/projects\/(?:aster|asset|monitor|crossex|greeks)\/(?:launch|check)$/.test(url.pathname))) return route.continue();
      writes.push(`unexpected:${url.pathname}`); return send({ error: 'Execution forbidden' }, 405);
    }
    return route.continue();
  };
  const onError = error => errors.push(error.message); page.on('pageerror', onError); await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?view=project&id=aster`); const iframe = page.locator('iframe[title="Aster 5x模块"]'), password = page.getByRole('textbox', { name: '工作台密码', exact: true });
    await password.or(iframe).first().waitFor(); if (await password.isVisible()) { await password.fill('aster-notices-browser-fixture'); await page.getByRole('button', { name: '登录', exact: true }).click(); }
    await iframe.waitFor(); const app = page.frameLocator('iframe[title="Aster 5x模块"]'); await app.getByRole('tab', { name: '配对组', exact: true }).click();
    await app.getByText('划转归档核对', { exact: true }).click(); await app.getByText('流水读取失败，到账结果未知', { exact: false }).waitFor();
    await app.getByRole('button', { name: '记录核对备注' }).click(); await app.getByLabel('核对说明', { exact: true }).fill('已咨询客服'); await app.getByLabel('证据来源（勿填写凭据）').fill('工单123');
    await app.getByRole('button', { name: '保存人工备注' }).click(); await app.getByText('已咨询客服', { exact: false }).waitFor(); assert(entry.shared_outcome === 'rejected', 'note preserves original settlement');
    await app.getByText('配对组设置', { exact: false }).first().click(); await app.getByLabel('启用两侧绝对保留金额').check();
    await app.getByLabel('A 多侧最低保留', { exact: false }).fill('150'); await app.getByLabel('B 空侧最低保留', { exact: false }).fill('250');
    await app.getByRole('button', { name: '保存设置，保持暂停', exact: true }).click();
    await app.getByText('绝对保留：A 多侧 150 USD1 · B 空侧 250 USD1', { exact: false }).waitFor();
    failArchive = true; await app.getByText('划转归档核对', { exact: true }).click(); await app.getByText('划转归档核对', { exact: true }).click();
    await app.getByText('归档读取失败，到账结果未知', { exact: true }).waitFor();
    assert(writes.join(',') === 'note,config', `only notes/config writes: ${writes}`); assert(!errors.length && !external.length, `errors/external: ${errors};${external}`);
    return { passed: true, writes, browserErrors: 0, external: 0 };
  } finally { page.off('pageerror', onError); await page.unroute('**/*', handler); }
}
