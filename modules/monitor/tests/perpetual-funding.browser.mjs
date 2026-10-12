// Start the portable dev or built server on 127.0.0.1:3193, then use an isolated Playwright CLI session:
// playwright-cli -s=scanner-20261008 run-code --filename tests/perpetual-funding.browser.mjs
// Every API response is a local fixture; external requests are blocked. Screenshots stay untracked.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3193', hour = 3_600_000, anchor = Date.UTC(2026, 9, 6);
  let now = anchor, priceAge = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [], externalRequests = [], historyRequests = [], metricRequests = [], counts = new Map();
  const onPageError = error => errors.push(error.message);
  page.on('pageerror', onPageError);
  const bases = ['BTC', 'ETH', 'SOL', 'ADA'];
  const venues = [{ id: 'binance', name: 'Binance' }, { id: 'gate', name: 'Gate' }];
  const quote = (base, exchange) => {
    const binance = exchange === 'binance', initial = base === 'BTC' ? 99 : 199;
    return {
      exchange, base, symbol: `${base}USDT`, quoteCurrency: 'USDT', multiplier: 1,
      bid: initial + (binance ? 0 : 3), ask: initial + (binance ? 1 : 4),
      mark: initial + (binance ? 0.5 : 3.5), last: initial + 1,
      bidAskAt: now - priceAge, markAt: now - priceAge, sourceTime: now, receivedAt: now, transport: 'rest',
      // BTC: Binance +0.04% / 4h, Gate +0.02% / 8h. Receiving Binance requires the negative-spread direction.
      fundingRate: base === 'ADA' && binance ? null : binance ? base === 'BTC' ? 0.0004 : base === 'SOL' ? 0.008 : 0.0002 : 0.0002,
      fundingIntervalHours: binance ? 4 : 8,
      fundingAt: base === 'SOL' && binance ? now - 300_001 : now,
      nextFundingAt: anchor + (binance ? hour : 2 * hour),
      comparable: true, assetClass: base === 'ADA' ? 'stock' : 'crypto', identityVerified: base !== 'SOL', identitySource: 'official fixture directory',
      delisting: false, delistingAt: null, collateralCurrency: 'USDT',
    };
  };
  const snapshot = () => ({
    schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: now, staleAfterMs: 30_000,
    quotes: bases.flatMap(base => venues.map(venue => quote(base, venue.id))),
    exchanges: venues.map(venue => ({ ...venue, kind: 'cex', status: 'live', marketCount: bases.length, quoteCount: bases.length, lastMessageAt: now, error: null })),
  });
  await page.goto('about:blank');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.unrouteAll({ behavior: 'wait' });
  await page.clock.install({ time: new Date(anchor - 1000) });
  await page.clock.pauseAt(new Date(anchor));
  await page.addInitScript(({ localOrigin }) => {
    if (location.origin !== localOrigin) return;
    if (sessionStorage.getItem('scanner-regression-seeded')) return;
    sessionStorage.setItem('scanner-regression-seeded', '1');
    localStorage.removeItem('market-monitor:perpetual-scanner:v1');
    localStorage.removeItem('market-monitor:perpetual-scanner-ranges:v1');
    localStorage.setItem('market-monitor:perpetual:v1', JSON.stringify({ version: 2, sortBy: 'gross' }));
    localStorage.setItem('market-monitor:perpetual-quality-budget:v1', JSON.stringify({ version: 2, takerOverrides: { binance: 0.05, gate: 0.05 }, slippagePercent: 0.10 }));
  }, { localOrigin: origin });
  try {
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (url.origin !== origin) {
        externalRequests.push(url.origin);
        return route.abort('blockedbyclient');
      }
      if (!path.startsWith('/api/')) return route.continue();
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (path.endsWith('/perpetual/crossex-settings')) return route.fulfill({ json: {
        available: true, generatedAt: now, revision: 0, metadataRevision: 1,
        config: { requireSpotTransfer: true, blockedBases: [] }, error: '',
        spotTransferPairs: bases.map(base => ({ base, exchanges: ['binance', 'gate'], networks: ['TEST'], checkedAt: now - 1000, expiresAt: now + 179_000 })),
        venues: venues.map(venue => ({ exchange: venue.id, state: 'live', checkedAt: now, error: '' })),
      } });
      if (path.endsWith('/perpetual/quote')) return route.fulfill({ json: snapshot() });
      if (path.endsWith('/perpetual/stream')) return route.fulfill({ status: 503, body: 'fixture polling only' });
      if (path.endsWith('/perpetual/funding-history')) {
        const { pairs } = route.request().postDataJSON();
        historyRequests.push(pairs);
        const pending = historyRequests.length === 1;
        const backfilled = historyRequests.length >= 3;
        const legs = Object.fromEntries(pairs.flatMap(pair => [pair.longKey, pair.shortKey]).map(key => {
          const [exchange, symbol] = key.split(':'), isBtc = symbol === 'BTCUSDT';
          const hours = isBtc ? backfilled ? Array.from({ length: 97 }, (_, index) => (96 - index) * 8) : [96, 88, 80, 72, 64, 56, 48, 40, 32, 24, 16, 8, 0] : [32, 24, 16, 8, 0];
          return [key, { key, exchange, symbol, identity: `${key}:fixture`, status: pending ? 'pending' : 'ready', fetchedAt: pending ? null : anchor,
            coverage: pending ? null : { from: anchor - (isBtc && backfilled ? 768 : 96) * hour, to: anchor }, error: '', backfillComplete: !isBtc || backfilled,
            records: pending ? [] : hours.map(offset => ({ time: anchor - offset * hour, rate: !isBtc ? 0 : exchange === 'gate' ? .0002 : offset < 24 ? .0003 : .0001 })),
          }];
        }));
        return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, legs } });
      }
      if (path.endsWith('/perpetual/metrics')) {
        const { pairs } = route.request().postDataJSON(); metricRequests.push(pairs);
        const pending = metricRequests.length === 1;
        const metric = (value, currency, observedAt = anchor, error = '') => ({ value, currency, observedAt, source: 'official fixture ticker', error });
        const empty = error => metric(null, null, null, error);
        const legs = Object.fromEntries(pairs.flatMap(pair => [pair.longKey, pair.shortKey]).map(key => {
          const [exchange, symbol] = key.split(':'), binance = exchange === 'binance', unsupported = symbol === 'ADAUSDT';
          return [key, { key, exchange, symbol, identity: `${key}:fixture`, status: unsupported ? 'unsupported' : pending ? 'pending' : 'ready', fetchedAt: pending || unsupported ? null : anchor,
            volume24h: pending || unsupported ? empty('') : metric(binance ? 123456789 : 45678901, binance ? 'USDT' : 'USDC', symbol === 'SOLUSDT' ? anchor - 700000 : anchor),
            openInterest: pending || unsupported ? empty('') : symbol === 'ETHUSDT' ? empty('交易所未提供持仓金额') : metric(binance ? 0 : 5000000, binance ? 'USDT' : 'USD', anchor, symbol === 'SOLUSDT' ? 'upstream failed' : ''),
            error: unsupported ? '该合约暂不支持金额指标' : '',
          }];
        }));
        return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, legs } });
      }
      return route.fulfill({ status: 503, json: { error: 'Unavailable fixture detail' } });
    });
    const rankingRows = page.locator('.perp-scanner:visible .perp-scanner-table > tbody > tr:not(.perp-detail-row)');
    const baseNames = () => rankingRows.locator('.perp-base-cell > div > strong').allTextContents();
    const rowFor = base => rankingRows.filter({ has: page.getByText(base, { exact: true }) });
    const tick = async ms => { now += ms; await page.clock.runFor(ms); };
    const waitBases = async expected => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const actual = await baseNames();
        if (JSON.stringify(actual) === JSON.stringify(expected)) return;
        await tick(100);
      }
      throw new Error(`Expected ranking ${expected.join(', ')}; actual ${(await baseNames()).join(', ')}`);
    };
    const checkDirection = async (base, long, short) => {
      const row = rowFor(base);
      check((await row.locator('.perp-long > strong').innerText()).startsWith(long), `${base} long leg is ${long}`);
      check((await row.locator('.perp-short > strong').innerText()).startsWith(short), `${base} short leg is ${short}`);
    };
    const sort = page.locator('select[aria-label="价差排序"]');
    const filters = page.getByRole('button', { name: /^筛选/ });
    const fundingView = page.getByRole('button', { name: '资金费套利', exact: true });
    const grossView = page.getByRole('button', { name: '价格套利', exact: true });
    const history24 = base => rowFor(base).locator('[data-column="history24h"] strong');
    const menu = label => page.locator('.perp-scanner:visible .scanner-menu').filter({ has: page.locator('summary').filter({ hasText: label }) });
    const openMenu = async label => { const current = menu(label); if (!await current.getAttribute('open').then(value => value !== null)) await current.locator('summary').click(); return current; };
    await page.goto(`${origin}/?monitor=perpetual&goldOil=cl&goldOilExchange=binance`);
    await waitBases(['BTC', 'ADA', 'ETH', 'SOL']);
    await filters.click();
    check(await sort.inputValue() === 'gross', 'Initial ranking is gross spread');
    await checkDirection('BTC', 'Binance', 'Gate');
    check((await rowFor('BTC').innerText()).includes('+2.000%'), 'Default BTC direction has a positive gross spread');
    for (let attempt = 0; attempt < 100 && !historyRequests.length; attempt++) await tick(100);
    check(historyRequests.length > 0, 'The visible default 24h column requests settled funding in price mode');
    check((await rowFor('BTC').locator('[data-column="history24h"]').innerText()).includes('采集中'), 'Pending history is never displayed as zero');
    await tick(3000);
    for (let attempt = 0; attempt < 100 && await history24('BTC').innerText() !== '−0.0300%'; attempt++) await tick(100);
    check(await history24('BTC').innerText() === '−0.0300%', 'Price mode history uses its own Binance-long/Gate-short direction');
    check(await page.locator('thead [data-column="time"]').count() === 0 && await page.locator('thead [data-column="quality"]').count() === 0, 'Time and quality columns are optional by default');
    for (const id of ['history7d', 'history30d']) {
      check(await rowFor('BTC').locator(`[data-column="${id}"] strong`).innerText() === '—', `${id} has no fabricated value`);
      check((await rowFor('BTC').locator(`[data-column="${id}"]`).innerText()).includes('采集中'), `${id} states backfill is still running`);
    }
    await tick(3000);
    check(await rowFor('BTC').locator('[data-column="history7d"] strong').innerText() === '+0.1500%', 'Seven days uses its settled window after older coverage arrives');
    check(await rowFor('BTC').locator('[data-column="history30d"] strong').innerText() === '+0.8400%', 'Thirty days uses its own settled window, without extrapolating recent rates');
    check((await rowFor('ETH').locator('[data-column="history7d"]').innerText()).includes('历史不足'), 'Complete backfill with insufficient listing history remains explicitly missing');
    const btcVolume = rowFor('BTC').locator('[data-column="volume"]');
    const btcInterest = rowFor('BTC').locator('[data-column="openInterest"]');
    check((await btcVolume.locator('.scanner-metric-trigger').nth(0).innerText()).includes('123.46M') && (await btcVolume.locator('.scanner-metric-trigger').nth(1).innerText()).includes('USDC'), 'Volume has compact money amounts and retains each leg currency');
    check((await btcInterest.locator('.scanner-metric-trigger').nth(0).innerText()).includes('0') && !(await btcInterest.locator('.scanner-metric-trigger').nth(0).innerText()).includes('—'), 'True zero open interest is not missing');
    check((await btcInterest.locator('.scanner-metric-trigger').nth(1).innerText()).includes('USD'), 'USD stays distinct from USDT and USDC');
    await btcVolume.locator('.scanner-metric-trigger').nth(0).click();
    const metricEvidence = page.getByRole('dialog', { name: '多腿24h 成交额来源', exact: true });
    check((await metricEvidence.innerText()).includes('official fixture ticker'), 'Clicking a money amount exposes its source');
    check(await metricEvidence.locator('time').getAttribute('datetime') === new Date(anchor).toISOString(), 'Money evidence exposes the unchanged source timestamp');
    await metricEvidence.getByRole('button', { name: '收起指标来源', exact: true }).click();
    check((await rowFor('SOL').locator('[data-column="volume"] .scanner-metric-trigger').first().innerText()).includes('已过期'), 'Stale money amounts keep the stale label');
    check((await rowFor('SOL').locator('[data-column="openInterest"] .scanner-metric-trigger').first().innerText()).includes('更新失败'), 'A failed metric retains its amount and failure label');
    check((await rowFor('ADA').locator('[data-column="volume"] .scanner-metric-trigger').first().innerText()).includes('不支持'), 'Unsupported money data is explicit');
    check((await rowFor('ETH').locator('[data-column="openInterest"] .scanner-metric-trigger').first().innerText()).includes('暂无数据'), 'A successful source without verified open-interest money is marked unavailable rather than a failed refresh');
    const readyHistoryReads = historyRequests.length, readyMetricReads = metricRequests.length;
    const spreadMinimum = page.getByRole('textbox', { name: '开仓价差最小值', exact: true });
    const fundingMinimum = page.getByRole('textbox', { name: '资金费差最小值', exact: true });
    await spreadMinimum.fill('1.5');
    await waitBases(['BTC']);
    // Range inputs are independent of sort mode; choose the desired positive-carry bounds explicitly.
    await spreadMinimum.fill('');
    await fundingMinimum.fill('0');
    await fundingView.click();
    await waitBases(['BTC', 'ETH']);
    check(await sort.inputValue() === 'funding', 'Funding entry selects funding sort');
    check(await fundingView.getAttribute('aria-pressed') === 'true', 'Funding view is visibly selected');
    await checkDirection('BTC', 'Gate', 'Binance');
    const fundingText = await rowFor('BTC').innerText();
    check(fundingText.includes('−3.883%'), 'A negative gross spread remains eligible in the receiving-funding direction');
    check(fundingText.includes('+0.0600%'), 'Eight-hour funding spread uses each leg\'s actual period');
    await tick(1500);
    check(historyRequests.length === readyHistoryReads && metricRequests.length === readyMetricReads, 'Reversing a cached direction reuses both history and metrics without another HTTP read');
    check(await history24('BTC').innerText() === '+0.0300%', 'Past 1 day sums settled short-minus-long funding in the displayed direction');
    check(await history24('ETH').innerText() === '0.0000%', 'Complete true-zero settlements display zero');
    check(await rowFor('BTC').locator('[data-column="history7d"] strong').innerText() === '−0.1500%' && await rowFor('BTC').locator('[data-column="history30d"] strong').innerText() === '−0.8400%', 'Seven and thirty day net cashflows reverse with the displayed legs');
    const schedules = rowFor('BTC').locator('[data-column="funding"] .scanner-funding-rate');
    check((await schedules.nth(0).innerText()).includes('+0.0200%') && (await schedules.nth(0).innerText()).includes('8h'), 'Funding row shows the long leg original rate and period');
    check((await schedules.nth(1).innerText()).includes('+0.0400%') && (await schedules.nth(1).innerText()).includes('4h'), 'Funding row shows the short leg original rate and period');
    check(await schedules.nth(0).locator('time').getAttribute('datetime') === new Date(anchor + 2 * hour).toISOString(), 'Long settlement countdown retains its real timestamp');
    check(await schedules.nth(1).locator('time').getAttribute('datetime') === new Date(anchor + hour).toISOString(), 'Short settlement countdown retains its real timestamp');
    check((await rowFor('ETH').innerText()).includes('+0.0200%'), 'Funding rows are descending independently of the gross threshold');
    check(await rowFor('SOL').count() === 0 && await rowFor('ADA').count() === 0, 'Stale and missing funding are excluded despite fresh positive-spread quotes');

    await fundingMinimum.fill('0.03'); await waitBases(['BTC']);
    await fundingMinimum.fill('0.07'); await waitBases([]);
    check(/没有组合满足当前范围|未找到匹配组合/.test(await page.locator('.perp-empty').innerText()), 'A funding threshold miss is not mislabeled as missing transfer qualification');
    await fundingMinimum.fill('0'); await waitBases(['BTC', 'ETH']);
    await filters.click();

    await rowFor('BTC').getByRole('button', { name: /^收藏组合：BTC，/ }).click();
    const favorites = page.getByRole('button', { name: /^自选/ });
    await favorites.click(); await waitBases(['BTC']);
    await checkDirection('BTC', 'Gate', 'Binance');
    await rowFor('BTC').getByRole('button', { name: /^移除组合：BTC，/ }).click();
    await waitBases([]);
    await favorites.click(); await waitBases(['BTC', 'ETH']);

    // Next/React may defer the first lazy/Suspense commit until the browser clock advances.
    await page.clock.resume();
    await rowFor('BTC').getByRole('button', { name: /^展开 BTC，/ }).click();
    await page.getByText('行情已暂停', { exact: true }).waitFor();
    const holdingHours = page.getByLabel(/^预计持有 \/ 小时/);
    await holdingHours.waitFor();
    now = await page.evaluate(() => Date.now()) + 100;
    await page.clock.pauseAt(new Date(now));
    check(await holdingHours.inputValue() === '24', 'Funding details default to a 24-hour holding period');
    check(Math.abs(Number(await page.getByRole('spinbutton', { name: '退出残余价差', exact: true }).inputValue()) - (99 / 103 - 1) * 100) < 1e-10, 'Funding details preserve the entry spread rather than assume convergence');
    const detailEvidence = page.locator('.scanner-detail-evidence');
    const estimateText = await detailEvidence.innerText();
    check(estimateText.includes('未来 24h 资金费 +0.1800%') && estimateText.includes('未来 24h 扣费后 −0.1200%'), 'Future estimates are explicitly separated from settled history');
    check(await detailEvidence.locator('[data-history-hours="72"] dd').innerText() === '−0.0300%', 'Past 3 days uses its own settled window rather than scaling 1 day or extrapolating current rates');
    await detailEvidence.locator('.perp-funding-history summary').click();
    const historicalEvidence = await detailEvidence.innerText();
    check(historicalEvidence.includes('2026-10-06 08:00') && historicalEvidence.includes('多腿费率累计 +0.0600% · 3 次') && historicalEvidence.includes('空腿费率累计 +0.1500% · 9 次'), 'History exposes the common cutoff, leg totals and actual settlement counts');
    await detailEvidence.locator('.perp-funding-history summary').click();
    await page.getByRole('tab', { name: '各平台报价', exact: true }).click();
    const details = page.locator('.perp-detail-row');
    const binance = details.locator('.perp-detail-scroll tbody tr').filter({ has: page.getByText('Binance', { exact: true }) });
    const gate = details.locator('.perp-detail-scroll tbody tr').filter({ has: page.getByText('Gate', { exact: true }) });
    check((await binance.locator('[data-label="资金费 / 原周期"]').innerText()).includes('每 4h'), 'Binance original settlement period is visible');
    check((await gate.locator('[data-label="资金费 / 原周期"]').innerText()).includes('每 8h'), 'Gate original settlement period is visible');
    check((await binance.locator('[data-label="下次结算"]').innerText()).includes('09:00:00'), 'Binance future settlement is shown in Beijing time');
    check((await gate.locator('[data-label="下次结算"]').innerText()).includes('10:00:00'), 'Gate future settlement is shown in Beijing time');
    await page.screenshot({ path: 'output/playwright/scanner-layout-funding-details-desktop.png', fullPage: true });
    await page.locator('.perp-inspection-bar').getByRole('button', { name: '收起并恢复', exact: true }).click();
    await waitBases(['BTC', 'ETH']);
    await rowFor('ETH').getByRole('button', { name: /^展开 ETH，/ }).click();
    check(await detailEvidence.locator('[data-history-hours="72"] dd').innerText() === '—', 'Insufficient history stays missing rather than zero');
    check((await detailEvidence.locator('[data-history-hours="72"]').innerText()).includes('历史不足'), 'History completeness is visible beside the missing value');
    await page.locator('.perp-inspection-bar').getByRole('button', { name: '收起并恢复', exact: true }).click();
    await page.screenshot({ path: 'output/playwright/scanner-layout-funding-desktop.png', fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Funding ranking has no whole-page overflow at 390px');
    check(await history24('BTC').innerText() === '+0.0300%', 'Mobile keeps the settled 24h column in the horizontal table');
    check(await page.locator('.scanner-table-wrap').evaluate(element => element.scrollWidth > element.clientWidth), '390px scanner table scrolls horizontally within its container');
    await checkDirection('BTC', 'Gate', 'Binance');
    const mobileMetric = rowFor('BTC').locator('[data-column="volume"] .scanner-metric-trigger').first();
    await mobileMetric.click();
    const mobileEvidence = page.getByRole('dialog', { name: '多腿24h 成交额来源', exact: true });
    const evidenceBounds = await mobileEvidence.boundingBox();
    check(Boolean(evidenceBounds && evidenceBounds.x >= 0 && evidenceBounds.x + evidenceBounds.width <= 391), 'Metric source evidence remains inside the mobile viewport');
    check((await mobileEvidence.innerText()).includes('official fixture ticker'), 'Mobile tap exposes the metric source');
    await mobileEvidence.getByRole('button', { name: '收起指标来源', exact: true }).click();
    check(await mobileMetric.getAttribute('aria-expanded') === 'false', 'Mobile metric evidence has an explicit close action');
    await rowFor('BTC').getByRole('button', { name: /^展开 BTC，/ }).click();
    await page.getByRole('tab', { name: '各平台报价', exact: true }).click();
    await detailEvidence.locator('.perp-funding-history summary').click();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Expanded funding details have no whole-page overflow at 390px');
    await detailEvidence.locator('.perp-funding-history summary').click();
    await page.screenshot({ path: 'output/playwright/scanner-layout-funding-details-mobile.png', fullPage: true });
    await page.locator('.perp-inspection-bar').getByRole('button', { name: '收起并恢复', exact: true }).click();
    await page.screenshot({ path: 'output/playwright/scanner-layout-funding-mobile.png', fullPage: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    await filters.click();
    await fundingMinimum.fill(''); await spreadMinimum.fill('1.5');
    await grossView.click(); await waitBases(['BTC']);
    await filters.click();
    check(await history24('BTC').innerText() === '−0.0300%', 'Returning to price mode reverses the historical cashflow with the row direction');
    let columns = await openMenu(/^显示列/);
    await columns.getByRole('checkbox', { name: '24h · 实际', exact: true }).uncheck();
    await columns.getByRole('checkbox', { name: '30天 · 实际', exact: true }).uncheck();
    await columns.locator('summary').press('Escape');
    check(await page.locator('[data-column="history24h"]').count() === 0, 'A hidden history column is removed from both header and rows');
    const onlySevenDayReads = historyRequests.length;
    await tick(300000);
    check(historyRequests.length > onlySevenDayReads, 'The visible seven-day column keeps the shared historical cache active');
    columns = await openMenu(/^显示列/);
    await columns.getByRole('checkbox', { name: '7天 · 实际', exact: true }).uncheck();
    await columns.getByRole('checkbox', { name: '24h 成交额', exact: true }).uncheck();
    await columns.getByRole('checkbox', { name: '持仓量', exact: true }).uncheck();
    await columns.locator('summary').press('Escape');
    const historyBeforePause = historyRequests.length;
    const metricsBeforePause = metricRequests.length;
    await tick(300000);
    check(historyRequests.length === historyBeforePause && metricRequests.length === metricsBeforePause, 'Hiding all related columns pauses both cache polls');
    await page.reload(); await waitBases(['BTC']);
    check(await page.locator('[data-column="history24h"]').count() === 0, 'Column preferences survive reload');
    await checkDirection('BTC', 'Binance', 'Gate');
    await filters.click();
    check(await sort.inputValue() === 'gross', 'Returning to spread ranking restores gross sort');
    check(await spreadMinimum.inputValue() === '1.5', 'Explicit gross threshold survives reload');
    await spreadMinimum.fill(''); await fundingMinimum.fill('0');
    await page.locator('.scanner-tools > summary').click();
    await page.locator('.scanner-advanced-filters > summary').click();
    await sort.selectOption('funding'); await waitBases(['BTC', 'ETH']);
    check(await fundingView.getAttribute('aria-pressed') === 'true', 'Sort select and funding tab stay synchronized');
    await page.getByRole('button', { name: '重置全部筛选', exact: true }).click();
    check(await spreadMinimum.inputValue() === '' && await fundingMinimum.inputValue() === '', 'Reset clears all explicit numeric bounds');
    await spreadMinimum.fill('0'); await waitBases(['BTC', 'ADA', 'ETH', 'SOL']);
    check(await page.locator('[data-column="history24h"]').count() === 0, 'Resetting ranking filters preserves independent display columns');
    await filters.click();
    await page.locator('.scanner-tools > summary').click();
    await page.getByRole('checkbox', { name: '加密', exact: true }).uncheck(); await waitBases(['ADA', 'SOL']);
    check((await rowFor('ADA').locator('[data-column="type"]').innerText()) === 'R', 'An explicit official stock category is shown as RWA');
    check((await rowFor('SOL').locator('[data-column="type"]').innerText()) === '?', 'A familiar ticker without verified crypto evidence stays unknown');
    await page.getByRole('checkbox', { name: 'RWA', exact: true }).uncheck(); await waitBases(['SOL']);
    let categories = await openMenu(/^类别/);
    await categories.getByRole('checkbox', { name: '未分类', exact: true }).uncheck(); await waitBases([]);
    check((await page.locator('.perp-empty').innerText()).includes('请选择至少一种资产类别'), 'Zero categories is an explicit empty selection');
    await categories.locator('summary').press('Escape');
    await page.reload(); await waitBases([]);
    await page.locator('.perp-scanner:visible .scanner-menu > summary').filter({ hasText: '类别（0 / 6）' }).waitFor();
    categories = await openMenu(/^类别/);
    check(await categories.getByRole('checkbox', { checked: true }).count() === 0, 'An empty category selection survives reload');
    await categories.getByRole('button', { name: '全部类别', exact: true }).click(); await waitBases(['BTC', 'ADA', 'ETH', 'SOL']);
    await categories.locator('summary').press('Escape');
    columns = await openMenu(/^显示列/);
    await columns.getByRole('checkbox', { name: '报价时间', exact: true }).check();
    check(await page.locator('thead [data-column="time"]').count() === 1, 'Optional quote time can be enabled');
    await columns.getByRole('button', { name: '恢复默认列', exact: true }).click();
    await columns.locator('summary').press('Escape');
    await page.locator('.perp-scanner:visible thead [data-column="history24h"]').waitFor();
    await page.locator('.perp-scanner:visible thead [data-column="time"]').waitFor({ state: 'detached' });
    check(await page.locator('.perp-scanner:visible thead [data-column]').count() === 12, 'Restoring columns returns exactly the twelve defaults');
    for (let attempt = 0; attempt < 100 && historyRequests.length === historyBeforePause; attempt++) await tick(100);
    check(historyRequests.length > historyBeforePause, 'Restoring the visible history column resumes its requests');
    priceAge = 29_000;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await tick(100);
    await rowFor('BTC').getByRole('button', { name: /^展开 BTC，/ }).click();
    await tick(2200);
    check((await rowFor('BTC').locator('[data-column="quote"]').innerText()).includes('报价已过期'), 'Paused source prices expire visibly even when the time column is hidden');
    check((await page.locator('.perp-inspection-bar').innerText()).includes('已过期，仅供核对'), 'Inspection expiry follows the row price time rather than the newer snapshot time');
    priceAge = 0;
    await page.locator('.perp-inspection-bar').getByRole('button', { name: '收起并恢复', exact: true }).click();
    bases.push('DOGE', 'XRP', 'LINK', 'AVAX', 'SUI', 'NEAR', 'LTC', 'DOT');
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await tick(16_000);
    await waitBases(['BTC', ...bases.filter(base => base !== 'BTC').sort()]);
    await page.setViewportSize({ width: 1920, height: 1200 });
    await page.locator('.perp-scanner:visible').screenshot({ path: 'output/playwright/scanner-layout-wide.png' });
    check(errors.length === 0, `Unexpected page errors: ${errors.join('; ')}`);
    check(externalRequests.length === 0, `Unexpected external requests were blocked: ${externalRequests.join(', ')}`);
    return { passed: true, checks: ['opposite funding direction', '8h normalization and order', '24h cost estimate', 'settled 1-day/3-day/7-day/30-day distinct windows', 'same-cutoff backfill expansion', 'true zero versus incomplete history', 'five-minute cache refresh and hidden-column pause', 'cached direction reversal without fetch', 'compact amounts and independent currencies', 'metric source timestamps and stale/error/unsupported labels', 'leg settlement evidence', 'independent threshold', 'missing and stale funding excluded', 'directional favorites', 'future settlements and periods', 'gross restoration', 'official categories and unknown evidence', 'empty category persistence', 'column persistence and reset', '1280px desktop and 390px horizontal table'], requests: Object.fromEntries(counts) };
  } finally {
    page.off('pageerror', onPageError);
    await page.clock.resume();
  }
}
