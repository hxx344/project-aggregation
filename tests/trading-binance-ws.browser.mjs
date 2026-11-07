// Isolated production preview on 4197; all API and external traffic is mocked.
async (page) => {
  const origin = 'http://127.0.0.1:4197';
  if (page.url() !== 'about:blank' && new URL(page.url()).origin !== origin) throw new Error('Binance WS fixture requires isolated localhost:4197');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  let phase = 0, reads = 0;
  const at = new Date().toISOString(), start = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const position = () => ({ id: 'binance:ANTHROPICUSDT:LONG', exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'long', mode: 'hedge',
    quantity: phase < 2 ? '10' : '12', entryPrice: '100', markPrice: phase === 2 ? null : '101', notional: phase === 2 ? null : '1212',
    unrealizedPnl: '12', leverage: phase === 2 ? null : '3', liquidationPrice: phase === 2 ? null : '79',
    riskFetchedAt: phase === 2 ? null : at, distancePercent: phase === 2 ? null : '21.78', alerting: false, quantityUnit: null, marginMode: null });
  const watch = () => ({ generatedAt: at, sources: [
    { exchange: 'binance', connected: true, state: phase === 0 || phase === 2 ? 'stale' : 'live', fetchedAt: at, refreshing: false,
      error: phase === 0 ? 'Binance 组合保证金仓位读取失败（HTTP 400，Binance -1021），请求时间与 Binance 服务器时间不一致，请检查服务器时钟同步' : null,
      positions: phase === 0 || phase === 4 ? [] : [position()] },
    ...['okx', 'hyperliquid', 'rh-lighter'].map(exchange => ({ exchange, connected: false, state: 'unconfigured', fetchedAt: null, error: null, refreshing: false, positions: [] })),
  ], alerts: { config: { enabled: false, thresholdPercent: 20, repeatMinutes: 30 }, channel: { configured: false, source: null, host: null, error: null },
    history: [], error: null, staleAfterSeconds: 180, hysteresisPercent: 2 } });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const send = json => route.fulfill({ contentType: 'application/json', body: JSON.stringify(json) });
    if (request.method() !== 'GET') { writes.push(url.pathname); return send({ error: 'No writes are expected' }); }
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture-only' });
    if (url.pathname === '/api/overview' || url.pathname === '/api/projects') return send({ projects: [], generatedAt: at });
    if (url.pathname === '/api/overview/events') return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: at })}\n\n` });
    if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (url.pathname === '/api/trading/anthropic') { reads++; return send(watch()); }
    if (url.pathname === '/api/trading/execution') return send({ generatedAt: at, connections: [], positions: [], jobs: [], maintenance: false });
    if (url.pathname === '/api/trading') return send({ mode: 'read-only', strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: at,
      cache: { builtAt: at, servedAt: at, rebuilding: false }, period: { days: 7, start, end: at }, exchanges: ['binance', 'bybit'], accounts: [], legs: [],
      structure: { state: 'opposed', message: '' }, pnl: { currency: 'USDT', intervalMs: 60000, cumulativeStart: Date.parse(start), end: Date.parse(at), recordingStartedAt: Date.parse(at), pointCount: 0, points: [], latest: null, status: 'ready' },
      funding: { complete: true, income: '0', expense: '0', net: '0', currency: 'USDT', events: [], pagination: { page: 0, pageSize: 50, total: 0, pages: 1 }, daily: [] } });
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Unrelated fixture API' }) });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?view=trading&tradingSection=legs`);
  const section = page.locator('section.trading-anthropic-positions'), status = section.locator('.trading-account-status').first();
  const rows = section.locator('.trading-position-table tbody tr');
  await section.getByRole('heading', { name: 'Anthropic 套利仓位', exact: true }).waitFor();
  await status.getByText(/请求时间与 Binance 服务器时间不一致/).waitFor();
  assert(!(await status.innerText()).includes('IP 白名单'), 'timestamp failure is not shown as permissions or IP failure');
  const next = async value => { phase = value; await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); };
  await next(1); await rows.first().waitFor();
  await status.getByText('已同步', { exact: true }).waitFor();
  assert((await rows.first().innerText()).includes('21.78%'), 'REST baseline supplies liquidation distance');
  await next(2); await status.getByText('数据已过期', { exact: true }).waitFor();
  const changed = await rows.first().innerText();
  assert(changed.includes('12') && !changed.includes('21.78%') && !changed.includes('79'), 'new WS quantity does not reuse old liquidation evidence');
  await next(3); await status.getByText('已同步', { exact: true }).waitFor();
  assert((await rows.first().innerText()).includes('21.78%'), 'fresh risk reconciliation restores the distance');
  await next(4); await rows.first().waitFor({ state: 'detached' });
  assert(await rows.count() === 0, 'explicit zero position removes the old leg');
  assert(writes.length === 0 && errors.length === 0, `no writes or page errors: ${JSON.stringify({ writes, errors })}`);
  return { passed: true, scenarios: 5, reads, writes: writes.length, pageErrors: errors.length };
}
