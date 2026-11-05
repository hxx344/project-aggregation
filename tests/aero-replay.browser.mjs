// Run against a static preview of the built workbench (dist/) on port 4180, as tests/aero-add-pool.browser.mjs.
// Every API is an isolated fixture; nothing reaches an RPC.
async (page) => {
  const origin = 'http://127.0.0.1:4180', market = '/api/research/aero-market';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const WETH = '0x4200000000000000000000000000000000000006', USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
  const GOOD = '0x1111111111111111111111111111111111111111', BAD = '0x2222222222222222222222222222222222222222';
  const tick = -196256, sqrtPriceX96 = BigInt(Math.round(Math.sqrt(1.0001 ** tick) * 2 ** 96)).toString();
  const vol = (daily) => ({ daily, annual: daily * Math.sqrt(365), samples: 24 });
  const pool = (address, symbol, emissionPerSec) => ({
    chain: 'base', address, gauge: '0x000000000000000000000000000000000000abcd', tickSpacing: 100,
    token0: { address: WETH, symbol: 'WETH', decimals: 18, usd: 3000 }, token1: { address: symbol === 'USDC' ? USDC : CBBTC, symbol, decimals: 6, usd: 1 },
    fee: 500, unstakedFee: 100000, tick, sqrtPriceX96, liquidity: '5000000000000000', stakedLiquidity: '3000000000000000', tvlUsd: 2e7,
    emissionPerSec, emissionWindowSec: 3600, vol24h: vol(0.02), vol7d: vol(0.02), change24h: 0,
  });
  // BAD 的排放更高，按公式的收益波动比排在前面；回放亏钱，默认按回放排序时应排到后面。
  const snapshot = () => ({
    schema: 1, revision: 1, serverNow: Date.now(), config: { enabled: true, intervalMin: 10, minTvlUsd: 0, chains: { base: { enabled: true, rpcUrl: '' } } },
    configError: null, aero: { usd: 1, at: Date.now() },
    chains: [{ id: 'base', name: 'Base', enabled: true, rpcHost: 'fixture', status: 'ok', updatedAt: Date.now(), checkedAt: Date.now(), nextAt: null, error: null, errorAt: null,
      poolCount: 2, activeCount: 2, gaugeCount: 2, history: { points: 0, from: null, archive: 'local', pending: 0 } }],
    pools: [pool(GOOD, 'USDC', 0.05), pool(BAD, 'TEST', 0.5)], favorites: [], samples: { available: true, error: null, version: 3 },
  });
  const replays = [], errors = [];
  const replayOf = (address, deposit) => address === GOOD
    ? { hours: 48, net: deposit * 0.05, emission: deposit * 0.07, impermanent: deposit * 0.015, cost: deposit * 0.005, rebalances: 3, intraHour: 1.4, inRange: 0.97, missingHours: 0, apr: 0.05 * 365 / 2 }
    : { hours: 48, net: -deposit * 0.02, emission: deposit * 0.2, impermanent: deposit * 0.15, cost: deposit * 0.07, rebalances: 30, intraHour: 12, inRange: 0.8, missingHours: 2, apr: -0.02 * 365 / 2 };
  const handler = async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'aero-replay-fixture' });
    if (url.pathname === '/api/overview') return send({ projects: [], generatedAt: new Date().toISOString() });
    if (url.pathname === market) return send(snapshot());
    if (url.pathname === `${market}/samples`) return send({ window: '7d', available: true, error: null, version: 3, tag: 't', from: Date.now() - 7 * 86400e3, pools: {} });
    if (url.pathname === `${market}/pool`) return send({ chain: 'base', address: GOOD, points: [] });
    if (url.pathname === `${market}/liquidity`) return send({ error: 'isolated fixture' }, 503);
    if (url.pathname === `${market}/replay` && method === 'POST') {
      const body = request.postDataJSON();
      replays.push(body);
      return send({ window: body.window, available: true, error: null, version: 3, from: Date.now() - 7 * 86400e3,
        pools: Object.fromEntries(body.pools.map(([chain, address]) => [`${chain}:${address}`, replayOf(address, body.deposit)])) });
    }
    if (url.pathname === '/api/automation/aero-safe') return send({ error: 'isolated fixture' }, 503);
    return send({ error: 'isolated fixture' }, 404);
  };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?view=aero&tab=market`);
    const rows = page.locator('table.am-table tbody tr');
    await rows.first().getByText('+$25/天').waitFor();
    assert((await rows.nth(0).textContent()).includes('WETH / USDC'), 'the pool that made money in the replay is first by default');
    assert((await rows.nth(1).textContent()).includes('−$10/天'), 'the losing pool shows a negative daily amount');
    assert((await rows.nth(1).textContent()).includes('调仓 42 次'), 'hourly exits plus estimated intra-hour touches');
    const first = replays[0];
    assert(first.window === '7d' && first.deposit === 1000 && first.delayMin === 5 && first.pools.length === 2, `replay request ${JSON.stringify(first)}`);
    assert(first.pools.every(([chain, address, cells]) => chain === 'base' && [GOOD, BAD].includes(address) && Number.isInteger(cells) && cells >= 0), 'pools carry recommended cells');

    // 改投入金额：旧金额的结果不再显示，停止输入后只回放一次。
    const before = replays.length;
    await page.getByLabel('投入（美元）').fill('5000');
    await rows.first().getByText('+$125/天').waitFor();
    const after = replays.slice(before);
    assert(after.length === 1 && after[0].deposit === 5000, `one debounced replay per batch for the new deposit: ${JSON.stringify(after.map((r) => r.deposit))}`);

    // 详情页拆出排放、无常损失与调仓成本。
    await rows.first().click();
    const fact = page.locator('.am-detail-facts div').filter({ hasText: '历史回放（推荐宽度）' });
    await fact.waitFor();
    const text = await fact.textContent();
    assert(text.includes('+$250') && text.includes('排放 +$350') && text.includes('无常损失 $75') && text.includes('调仓成本 $25') && text.includes('整点出区间 3 次'), `detail breakdown: ${text}`);
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
    return 'aero replay browser fixture passed';
  } finally {
    await page.unroute('**/*', handler);
  }
}
