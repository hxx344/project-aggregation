// Run with playwright-cli run-code --filename against the production preview on 4193.
// All APIs and outside origins are intercepted; no real order or credential is used.
async (page) => {
  const origin = 'http://127.0.0.1:4193', root = '/api/trading/execution/anthropic-reduction';
  if (page.url() !== 'about:blank' && new URL(page.url()).origin !== origin) throw new Error('ANT reduction fixture requires isolated localhost:4193');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const time = '2026-11-07T08:00:00.000Z', writes = [], errors = [], checks = [];
  const onError = error => errors.push(error.message);
  let revision = 0, config = null, failSave = false, failRead = false, unauthorized = false, watchFails = true;
  let phase = 'disabled', reason = null, job = null, maintenance = false;
  let nextRead = deferred(), nextWrite = null;
  const firstRead = nextRead.promise;
  const connections = ['binance', 'okx', 'hyperliquid', 'rh-lighter'].map(exchange => ({ exchange, connected: true, revision: 1, accountMode: exchange === 'hyperliquid' ? 'agent' : 'hedge', identity: null, keyLabel: null, verifiedAt: time, locked: false }));
  const snapshot = () => ({ generatedAt: time, revision, config: structuredClone(config), state: { phase, jobId: job?.id ?? null, reason, events: [], triggeredAt: job ? time : null },
    live: config ? { checkedAt: time, met: phase === 'reducing', legs: config.legs.map((leg, index) => ({ ...leg, quantity: index ? '1000' : '100', distancePercent: index ? '4' : '20' })) } : null,
    connections: structuredClone(connections), maintenance, job: structuredClone(job) });
  const trading = { mode: 'read-only', strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: time, cache: { builtAt: time, servedAt: time, rebuilding: false }, period: { days: 7, start: time, end: time }, exchanges: ['binance', 'bybit'], accounts: [], legs: [], structure: { state: 'opposed', message: '' },
    pnl: { currency: 'USDT', intervalMs: 60000, cumulativeStart: Date.parse(time), end: Date.parse(time), recordingStartedAt: Date.parse(time), pointCount: 0, points: [], latest: null, status: 'ready' }, funding: { complete: true, income: '0', expense: '0', net: '0', currency: 'USDT', events: [], pagination: { page: 0, pageSize: 50, total: 0, pages: 1 }, daily: [] } };
  const handler = async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture-ant-reduction' });
    if (url.pathname === '/api/overview/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: time })}\n\n` });
    if (url.pathname === '/api/overview' || url.pathname === '/api/projects') return send({ projects: [], generatedAt: time });
    if (url.pathname === '/api/trading') return send(trading);
    if (url.pathname === '/api/trading/execution' && method === 'GET') return send({ generatedAt: time, connections, positions: [], jobs: job ? [job] : [] });
    if (url.pathname === '/api/trading/execution/auto') return send({ generatedAt: time, maintenance: false, rules: [] });
    if (url.pathname === '/api/trading/anthropic') return watchFails ? send({ error: '夹具只读仓位暂不可用' }, 503) : send({ generatedAt: time, sources: [], alerts: { config: { enabled: false, thresholdPercent: 20, repeatMinutes: 30 }, channel: { configured: false, source: null, host: null, error: null }, history: [], error: null, staleAfterSeconds: 180, hysteresisPercent: 2 } });
    if (url.pathname === root && method === 'GET') {
      if (unauthorized) return send({ error: '登录已过期' }, 401);
      if (nextRead) { const held = nextRead; nextRead = null; held.resolve({ route, data: snapshot() }); return; }
      return failRead ? send({ error: '夹具风险读取失败' }, 503) : send(snapshot());
    }
    if ((url.pathname === root && method === 'PUT') || (url.pathname === `${root}/disable` && method === 'POST')) {
      const body = request.postDataJSON(); writes.push({ method, path: url.pathname, body });
      if (failSave) return send({ error: '夹具保存拒绝' }, 409);
      if (body.revision !== revision) return send({ error: '规则版本已变化' }, 409);
      config = url.pathname.endsWith('/disable') ? { ...config, enabled: false } : structuredClone(body.config);
      config.legs.sort((first, second) => `${first.exchange}:${first.symbol}:${first.side}`.localeCompare(`${second.exchange}:${second.symbol}:${second.side}`));
      revision++; phase = config.enabled ? 'armed' : job ? phase : 'disabled';
      if (nextWrite) { const held = nextWrite; nextWrite = null; held.resolve({ route, data: snapshot() }); return; }
      return send(snapshot());
    }
    return send({ error: `Unexpected isolated API: ${method} ${url.pathname}` }, 404);
  };
  const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const refresh = async () => {
    const response = page.waitForResponse(item => new URL(item.url()).pathname === root && item.request().method() === 'GET');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await (await response).finished(); await flush();
  };
  const release = async held => { await held.route.fulfill({ status: 200, json: held.data }); await flush(); };
  page.on('pageerror', onError);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => { localStorage.removeItem('workbench:execution-preferences:v1'); localStorage.removeItem('workbench:anthropic-shares:v1'); });
  await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?view=trading&tradingSection=legs`);
    const section = page.getByRole('region', { name: 'ANT 自动多批减仓' });
    const heldInitial = await firstRead;
    await section.getByText('正在读取自动减仓设置…').waitFor();
    assert(await section.getByRole('form').count() === 0, 'loading must not show a false disabled configuration');
    await release(heldInitial);
    const enabled = section.getByLabel('启用自动减仓', { exact: true });
    const threshold = section.getByLabel('触发阈值（距强平 %）');
    const percent = section.getByLabel('总减仓比例（%）');
    const confirm = section.getByLabel('我确认启用后按本规则自动发送双边实盘市价减仓委托');
    const saveEnabled = section.getByRole('button', { name: '保存并启用自动减仓', exact: true });
    await enabled.waitFor();
    assert(!(await enabled.isChecked()) && writes.length === 0, 'defaults are disabled and reads never write');
    assert(await threshold.inputValue() === '5' && await percent.inputValue() === '25', '5% trigger and 25% total reduction defaults');
    assert(await section.getByLabel('减仓批次数').inputValue() === '3', 'defaults to three batches');
    assert(await section.getByLabel('减仓多头合约').locator('option:checked').getAttribute('value') === 'hyperliquid:io:ANTH', 'explicit long contract identity');
    assert(await section.getByLabel('减仓空头合约').locator('option[value="hyperliquid:io:ANTH"]').getAttribute('disabled') !== null, 'cannot select the same contract twice');
    checks.push('unloaded state, default off and independent from read-only positions');

    await section.getByLabel('减仓多头合约').selectOption('binance:ANTHROPICUSDT');
    await section.getByLabel('减仓空头合约').selectOption('okx:ANTHROPICUSDT');
    await percent.fill('30'); await section.getByLabel('减仓批次数').fill('4');
    await section.getByLabel('减仓批次间隔（秒）').fill('1.001'); await enabled.check();
    assert(await saveEnabled.isDisabled(), 'live enablement needs explicit confirmation');
    await confirm.check(); await threshold.fill('6');
    assert(!(await confirm.isChecked()), 'changing a parameter invalidates prior confirmation');
    await confirm.check();
    nextRead = deferred(); const oldRead = nextRead.promise;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const heldOld = await oldRead;
    await saveEnabled.click(); await section.getByText('自动减仓已启用；达到条件后会发送实盘市价减仓委托。').waitFor();
    await release(heldOld);
    assert(await threshold.inputValue() === '6' && await percent.inputValue() === '30' && await enabled.isChecked(), 'late old GET cannot replace saved enabled config');
    assert(JSON.stringify(writes[0].body) === JSON.stringify({ revision: 0, config: { enabled: true, legs: [{ exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'long' }, { exchange: 'okx', symbol: 'ANTHROPICUSDT', side: 'short' }], shares: { outstanding: '12.7', diluted: '16.7' }, thresholdPercent: '6', reducePercent: '30', batchCount: 4, batchIntervalMs: 1001, timeoutMs: 600000 }, confirmLive: true }), `exact server payload: ${JSON.stringify(writes[0].body)}`);
    checks.push('explicit confirmation, native contract identities, total ratio, millisecond precision and stale GET protection');

    await percent.fill('40'); await refresh();
    assert(await percent.inputValue() === '40', 'polling preserves unsaved drafts');
    failSave = true; await confirm.check(); await saveEnabled.click();
    await section.getByRole('alert').filter({ hasText: '夹具保存拒绝' }).waitFor();
    await refresh();
    assert(await percent.inputValue() === '40', 'failed saves preserve the draft');
    assert(await section.getByRole('alert').filter({ hasText: '夹具保存拒绝' }).isVisible(), 'successful polling does not clear write errors');
    failSave = false; await confirm.check();
    nextWrite = deferred(); const saving = nextWrite.promise;
    await saveEnabled.click(); const heldSave = await saving;
    assert(await percent.isDisabled(), 'in-flight write disables draft edits');
    await release(heldSave); await section.getByText('自动减仓已启用；达到条件后会发送实盘市价减仓委托。').waitFor();
    checks.push('draft retention, rejected writes, durable error and in-flight edit lock');

    await section.getByLabel('减仓多头合约').selectOption('hyperliquid:io:ANTH');
    await section.getByLabel('减仓空头合约').selectOption('binance:ANTHROPICUSDT');
    await confirm.check(); await saveEnabled.click();
    await section.getByText('自动减仓已启用；达到条件后会发送实盘市价减仓委托。').waitFor();
    assert(config.legs[0].side === 'short', 'fixture uses server canonical ordering with short leg first');
    assert(await section.getByLabel('减仓多头合约').inputValue() === 'hyperliquid:io:ANTH' && await section.getByLabel('减仓空头合约').inputValue() === 'binance:ANTHROPICUSDT', 'server canonical ordering never reverses the configured directions');
    checks.push('canonical leg order preserves long and short identities');

    await page.getByRole('tab', { name: '价差下单', exact: true }).click();
    const execution = page.getByRole('region', { name: '组合交易', exact: true });
    await execution.getByRole('group', { name: '品种', exact: true }).getByRole('button', { name: 'Anthropic', exact: true }).click();
    await execution.getByLabel('流通股 · 十亿股', { exact: true }).fill('13');
    await execution.getByLabel('完全稀释股 · 十亿股', { exact: true }).fill('17');
    await page.getByRole('tab', { name: '套利仓位', exact: true }).click();
    await section.getByText('当前页面为 13B / 17B。', { exact: false }).waitFor();
    assert((await section.innerText()).includes('本规则股数快照：流通 12.7B · 完全稀释 16.7B'), 'page shares never silently mutate the armed rule snapshot');
    checks.push('immutable armed share snapshot');

    await percent.fill('45'); revision++; config = { ...config, reducePercent: '35' }; await refresh();
    await section.getByRole('alert').filter({ hasText: '服务器规则已变化' }).waitFor();
    assert(await percent.inputValue() === '45' && await saveEnabled.isDisabled(), 'external revision preserves draft and blocks overwriting newer config');
    await section.getByRole('button', { name: '放弃草稿并读取当前规则' }).click();
    await flush();
    assert(await percent.inputValue() === '35', 'explicit discard accepts current server config');

    phase = 'reducing'; revision++; job = { id: 'ant-reduce-fixture', market: 'anthropic', preset: 'cross-exchange', action: 'close', status: 'running', createdAt: time, updatedAt: time, deadlineAt: time, batchIndex: 1, batchCount: 4, reason: null, canResume: false, events: [], legs: config.legs.map((leg, index) => ({ ...leg, id: `leg-${index}`, orderSide: index ? 'buy' : 'sell', orderType: 'market', stopPrice: null, quantity: index ? '350' : '35', filledQuantity: index ? '175' : '17.5', remainingQuantity: index ? '175' : '17.5', currentOrder: null })) };
    await refresh(); await section.getByLabel('自动减仓执行进度').waitFor();
    assert((await section.getByLabel('自动减仓执行进度').innerText()).includes('第 2 / 4 批'), 'actual job batch progress is displayed');
    assert(await threshold.isDisabled() && await saveEnabled.isDisabled(), 'running job blocks configuration edits');
    await section.getByRole('button', { name: '停用新触发' }).click();
    await section.getByText('已停用新触发；在途批次不会撤销，请到「价差下单」查看或停止执行。').waitFor();
    assert(writes.at(-1).path === `${root}/disable` && Object.keys(writes.at(-1).body).join(',') === 'revision', 'disable uses current CAS revision and never posts job stop');
    assert(job.status === 'running', 'disable never pretends to stop the in-flight job');
    phase = 'review'; reason = '第 2 批结果待核对，后续批次已停止'; job.status = 'attention'; revision++; await refresh();
    await section.getByRole('alert').filter({ hasText: reason }).waitFor();
    assert(await section.getByRole('link', { name: '到价差下单核对执行' }).getAttribute('href') === '?view=trading&tradingSection=trade', 'review links to the actual execution entry');
    phase = 'completed'; reason = null; job.status = 'completed'; revision++; await refresh();
    await section.getByText('本轮完成 · 已自动停用', { exact: true }).waitFor();
    assert(!(await enabled.isChecked()), 'completion does not auto-rearm');
    checks.push('revision conflict, actual batch progress, in-flight disable, failure review and manual rearm');

    await section.getByLabel('减仓批次数').fill('200'); await section.getByLabel('减仓批次间隔（秒）').fill('600');
    await section.getByRole('alert').filter({ hasText: '最长执行时间须覆盖全部批次间隔' }).waitFor();
    assert(await section.getByRole('button', { name: '保存减仓设置' }).isDisabled(), 'impossible batch schedule is rejected before write');
    await section.getByRole('button', { name: '放弃草稿并读取当前规则' }).click();
    await enabled.check(); await confirm.check(); failRead = true; await refresh();
    await section.getByRole('alert').filter({ hasText: '夹具风险读取失败' }).waitFor();
    assert(await saveEnabled.isDisabled(), 'read failure blocks enablement until fresh server state');
    failRead = false; maintenance = true; await refresh();
    assert(await saveEnabled.isDisabled(), 'maintenance blocks enablement');
    maintenance = false; connections[0].connected = false; await refresh();
    assert(!(await confirm.isChecked()) && await saveEnabled.isDisabled(), 'connection change invalidates confirmation and blocks enablement');
    checks.push('schedule validation, read failure, maintenance and connection guards');

    watchFails = false; await refresh();
    await page.setViewportSize({ width: 390, height: 844 }); await flush();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '390px has no page-wide overflow');
    await section.screenshot({ path: 'output/playwright/trading-anthropic-reduction-mobile.png' });
    assert(!errors.length, `No uncaught browser errors: ${errors.join('; ')}`);
    checks.push('390px layout and no uncaught browser errors');
    unauthorized = true; await refresh();
    await page.getByRole('heading', { name: '进入工作台', exact: true }).waitFor();
    checks.push('401 expires the session');
    return { passed: true, checks, writes: writes.length };
  } finally {
    await page.goto('about:blank'); page.off('pageerror', onError); await page.unroute('**/*', handler);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}
