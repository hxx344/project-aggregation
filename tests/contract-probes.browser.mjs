// Run with playwright-cli run-code --filename on the isolated production preview :4180.
async (page) => {
  const origin = 'http://127.0.0.1:4180', root = '/api/system/contract-probes';
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [], writes = [];
  const onError = error => errors.push(error.message);
  // playwright-cli holds native dialogs open, so the page's confirm is replaced and its messages recorded.
  const confirms = () => page.evaluate(() => window.__confirms);
  const at = offset => new Date(Date.now() + offset).toISOString();
  const run = (overrides = {}) => ({ id: '11111111-1111-4111-8111-111111111111', probe: 'bybit', mode: 'read-only', status: 'running', startedAt: at(-5000), endedAt: null, exitCode: null, phrase: null, outcome: null, error: null,
    params: { symbol: 'BZUSDT', maxNotional: '80', passiveBps: 200, allowFill: true, settleTimeoutS: 60 }, stopRequestedAt: null, forced: false, usedForLive: false, hasReport: false, log: ['[t] 读取行情'], ...overrides });
  let state = { observedAt: at(0), running: null, maintenance: false, liveWindowMs: 600000, options: { bybit: { symbols: ['CLUSDT', 'BZUSDT'] }, aster: { prefixes: [] }, canary: { symbols: ['CLUSDT', 'BZUSDT'] } }, liveBlocked: { bybit: null, aster: null, canary: null }, runs: [] };
  let refuse = null;
  const external = route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort();
  const handler = async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture' });
    if (pathname === '/api/health') return send({ status: 'ok' });
    if (pathname === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [] });
    if (pathname === '/api/system/updates') return send({ enabled: false, checking: false, modules: [] });
    if (!pathname.startsWith(root)) return send({ error: 'Outside fixture scope' }, 503);
    state.observedAt = at(0);
    if (request.method() === 'GET' && pathname === root) return send(state);
    if (request.method() === 'GET' && pathname.endsWith('/report')) return send({ id: 'x', report: { probe: 'bybit-chase', outcome: 'complete' } });
    writes.push({ pathname, body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] });
    if (refuse) return send({ error: refuse }, 409);
    if (pathname === `${root}/runs`) state = { ...state, running: run().id, runs: [run({ params: { ...run().params, ...request.postDataJSON().params } })] };
    else if (pathname.endsWith('/live')) state = { ...state, running: '22222222-2222-4222-8222-222222222222', runs: [run({ id: '22222222-2222-4222-8222-222222222222', mode: 'live', log: ['[t] 创建追价'] }), { ...state.runs[0], usedForLive: true, log: undefined }] };
    else if (pathname.endsWith('/stop')) state = { ...state, runs: [{ ...state.runs[0], stopRequestedAt: state.runs[0].stopRequestedAt ?? at(0), forced: !!request.postDataJSON().force }, ...state.runs.slice(1)] };
    return send(state, pathname.endsWith('/stop') ? 200 : 202);
  };
  const previousViewport = page.viewportSize();
  page.on('pageerror', onError);
  await page.route('**/*', external);
  await page.route(`${origin}/api/**`, handler);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/?view=contract-probes`);
    const view = page.locator('.contract-probes');
    await view.getByRole('heading', { name: '接口实测' }).waitFor();
    await page.evaluate(() => { window.__confirms = []; window.confirm = message => { window.__confirms.push(message); return true; }; });
    assert(await page.getByRole('button', { name: '接口实测' }).getAttribute('aria-current') === 'page', 'the navigation entry is current');
    assert(await view.getByText('不足三个凭据齐全的账户').isVisible(), 'ASTER without configured accounts offers no run');
    assert(await view.getByRole('button', { name: '只读检查' }).count() === 1, 'only Bybit can start');

    // Read-only check: exact whitelisted body, then the bound run shows progress and the final result.
    await view.getByLabel('标的').selectOption('BZUSDT');
    await view.getByLabel('名义金额上限').fill('80');
    await view.getByText('同时测试成交与平仓').click();
    await view.getByRole('button', { name: '只读检查' }).click();
    await view.getByText('只读检查中').waitFor();
    assert(JSON.stringify(writes[0]) === JSON.stringify({ pathname: `${root}/runs`, body: { probe: 'bybit', params: { symbol: 'BZUSDT', maxNotional: '80', passiveBps: 200, settleTimeoutS: 60, allowFill: true } }, csrf: 'fixture' }), 'start body: ' + JSON.stringify(writes[0]));
    assert(await view.getByRole('button', { name: '只读检查' }).isDisabled(), 'one run at a time');
    assert(await view.getByRole('button', { name: '开始真实运行' }).count() === 0, 'no live offer while the check runs');
    state = { ...state, running: null, runs: [run({ status: 'completed', endedAt: at(0), exitCode: 0, phrase: 'bybit-chase-BZUSDT-0.01-bps200-fill', hasReport: true })] };
    await view.getByText('只读检查通过，未发送任何写请求').waitFor({ timeout: 8000 });

    // Live needs both confirmations; it sends only the confirmation and the displayed phrase.
    const live = view.getByRole('button', { name: '开始真实运行' });
    assert(await view.getByText('bybit-chase-BZUSDT-0.01-bps200-fill').isVisible() && await view.getByText('会真实成交一笔并随后市价平仓，产生手续费').isVisible(), 'the confirmation content and the fill warning are shown');
    assert(await live.isDisabled(), 'live is disabled before confirmation');
    await view.getByLabel('我确认用真实账户发送上述委托').check();
    assert(await live.isDisabled(), 'one confirmation is not enough');
    await view.getByLabel('测试期间不在其他系统对该 Bybit 账户的这个标的下单').check();
    refuse = '有未结束的实盘执行任务，结束后再做 Bybit 真实测试';
    await live.click();
    await view.getByRole('alert').filter({ hasText: refuse }).waitFor();
    assert(state.runs.length === 1, 'a refused live request starts nothing');
    refuse = null;
    await live.click();
    await view.getByText('真实运行中').waitFor();
    assert(JSON.stringify(writes.at(-1).body) === JSON.stringify({ confirmLive: true, phrase: 'bybit-chase-BZUSDT-0.01-bps200-fill' }) && writes.at(-1).pathname.endsWith('/11111111-1111-4111-8111-111111111111/live'), 'live body: ' + JSON.stringify(writes.at(-1)));
    assert(await view.getByRole('button', { name: '开始真实运行' }).count() === 0, 'a used check offers no second live run');

    // Stop asks first; force is offered only after a stop was requested.
    assert(await view.getByRole('button', { name: '强制结束' }).count() === 0, 'force is not the first option');
    await view.getByRole('button', { name: '停止并收尾' }).click();
    await view.getByText('已请求停止，正在收尾').waitFor();
    let dialogs = await confirms();
    assert(dialogs.length === 1 && dialogs[0].includes('收尾') && JSON.stringify(writes.at(-1).body) === '{}', 'stop is confirmed and sends no force');
    await view.getByRole('button', { name: '强制结束' }).click();
    await page.waitForFunction(() => window.__confirms.length === 2);
    dialogs = await confirms();
    assert(dialogs[1].includes('跳过收尾') && writes.at(-1).body.force === true, 'force warns about residue');
    state = { ...state, running: null, runs: [{ ...state.runs[0], status: 'needs-check', endedAt: at(0), exitCode: 2, outcome: '收尾后未能确认无残留', hasReport: true }, ...state.runs.slice(1)] };
    await view.getByText('已发送过真实请求且未确认收尾正常：请到交易所核对').waitFor({ timeout: 8000 });
    assert(await view.locator('.probe-run.bad').count() === 1 && await view.getByText('结果：收尾后未能确认无残留').isVisible(), 'the final result stays on the run that was started');
    assert(await view.getByRole('heading', { name: '较早的测试' }).isVisible() && await view.locator('.probe-table tbody tr').count() === 1, 'the earlier check moves to the history');
    const download = page.waitForEvent('download');
    await view.locator('.probe-run').getByRole('button', { name: '下载报告' }).click();
    assert((await download).suggestedFilename().startsWith('contract-bybit-live-'), 'the report downloads as a file');

    // Maintenance and a server-side blocker disable starting and explain why.
    state = { ...state, maintenance: true, options: { ...state.options, aster: { prefixes: ['MA', 'SA', 'SB'] } } };
    await view.getByText('暂不能开始测试').waitFor({ timeout: 20000 });
    assert((await view.getByRole('button', { name: '只读检查' }).all()).length === 2 && await view.getByRole('button', { name: '只读检查' }).first().isDisabled(), 'maintenance disables both starts');
    state = { ...state, maintenance: false };
    await page.reload();
    await view.getByLabel('主账户').waitFor();
    await view.getByLabel('主账户').selectOption('MA'); await view.getByLabel('子账户 A').selectOption('SA'); await view.getByLabel('子账户 B').selectOption('SB');
    await view.getByRole('button', { name: '填入建议值' }).click();
    await view.getByRole('button', { name: '只读检查' }).nth(1).click();
    await page.waitForFunction(() => true);
    await view.getByText('只读检查中').waitFor();
    assert(JSON.stringify(writes.at(-1).body) === JSON.stringify({ probe: 'aster', params: { masterPrefix: 'MA', aPrefix: 'SA', bPrefix: 'SB', amount: '1', probeNonce: [-30, -59, -61, -90, -121, 61], balancerPaused: false, settleTimeoutS: 300, historyMinutes: 30 } }), 'ASTER body: ' + JSON.stringify(writes.at(-1).body));

    // Oil canary: four step buttons share one form; a check has no live offer, a preview offers live with its own confirmations.
    state = { ...state, running: null, runs: [] };
    await page.reload();
    const canary = view.locator('section').filter({ has: page.getByRole('heading', { name: '原油双腿金丝雀（新执行器）' }) });
    await canary.getByLabel('首腿交易所').waitFor();
    assert(await canary.getByLabel('首腿下单方式').isDisabled(), 'chase is offered only with a Bybit lead');
    await canary.getByRole('button', { name: '开仓预览' }).click();
    await view.getByRole('alert').filter({ hasText: '请填写每腿数量' }).waitFor();
    const before = writes.length;
    await canary.getByLabel('合约').selectOption('BZUSDT');
    await canary.getByLabel('首腿交易所').selectOption('bybit');
    await canary.getByLabel('首腿下单方式').selectOption('chase');
    await canary.getByLabel('每腿数量').fill('0.5');
    await canary.getByLabel('价格保护').fill('40');
    await canary.getByRole('button', { name: '开仓预览' }).click();
    await view.getByText('只读检查中').waitFor();
    assert(writes.length === before + 1 && JSON.stringify(writes.at(-1).body) === JSON.stringify({ probe: 'canary', params: { step: 'open', symbol: 'BZUSDT', lead: 'bybit', leadSide: 'long', leadOrder: 'chase', quantity: '0.5', perJob: '100', totalOpen: '300', timeoutS: 120, maxSlippageBps: 40 } }),
      'canary body: ' + JSON.stringify(writes.at(-1).body));
    const canaryRun = overrides => run({ id: '33333333-3333-4333-8333-333333333333', probe: 'canary', status: 'completed', endedAt: at(0), exitCode: 0, log: ['[t] Binance 账户 ***1234'],
      params: { step: 'check', symbol: 'CLUSDT', lead: 'binance', leadSide: 'long', leadOrder: 'market', quantity: '1', perJob: '100', totalOpen: '300', timeoutS: 120, maxSlippageBps: null }, ...overrides });
    state = { ...state, running: null, runs: [canaryRun({ outcome: '检查通过：账户持仓与金丝雀记录一致（Binance 0、Bybit 0）' })] };
    await canary.getByText('检查完成，未发送任何写请求').waitFor({ timeout: 20000 });
    assert(await canary.getByRole('button', { name: '开始真实运行' }).count() === 0, 'a check offers no live run');
    state = { ...state, runs: [canaryRun({ id: '44444444-4444-4444-8444-444444444444', phrase: 'oil-canary-close-CLUSDT-binance-long-market-1-0123456789', params: { ...canaryRun().params, step: 'close' } })] };
    await canary.getByText('预览完成，未发送任何写请求').waitFor({ timeout: 20000 });
    assert(await canary.getByText('平仓 · CLUSDT · 首腿 Binance（方向取金丝雀持仓） 市价 · 每腿 1 桶').isVisible(), 'the close summary names the derived direction');
    await canary.getByLabel('我确认用真实账户发送上述委托').check();
    await canary.getByLabel('测试期间旧系统（含自动规则）和人工都不对这两个账户的该合约下单').check();
    await canary.getByRole('button', { name: '开始真实运行' }).click();
    await page.waitForFunction(() => true);
    await view.getByText('真实运行中').waitFor();
    assert(JSON.stringify(writes.at(-1).body) === JSON.stringify({ confirmLive: true, phrase: 'oil-canary-close-CLUSDT-binance-long-market-1-0123456789' }), 'canary live body: ' + JSON.stringify(writes.at(-1)));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 0, `no horizontal overflow on a phone (${overflow}px)`);
    assert(errors.length === 0, 'page errors: ' + errors.join('; '));
    return { ok: true, writes: writes.length };
  } finally {
    page.off('pageerror', onError);
    await page.unroute(`${origin}/api/**`, handler); await page.unroute('**/*', external);
    if (previousViewport) await page.setViewportSize(previousViewport);
  }
}
