// Open about:blank, then run this file with playwright-cli run-code --filename.
// Every API request is intercepted before navigating to the isolated localhost:4175 build.
async (page) => {
  const origin = page.url() === 'about:blank' ? 'http://127.0.0.1:4175' : new URL(page.url()).origin;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):4175$/.test(origin)) throw new Error('Anthropic positions fixture requires isolated localhost:4175');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pageErrors = [], writes = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const fixedTime = '2026-11-06T04:00:00.000Z', start = '2026-10-30T04:00:00.000Z';
  let config = { enabled: true, thresholdPercent: 20, repeatMinutes: 30 }, channel = { configured: true, source: 'digest', host: null, error: null }, testFailure = true;
  let missingMarks = false;
  const leg = (exchange, symbol, side, extra) => ({ id: `${exchange}:${symbol}:${side}`, exchange, symbol, side, quantityUnit: null, contractSize: null, entryPrice: '180', unrealizedPnl: '0', leverage: '3', marginMode: 'isolated', ...extra });
  const watch = () => ({ generatedAt: fixedTime, sources: [
    { exchange: 'binance', connected: true, state: 'live', fetchedAt: fixedTime, error: null, refreshing: false,
      positions: [leg('binance', 'ANTHROPICUSDT', 'long', { quantity: '30', markPrice: '183.5', notional: '5505', unrealizedPnl: '105', liquidationPrice: '150.1', distancePercent: '18.20', alerting: true })] },
    { exchange: 'okx', connected: true, state: 'stale', fetchedAt: start, error: 'OKX 仓位读取超时', refreshing: false,
      positions: [leg('okx', 'ANTHROPICUSDT', 'short', { quantity: '300', quantityUnit: '张', contractSize: '1', markPrice: '183.6', notional: '5508', unrealizedPnl: '-108', liquidationPrice: '240', distancePercent: '30.72', alerting: false, marginMode: 'cross' })] },
    { exchange: 'hyperliquid', connected: true, address: '0x' + 'ab'.repeat(20), state: 'live', fetchedAt: fixedTime, error: null, refreshing: false,
      positions: [leg('hyperliquid', 'xyz:ANT', 'long', { quantity: '100', markPrice: missingMarks ? null : '14.4', notional: missingMarks ? '0' : '1440', liquidationPrice: null, distancePercent: null, riskUnknown: missingMarks, alerting: missingMarks })] },
    { exchange: 'rh-lighter', connected: true, address: '0x' + 'cd'.repeat(20), state: 'live', fetchedAt: fixedTime, error: null, refreshing: false,
      positions: [{ ...leg('rh-lighter', 'ANTHROPIC', 'short', { quantity: '0.6', markPrice: missingMarks ? null : '1520.1', notional: missingMarks ? '0' : '912.06', liquidationPrice: '1900.5', distancePercent: missingMarks ? null : '25.02', riskUnknown: missingMarks, alerting: missingMarks, marginMode: 'cross' }), id: 'rh-lighter:ANTHROPIC:22163:short', account: 22163 }] },
  ], alerts: { config, channel, history: [{ at: fixedTime, status: 'sent', count: 1, summary: ['Binance ANTHROPICUSDT 做多：距强平 18.20%（阈值 20%）'], error: null }], error: null, staleAfterSeconds: 180, hysteresisPercent: 2 } });
  const trading = () => ({ mode: 'read-only', strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: fixedTime, cache: { builtAt: fixedTime, servedAt: fixedTime, rebuilding: false }, period: { days: 7, start, end: fixedTime },
    exchanges: ['binance', 'bybit'], accounts: [], legs: [], structure: { state: 'opposed', message: '' },
    pnl: { currency: 'USDT', intervalMs: 60000, cumulativeStart: Date.parse(start), end: Date.parse(fixedTime), recordingStartedAt: Date.parse(fixedTime), pointCount: 0, points: [], latest: null, status: 'ready' },
    funding: { complete: true, income: '0', expense: '0', net: '0', currency: 'USDT', events: [], pagination: { page: 0, pageSize: 50, total: 0, pages: 1 }, daily: [] } });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const send = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture-only-csrf' });
    if (url.pathname === '/api/overview/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: fixedTime })}\n\n` });
    if (url.pathname === '/api/overview' || url.pathname === '/api/projects') return send({ projects: [], generatedAt: fixedTime });
    if (url.pathname === '/api/trading/execution' && method === 'GET') return send({ generatedAt: fixedTime, connections: [], positions: [], jobs: [] });
    if (url.pathname === '/api/trading' && method === 'GET') return send(trading());
    if (url.pathname === '/api/trading/anthropic' && method === 'GET') return send(watch());
    if (url.pathname === '/api/trading/anthropic/alerts' && method === 'PUT') {
      const body = JSON.parse(request.postData()); writes.push(body);
      config = body.config; return send(watch());
    }
    if (url.pathname === '/api/trading/anthropic/alerts/channel' && method === 'PUT') {
      writes.push(JSON.parse(request.postData()));
      channel = { configured: true, source: 'own', host: 'open.feishu.cn', error: null }; return send(watch());
    }
    if (url.pathname === '/api/trading/anthropic/alerts/channel/clear' && method === 'POST') {
      writes.push(JSON.parse(request.postData()));
      channel = { configured: true, source: 'digest', host: null, error: null }; return send(watch());
    }
    if (url.pathname === '/api/trading/anthropic/alerts/test' && method === 'POST') {
      writes.push(JSON.parse(request.postData()));
      return testFailure ? send({ error: '飞书发送失败（19024）' }, 502) : send(watch());
    }
    return send({ error: `Unexpected fixture API: ${method} ${url.pathname}` }, 404);
  });
  const section = page.locator('section.trading-anthropic-positions');
  const rows = section.locator('.trading-position-table tbody tr');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?view=trading&tradingSection=trade`);
  await section.getByRole('heading', { name: 'Anthropic 套利仓位', exact: true }).waitFor();
  await rows.first().waitFor();
  assert(await rows.count() === 4, 'one row per leg across Binance, OKX, Hyperliquid and Lighter RH');
  const texts = await rows.allInnerTexts();
  assert(texts[0].includes('ANTHROPICUSDT') && texts[0].includes('做多') && texts[0].includes('≈ 381 股') && texts[0].includes('150.1') && texts[0].includes('18.20%') && texts[0].includes('预警中'), `Binance near row: ${texts[0]}`);
  assert(await rows.nth(0).evaluate(row => row.classList.contains('trading-anthropic-near')), 'a leg inside the threshold is highlighted');
  assert(texts[1].includes('300 张') && texts[1].includes('≈ 381 股') && texts[1].includes('全仓') && !(await rows.nth(1).evaluate(row => row.classList.contains('trading-anthropic-near'))), `OKX row: ${texts[1]}`);
  assert(texts[2].includes('xyz:ANT') && texts[2].includes('≈ 100 股') && texts[2].includes('未提供'), `Hyperliquid row without a liquidation price: ${texts[2]}`);
  assert(texts[3].includes('ANTHROPIC') && texts[3].includes('Lighter RH · 账户 22163') && texts[3].includes('≈ 10.02 股') && texts[3].includes('25.02%') && texts[3].includes('全仓'), `Lighter RH row names its account: ${texts[3]}`);
  const statuses = await section.locator('.trading-account-status').allInnerTexts();
  assert(statuses[1].includes('数据已过期') && statuses[1].includes('OKX 仓位读取超时'), `OKX stale status: ${statuses[1]}`);
  assert(statuses[2].includes('0xabab…abab'), `Hyperliquid address is masked: ${statuses[2]}`);
  assert(statuses[3].includes('Lighter RH') && statuses[3].includes('0xcdcd…cdcd'), `Lighter RH address is masked: ${statuses[3]}`);
  assert((await section.locator('.trading-structure').innerText()).includes('多头 ≈ 481 股 · 空头 ≈ 391 股 · 差 89.98 股'), 'long and short shares are summed under the share assumption');

  missingMarks = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await rows.nth(2).getByText('标记价缺失，无法计算', { exact: true }).waitFor();
  for (const index of [2, 3]) {
    const text = await rows.nth(index).innerText();
    assert(text.includes('标记价缺失，无法计算') && text.includes('预警中'), `unknown risk retains its warning: ${text}`);
    assert(await rows.nth(index).evaluate(row => row.classList.contains('trading-anthropic-near')), 'unknown risk keeps the active warning highlighted');
  }
  missingMarks = false;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await rows.nth(3).getByText('25.02%', { exact: true }).waitFor();
  assert(await section.getByText('标记价缺失，无法计算', { exact: true }).count() === 0, 'valid marks remove the unknown display');

  const save = section.getByRole('button', { name: '保存', exact: true });
  assert(await save.isDisabled(), 'save waits for a change');
  await section.getByLabel('距强平低于').fill('15');
  await save.click();
  await section.getByText('预警设置已保存。').waitFor();
  assert(JSON.stringify(writes[0]) === JSON.stringify({ config: { enabled: true, thresholdPercent: 15, repeatMinutes: 30 } }), `PUT body: ${JSON.stringify(writes[0])}`);
  assert(!(await rows.nth(0).evaluate(row => row.classList.contains('trading-anthropic-near'))), 'the saved 15% threshold no longer highlights the 18.20% leg');

  await section.getByRole('button', { name: '发送测试' }).click();
  await section.getByRole('alert').filter({ hasText: '飞书发送失败（19024）' }).waitFor();
  assert(JSON.stringify(writes[1]) === '{}', 'test sends an empty body');

  assert((await section.locator('.trading-anthropic-robot-status').innerText()).includes('「系统 → 飞书汇总」的机器人'), 'falls back to the digest robot');
  await section.getByText('使用预警专用机器人').click();
  const hook = 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture-own';
  const saveRobot = section.getByRole('button', { name: '保存机器人' });
  assert(await saveRobot.isDisabled(), 'saving the robot needs a webhook');
  await section.getByLabel('Webhook 地址').fill(hook);
  await section.getByLabel('签名密钥（可选）').fill('fixture-secret');
  await saveRobot.click();
  await section.getByText('预警机器人已保存', { exact: false }).waitFor();
  assert(JSON.stringify(writes[2]) === JSON.stringify({ webhookUrl: hook, signingSecret: 'fixture-secret' }), `robot PUT body: ${JSON.stringify(writes[2])}`);
  assert((await section.locator('.trading-anthropic-robot-status').innerText()).includes('预警专用机器人（open.feishu.cn）'), 'shows only the host of the own robot');
  assert(await section.getByLabel('Webhook 地址').inputValue() === '' && await section.getByLabel('Webhook 地址').getAttribute('type') === 'password', 'the webhook is masked and cleared after saving');
  await section.getByRole('button', { name: '改用飞书汇总的机器人' }).click();
  await section.getByText('已改用「系统 → 飞书汇总」的机器人。').waitFor();
  assert(JSON.stringify(writes[3]) === '{}', 'clear sends an empty body');

  channel = { configured: false, source: 'own', host: null, error: '已保存的预警机器人无法读取，请重新填写' };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await section.getByRole('alert').filter({ hasText: '已保存的预警机器人无法读取' }).waitFor();
  assert(await section.getByRole('button', { name: '发送测试' }).isDisabled(), 'an unreadable own robot blocks the test');

  channel = { configured: false, source: null, host: null, error: null };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await section.getByText('尚未配置飞书机器人', { exact: false }).waitFor();
  assert(await section.getByRole('button', { name: '发送测试' }).isDisabled(), 'test needs the Feishu robot');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '390px viewport has no page-wide horizontal overflow');
  assert(await section.locator('.trading-position-table thead').isHidden(), 'phone uses labelled position cards');
  await section.screenshot({ path: 'output/playwright/trading-anthropic-positions-mobile.png' });
  assert(!pageErrors.length, `No uncaught browser errors: ${pageErrors.join('; ')}`);
  return { passed: true, scenarios: ['four sources with stale and masked addresses', 'near highlight and share estimates', 'missing marks retain active warnings and recover', 'save exact body', 'test failure shown', 'no robot disables test', '390px mobile'] };
}
