// Production workbench preview on port 4180; all APIs are local fixtures and all writes are refused.
// playwright-cli -s=aero-rewards run-code --filename tests/aero-lp-rewards.browser.mjs
async (page) => {
  const origin = 'http://127.0.0.1:4180', root = '/api/automation/aero-lp';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const address = `0x${'1'.repeat(40)}`;
  const config = { rpcUrl: 'https://example.invalid', pool: address, factory: address, nft: address, gauge: address, token: address, token1: address,
    tickSpacing: 100, upperPrice: 60, gapBps: 40, intervalSec: 600, twapSec: 900, maxTwapDeviationBps: 300, slippageBps: 50, keepInWallet: '0', minDeploy: '1000', minEthForGas: '0.0002' };
  const cycle = { at: new Date().toISOString(), event: 'cycle', block: 100, symbols: ['RSGP', 'USDC'], price: 40, twapPrice: 40, target: [50, 60], status: 'below',
    wallet: {}, actions: [], notes: [], positions: ['1', '2'].map(id => ({ id, range: [50, 60], staked: true, liquidity: '200', state: 'below',
      amount0: 1, amount1: 0, value: 40, apr: 1, aprEstimated: true, aeroPerDay: 57600, aeroPerDayEstimated: true, feeApr: null })),
    rewards: { price: 0.5, poolPerDay: 86400, pending: '0', deferred: '0', dailyTotal: { perDay: 69120, scenario: 'same-lower', reason: null } } };
  const state = () => ({ schema: 1, enabled: true, state: 'running', error: null, wallet: address, paused: false, pauseReason: null, phase: null,
    lastCycle: structuredClone(cycle), events: [], ledger: null, config, defaults: config, serverNow: Date.now() });
  const errors = [], writes = [], checks = [];
  const onError = error => errors.push(error.message);
  const handler = async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (!['GET', 'HEAD'].includes(request.method())) { writes.push(url.pathname); return route.fulfill({ status: 405, json: { error: 'read-only fixture' } }); }
    if (url.pathname === '/api/session') return route.fulfill({ json: { authenticated: true, csrfToken: 'aero-rewards-fixture' } });
    if (url.pathname === '/api/overview') return route.fulfill({ json: { projects: [], generatedAt: new Date().toISOString() } });
    if (url.pathname === root) return route.fulfill({ json: state() });
    return route.fulfill({ status: 404, json: { error: 'isolated fixture' } });
  };
  page.on('pageerror', onError); await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?view=aero-lp`);
    const fact = page.locator('.lp-facts > div').filter({ has: page.getByText('预估每日 AERO', { exact: true }) });
    await fact.waitFor();
    const value = () => fact.locator('dd').evaluate(element => element.firstChild.textContent);
    const refresh = async () => {
      const response = page.waitForResponse(item => item.url() === origin + root);
      await page.getByRole('button', { name: '刷新状态', exact: true }).click();
      await (await response).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    assert(await value() === '69,120 AERO', 'common scenario total must not sum the independent rows');
    assert((await fact.innerText()).includes('假设外部活跃流动性不变'), 'the shared scenario assumption is visible');
    assert(await page.getByRole('cell', { name: '57,600（独立估计）', exact: true }).count() === 2, 'row estimates are explicitly independent');
    checks.push('same lower, common denominator');
    for (const [reason, text] of [['different-lower', '头寸下沿不同'], ['mixed-ranges', '头寸所在区间状态不同']]) {
      cycle.rewards.dailyTotal = { perDay: null, scenario: null, reason }; await refresh();
      assert(await value() === '—' && (await fact.innerText()).includes(text), reason);
      checks.push(reason);
    }
    delete cycle.rewards.dailyTotal; await refresh();
    assert(await value() === '—' && (await fact.innerText()).includes('等待下一轮'), 'old cycles must not fall back to row sums');
    checks.push('legacy cycle');
    cycle.rewards.price = null; cycle.rewards.dailyTotal = { perDay: 69120, scenario: 'same-lower', reason: null }; await refresh();
    assert(await value() === '69,120 AERO' && !(await fact.innerText()).includes('≈'), 'missing price preserves quantity without inventing value');
    checks.push('missing AERO price');
    cycle.rewards.dailyTotal = { perDay: 0, scenario: 'no-emissions', reason: null }; await refresh();
    assert(await value() === '0 AERO' && (await fact.innerText()).includes('池子当前无排放'), 'zero emissions stays a known zero');
    checks.push('zero emissions');
    cycle.rewards.dailyTotal = { perDay: 86400, scenario: 'current', reason: null }; await refresh();
    assert(await value() === '86,400 AERO' && (await fact.innerText()).includes('区间内实时'), 'current-price total uses the backend quantity');
    checks.push('current scenario');
    assert(writes.length === 0 && errors.length === 0, `no writes or page errors: ${errors.join('; ')}`);
    return { checks, writes: writes.length };
  } finally { page.off('pageerror', onError); await page.unroute('**/*', handler); }
}
