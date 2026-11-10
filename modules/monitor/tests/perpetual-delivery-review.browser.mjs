// Built Monitor portable server on 3193; only synthetic APIs, no channel sends.
// playwright-cli -s=p2-monitor run-code --filename modules/monitor/tests/perpetual-delivery-review.browser.mjs
async page => {
  const origin = 'http://127.0.0.1:3193', now = Date.now(), writes = [], errors = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const view = { available: true, generatedAt: now, revision: 1, config: { enabled: false, rules: [] }, webhookConfigured: true, running: true, error: '', progress: {},
    history: [{ id: 'delivery', ruleId: 'r', name: '隔离告警', time: now, status: 'failed', deliveryStage: 'unknown', base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'gate:BTCUSDT', netSpreadPercent: 1, error: '渠道结果未知', reviews: [] }] };
  const handler = async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (url.pathname === '/api/monitors/perpetual/quote') return send({ schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: now, staleAfterMs: 30000, quotes: [], exchanges: [] });
    if (url.pathname === '/api/monitors/perpetual/crossex-settings') return send({ available: true, generatedAt: now, revision: 0, config: { requireSpotTransfer: false, blockedBases: [] }, error: '', spotTransferPairs: [], venues: [] });
    if (url.pathname === '/api/monitors/perpetual/alerts' && request.method() === 'GET') return send(view);
    if (url.pathname === '/api/monitors/perpetual/alerts/reviews' && request.method() === 'POST') {
      const body = request.postDataJSON(); check(body.id === 'delivery' && !('status' in body), 'note binds immutable event'); writes.push('review');
      view.history[0].reviews.push({ id: 'manual', actor: 'authenticated_admin', at: now, note: body.note, source: body.source }); return send(view);
    }
    return send({ error: 'isolated fixture' }, 503);
  };
  const onError = error => errors.push(error.message); page.on('pageerror', onError); await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?monitor=perpetual`); await page.getByRole('button', { name: '机会提醒', exact: true }).click();
    await page.getByText('最近提醒记录（24 小时，最多 100 条）', { exact: true }).click();
    await page.getByRole('button', { name: '记录核对说明', exact: true }).click(); await page.getByLabel('核对说明', { exact: true }).fill('人工查证'); await page.getByLabel('证据来源（勿填写凭据）').fill('群记录');
    await page.getByRole('button', { name: '保存核对说明', exact: true }).click(); await page.getByText('人工查证', { exact: false }).waitFor();
    check(view.history[0].deliveryStage === 'unknown' && writes.join(',') === 'review', 'manual note does not acknowledge or resend'); check(!errors.length, errors.join(';'));
    return { passed: true, writes, browserErrors: 0 };
  } finally { page.off('pageerror', onError); await page.unroute('**/*', handler); }
}
