// Start after building Hub + Asset:
// node --import ./tests/fixtures/asset-performance-workbench.mjs server/index.mjs
// Run: playwright-cli -s=asset-performance run-code --filename tests/asset-performance.browser.mjs
// Real Hub login, launch, proxy, Next page and SQLite history are exercised first.
// Only the later edge cases replace Asset ledger/sync responses in the browser.
async (page) => {
  const origin = 'http://hub.localhost:39153';
  const screenshotRoot = 'output/playwright/asset-performance';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], external = [], writes = [], requests = [], scenarios = [];
  const onPageError = error => errors.push(error.message);
  let moduleOrigin, override = null, baseLedger, app, frame;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const [year, month] = today.split('-').map(Number);
  const date = (offset, day) => new Date(Date.UTC(year, month - 1 + offset, day)).toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7), priorMonth = date(-1, 1).slice(0, 7), earlierMonth = date(-2, 1).slice(0, 7);
  const elapsedDays = (start, end) => (Date.parse(end) - Date.parse(start)) / 86_400_000;
  // Independent oracle: add the fraction of a calendar year for each elapsed day.
  const annualize = (rate, start, end) => {
    let fraction = 0;
    for (let time = Date.parse(start); time < Date.parse(end); time += 86_400_000) {
      const y = new Date(time).getUTCFullYear();
      fraction += 1 / (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 366 : 365);
    }
    return rate / fraction;
  };
  const percent = value => value === null ? '—' : `${value < 0 ? '-' : '+'}${Math.abs(value * 100).toFixed(2)}%`;
  const amount = value => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const expectedMonthly = annualize(0.1, date(-1, 1), date(0, 0));
  const expectedOverall = annualize(0.26, date(-2, 1), today);
  const expectedSamples = [
    { date: date(-2, 1), total: 10000 }, { date: date(-1, 0), total: 9500 },
    { date: date(-1, 1), total: 10000 }, { date: date(-1, 15), total: 10400, partial: true },
    { date: date(0, 0), total: 11000 },
    ...(today !== date(0, 1) ? [{ date: date(0, 1), total: 11000 }] : []),
    { date: today, total: 12600 },
  ];
  await page.unrouteAll({ behavior: 'wait' });
  page.on('pageerror', onPageError);
  const routeHandler = async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.port !== '39153' || !(url.hostname === 'hub.localhost' || /^p-[a-f0-9]+\.hub\.localhost$/.test(url.hostname))) {
      external.push(url.href);
      return route.abort('blockedbyclient');
    }
    requests.push({ method: request.method(), url: url.href });
    const moduleRequest = url.origin !== origin;
    if (!['GET', 'HEAD'].includes(request.method())) {
      const permitted = request.method() === 'POST' && (
        !moduleRequest && (url.pathname === '/api/login' || /^\/api\/projects\/(?:asset|aster|monitor|crossex|greeks)\/(?:launch|check)$/.test(url.pathname))
        || moduleRequest && url.pathname === '/api/sync'
      );
      if (!permitted) {
        writes.push(`${request.method()} ${url.href}`);
        return route.fulfill({ status: 405, json: { error: 'Only login, launch, read-only connection checks and fixture sync are allowed' } });
      }
    }
    if (moduleRequest && override && ['/api/ledger', '/api/sync'].includes(url.pathname)) {
      return route.fulfill({ status: 200, json: override, headers: { 'Cache-Control': 'no-store' } });
    }
    return route.continue();
  };
  await page.route('**/*', routeHandler);
  try {
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(`${origin}/?view=project&id=asset`);
    const password = page.getByRole('textbox', { name: '工作台密码', exact: true });
    if (await password.isVisible()) {
      await password.fill('asset-performance-browser-fixture');
      await page.getByRole('button', { name: '登录', exact: true }).click();
    }
    const iframeSelector = 'iframe[title="Asset Ledger模块"]';
    const iframe = page.locator(iframeSelector);
    await iframe.waitFor();
    app = page.frameLocator(iframeSelector);
    await app.getByRole('heading', { name: '资产总览', exact: true }).waitFor();
    moduleOrigin = new URL(await iframe.getAttribute('src'), origin).origin;
    frame = page.frames().find(candidate => candidate.url().startsWith(moduleOrigin + '/'));
    assert(frame, 'real Asset production iframe loaded');
    const metrics = app.getByRole('region', { name: '收益指标', exact: true });
    const cards = metrics.locator('.performance-card');
    const details = metrics.locator('details.performance-monthly');
    const summary = details.locator('summary');
    const table = details.locator('table.performance-table');
    const rows = table.locator('tbody tr');
    const rowFor = month => rows.filter({ hasText: month }).first();
    const isOpen = () => details.evaluate(element => element.open);
    const openTable = async () => {
      if (!await isOpen()) await summary.click();
      await table.waitFor({ state: 'visible' });
    };
    const refresh = async () => {
      const response = page.waitForResponse(response => response.url() === `${moduleOrigin}/api/sync` && response.request().method() === 'POST');
      await app.getByRole('button', { name: '刷新资产', exact: true }).click();
      const completed = await response;
      assert(completed.ok(), `fixture sync status ${completed.status()}`);
      await completed.finished();
      await frame.waitForFunction(() => document.querySelector('.page-heading button')?.textContent?.includes('刷新资产'));
    };
    const noPageOverflow = async label => {
      for (const [name, target] of [['Hub', page], ['Asset iframe', frame]]) {
        const bounds = await target.evaluate(() => ({
          viewport: document.documentElement.clientWidth,
          html: document.documentElement.scrollWidth, body: document.body.scrollWidth,
        }));
        assert(bounds.html <= bounds.viewport + 1 && bounds.body <= bounds.viewport + 1,
          `${label}: ${name} horizontal overflow ${JSON.stringify(bounds)}`);
      }
    };
    baseLedger = await frame.evaluate(async () => {
      const response = await fetch('/api/ledger');
      if (!response.ok) throw new Error(`Real fixture ledger returned ${response.status}`);
      return response.json();
    });
    const actualSamples = [...baseLedger.history].sort((a, b) => a.date.localeCompare(b.date));
    assert(actualSamples.length === expectedSamples.length, 'real SQLite fixture has only the expected history');
    expectedSamples.forEach((expected, index) => {
      const actual = actualSamples[index];
      assert(actual.date === expected.date && actual.total === expected.total && Boolean(actual.partial) === Boolean(expected.partial),
        `real SQLite sample ${index}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    });
    assert(baseLedger.assets.every(asset => asset.mode === 'manual'), 'fixture assets are manual only');
    assert(Object.values(baseLedger.connections).every(connection => !connection.configured), 'fixture has no connected accounts');
    await metrics.waitFor();
    assert(await cards.count() === 2, 'two annualized metric cards');
    assert((await cards.nth(0).innerText()).includes(priorMonth), 'monthly annualization explicitly identifies the prior natural month');
    assert(await cards.nth(0).locator('strong').innerText() === percent(expectedMonthly), 'monthly annualization uses the prior month observed date span');
    assert(await cards.nth(1).locator('strong').innerText() === percent(expectedOverall), 'overall annualization uses the entire observed range');
    assert((await cards.nth(1).locator('p').innerText()).includes(`${elapsedDays(date(-2, 1), today)} 天`), 'overall day span excludes an extra inclusive day');
    assert(await details.getAttribute('open') === null, 'monthly details starts collapsed');
    await summary.focus();
    await summary.press('Enter');
    assert(await isOpen(), 'Enter expands native details');
    await summary.press('Space');
    assert(!await isOpen(), 'Space collapses native details');
    await summary.press('Space');
    assert(await isOpen(), 'Space expands native details');
    await summary.press('Enter');
    assert(!await isOpen(), 'Enter collapses native details');
    await openTable();
    const headers = await table.locator('thead th').allTextContents();
    assert(JSON.stringify(headers) === JSON.stringify(['月份 / 快照区间', '收益金额', '收益率', '期末调整后资产']), 'monthly table exposes the four expected columns');
    assert(await rows.count() === 3, 'three observed calendar months are shown');
    const rowMonths = await rows.locator('th[scope="row"]').allTextContents();
    assert([currentMonth, priorMonth, earlierMonth].every((month, index) => rowMonths[index].startsWith(month)), 'months are newest first');
    const previous = rowFor(priorMonth), negative = rowFor(earlierMonth), current = rowFor(currentMonth);
    assert(await previous.locator('td').nth(0).innerText() === '$ +1,000.00', 'prior month gain is +1000 USD');
    assert(await previous.locator('td').nth(1).innerText() === '+10.00%', 'prior month rate is +10%');
    assert(await previous.locator('td').nth(2).innerText() === '$ 11,000.00', 'prior month end adjusted value is 11000 USD');
    assert(await negative.locator('td').nth(0).innerText() === '$ -500.00', 'earlier month loss is -500 USD');
    assert(await negative.locator('td').nth(1).innerText() === '-5.00%', 'earlier month rate is -5%');
    assert(await negative.locator('td.performance-negative').count() === 2, 'negative gain and rate use the negative class');
    assert((await previous.innerText()).includes('含旧值或缺失行情'), 'partial month has a row-level warning');
    assert((await metrics.locator(':scope > .performance-warning').innerText()).includes('收益指标可能受影响'), 'partial history has a metric-level warning');
    assert((await current.innerText()).includes('进行中'), 'current calendar month is marked in progress');
    const currentRate = today === date(0, 1) ? null : 1600 / 11000;
    assert(await current.locator('td').nth(1).innerText() === percent(currentRate), 'current month rate reflects its available distinct days');
    assert(await current.locator('td').nth(2).innerText() === `$ ${amount(12600)}`, 'current month uses the latest saved adjusted value');
    await refresh();
    assert(await cards.nth(0).locator('strong').innerText() === percent(expectedMonthly), 'real refresh preserves the isolated performance fixture');
    assert(requests.some(request => request.method === 'POST' && request.url === `${origin}/api/projects/asset/launch`), 'actual Hub launch endpoint was exercised');
    await noPageOverflow('1440 desktop');
    await metrics.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${screenshotRoot}/desktop.png`, fullPage: true });
    await metrics.screenshot({ path: `${screenshotRoot}/desktop-metrics.png` });
    scenarios.push('real SQLite samples, previous-month/overall annualization, native keyboard toggle, signs and partial warnings');

    await page.setViewportSize({ width: 390, height: 844 });
    await metrics.scrollIntoViewIfNeeded();
    await noPageOverflow('390 mobile');
    const scroll = details.getByRole('region', { name: '每月表现明细，可横向滚动', exact: true });
    const scrolling = await scroll.evaluate(element => {
      const result = { width: element.clientWidth, content: element.scrollWidth, overflow: getComputedStyle(element).overflowX };
      element.scrollLeft = element.scrollWidth;
      return { ...result, moved: element.scrollLeft };
    });
    assert(scrolling.content > scrolling.width && scrolling.overflow === 'auto' && scrolling.moved > 0,
      `mobile monthly table scrolls inside its region: ${JSON.stringify(scrolling)}`);
    await noPageOverflow('390 mobile after internal scroll');
    await scroll.evaluate(element => { element.scrollLeft = 0; });
    await page.screenshot({ path: `${screenshotRoot}/mobile.png`, fullPage: true });
    await metrics.screenshot({ path: `${screenshotRoot}/mobile-metrics.png` });
    scenarios.push('1440 desktop and 390 mobile have no Hub/iframe page overflow; table scroll is contained');

    await page.setViewportSize({ width: 1440, height: 1050 });
    const setHistory = async points => {
      override = structuredClone(baseLedger);
      override.history = points.map(point => ({
        id: `daily-${point.date}`, date: point.date, total: point.value,
        fx: 7, cny: point.value * 7, future: false, difference: 0, withdrawn: 0,
      }));
      override.withdrawals = [];
      override.baselineDate = points[0]?.date ?? date(-2, 1);
      override.startedAt = override.baselineDate;
      override.baselineTotal = points[0]?.value ?? 0;
      override.assets = points.length ? [{ ...baseLedger.assets[0], value: points.at(-1).value, quantity: points.at(-1).value }] : [];
      await refresh();
    };
    await setHistory([]);
    assert(await metrics.count() === 0, 'empty history hides performance metrics');
    await app.getByText('刷新资产后生成第一条日快照', { exact: true }).waitFor();
    await setHistory([{ date: today, value: 10000 }]);
    assert(await metrics.count() === 0, 'one date does not manufacture performance metrics');
    await app.locator('.chart[aria-label^="资产变化折线图"]').waitFor();
    scenarios.push('empty and single-date histories retain appropriate native empty/chart states without metrics');

    await setHistory([{ date: date(-2, 1), value: 10000 }, { date: date(-1, 0), value: 11000 }, { date: today, value: 12000 }]);
    await metrics.waitFor();
    assert(await cards.nth(0).locator('strong').innerText() === '—', 'missing previous month does not fall back to an older complete month');
    assert((await cards.nth(0).innerText()).includes('上个自然月没有快照'), 'missing previous month explains the unavailable metric');
    assert(await cards.nth(1).locator('strong').innerText() === percent(annualize(0.2, date(-2, 1), today)), 'missing previous month still permits the overall metric');
    await openTable();
    assert((await rowFor(currentMonth).innerText()).includes('仅一个日期，无法计算收益'), 'a singleton month explains its unavailable monthly return');
    scenarios.push('missing previous month stays unavailable while full-history annualization remains valid');

    await setHistory([{ date: date(-1, 1), value: 0 }, { date: date(0, 0), value: 100 }]);
    assert(await cards.nth(0).locator('strong').innerText() === '—' && await cards.nth(1).locator('strong').innerText() === '—', 'zero starting assets produce no annualized percentage');
    await openTable();
    assert(await rowFor(priorMonth).locator('td').nth(0).innerText() === '$ +100.00', 'zero start still has a valid absolute gain');
    assert(await rowFor(priorMonth).locator('td').nth(1).innerText() === '—', 'zero start produces no monthly percentage');
    assert((await rowFor(priorMonth).innerText()).includes('起始资产不大于 0'), 'zero starting assets are explained');
    await metrics.screenshot({ path: `${screenshotRoot}/zero-start.png` });
    scenarios.push('zero starting assets retain the absolute gain and explain unavailable percentage returns');

    await setHistory([{ date: date(-1, 1), value: 10000 }, { date: date(0, 0), value: 9999.9999 }]);
    await openTable();
    const tiny = rowFor(priorMonth);
    assert(await tiny.locator('td').nth(0).innerText() === '$ +0.00', 'tiny negative amount rounds without a negative zero');
    assert(await tiny.locator('td').nth(1).innerText() === '+0.00%', 'tiny negative rate rounds without a negative zero');
    assert(await tiny.locator('td.performance-neutral').count() === 2, 'rounded-zero amount and return use neutral styling');
    assert(await cards.locator('strong.performance-neutral').count() === 2, 'rounded-zero annualized metrics use neutral styling');
    assert((await cards.locator('strong').allTextContents()).every(text => text === '+0.00%'), 'annualized rounded zeros have a positive zero sign');
    assert(!(await metrics.innerText()).includes('-0.00'), 'no negative zero is rendered within the metric panel');
    await metrics.screenshot({ path: `${screenshotRoot}/rounded-zero.png` });
    scenarios.push('tiny negative values round to +0.00 / +0.00% with neutral styling');

    override = null;
    await refresh();
    await openTable();
    assert(await cards.nth(0).locator('strong').innerText() === percent(expectedMonthly), 'real fixture is restored after response overrides');
    assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
    assert(writes.length === 0, `unexpected writes: ${writes.join('; ')}`);
    assert(external.length === 0, `external browser requests: ${external.join('; ')}`);
    return { passed: true, entry: page.url(), moduleOrigin, today,
      expectedMonthly: percent(expectedMonthly), expectedOverall: percent(expectedOverall),
      unexpectedWrites: 0, browserErrors: 0, externalRequests: 0, scenarios };
  } catch (error) {
    await page.screenshot({ path: `${screenshotRoot}/failure.png`, fullPage: true });
    throw error;
  } finally {
    override = null;
    await page.unroute('**/*', routeHandler);
    page.off('pageerror', onPageError);
  }
}
