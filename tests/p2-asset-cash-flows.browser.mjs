// Existing isolated Hub + production Asset + temporary SQLite fixture at :39153.
// playwright-cli -s=p2-asset open about:blank
// playwright-cli -s=p2-asset run-code --filename tests/p2-asset-cash-flows.browser.mjs
// Writes only prefixed synthetic annotations to the fixture database; never contacts an exchange.
async page => {
  const origin = 'http://hub.localhost:39153', run = 'p2-browser-' + Date.now().toString(36);
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const day = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10), today = day(Date.now()), yesterday = day(Date.now() - 86400000);
  const requests = [], errors = [], external = [], unexpectedWrites = [], scenarios = [];
  const onError = error => errors.push(error.message);
  const handler = async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.port !== '39153' || !(url.hostname === 'hub.localhost' || /^p-[a-f0-9]{24}\.hub\.localhost$/.test(url.hostname))) { external.push(url.href); return route.abort('blockedbyclient'); }
    requests.push({ method, path: url.pathname, origin: url.origin });
    if (!['GET', 'HEAD'].includes(method)) {
      const allowed = method === 'POST' && (url.origin === origin ? url.pathname === '/api/login' || /^\/api\/projects\/(?:asset|aster|monitor|crossex|greeks)\/(?:launch|check)$/.test(url.pathname) : ['/api/cash-flows', '/api/sync'].includes(url.pathname));
      if (!allowed) { unexpectedWrites.push(`${method} ${url.href}`); return route.fulfill({ status: 405, json: { error: 'P2 fixture blocks this write' } }); }
    }
    return route.continue();
  };
  await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' }); await page.setViewportSize({ width: 1440, height: 1050 });
  page.on('pageerror', onError); await page.route('**/*', handler);
  try {
    await page.goto(origin + '/?view=project&id=asset');
    const password = page.getByRole('textbox', { name: '工作台密码', exact: true }), iframe = page.locator('iframe[title="Asset Ledger模块"]');
    await Promise.race([password.waitFor(), iframe.waitFor()]);
    if (await password.isVisible()) { await password.fill('asset-performance-browser-fixture'); await page.getByRole('button', { name: '登录', exact: true }).click(); }
    await iframe.waitFor({ timeout: 20000 });
    const app = page.frameLocator('iframe[title="Asset Ledger模块"]'); await app.getByRole('heading', { name: '资产总览', exact: true }).waitFor({ timeout: 20000 });
    const moduleOrigin = new URL(await iframe.getAttribute('src'), origin).origin, frame = page.frames().find(candidate => candidate.url().startsWith(moduleOrigin + '/'));
    assert(frame, 'real Asset iframe is loaded');
    const daily = app.locator('details.daily-changes'); await daily.locator(':scope > summary').click();
    const panel = daily.getByRole('region', { name: '净资金流标注', exact: true });
    await panel.getByRole('button', { name: '登记资金流', exact: true }).waitFor();
    const activeRows = () => panel.locator(':scope > ol > li');
    const save = async () => {
      const responsePromise = page.waitForResponse(response => new URL(response.url()).origin === moduleOrigin && new URL(response.url()).pathname === '/api/cash-flows' && response.request().method() === 'POST');
      await panel.getByRole('button', { name: '保存标注', exact: true }).click();
      const response = await responsePromise, audit = await response.json(); assert(response.status() === 200 && Array.isArray(audit), `annotation save failed: ${JSON.stringify(audit)}`);
      await panel.locator('form').waitFor({ state: 'hidden' }); return audit;
    };
    const create = async ({ account, amount, reference, kind = 'external', transferId = '', date = today }) => {
      await panel.getByRole('button', { name: '登记资金流', exact: true }).click();
      await panel.getByLabel('业务日期', { exact: true }).fill(date);
      await panel.getByLabel('账户标识', { exact: true }).fill(account);
      await panel.getByLabel('原币金额（流出为负）', { exact: true }).fill(amount);
      await panel.locator('form select').selectOption(kind);
      if (kind === 'internal') await panel.getByLabel('内部转账配对编号', { exact: true }).fill(transferId);
      await panel.getByLabel('原始凭证引用', { exact: true }).fill(reference);
      await panel.getByLabel('登记或修改原因', { exact: true }).fill(run + ' 合成凭证登记');
      return save();
    };
    const depositReference = run + '-deposit-receipt';
    let audit = await create({ account: run + '-bank', amount: '100', reference: depositReference });
    const deposit = audit.find(row => row.reference === depositReference); assert(deposit && deposit.revision === 1 && deposit.amount === '100', 'real API persisted original USD100 annotation');
    let depositRow = activeRows().filter({ hasText: depositReference }); await depositRow.waitFor();
    assert((await depositRow.innerText()).includes('外部资金流 USD 100'), 'deposit is labelled as external flow');
    const report = await frame.evaluate(async () => (await fetch('/api/daily-changes')).json());
    const interval = report.days.find(item => item.attribution.cashFlows.rows.some(row => row.id === deposit.id));
    assert(interval && interval.attribution.cashFlows.rows.find(row => row.id === deposit.id).usdValue === 100, 'real daily attribution includes deposit evidence');
    assert(Math.abs(interval.change - (interval.withdrawnChange + (interval.attribution.cashFlows.knownNetUsd ?? 0) + (interval.attribution.knownPositionChange ?? 0) + interval.attribution.unexplained)) < 0.000001, 'real day components reconcile to total change');
    scenarios.push('real Hub login + production Asset + SQLite: external USD100 is separately attributed and day components reconcile');
    await depositRow.getByRole('button', { name: '修改/作废', exact: true }).click();
    await panel.getByLabel('原币金额（流出为负）', { exact: true }).fill('120'); await panel.getByLabel('登记或修改原因', { exact: true }).fill(run + ' 修订金额');
    audit = await save(); assert(audit.filter(row => row.id === deposit.id).map(row => row.amount).join(',') === '100,120', 'revision keeps original amount');
    depositRow = activeRows().filter({ hasText: depositReference }); await depositRow.getByRole('button', { name: '修改/作废', exact: true }).click();
    await panel.getByLabel('作废本条（保留历史）', { exact: true }).check(); await panel.getByLabel('登记或修改原因', { exact: true }).fill(run + ' 作废合成记录');
    audit = await save(); assert(audit.filter(row => row.id === deposit.id).length === 3 && audit.findLast(row => row.id === deposit.id).void, 'void appends the third version');
    assert(await activeRows().filter({ hasText: depositReference }).count() === 0, 'voided deposit no longer contributes');
    await panel.getByText('作废审计记录', { exact: true }).click();
    const voided = panel.locator(':scope > details > ul > li').filter({ hasText: deposit.id }); await voided.getByText('完整审计历史', { exact: true }).click();
    const history = await voided.innerText();
    assert(['v1', 'v2', 'v3', depositReference, today, 'USD 汇率', '100 USD', '120 USD', '修订金额', '作废合成记录'].every(text => history.includes(text)), `complete audit survives void: ${history}`);
    await voided.screenshot({ path: 'output/playwright/p2-asset/voided-audit.png' });
    scenarios.push('edit/void preserve and display original reference, date, FX fields and all three audit revisions');
    const pairId = run + '-same-day-pair', outReference = run + '-out', inReference = run + '-in';
    await create({ account: run + '-account-a', amount: '-10', reference: outReference, kind: 'internal', transferId: pairId });
    assert((await activeRows().filter({ hasText: outReference }).innerText()).includes('待配对'), 'single-sided internal flow waits for matching evidence');
    await create({ account: run + '-account-b', amount: '10', reference: inReference, kind: 'internal', transferId: pairId });
    for (const reference of [outReference, inReference]) assert((await activeRows().filter({ hasText: reference }).innerText()).includes('已配对，净贡献 0'), 'both equal opposite entries pair exactly once with zero net contribution');
    const pairedReport = await frame.evaluate(async () => (await fetch('/api/daily-changes')).json());
    const paired = pairedReport.days.flatMap(item => item.attribution.cashFlows.rows).filter(row => row.transferId === pairId);
    assert(paired.length === 2 && paired.every(row => row.status === 'paired') && paired.reduce((sum, row) => sum + row.usdValue, 0) === 0, 'real daily service confirms a single pair with net zero');
    const crossPair = run + '-cross-day';
    await create({ account: run + '-account-c', amount: '-10', reference: run + '-cross-out', kind: 'internal', transferId: crossPair });
    await create({ account: run + '-account-d', amount: '10', reference: run + '-cross-in', kind: 'internal', transferId: crossPair, date: yesterday });
    for (const reference of [run + '-cross-out', run + '-cross-in']) assert((await activeRows().filter({ hasText: reference }).innerText()).includes('待配对'), 'cross-day records stay pending instead of being auto-matched');
    scenarios.push('same-day ±10 internal pair contributes zero; single-side and cross-day records remain pending');
    const beforeHistoryReads = requests.filter(request => request.path === '/api/hub/fills').length;
    const diagnostic = await frame.evaluate(async () => (await fetch('/api/hub/fills/diagnostics')).json());
    assert(diagnostic.version === 1 && diagnostic.window === 'retained-entry-lifetime' && Array.isArray(diagnostic.groups), 'bounded diagnostics endpoint is available from the real authenticated Asset session');
    assert(requests.filter(request => request.path === '/api/hub/fills').length === beforeHistoryReads, 'reading diagnostics does not start a history request');
    await panel.screenshot({ path: 'output/playwright/p2-asset/cash-flow-pairing.png' });
    assert(!external.length && !unexpectedWrites.length && !errors.length, JSON.stringify({ external, unexpectedWrites, errors }));
    return { passed: true, run, scenarios, annotationWrites: requests.filter(request => request.path === '/api/cash-flows' && request.method === 'POST').length, diagnosticsGroups: diagnostic.groups.length, errors, external };
  } catch (error) {
    await page.screenshot({ path: 'output/playwright/p2-asset/failure.png', fullPage: true }).catch(() => {});
    throw new Error(`${error.message}\n${JSON.stringify({ errors, recentRequests: requests.slice(-12), body: (await page.locator('body').innerText()).slice(0, 3000) })}`);
  } finally { page.off('pageerror', onError); await page.goto('about:blank').catch(() => {}); await page.unroute('**/*', handler); }
}
