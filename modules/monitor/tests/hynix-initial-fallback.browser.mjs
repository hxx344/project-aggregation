// Start tests/hynix-initial-server.mjs on 3198 (after npm run build), then run in a Playwright CLI session:
// playwright-cli run-code --filename tests/hynix-initial-fallback.browser.mjs
// The first render embeds only the overview trend; a failed full-history read must keep it, never show an empty market.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3198';
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  let historyReads = 0, fullHistory = null;
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.clock.install({ time: new Date() });
  try {
    await page.route('**/api/**', async route => {
      const path = '/' + route.request().url().split('/').slice(3).join('/').split('?')[0];
      const fetchedAt = new Date(await page.evaluate(() => Date.now())).toISOString();
      if (path === '/api/monitors/hynix/history') {
        historyReads++;
        if (historyReads === 1) return route.fulfill({ status: 503, json: { error: 'Controlled history outage' } });
        return route.fulfill({ json: { ...fullHistory, fetchedAt } });
      }
      if (path === '/api/monitors/hynix/quote') return route.fulfill({ json: { status: 'live', fetchedAt, ordinary: 1000, adr: 106, equivalent: 100, spread: 6, premium: 6 } });
      return route.fulfill({ status: 503, json: { error: 'Controlled unavailable response' } });
    });
    await page.goto(`${origin}/?monitor=hynix`);
    const embedded = JSON.parse(await page.locator('#market-initial-data').textContent()).initial.hynix;
    check(embedded.trend?.points.length === 168 && !('history' in embedded), 'The first render embeds only the seven-day trend');
    const initialLast = embedded.trend.points.at(-1);
    fullHistory = { status: 'live', interval: '1h', firstAvailable: new Date(initialLast.time - 299 * 3_600_000).toISOString(), warnings: [],
      points: Array.from({ length: 301 }, (_, index) => ({ time: initialLast.time - (299 - index) * 3_600_000, ordinary: 1000, adr: 107, equivalent: 100, spread: 7, premium: 7 })) };
    const card = page.getByRole('region', { name: '市场行情概览' }).getByRole('button', { name: /^海力士 ADR/ });
    const sparkline = card.locator('.hub-sparkline');
    const detail = page.getByRole('tabpanel', { name: '海力士 ADR', exact: true });
    const closing = time => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(time + 3_600_000));

    await detail.getByText('历史行情：', { exact: false }).waitFor();
    check(historyReads === 1, 'The detail reads the full history on mount');
    // The status label may be visually collapsed on narrow cards; the accessible description carries it too.
    await sparkline.getByText('保留历史', { exact: false }).waitFor({ state: 'attached' });
    const retained = await sparkline.getAttribute('title');
    check(retained.includes(`最后收盘 ${closing(initialLast.time)} 北京时间，${initialLast.value.toFixed(3)}%`), `A failed read keeps the embedded trend and its real close time: ${retained}`);
    check(await card.locator('.hub-sparkline svg path.spark-line').count() > 0, 'The retained trend is still drawn');
    check(await detail.getByText('暂无可用行情').count() === 0 && await detail.getByText('暂无记录').count() === 0, 'A failed first read is not shown as an absent market');
    check(await detail.getByText('正在载入上市以来的历史行情').count() === 1, 'The chart stays in its pending state');

    await page.clock.runFor(60_000);
    await page.waitForFunction(() => [...document.querySelectorAll('.hub-summary-card')].find(node => node.textContent.includes('海力士 ADR'))?.querySelector('.hub-sparkline')?.getAttribute('title')?.includes('7.000%'));
    check(historyReads === 2, 'The next scheduled read loads the full history');
    const loaded = await sparkline.getAttribute('title');
    check(!loaded.includes('保留历史') && loaded.includes(`最后收盘 ${closing(initialLast.time + 3_600_000)} 北京时间，7.000%`), `The overview switches to the full history: ${loaded}`);
    await detail.locator('tbody tr').filter({ hasText: '+7.00%' }).first().waitFor();
    check(await detail.getByText('历史行情：', { exact: false }).count() === 0, 'A successful read clears the history error');
    check(await detail.locator('.metric').filter({ hasText: '区间平均溢价' }).getByText('+7.00%', { exact: true }).count() === 1, 'Detail statistics use the full history');
    return { passed: true, historyReads, retained, loaded };
  } finally {
    await page.clock.resume();
  }
}
