// Run against the production workbench preview on port 4180:
// playwright-cli -s=aero-add-pool run-code --filename tests/aero-add-pool.browser.mjs
// Every API is an isolated fixture; nothing reaches an RPC, the Safe or Roles.
async (page) => {
  const origin = 'http://127.0.0.1:4180', market = '/api/research/aero-market', root = '/api/automation/aero-safe';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const WETH = '0x4200000000000000000000000000000000000006', USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', POOL = '0xeC3c4F0E9a1fC3B1D29BC2F8DA0C7e0E2B4074C2';
  const GAUGE = '0xAbb3fF6c0b4F2c0B0a5ad0f2C1b2f6C4f8Bd6D8C';
  const token = (address, symbol, decimals, usd) => ({ address, symbol, decimals, usd });
  const pool = {
    chain: 'base', address: POOL, gauge: GAUGE, tickSpacing: 1, token0: token(WETH, 'WETH', 18, 3000), token1: token(CBBTC, 'cbBTC', 8, 100000),
    fee: 0.0001, unstakedFee: 0.1, tick: -100000, sqrtPriceX96: '533831226000000000000000000', liquidity: '1000000000', stakedLiquidity: '800000000',
    tvlUsd: 5_000_000, emissionPerSec: 0.01, emissionWindowSec: 604800, vol24h: null, vol7d: null, change24h: 0.01,
  };
  const snapshot = () => ({
    schema: 1, revision: 1, serverNow: Date.now(), config: { enabled: true, intervalMin: 10, minTvlUsd: 0, chains: { base: { enabled: true, rpcUrl: '' } } },
    configError: null, aero: { usd: 1, at: Date.now() },
    chains: [{ id: 'base', name: 'Base', enabled: true, rpcHost: 'fixture', status: 'ok', updatedAt: Date.now(), checkedAt: Date.now(), nextAt: null, error: null, errorAt: null,
      poolCount: 1, activeCount: 1, gaugeCount: 1, history: { points: 0, from: null, archive: 'local', pending: 0 } }],
    pools: [pool], favorites: [], samples: { available: false, error: null, version: 1 },
  });
  const permissions = () => ({ roleKey: 'aero-lp-bot', swaps: [], allowances: [{ token: WETH, symbol: 'WETH', perDay: '1000000000000000000' }, { token: USDC, symbol: 'USDC', perDay: '1000000000' }],
    pools: [{ name: 'WETH/USDC ts100', token0: WETH, token1: USDC, tickSpacing: 100, gauge: '0x0000000000000000000000000000000000000abc' }, ...(merged ? [{ name: 'WETH/cbBTC ts1', token0: WETH, token1: CBBTC, tickSpacing: 1, gauge: GAUGE }] : [])] });
  let plan = null, merged = false, failApply = true;
  const requests = [], errors = [];
  const planPool = () => ({ address: POOL, name: 'WETH/cbBTC ts1', gauge: GAUGE, tickSpacing: 1, token0: { address: WETH, symbol: 'WETH', decimals: 18 }, token1: { address: CBBTC, symbol: 'cbBTC', decimals: 8 },
    allowances: [{ token: CBBTC, symbol: 'cbBTC', perDay: plan.perDay, decimals: 8 }], transactions: 3 });
  const state = () => {
    const perms = permissions();
    return {
      schema: 1, configured: true, configError: null, defaults: { rpcUrl: '', slippageBps: 50, autoSellRewards: false, minRewardSell: '0' },
      config: { schema: 1, rpcUrl: '', safe: '0x0000000000000000000000000000000000000def', roles: '0x0000000000000000000000000000000000000fed', permissions: perms, slippageBps: 50, autoSellRewards: false, minRewardSell: '0' },
      wallet: '0x0000000000000000000000000000000000000b07', paused: false, pauseReason: null, pending: null, job: null, chainAt: Date.now(), chainError: null, refreshing: false,
      chain: { blockNumber: 1, timestamp: Math.floor(Date.now() / 1000), bot: null, botEth: '1', inflight: false, tokens: [], allowances: [],
        pools: perms.pools.map((p, i) => ({ name: p.name, address: i ? POOL : '0x0000000000000000000000000000000000000ccc', gauge: p.gauge, token0: p.token0, token1: p.token1, tickSpacing: p.tickSpacing,
          sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, feePips: 100, earned: '0', penalty: { minStakeBlocks: '0', penaltyRate: '0' }, positions: [] })) },
      events: [], ledger: [], serverNow: Date.now(), poolPlan: plan ? { createdAt: plan.at, pool: planPool(), stale: false } : null,
    };
  };
  const handler = async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (method !== 'GET') requests.push(`${method} ${url.pathname}`);
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'aero-add-pool-fixture' });
    if (url.pathname === '/api/overview') return send({ projects: [], generatedAt: new Date().toISOString() });
    if (url.pathname === market) return send(snapshot());
    if (url.pathname === `${market}/pool`) return send({ chain: 'base', address: POOL, points: [] });
    if (url.pathname === `${market}/liquidity`) return send({ error: 'isolated fixture' }, 503);
    if (url.pathname === `${market}/samples`) return send({ window: '7d', available: false, error: null, version: 1, pools: {} });
    if (url.pathname === root && method === 'GET') return send(state());
    if (url.pathname === `${root}/pools/plan` && method === 'POST') {
      const body = request.postDataJSON();
      assert(body.pool === POOL, 'plan request names the pool');
      assert(Object.keys(body.allowances).length === 1 && body.allowances[CBBTC], `only the new token gets an allowance: ${JSON.stringify(body.allowances)}`);
      plan = { at: Date.now(), perDay: String(Math.round(Number(body.allowances[CBBTC]) * 1e8)) };
      return send({ pool: planPool(), builder: { version: '1.0', chainId: '8453', transactions: [] }, usage: [{ label: 'Router.exactInputSingle', nodes: 29 }],
        transactions: [{ to: '0xfed', description: '限定目标 gauge WETH/cbBTC ts1' }, { to: '0xfed', description: '按条件允许 NPM.mint' }, { to: '0xfed', description: '额度 cbBTC：每 24 小时 1000000（最小单位）' }], state: state() });
    }
    if (url.pathname === `${root}/pools/apply` && method === 'POST') {
      if (failApply) return send({ error: '批次尚未在链上生效（2/14 项未通过）：gauge deposit、额度 cbBTC' }, 409);
      merged = true; plan = null; return send(state());
    }
    if (url.pathname === `${root}/pools/discard` && method === 'POST') { plan = null; return send(state()); }
    return send({ error: 'isolated fixture' }, 404);
  };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?view=aero&tab=market&pool=${encodeURIComponent(`base:${POOL}`)}`);
    const generate = page.getByRole('button', { name: '生成 Safe 批次', exact: true });
    await generate.waitFor();
    // 只为没有额度的 cbBTC 要求填写；WETH 已有额度不出现输入框。
    const cap = page.getByLabel('cbBTC 每日额度');
    assert(await cap.count() === 1, 'cbBTC daily cap input shown');
    assert(await page.getByLabel('WETH 每日额度').count() === 0, 'existing WETH allowance has no input');
    assert(await cap.inputValue() !== '', 'cbBTC cap is prefilled');
    await cap.fill('');
    assert(await generate.isDisabled(), 'generate disabled without a cap');
    await cap.fill('0.01');
    await page.getByText('约 $1,000').waitFor();
    await generate.click();
    await page.getByText('批次共 3 笔，条件树最多用到 29/255 个节点', { exact: false }).waitFor();
    await page.getByText('批次明细').click();
    await page.getByText('额度 cbBTC：每 24 小时 1000000（最小单位）').waitFor();
    assert(plan.perDay === '1000000', `cap sent in token units: ${plan.perDay}`);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载批次 JSON' }).click();
    const file = await download;
    assert(file.suggestedFilename() === 'aero-add-pool-WETH-cbBTC-ts1.json', `download name ${file.suggestedFilename()}`);

    // 链上未生效：显示服务端原因，计划保留。
    const apply = page.getByRole('button', { name: '已执行，核对并启用' });
    await apply.click();
    await page.getByRole('alert').filter({ hasText: '批次尚未在链上生效（2/14 项未通过）' }).waitFor();
    assert(await apply.isVisible(), 'plan kept after a failed apply');

    // 刷新页面后仍能看到已保存的计划并启用。
    await page.reload();
    await page.getByText('已生成 3 笔的批次', { exact: false }).waitFor();
    assert(await page.getByLabel('cbBTC 每日额度').inputValue() === '0.01', 'saved plan allowance is reused after reload');
    failApply = false;
    await page.getByRole('button', { name: '已执行，核对并启用' }).click();
    await page.getByRole('button', { name: '预览开仓' }).or(page.getByText('Safe 余额：')).first().waitFor();
    assert(await page.getByRole('button', { name: '生成 Safe 批次' }).count() === 0, 'add-pool form gone after the pool is whitelisted');
    assert(requests.filter((r) => r.endsWith('/pools/apply')).length === 2, `apply requests ${requests}`);
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
    return 'aero add-pool browser fixture passed';
  } finally {
    await page.unroute('**/*', handler);
  }
}
