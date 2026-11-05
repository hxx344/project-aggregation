// Open about:blank, then run this file with playwright-cli run-code.
// All API intercepts are installed before navigating to isolated localhost:4175.
async (page) => {
  const origin = page.url() === 'about:blank' ? 'http://127.0.0.1:4175' : new URL(page.url()).origin;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):4175$/.test(origin)) throw new Error('Spread fixture requires isolated localhost:4175');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pageErrors = [], quoteReads = [];
  let failQuotes = false;
  page.on('pageerror', error => pageErrors.push(error.message));
  const prices = {
    binance: { CLUSDT: ['60.00', '60.02'], BZUSDT: ['64.20', '64.22'], SKHYUSDT: ['41.99', '42.01'], SKHYNIXUSDT: ['399.9', '400.1'] },
    bybit: { CLUSDT: ['60.05', '60.07'], BZUSDT: ['64.10', '64.12'], SKHYUSDT: null, SKHYNIXUSDT: ['400.0', '400.2'] },
    okx: { CLUSDT: ['59.90', '59.92'], BZUSDT: ['64.30', '64.32'], SKHYUSDT: ['42.10', '42.12'], SKHYNIXUSDT: ['401.0', '401.2'] },
  };
  const quotes = () => {
    const now = new Date().toISOString();
    return { generatedAt: now, maxAgeMs: 10_000, books: ['binance', 'bybit', 'okx'].flatMap(exchange => Object.entries(prices[exchange]).map(([symbol, book]) => book
      ? { exchange, symbol, bid: book[0], ask: book[1], at: now }
      : { exchange, symbol, error: '合约当前不支持所需的限价交易' })) };
  };
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const send = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    assert(method === 'GET', `spread fixture is read-only: ${method} ${url.pathname}`);
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture-only-csrf' });
    if (url.pathname === '/api/overview/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: new Date().toISOString() })}\n\n` });
    if (url.pathname === '/api/overview') return send({ projects: [], generatedAt: new Date().toISOString() });
    if (url.pathname === '/api/trading/execution') return send({ generatedAt: new Date().toISOString(), connections: [], positions: [], jobs: [] });
    if (url.pathname === '/api/trading/execution/quotes') {
      quoteReads.push(url.search);
      assert(url.search === '', 'quotes request carries no query');
      if (failQuotes) return send({ error: '模拟行情故障' }, 503);
      return send(quotes());
    }
    if (url.pathname === '/api/trading') return send({ error: '只读账本不在本用例范围' }, 503);
    return send({ error: `Unexpected fixture API: ${method} ${url.pathname}` }, 404);
  });
  const panel = page.locator('section.spread-panel');
  const cell = (caption, row, column) => panel.locator(`table:has(caption:text-is("${caption}")) tbody tr:has(th:text-is("${row}")) td`).nth(column);
  const oil = '原油 · 同所价差 BZ − CL', hynix = '海力士 · 同所价差 ADR − 正股 ÷ 10';
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?view=trading&tradingSection=oil`);
  await panel.getByText('前台每 3 秒更新盘口').waitFor();

  // Same-venue spreads come first and cover every exchange regardless of the selected pair.
  assert(await panel.locator('table').first().locator('caption').textContent() === oil, 'same-venue oil table is first');
  for (const [venue, spread, percent] of [['Binance', '+4.200', '+6.999%'], ['Bybit', '+4.050', '+6.743%'], ['OKX', '+4.400', '+7.344%']]) {
    assert(await cell(oil, venue, 2).textContent() === spread, `${venue} oil spread`);
    assert(await cell(oil, venue, 3).textContent() === percent, `${venue} oil spread percent`);
  }
  assert(await cell(hynix, 'Binance', 3).textContent() === '+5.000%', 'Binance hynix premium');
  assert((await cell(hynix, 'Bybit', 1).textContent()).includes('合约当前不支持'), 'failed leg shows its own error');
  assert(await cell(hynix, 'Bybit', 2).textContent() === '—', 'no spread from a failed leg');

  // Cross-venue view is secondary: collapsed, and follows the selected pair.
  const cross = panel.locator('details.spread-cross');
  assert(!(await cross.evaluate(element => element.open)), 'cross-venue section starts collapsed');
  assert((await cross.locator('summary').textContent()).includes('Binance 与 Bybit'), 'cross-venue section names the pair');
  await cross.locator('summary').click();
  const crossOil = '原油 · Binance − Bybit（中间价）';
  assert(await cell(crossOil, 'CL', 2).textContent() === '-0.050', 'cross-venue CL spread');
  assert((await cell(crossOil, 'CL', 4).textContent()).includes('Bybit 卖 · Binance 买'), 'edge direction');
  assert((await cell(crossOil, 'CL', 4).textContent()).startsWith('+0.03'), 'edge value sells bid and buys ask');
  assert(await cell(crossOil, '四腿：两所价差之差', 1).textContent() === '+0.256 个百分点', 'four-leg spread gap');
  await page.getByRole('button', { name: 'Binance + OKX' }).click();
  await panel.locator('caption:text-is("原油 · Binance − OKX（中间价）")').waitFor();
  assert(await panel.locator('caption:text-is("原油 · Binance − Bybit（中间价）")').count() === 0, 'previous pair is gone');

  // A failed read keeps the last result and says so.
  failQuotes = true;
  await panel.getByRole('button', { name: '刷新行情' }).click();
  await panel.getByText('行情读取失败：模拟行情故障 当前保留上次结果。', { exact: false }).waitFor();
  assert(await cell(oil, 'OKX', 2).textContent() === '+4.400', 'last result is kept');
  failQuotes = false;

  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(200);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'narrow layout has no page-level horizontal scroll');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  return { quoteReads: quoteReads.length };
}
