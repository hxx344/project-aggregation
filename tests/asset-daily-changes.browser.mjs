// Start after building Hub + Asset:
// node --import ./tests/fixtures/asset-performance-workbench.mjs server/index.mjs
// Run: playwright-cli -s=asset-daily-changes run-code --filename tests/asset-daily-changes.browser.mjs
// Real Hub login, launch, proxy, Next page and SQLite snapshots are read first;
// only the error and many-source cases replace /api/daily-changes in the browser.
async (page) => {
  const origin = 'http://hub.localhost:39153';
  const screenshotRoot = 'output/playwright/asset-daily-changes';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], external = [], writes = [], dailyRequests = [], scenarios = [];
  const onPageError = error => errors.push(error.message);
  let mode = 'real';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const [year, month] = today.split('-').map(Number);
  const date = (offset, day) => new Date(Date.UTC(year, month - 1 + offset, day)).toISOString().slice(0, 10);
  // Same samples as the fixture; the first is the workbook baseline column.
  const samples = [
    { date: date(-2, 1), total: 10000 }, { date: date(-1, 0), total: 9500 },
    { date: date(-1, 1), total: 10000 }, { date: date(-1, 15), total: 10400, partial: true },
    { date: date(0, 0), total: 11000 },
    ...(today !== date(0, 1) ? [{ date: date(0, 1), total: 11000 }] : []),
    { date: today, total: 12600 },
  ];
  const signed = value => `${value < 0 ? '-' : '+'}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const expected = samples.slice(1).map((sample, index) => {
    const previous = samples[index];
    return { date: sample.date, previous: previous.date, change: sample.total - previous.total,
      gap: (Date.parse(sample.date) - Date.parse(previous.date)) / 86_400_000, partial: !!sample.partial || !!previous.partial };
  }).reverse();
  const manySources = { today, windowStart: today, days: [{
    date: today, previousDate: date(0, 0), gapDays: 2, previousAdjusted: 1000, adjusted: 1015, change: 15,
    heldChange: 5, withdrawnChange: 10, unattributed: 0, partial: false,
    sources: [['A', 8], ['B', -6], ['C', 2], ['D', 1]].map(([project, change], index) => ({ id: 'row-' + index, project, kind: '资产', previous: 100, current: 100 + change, change,
      details: project === 'A' ? [{ label: 'USDⓈ-M 合约（折合 USDT） · USDT', previous: 60, current: 70, change: 10 }, { label: '资金账户（折合 USDT） · USDT', previous: 40, current: 38, change: -2 }] : [] })),
    positions: { compared: true, recorded: true, capturedAt: today + 'T07:00:00.000Z', previousCapturedAt: date(0, 0) + 'T07:00:00.000Z', groups: [
      { id: 'oil', label: '原油套利', change: 5.5, complete: true, legs: 2 }, { id: 'hynix', label: '海力士套利', change: -1.25, complete: false, legs: 2 },
      { id: 'other', label: '其他持仓', change: null, complete: false, legs: 1 }] },
  }] };  await page.unrouteAll({ behavior: 'wait' });
  page.on('pageerror', onPageError);
  const routeHandler = async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.port !== '39153' || !(url.hostname === 'hub.localhost' || /^p-[a-f0-9]+\.hub\.localhost$/.test(url.hostname))) {
      external.push(url.href);
      return route.abort('blockedbyclient');
    }
    const moduleRequest = url.origin !== origin;
    if (!['GET', 'HEAD'].includes(request.method())) {
      const permitted = request.method() === 'POST' && (
        !moduleRequest && (url.pathname === '/api/login' || /^\/api\/projects\/(?:asset|aster|monitor|crossex|greeks)\/(?:launch|check)$/.test(url.pathname))
        || moduleRequest && url.pathname === '/api/sync'
      );
      if (!permitted) {
        writes.push(`${request.method()} ${url.href}`);
        return route.fulfill({ status: 405, json: { error: 'Only login, launch, read-only checks and fixture sync are allowed' } });
      }
    }
    if (moduleRequest && url.pathname === '/api/daily-changes') {
      dailyRequests.push(mode);
      if (mode === 'error') return route.fulfill({ status: 503, json: { error: '服务暂时不可用，已保留上次数据，请稍后重试' } });
      if (mode === 'many') return route.fulfill({ status: 200, json: manySources, headers: { 'Cache-Control': 'no-store' } });
    }
    return route.continue();
  };
  await page.route('**/*', routeHandler);
  try {
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(`${origin}/?view=project&id=asset`);
    const password = page.getByRole('textbox', { name: '工作台密码', exact: true });
    const iframeSelector = 'iframe[title="Asset Ledger模块"]';
    const iframe = page.locator(iframeSelector);
    await Promise.race([password.waitFor(), iframe.waitFor()]);
    if (await password.isVisible()) {
      await password.fill('asset-performance-browser-fixture');
      await page.getByRole('button', { name: '登录', exact: true }).click();
    }
    await iframe.waitFor();
    const app = page.frameLocator(iframeSelector);
    await app.getByRole('heading', { name: '资产总览', exact: true }).waitFor();
    const moduleOrigin = new URL(await iframe.getAttribute('src'), origin).origin;
    const frame = page.frames().find(candidate => candidate.url().startsWith(moduleOrigin + '/'));
    assert(frame, 'real Asset production iframe loaded');
    const details = app.locator('details.daily-changes');
    const summary = details.locator('summary');
    const list = details.getByRole('list', { name: '每日波动明细，按日期从新到旧' });
    const items = list.locator(':scope > li');
    const noPageOverflow = async label => {
      for (const [name, target] of [['Hub', page], ['Asset iframe', frame]]) {
        const bounds = await target.evaluate(() => ({ viewport: document.documentElement.clientWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
        assert(bounds.html <= bounds.viewport + 1 && bounds.body <= bounds.viewport + 1, `${label}: ${name} horizontal overflow ${JSON.stringify(bounds)}`);
      }
    };

    await details.waitFor();
    assert(await details.getAttribute('open') === null, 'daily changes start collapsed');
    assert(dailyRequests.length === 0, 'collapsed section does not request daily changes');
    mode = 'error';
    await summary.click();
    const alert = details.getByRole('alert');
    await alert.waitFor();
    assert((await alert.innerText()).includes('服务暂时不可用'), 'failed read shows the server message');
    mode = 'real';
    await alert.getByRole('button', { name: '重试', exact: true }).click();
    await list.waitFor();
    assert(await details.getByRole('alert').count() === 0, 'successful retry clears the error');
    scenarios.push('collapsed until opened; failed read shows an alert and retry loads real data');

    assert(await items.count() === expected.length, `expected ${expected.length} observed day changes, got ${await items.count()}`);
    for (const [index, day] of expected.entries()) {
      const text = await items.nth(index).innerText();
      assert(text.includes(day.date.slice(5)) && text.includes('较 ' + day.previous.slice(5)), `day ${day.date} compares with ${day.previous}: ${text}`);
      assert(text.includes('$ ' + signed(day.change)), `day ${day.date} change ${signed(day.change)}: ${text}`);
      assert(!text.includes('含旧值'), `day ${day.date} shows no stale-value marker`);
      assert(text.includes(`间隔 ${day.gap} 天`) === day.gap > 1, `day ${day.date} gap ${day.gap}`);
      if (day.change) assert(text.includes('月度表现示例资产 · 资产') && text.includes(signed(day.change)), `day ${day.date} is attributed to the asset row`);
      else assert(text.includes('各来源无变化'), `day ${day.date} without change says so`);
    }
    assert((await summary.innerText()).includes(`${expected.length} 日`), 'summary shows the loaded day count');
    const first = items.nth(0).locator('.daily-change-head > span').last();
    assert((await first.getAttribute('class')).includes(expected[0].change > 0 ? 'performance-positive' : expected[0].change < 0 ? 'performance-negative' : 'performance-neutral'), 'change uses the signed tone');
    await details.scrollIntoViewIfNeeded();
    await details.screenshot({ path: `${screenshotRoot}/desktop.png` });
    scenarios.push('real SQLite days are newest first with prior-day base, gap, no stale-value marker and row attribution');

    mode = 'many';
    await summary.click();
    await summary.click();
    await list.locator('text=A · 资产').waitFor();
    const day = items.nth(0);
    assert(await day.locator(':scope > ul.daily-sources > li').count() === 3, 'only the top three sources show by default');
    assert((await day.locator(':scope > ul.daily-sources > li').allInnerTexts()).map(text => text.split('\n')[0])[0].startsWith('出金（加回）'), 'withdrawal add-back is ranked among sources by size');
    const groups = (await day.getByRole('list', { name: '持仓影响' }).locator('li').allInnerTexts()).map(text => text.replace(/\s+/g, ''));
    assert(groups.length === 3 && groups[0] === '原油套利+5.50' && groups[1] === '海力士套利-1.25部分' && groups[2] === '其他持仓—', `three holding totals are visible without expanding: ${groups.join(' | ')}`);
    const toggle = day.getByRole('button', { name: '展开明细' });
    assert(await toggle.getAttribute('aria-expanded') === 'false', 'expand control reports collapsed');
    await toggle.click();
    assert(await day.locator(':scope > ul.daily-sources > li').count() === 5, 'expanding shows all five sources');
    const expandedText = await day.innerText();
    assert(expandedText.includes('100.00 → 108.00'), 'expanded sources show previous and current values');
    assert(expandedText.includes('USDⓈ-M 合约（折合 USDT） · USDT') && expandedText.includes('60.00 → 70.00'), 'exchange rows break down by account');
    assert(!expandedText.includes('CLUSDT') && await day.getByRole('list', { name: '持仓影响' }).locator('li').count() === 3, 'expanding adds balance details but no per-position list');
    await page.setViewportSize({ width: 390, height: 844 });
    await day.scrollIntoViewIfNeeded();
    await noPageOverflow('390 mobile expanded day');
    await day.screenshot({ path: `${screenshotRoot}/holdings-mobile.png` });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await day.getByRole('button', { name: '收起' }).click();
    assert(await day.locator(':scope > ul.daily-sources > li').count() === 3, 'collapsing returns to the top three');
    scenarios.push('crude-oil, SK hynix and other holding totals show by default; expanding lists all sources and account breakdown only; 390 expanded has no overflow');
    mode = 'real';
    await summary.click();
    await summary.click();
    await list.locator('text=月度表现示例资产 · 资产').first().waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await details.scrollIntoViewIfNeeded();
    await noPageOverflow('390 mobile');
    await details.screenshot({ path: `${screenshotRoot}/mobile.png` });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await noPageOverflow('1440 desktop');
    scenarios.push('1440 desktop and 390 mobile have no Hub/iframe page overflow');

    assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
    assert(writes.length === 0, `unexpected writes: ${writes.join('; ')}`);
    assert(external.length === 0, `external browser requests: ${external.join('; ')}`);
    return { passed: true, today, days: expected.length, dailyRequests, browserErrors: 0, unexpectedWrites: 0, externalRequests: 0, scenarios };
  } catch (error) {
    await page.screenshot({ path: `${screenshotRoot}/failure.png`, fullPage: true });
    throw error;
  } finally {
    await page.unroute('**/*', routeHandler);
    page.off('pageerror', onPageError);
  }
}
