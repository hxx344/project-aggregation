// Production workbench preview on 4180; all APIs are isolated, no RPC or notification leaves the browser.
// playwright-cli -s=p2-automation run-code --filename tests/p2-automation-review.browser.mjs
async (page) => {
  const origin = 'http://127.0.0.1:4180', aeroRoot = '/api/automation/aero-safe', digestRoot = '/api/automation/feishu-digest';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], writes = [], external = [], now = Date.now();
  const safe = '0x1111111111111111111111111111111111111111', roles = '0x2222222222222222222222222222222222222222', batchId = 'a'.repeat(64);
  const autoConfig = { enabled: false, triggerMinutes: 5, cooldownMinutes: 30, maxPerDay: 6, acceptPenalty: false, twapSeconds: 300, maxTwapDeviationBps: 100 };
  const aero = { schema: 1, configured: true, configError: null, defaults: { rpcUrl: '', slippageBps: 50, autoSellRewards: false, minRewardSell: '1' },
    config: { rpcUrl: '', safe, roles, permissions: { roleKey: 'fixture', pools: [], swaps: [], allowances: [] }, slippageBps: 50, autoSellRewards: false, minRewardSell: '1' },
    wallet: null, paused: false, pauseReason: null, pending: null, job: null, chain: null, chainError: null, chainAt: null, refreshing: false, events: [], ledger: [], serverNow: now,
    changes: { pools: [], allowances: [], preview: { transactions: 0, usage: [], error: null }, batch: null, persistError: null },
    auto: { config: autoConfig, defaults: autoConfig, error: null, halted: null, reopen: null, closing: null, stuck: null, history: [], watch: [], note: null, checkedAt: null, intervalMs: 30000 },
    notifications: { config: { interrupted: false, needs_review: false, recovered: false }, channelConfigured: true, error: null, history: [{ id: 'old-recovery', kind: 'recovered', status: 'superseded', at: now, reason: '旧观察已失效', error: null }] },
    permissionHistory: { error: null, reading: false, batches: [{ id: batchId, createdAt: now, chainId: 8453, safe, roles, transactions: 1, reviews: [] }] } };
  const config = { enabled: false, title: 'fixture', onlyOnAttention: false, hideIdle: true, showIssues: true, sections: {}, schedule: { mode: 'times', times: ['09:00'], intervalMinutes: 240, weekdays: [1, 2, 3, 4, 5, 6, 7], timezone: 'Asia/Shanghai' } };
  const digest = { schema: 1, config, channel: { configured: true, host: 'open.feishu.cn', error: null }, sending: false, nextAt: null, loadError: null, serverNow: now,
    history: [{ id: 'delivery', at: new Date(now).toISOString(), kind: 'schedule', status: 'uncertain', attention: 0, error: '渠道结果未知', stages: [{ at: new Date(now).toISOString(), status: 'generated' }, { at: new Date(now).toISOString(), status: 'sending' }], reviews: [] }] };
  const handler = async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.href); return route.abort('blockedbyclient'); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'p2-review-fixture' });
    if (url.pathname === '/api/overview') return send({ projects: [], generatedAt: new Date().toISOString() });
    if (url.pathname === aeroRoot && request.method() === 'GET') return send(aero);
    if (url.pathname === `${aeroRoot}/notifications` && request.method() === 'PUT') { writes.push('subscription'); aero.notifications.config = request.postDataJSON(); return send(aero); }
    if (url.pathname === `${aeroRoot}/changes/review` && request.method() === 'POST') {
      const body = request.postDataJSON(); assert(body.id === batchId && body.blockNumber === 123, 'review is bound to selected batch and fixed block'); writes.push('permission-review');
      aero.permissionHistory.batches[0].reviews.unshift({ at: now, blockNumber: 123, blockHash: null, transactionHash: null, receipt: 'unknown', status: 'insufficient', note: '未提供原批次回执，不能据此判定已执行', coverage: '仅核对本批次', checks: [], operations: [{ index: 0, to: roles, method: 'setAllowance', target: 'fixture-token-key' }] }); return send(aero);
    }
    if (url.pathname === digestRoot && request.method() === 'GET') return send(digest);
    if (url.pathname === `${digestRoot}/preview`) return send({ digest: { title: config.title, at: new Date(now).toISOString(), clock: '09:00', level: 'ok', sections: [], attention: [] }, bytes: 200, omitted: 0, catalog: [] });
    if (url.pathname === `${digestRoot}/reviews` && request.method() === 'POST') {
      const body = request.postDataJSON(); assert(body.id === 'delivery' && !('status' in body), 'review cannot modify channel status'); writes.push('delivery-review');
      digest.history[0].reviews.push({ id: 'review', actor: 'authenticated_admin', at: new Date(now).toISOString(), note: body.note, source: body.source }); return send(digest);
    }
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(`unexpected:${url.pathname}`);
    return send({ error: 'isolated fixture' }, 404);
  };
  const onError = error => errors.push(error.message); page.on('pageerror', onError); await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?view=aero&tab=config`);
    await page.getByLabel('需要核对', { exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('label')).some(label => label.textContent === '需要核对' && label.querySelector('input')?.checked));
    await page.getByText('状态通知记录', { exact: true }).click();
    await page.getByText('恢复依据已失效，未发送', { exact: false }).waitFor();
    await page.getByText('历史冻结批次 · 固定区块权限核对', { exact: true }).click();
    await page.getByRole('combobox', { name: '冻结批次', exact: true }).selectOption(batchId); await page.getByLabel('固定区块高度').fill('123');
    await page.getByRole('button', { name: '读取并留存核对', exact: true }).click();
    await page.getByText('未提供原批次回执，不能据此判定已执行', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: '已执行，核对并启用' }).count() === 0, 'read-only review adds no activation control');
    await page.goto(`${origin}/?view=feishu-digest`); await page.getByRole('button', { name: '记录核对说明', exact: true }).click();
    await page.getByLabel('人工核对说明', { exact: true }).fill('群内已人工查证'); await page.getByLabel('证据来源（勿填写凭据）', { exact: true }).fill('消息时间09:00');
    await page.getByRole('button', { name: '保存核对说明', exact: true }).click(); await page.getByText('群内已人工查证', { exact: false }).waitFor();
    assert(digest.history[0].status === 'uncertain', 'manual statement never changes unknown to sent');
    assert(writes.join(',') === 'subscription,permission-review,delivery-review', `only expected writes: ${writes}`);
    assert(!errors.length && !external.length, `browser errors/external: ${errors}; ${external}`);
    return { passed: true, writes, external: 0, browserErrors: 0 };
  } finally { page.off('pageerror', onError); await page.unroute('**/*', handler); }
}
