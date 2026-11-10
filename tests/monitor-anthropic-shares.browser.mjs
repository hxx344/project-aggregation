// Root production preview on 4187; Monitor tests/ssr-browser-server.mjs on 3197.
// playwright-cli run-code --filename tests/monitor-anthropic-shares.browser.mjs
// Real production host + SSR module bridge. All APIs/outside origins are isolated;
// the only permitted POST launches the fixture iframe, never an account operation.
async page => {
  const origin = 'http://hub.localhost:4187', moduleOrigin = 'http://p-0123456789abcdef01234567.hub.localhost:4187';
  const monitorBuild = 'http://127.0.0.1:3197', key = 'workbench:anthropic-shares:v1';
  const day = 86_400_000, step = 900_000, now = Date.now(), end = Math.floor(now / step) * step - step;
  const stamp = new Date(now).toISOString(), iso = time => new Date(time).toISOString();
  const check = (value, message) => { if (!value) throw new Error(message); };
  const exact = value => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const waitText = async (locator, expected) => { await locator.filter({ hasText: exact(expected) }).waitFor(); check(await locator.innerText() === expected, `Expected ${expected}; got ${await locator.innerText()}`); };
  const project = { id: 'monitor', name: 'monitor', description: '', category: 'monitoring', adapter: 'monitor', enabled: true, embedded: true, accessMode: 'proxy', apiUrl: 'http://127.0.0.1:9000', url: '', mode: 'embed', hasCredentials: true, revision: 'ant-shares-fixture', staleAfterSeconds: 120, order: 0 };
  const overview = { generatedAt: stamp, projects: [{ project, state: 'online', freshness: 'static', message: '', checkedAt: null, updatedAt: null, latencyMs: 1, diagnostics: [], metrics: [] }] };
  // Independently known results: S=10/F=20 -> 120 vs 80/100/40 -> 50/20/200%.
  // S=12/F=30 -> 100 vs 80/(2000/30)/(800/30) -> 25/50/275%.
  // S=15/F=30 -> 80 vs 80/(2000/30)/(800/30) -> 0/20/200%.
  const samples = Array.from({ length: 40 * 96 }, (_, index) => ({ time: end - (40 * 96 - 1 - index) * step, binance: 1200, xyz: 80, io: 2000, rh: 800 }));
  const candles = { status: 'live', metadata: { source: 'Binance + Hyperliquid + rh-Lighter', symbols: ['ANTHROPICUSDT', 'xyz:ANT', 'io:ANTH', 'ANTHROPIC'], interval: '15m', timezone: 'UTC', priceBasis: 'Completed 15-minute candle closes', fetchedAt: stamp, firstObservation: iso(samples[0].time), lastObservation: iso(end), rows: samples.length, errors: {} }, data: samples };
  const quote = { fetchedAt: stamp, errors: {}, binance: { markPx: 1200, fundingRate: 0, nextFundingTime: null }, xyz: { markPx: 80, fundingRate: 0, oraclePx: 80 }, io: { markPx: 2000, fundingRate: 0, oraclePx: 2000 }, rh: { markPx: 800, fundingRate: null, indexPx: 800 } };
  const cycle = closePrice => ({ status: 'complete', since: iso(end - 3 * day), closedQuantity: '1', closePrice, realizedPnl: '5', fees: '-1', funding: '2', net: '6', currency: 'USDT', note: null, updatedAt: stamp });
  const position = (symbol, side, quantity, closePrice) => ({ symbol, instrumentId: symbol, side, quantity, quantityUnit: 'ANTHROPIC', entryPrice: '1000', markPrice: '1000', unrealizedPnl: '10', pnlCurrency: 'USDT', cycle: cycle(closePrice) });
  const exchange = (id, name, row) => ({ id, name, accounts: [{ id: 'main', name: '主账户', scopes: [{ id: 'perp', status: 'live', fetchedAt: stamp, positions: [row] }] }] });
  const positions = { generatedAt: stamp, sources: [{ projectId: 'asset', name: 'Asset', status: 'ready', data: { exchanges: [
    exchange('binance', 'Binance', position('ANTHROPICUSDT', 'short', '2', '1100')),
    exchange('rh-lighter', 'Lighter RH', position('ANTHROPIC', 'long', '1', '1000')),
  ] } }] };
  const trading = { mode: 'read-only', strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: stamp, cache: { builtAt: stamp, servedAt: stamp, rebuilding: false }, period: { days: 7, start: iso(now - 7 * day), end: stamp }, exchanges: [], accounts: [], legs: [], structure: { state: 'unknown', message: '' },
    pnl: { currency: 'USDT', intervalMs: 60_000, cumulativeStart: now, end: now, recordingStartedAt: now, pointCount: 0, points: [], latest: null, status: 'ready' }, funding: { complete: false, income: null, expense: null, net: null, currency: 'USDT', events: [], pagination: { page: 0, pageSize: 50, total: 0, pages: 1 }, daily: [] } };
  const errors = [], writes = [], reads = [], report = {};
  const onError = error => errors.push(error.stack ?? error.message);
  const context = page.context();
  let writer = null, previousHost = null, previousModule = null;
  const handler = async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (url.origin !== origin && url.origin !== moduleOrigin) return route.abort('blockedbyclient');
    if (path === '/fixture-storage') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated preference fixture</title>' });
    if (url.origin === moduleOrigin) {
      if (request.method() !== 'GET') { writes.push(path); return send({ error: 'Unexpected module write' }, 405); }
      if (!path.startsWith('/api/')) return route.fulfill({ response: await route.fetch({ url: monitorBuild + path + url.search }) });
      reads.push(path);
      if (path === '/api/monitors') return send({ schemaVersion: 1, monitors: ['oil', 'hynix', 'anthropic', 'perpetual'].map(id => ({ id, runtime: { available: true, monitorId: id, enabled: true, running: true, revision: 0 } })) });
      if (path === '/api/monitors/anthropic/candles/15m') return send(candles);
      if (path === '/api/monitors/anthropic/quote') return send(quote);
      return send({ error: 'Controlled unavailable fixture' }, 503);
    }
    if (path === '/fixture-host') {
      const mode = url.searchParams.get('mode');
      const capabilities = mode === 'missing-capability' ? ['activity'] : ['activity', 'anthropic-shares'];
      const shares = mode === 'malformed' ? { outstanding: ['10'], diluted: '20' } : { outstanding: '10', diluted: '20' };
      // These controlled legacy/malformed hosts exercise actual postMessage origin/source checks.
      const script = mode === 'silent' ? '' : `let sent=false;addEventListener('message',event=>{if(sent||event.origin!==${JSON.stringify(moduleOrigin)}||event.source!==document.querySelector('iframe').contentWindow||event.data.type!=='ready')return;sent=true;const frame=document.querySelector('iframe').contentWindow;frame.postMessage({channel:'project-hub',version:1,type:'ready',role:'host',capabilities:${JSON.stringify(capabilities)},anthropicShares:${JSON.stringify(shares)}},${JSON.stringify(moduleOrigin)});frame.postMessage({channel:'project-hub',version:1,type:'activity',active:true,backgroundUpdates:true,anthropicShares:${JSON.stringify(shares)}},${JSON.stringify(moduleOrigin)});});`;
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><script>${script}</script><iframe title="fixture" style="width:1400px;height:1000px" src="${moduleOrigin}/?monitor=anthropic"></iframe>` });
    }
    if (path === '/api/projects/monitor/launch' && request.method() === 'POST') return send({ url: `${moduleOrigin}/?monitor=anthropic` });
    if (request.method() !== 'GET') { writes.push(path); return send({ error: 'Unexpected host write' }, 405); }
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'ant-shares-fixture-only' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/overview/events' || path === '/api/system/updates/events') return route.abort();
    if (path === '/api/overview') return send(overview);
    if (path === '/api/system/updates') return send({ enabled: false, checking: false, checkedAt: null, checkError: null, planId: null, expiresAt: null, modules: [], job: null });
    if (path === '/api/trading/positions') return send(positions);
    if (path === '/api/trading/fills') return send({ generatedAt: stamp, sources: [] });
    if (path === '/api/trading/anthropic') return send({ generatedAt: stamp, sources: [], alerts: { config: { enabled: false, thresholdPercent: 20, repeatMinutes: 30 }, channel: { configured: false, source: null, host: null, error: null }, history: [], error: null, staleAfterSeconds: 180, hysteresisPercent: 2 } });
    if (path === '/api/trading') return send(trading);
    if (path === '/api/trading/execution') return send({ generatedAt: stamp, connections: [], positions: [], jobs: [] });
    if (path === '/api/trading/execution/quotes') return send({ generatedAt: stamp, maxAgeMs: 10_000, books: [] });
    if (path === '/api/trading/execution/auto') return send({ generatedAt: stamp, rules: [], maintenance: false });
    if (path.startsWith('/api/')) return send({ error: 'Controlled unavailable fixture' }, 503);
    return route.continue();
  };
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1050 });
  page.on('pageerror', onError);
  await context.route('**/*', handler);
  try {
    await page.goto(`${origin}/fixture-storage`);
    previousHost = await page.evaluate(({ key }) => {
      const keys = [key, 'workbench:trading-section:v1'];
      const previous = Object.fromEntries(keys.map(item => [item, localStorage.getItem(item)]));
      localStorage.setItem(key, JSON.stringify({ outstanding: '10', diluted: '20' }));
      localStorage.setItem('workbench:trading-section:v1', JSON.stringify('trade'));
      return previous;
    }, { key });
    await page.goto(`${moduleOrigin}/fixture-storage`);
    previousModule = await page.evaluate(() => {
      const previous = Object.fromEntries(Object.keys(localStorage).filter(item => item.startsWith('monitor:')).map(item => [item, localStorage.getItem(item)]));
      for (const item of Object.keys(previous)) localStorage.removeItem(item);
      return previous;
    });
    await page.goto(`${origin}/?view=project&id=monitor`);
    const frame = page.frameLocator('iframe[title="monitor模块"]');
    const panel = frame.getByRole('tabpanel', { name: 'Anthropic 价差', exact: true });
    const summary = frame.locator('.hub-summary-shell[aria-label="Anthropic 价差"]');
    const chart = panel.getByRole('region', { name: '历史价差图表', exact: true });
    const pair = frame.locator('[data-related-positions="anthropic"] [data-ant-pair="rh"]');
    const pairValue = label => pair.locator('dl > div').filter({ hasText: label }).locator('dd');
    async function verify(expected, label) {
      const evidence = {};
      for (let index = 0; index < 3; index++) {
        const name = ['xyz:ANT', 'io:ANTH', 'Lighter RH'][index], value = expected.premiums[index];
        await panel.getByRole('button', { name, exact: true }).click();
        await waitText(panel.locator('.primary-metric .metric-value'), value);
        await waitText(panel.locator('.metrics .metric').nth(1).locator('.metric-value'), expected.binance);
        await waitText(panel.locator('.metrics .metric').nth(2).locator('.metric-value'), expected.other[index]);
        await waitText(panel.locator('.metrics .metric').nth(3).locator('.metric-value'), value);
        await chart.getByRole('button', { name: '溢价率', exact: true }).click();
        const plot = chart.locator('.chart-container .svg-plot-surface');
        await plot.focus(); await plot.press('End');
        const tooltip = chart.locator('.chart-container .chart-tooltip');
        await tooltip.getByText(value.replace(/^\+/, ''), { exact: true }).first().waitFor();
        check((await tooltip.innerText()).includes(`${expected.binance} / ${expected.other[index]}`), `${label}/${name}: plotted history uses current per-share prices`);
        check((await plot.locator('g[data-series="premium"] path').getAttribute('d'))?.length > 20, `${label}/${name}: premium line is drawn`);
        const recent = panel.locator('.table-panel tbody tr').first();
        check((await recent.innerText()).includes(value) && (await recent.innerText()).includes(expected.binance), `${label}/${name}: recent observations agree`);
        await waitText(summary.locator('.hub-card-metrics > span').nth(index).locator('strong'), value);
        evidence[name] = { current: await panel.locator('.primary-metric .metric-value').innerText(), tooltip: await tooltip.innerText() };
      }
      await pair.waitFor();
      await waitText(pairValue('开仓溢价'), expected.opening);
      await waitText(pairValue('平仓溢价'), expected.closing);
      // Freshness may add a visible “旧” tag; the numerical reading must still match.
      check((await pairValue('当前溢价').innerText()).startsWith(expected.current), `${label}: related current premium agrees`);
      check((await pair.locator('.related-pair-estimate').innerText()).includes('+32.00 USD'), `${label}: share assumptions do not rewrite actual cash PnL`);
      report[label] = evidence;
    }
    await verify({ premiums: ['+50.00%', '+20.00%', '+200.00%'], binance: '$120.00', other: ['$80.00', '$100.00', '$40.00'], opening: '+100.000%', closing: '+120.000%', current: '+200.000%' }, 'initial');
    check((await panel.locator('.method-panel').innerText()).includes('10') && (await panel.locator('.method-panel').innerText()).includes('20'), 'method text describes synchronized S/F');
    check(!(await panel.locator('.method-panel').innerText()).includes('流通 127 亿'), 'method never claims custom values are 127/167 defaults');

    // A different window of the same host origin delivers a native storage event.
    writer = await context.newPage(); writer.on('pageerror', onError);
    await writer.goto(`${origin}/fixture-storage`); await page.bringToFront();
    await writer.evaluate(({ key }) => localStorage.setItem(key, JSON.stringify({ outstanding: '12', diluted: '30' })), { key });
    await verify({ premiums: ['+25.00%', '+50.00%', '+275.00%'], binance: '$100.00', other: ['$80.00', '$66.67', '$26.67'], opening: '+150.000%', closing: '+175.000%', current: '+275.000%' }, 'storage');

    // Both halves of trust are required: a sibling/self cannot forge a parent,
    // and a parent WindowProxy paired with an untrusted origin is also rejected.
    await frame.locator('body').evaluate(async (node, origin) => {
      const payload = { channel: 'project-hub', version: 1, type: 'activity', active: true, anthropicShares: { outstanding: '1', diluted: '100' } };
      window.dispatchEvent(new MessageEvent('message', { data: payload, origin, source: window }));
      window.dispatchEvent(new MessageEvent('message', { data: payload, origin: 'https://untrusted.invalid', source: window.parent }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, origin);
    await waitText(panel.locator('.primary-metric .metric-value'), '+275.00%');
    check(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).outstanding, key) === '12', 'forged messages cannot write host preferences');

    // Keep the live iframe mounted while the actual trading UI persists edits.
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '交易中心', exact: true }).click();
    await page.getByRole('tab', { name: '价差下单', exact: true }).click();
    const assumptions = page.getByRole('group', { name: 'Anthropic 股数假设', exact: true });
    await assumptions.getByLabel('流通股 · 十亿股', { exact: true }).fill('15');
    await assumptions.getByLabel('完全稀释股 · 十亿股', { exact: true }).fill('30');
    await page.waitForFunction(key => { const value = JSON.parse(localStorage.getItem(key)); return value.outstanding === '15' && value.diluted === '30'; }, key);
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: /^monitor/ }).click();
    await verify({ premiums: ['0.00%', '+20.00%', '+200.00%'], binance: '$80.00', other: ['$80.00', '$66.67', '$26.67'], opening: '+100.000%', closing: '+120.000%', current: '+200.000%' }, 'trading-edit');
    await page.reload();
    await waitText(panel.locator('.primary-metric .metric-value'), '+200.00%');
    check(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).outstanding, key) === '15', 'reload retains saved host assumption');

    for (const mode of ['missing-capability', 'malformed', 'silent']) {
      const readStart = reads.length;
      await page.goto(`${origin}/fixture-host?mode=${mode}`);
      const controlled = page.frameLocator('iframe[title="fixture"]');
      await controlled.locator('.hub-summary-card').first().waitFor();
      if (mode === 'silent') await page.waitForTimeout(3000);
      else await controlled.locator('[data-monitor="anthropic"] .data-status').filter({ hasText: '实时报价 · 获取于' }).waitFor();
      const metric = controlled.locator('[data-monitor="anthropic"] .primary-metric .metric-value');
      await waitText(metric, '—');
      check(await controlled.locator('[data-monitor="anthropic"] .svg-plot-surface').count() === 0, `${mode}: unknown assumptions cannot draw default-valued history`);
      const values = await controlled.locator('.hub-summary-shell[aria-label="Anthropic 价差"] .hub-card-metrics strong').allInnerTexts();
      check(values.length === 3 && values.every(value => value === '—'), `${mode}: all summary premiums stay unknown: ${values}`);
      if (mode === 'silent') check(reads.length === readStart, 'unanswered embed performs no market reads');
      report[mode] = { premiums: values, marketReads: reads.length - readStart };
    }
    check(writes.length === 0, `No account or configuration API writes: ${writes.join(', ')}`);
    check(errors.length === 0, `SSR hydration and all browser flows have zero pageerrors: ${errors.join('\n')}`);
    return { passed: true, pageerrors: errors.length, writes: writes.length, report };
  } catch (error) {
    throw new Error(`${error.message}\nBrowser errors: ${errors.join('\n') || 'none'}\nCompleted scenarios: ${Object.keys(report).join(', ')}`, { cause: error });
  } finally {
    if (writer) { writer.off('pageerror', onError); await writer.close(); }
    // Restore only preferences touched by this fixture, including on failure.
    if (previousHost) {
      await page.goto(`${origin}/fixture-storage`);
      await page.evaluate(previous => { for (const [item, value] of Object.entries(previous)) { if (value === null) localStorage.removeItem(item); else localStorage.setItem(item, value); } }, previousHost);
    }
    if (previousModule) {
      await page.goto(`${moduleOrigin}/fixture-storage`);
      await page.evaluate(previous => { for (const item of Object.keys(localStorage)) if (item.startsWith('monitor:')) localStorage.removeItem(item); for (const [item, value] of Object.entries(previous)) localStorage.setItem(item, value); }, previousModule);
    }
    await page.goto('about:blank');
    page.off('pageerror', onError);
    await context.unroute('**/*', handler);
    await page.setViewportSize({ width: 1440, height: 1050 });
  }
}
