// Run against the production workbench preview on port 4180:
// playwright-cli -s=aero-add-pool run-code --filename tests/aero-add-pool.browser.mjs
// Every API is an isolated fixture; nothing reaches an RPC, the Safe or Roles.
// Covers: queueing a pool from its detail page (and removing it again), the 已加池/待加池 tags in the market list,
// adjusting an existing daily allowance in 配置 → 白名单变更, one Safe batch for all pending changes with its per-token allowance effects,
// the unknown gauge liveness warning, a failed and a passing apply,
// and the optional USD cap of the open form.
async (page) => {
  const origin = 'http://127.0.0.1:4180', market = '/api/research/aero-market', root = '/api/automation/aero-safe';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const WETH = '0x4200000000000000000000000000000000000006', USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', POOL = '0xeC3c4F0E9a1fC3B1D29BC2F8DA0C7e0E2B4074C2', LISTED = '0x0000000000000000000000000000000000000ccc';
  const GAUGE = '0xAbb3fF6c0b4F2c0B0a5ad0f2C1b2f6C4f8Bd6D8C';
  const token = (address, symbol, decimals, usd) => ({ address, symbol, decimals, usd });
  const marketPool = (address, token0, token1, tickSpacing, gauge) => ({
    chain: 'base', address, gauge, tickSpacing, token0, token1,
    fee: 0.0001, unstakedFee: 0.1, tick: -100000, sqrtPriceX96: '533831226000000000000000000', liquidity: '1000000000', stakedLiquidity: '800000000',
    tvlUsd: 5_000_000, emissionPerSec: 0.01, emissionWindowSec: 604800, vol24h: null, vol7d: null, change24h: 0.01,
  });
  const pool = marketPool(POOL, token(WETH, 'WETH', 18, 3000), token(CBBTC, 'cbBTC', 8, 100000), 1, GAUGE);
  const listedPool = marketPool(LISTED, token(WETH, 'WETH', 18, 3000), token(USDC, 'USDC', 6, 1), 100, '0x0000000000000000000000000000000000000abc');
  const snapshot = () => ({
    schema: 1, revision: 1, serverNow: Date.now(), config: { enabled: true, intervalMin: 10, minTvlUsd: 0, chains: { base: { enabled: true, rpcUrl: '' } } },
    configError: null, aero: { usd: 1, at: Date.now() },
    chains: [{ id: 'base', name: 'Base', enabled: true, rpcHost: 'fixture', status: 'ok', updatedAt: Date.now(), checkedAt: Date.now(), nextAt: null, error: null, errorAt: null,
      poolCount: 2, activeCount: 2, gaugeCount: 2, history: { points: 0, from: null, archive: 'local', pending: 0 } }],
    pools: [pool, listedPool], favorites: [], samples: { available: false, error: null, version: 1 },
  });
  // Fixture server model.
  let queued = [], allowances = [], batch = null, merged = false, failApply = true, usdcPerDay = '1000000000';
  const requests = [], errors = [], previews = [];
  const queuedPool = () => ({ address: POOL, name: 'WETH/cbBTC ts1', gauge: GAUGE, tickSpacing: 1, token0: { address: WETH, symbol: 'WETH', decimals: 18 }, token1: { address: CBBTC, symbol: 'cbBTC', decimals: 8 }, addedAt: Date.now(),
    gaugeStatus: { state: 'unknown', note: 'Voter 不提供 isAlive（调用回滚），无法确认 gauge 是否已被停用' } });
  const permissions = () => ({ roleKey: 'aero-lp-bot', swaps: [],
    allowances: [{ token: WETH, symbol: 'WETH', perDay: '1000000000000000000' }, { token: USDC, symbol: 'USDC', perDay: usdcPerDay }, ...(merged ? [{ token: CBBTC, symbol: 'cbBTC', perDay: '1000000' }] : [])],
    pools: [{ name: 'WETH/USDC ts100', token0: WETH, token1: USDC, tickSpacing: 100, gauge: listedPool.gauge }, ...(merged ? [{ name: 'WETH/cbBTC ts1', token0: WETH, token1: CBBTC, tickSpacing: 1, gauge: GAUGE }] : [])] });
  const pending = () => queued.length + allowances.length;
  const state = () => {
    const perms = permissions();
    return {
      schema: 1, configured: true, configError: null, defaults: { rpcUrl: '', slippageBps: 50, autoSellRewards: false, minRewardSell: '0' },
      config: { schema: 1, rpcUrl: '', safe: '0x0000000000000000000000000000000000000def', roles: '0x0000000000000000000000000000000000000fed', permissions: perms, slippageBps: 50, autoSellRewards: false, minRewardSell: '0' },
      wallet: '0x0000000000000000000000000000000000000b07', paused: false, pauseReason: null, pending: null, job: null, chainAt: Date.now(), chainError: null, refreshing: false,
      chain: { blockNumber: 1, timestamp: Math.floor(Date.now() / 1000), bot: null, botEth: '1', inflight: false,
        tokens: [{ address: WETH, symbol: 'WETH', decimals: 18, balance: '0' }, { address: USDC, symbol: 'USDC', decimals: 6, balance: '0' }],
        allowances: [{ token: USDC, symbol: 'USDC', perDay: usdcPerDay, remaining: '400000000', maxRefill: usdcPerDay, refillAt: null }],
        pools: perms.pools.map((p, i) => ({ name: p.name, address: i ? POOL : LISTED, gauge: p.gauge, token0: p.token0, token1: p.token1, tickSpacing: p.tickSpacing,
          sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, feePips: 100, earned: '0', penalty: { minStakeBlocks: '0', penaltyRate: '0' }, positions: [] })) },
      events: [], ledger: [], serverNow: Date.now(),
      changes: {
        pools: queued, allowances: allowances.map((a) => ({ ...a, current: a.token === USDC ? usdcPerDay : null })),
        preview: { transactions: pending() ? 3 + allowances.length : 0, usage: pending() ? [{ label: 'Router.exactInputSingle', nodes: 29 }] : [], error: null },
        batch,
      },
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
    const body = method === 'POST' ? request.postDataJSON() : null;
    if (url.pathname === `${root}/changes/pool` && method === 'POST') {
      assert(body.pool === POOL, 'queue request names the pool');
      assert(Object.keys(body.allowances).length === 1 && body.allowances[CBBTC], `only the new token gets an allowance: ${JSON.stringify(body.allowances)}`);
      queued = [queuedPool()];
      allowances = [...allowances.filter((a) => a.token !== CBBTC), { token: CBBTC, symbol: 'cbBTC', decimals: 8, perDay: String(Math.round(Number(body.allowances[CBBTC]) * 1e8)) }];
      return send(state());
    }
    if (url.pathname === `${root}/changes/remove` && method === 'POST') {
      assert(body.pool === POOL, 'remove names the pool');
      queued = []; allowances = allowances.filter((a) => a.token !== CBBTC); return send(state());
    }
    if (url.pathname === `${root}/changes/allowances` && method === 'POST') {
      assert(JSON.stringify(body) === JSON.stringify({ allowances: { [USDC]: '500' } }), `only the edited USDC row is sent: ${JSON.stringify(body)}`);
      allowances = [...allowances.filter((a) => a.token !== USDC), { token: USDC, symbol: 'USDC', decimals: 6, perDay: '500000000' }];
      return send(state());
    }
    if (url.pathname === `${root}/changes/batch` && method === 'POST') {
      batch = { createdAt: Date.now(), transactions: 4, pools: ['WETH/cbBTC ts1'], allowances: allowances.map(({ symbol, perDay, decimals }) => ({ symbol, perDay, decimals })), stale: false, staleReason: null, behind: false,
        added: { pools: [], allowances: [] }, withdrawn: { pools: [], allowances: [] } };
      const effect = (symbol, decimals, previous, perDay, used, balance, first) => ({ key: `0x${symbol}`, token: symbol, symbol, decimals, previous, perDay, first, used, balance,
        nextRefill: first ? null : 1_800_057_600, readAt: 1_800_000_000, replay: { samePeriod: balance, laterPeriod: perDay } });
      return send({ builder: { version: '1.0', chainId: '8453', transactions: [] }, usage: [{ label: 'Router.exactInputSingle', nodes: 29 }],
        allowances: [effect('cbBTC', 8, null, '1000000', '0', '1000000', true), effect('USDC', 6, '1000000000', '500000000', '600000000', '0', false)],
        transactions: [{ to: '0xfed', description: '限定目标 gauge WETH/cbBTC ts1' }, { to: '0xfed', description: '按条件允许 NPM.mint' }, { to: '0xfed', description: '额度 cbBTC：每 24 小时 1000000（最小单位）' },
          { to: '0xfed', description: '调整额度 USDC：每 24 小时 1000000000 → 500000000（最小单位）；按生成时链上读数本期已用 600000000，执行后本期剩余 0（不在本期重新计满）' }], state: state() });
    }
    if (url.pathname === `${root}/changes/apply` && method === 'POST') {
      if (failApply) return send({ error: '批次尚未在链上生效（2/14 项未通过）：gauge deposit、额度 cbBTC' }, 409);
      merged = true; usdcPerDay = '500000000'; queued = []; allowances = []; batch = null; return send(state());
    }
    if (url.pathname === `${root}/preview` && method === 'POST') {
      previews.push(body.params.cap ?? null);
      const capped = !!body.params.cap;
      return send({ pool: POOL, tick: pool.tick, sqrtPriceX96: pool.sqrtPriceX96, tickLower: body.params.tickLower, tickUpper: body.params.tickUpper,
        amount0: capped ? '100000000000000000' : '1000000000000000000', amount1: '0', capped, swap: null, deposit0: '0', deposit1: '0', previewedAt: Date.now() });
    }
    return send({ error: 'isolated fixture' }, 404);
  };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.route('**/*', handler);
  try {
    // 1. 池详情：只为没有额度的 cbBTC 要求填写，加入待加池，移出后再加入。
    await page.goto(`${origin}/?view=aero&tab=market&pool=${encodeURIComponent(`base:${POOL}`)}`);
    const add = page.getByRole('button', { name: '加入待加池', exact: true });
    await add.waitFor();
    const cap = page.getByLabel('cbBTC 每日额度');
    assert(await cap.count() === 1, 'cbBTC daily cap input shown');
    assert(await page.getByLabel('WETH 每日额度').count() === 0, 'existing WETH allowance has no input');
    assert(await cap.inputValue() !== '', 'cbBTC cap is prefilled');
    await cap.fill('');
    assert(await add.isDisabled(), 'add disabled without a cap');
    await cap.fill('0.01');
    await page.getByText('约 $1,000').waitFor();
    await add.click();
    await page.getByText('这个池子已在待加池里', { exact: false }).waitFor();
    await page.getByText('新代币每日额度：cbBTC 0.01', { exact: false }).waitFor();
    await page.getByText('gauge 状态未知：Voter 不提供 isAlive', { exact: false }).waitFor();
    await page.getByRole('button', { name: '移出待加池' }).click();
    await add.waitFor();
    await page.getByLabel('cbBTC 每日额度').fill('0.01');
    await add.click();
    await page.getByText('这个池子已在待加池里', { exact: false }).waitFor();

    // 2. 行情列表：已在白名单的池子标「已加池」，待加池的标「待加池」。
    await page.goto(`${origin}/?view=aero&tab=market`);
    const tagOf = (pair) => page.locator('tr', { hasText: pair }).locator('.as-tag');
    await tagOf('WETH / cbBTC').filter({ hasText: '待加池' }).waitFor();
    assert(await tagOf('WETH / USDC').innerText() === '已加池', 'whitelisted pool is tagged');

    // 3. 配置 → 白名单变更：改 USDC 每日额度，合成一份批次。
    await page.goto(`${origin}/?view=aero&tab=config`);
    const usdc = page.getByLabel('USDC 新每日额度');
    await usdc.waitFor();
    assert(await usdc.inputValue() === '1000', `USDC shows its current allowance: ${await usdc.inputValue()}`);
    assert(await page.getByLabel('cbBTC 新每日额度').inputValue() === '0.01', 'the queued new token is listed');
    await page.getByText('400 USDC').waitFor(); // today's remaining
    const record = page.getByRole('button', { name: '记为待改额度' });
    assert(await record.isDisabled(), 'nothing to record before an edit');
    await usdc.fill('0');
    assert(await record.isDisabled(), 'zero is rejected');
    await usdc.fill('500');
    await record.click();
    await page.getByText('待改，原 1000').waitFor();
    await page.getByText('1 个待加池 · 2 项额度待改').waitFor();
    await page.getByRole('button', { name: '生成 Safe 批次' }).click();
    await page.getByText('批次共 4 笔，条件树最多用到 29/255 个节点', { exact: false }).waitFor();
    await page.getByText('批次明细').click();
    await page.getByText('调整额度 USDC：每 24 小时 1000000000 → 500000000', { exact: false }).waitFor();
    // 额度的执行效果单列：本期已用 600 时调到 500，本期不再可用；重复执行的上限逐个代币列出。
    await page.getByText('USDC：每日 1000 USDC → 500 USDC；本期已用 600 USDC，执行后本期剩余 0 USDC', { exact: false }).waitFor();
    await page.getByText('cbBTC：链上尚无此额度，首次设置为每日 0.01 cbBTC', { exact: false }).waitFor();
    await page.getByText('USDC 每多执行一次本期最多再花 0 USDC，到之后的周期再执行则当期重新计满 500 USDC', { exact: false }).waitFor();
    assert(await page.locator('.as-list .as-warn', { hasText: 'gauge 状态未知' }).count() === 1, 'the pending pool list flags the unknown gauge');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载批次 JSON' }).click();
    const file = await download;
    assert(/^aero-roles-changes-[\d-]+\.json$/.test(file.suggestedFilename()), `download name ${file.suggestedFilename()}`);

    // 链上未生效：显示服务端原因，批次保留。
    const apply = page.getByRole('button', { name: '已执行，核对并启用' });
    await apply.click();
    await page.getByRole('alert').filter({ hasText: '批次尚未在链上生效（2/14 项未通过）' }).waitFor();
    assert(await apply.isVisible(), 'batch kept after a failed apply');

    // 刷新页面后仍能看到已保存的批次并启用。
    await page.reload();
    await page.getByText('生成的批次（4 笔）：加池 WETH/cbBTC ts1；额度 cbBTC 0.01、USDC 500', { exact: false }).waitFor();
    failApply = false;
    await page.getByRole('button', { name: '已执行，核对并启用' }).click();
    await page.getByText('没有待变更').waitFor();
    assert(await page.getByLabel('USDC 新每日额度').inputValue() === '500', 'USDC allowance applied');

    await page.goto(`${origin}/?view=aero&tab=market`);
    await tagOf('WETH / cbBTC').filter({ hasText: '已加池' }).waitFor();

    // 4. 启用后在新池开仓：投入上限按行情美元价随预览发送，预览标明已按上限缩减。
    await page.goto(`${origin}/?view=aero&tab=market&pool=${encodeURIComponent(`base:${POOL}`)}`);
    const capInput = page.getByLabel('投入上限（美元，选填）');
    await capInput.waitFor();
    await capInput.fill('-1');
    assert(await page.getByRole('button', { name: '预览', exact: true }).isDisabled(), 'negative cap blocks the preview');
    await capInput.fill('300');
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await page.getByText('已按上限 $300 缩减', { exact: false }).waitFor();
    assert(JSON.stringify(previews) === JSON.stringify([{ usd: 300, usd0: 3000, usd1: 100000 }]), `cap sent with market prices: ${JSON.stringify(previews)}`);
    await capInput.fill('');
    assert(await page.getByText('已按上限', { exact: false }).count() === 0, 'changing the cap invalidates the preview');
    assert(requests.filter((r) => r.endsWith('/changes/apply')).length === 2, `apply requests ${requests}`);
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
    return 'aero add-pool browser fixture passed';
  } finally {
    await page.unroute('**/*', handler);
  }
}
