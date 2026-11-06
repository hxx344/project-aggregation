// Run against the production workbench preview on port 4180:
// playwright-cli -s=aero-pool-policy run-code --filename tests/aero-pool-policy.browser.mjs
// Every API is an isolated fixture; nothing reaches an RPC, the Safe or Roles.
// Covers 仓位 → 每池仓位策略: saving state, USD cap and the auto switch; 只减不加 blocking 加仓 while 减仓 stays available;
// a partial reduce converted to one pool token; and 停止本池 setting the pool stopped before closing every position in one job.
async (page) => {
  const origin = 'http://127.0.0.1:4180', root = '/api/automation/aero-safe';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const WETH = '0x4200000000000000000000000000000000000006', USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';
  const POOL = '0x0000000000000000000000000000000000000a11', GAUGE = '0x0000000000000000000000000000000000000a12';
  const policies = [], executes = [], errors = [];
  let rule = null; // the fixture server's stored policy for POOL
  const position = (tokenId) => ({ tokenId, staked: true, tickLower: -200, tickUpper: 200, liquidity: '1000000', amount0: 0.1, amount1: 300,
    tokensOwed0: '0', tokensOwed1: '0', depositBlock: '1', depositTime: Math.floor(Date.now() / 1000) - 86_400, penaltyUntilBlock: null });
  const state = () => ({
    schema: 1, configured: true, configError: null, defaults: { rpcUrl: '', slippageBps: 50, autoSellRewards: false, minRewardSell: '0' },
    config: { schema: 1, rpcUrl: '', safe: '0x0000000000000000000000000000000000000def', roles: '0x0000000000000000000000000000000000000fed',
      permissions: { roleKey: 'aero-lp-bot', swaps: [{ tokenIn: WETH, tokenOut: USDC, tickSpacing: 100 }],
        allowances: [{ token: WETH, symbol: 'WETH', perDay: '1000000000000000000' }, { token: USDC, symbol: 'USDC', perDay: '1000000000' }],
        pools: [{ name: 'WETH/USDC', address: POOL, gauge: GAUGE, token0: WETH, token1: USDC, tickSpacing: 100 }] },
      slippageBps: 50, autoSellRewards: false, minRewardSell: '0' },
    wallet: '0x0000000000000000000000000000000000000b07', paused: false, pauseReason: null, pending: null, job: null, chainAt: Date.now(), chainError: null, refreshing: false,
    chain: { blockNumber: 100, timestamp: Math.floor(Date.now() / 1000), bot: null, botEth: '1', inflight: false,
      tokens: [{ address: WETH, symbol: 'WETH', decimals: 18, balance: '0' }, { address: USDC, symbol: 'USDC', decimals: 6, balance: '0' }, { address: AERO, symbol: 'AERO', decimals: 18, balance: '0' }],
      allowances: [], pools: [{ name: 'WETH/USDC', address: POOL, gauge: GAUGE, token0: WETH, token1: USDC, tickSpacing: 100, sqrtPriceX96: '79228162514264337593543950336', tick: 0, feePips: 500,
        earned: '0', penalty: { minStakeBlocks: '0', penaltyRate: '0' }, positions: [position('11'), position('12')] }] },
    events: [], ledger: [], serverNow: Date.now(),
    policy: { pools: rule ? { [POOL]: rule } : {}, corrupt: null, rooms: rule?.capUsd ? { [POOL]: { error: null, capUsd: rule.capUsd, inPoolUsd: 400, roomUsd: rule.capUsd - 400 } } : {} },
  });
  const handler = async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'aero-pool-policy-fixture' });
    if (url.pathname === '/api/overview') return send({ projects: [], generatedAt: new Date().toISOString() });
    if (url.pathname === root && method === 'GET') return send(state());
    if (url.pathname === `${root}/policy` && method === 'PUT') {
      const { policy } = request.postDataJSON(); policies.push(policy);
      rule = { state: policy.state, capUsd: policy.capUsd, auto: policy.auto };
      return send(state());
    }
    if (url.pathname === `${root}/execute` && method === 'POST') { executes.push(request.postDataJSON()); return send(state()); }
    return send({ error: 'isolated fixture' }, 404);
  };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?view=aero&tab=positions`);
    const policy = page.getByRole('group', { name: 'WETH/USDC 仓位策略' });
    await policy.waitFor();
    const save = policy.getByRole('button', { name: '保存' });
    assert(await save.isDisabled(), 'nothing to save before an edit');
    assert((await policy.textContent()).includes('运行 · 不限'), `default policy: ${await policy.textContent()}`);

    // 1. 设为只减不加、上限 $1,000、不参与自动调仓。
    await policy.getByLabel('状态').selectOption('reduce');
    await policy.getByLabel('本池上限（美元）').fill('1000.5');
    await policy.getByLabel('参与自动调仓').uncheck();
    await save.click();
    await policy.getByText('已用约 $400 / $1,000.5', { exact: false }).waitFor();
    assert(JSON.stringify(policies) === JSON.stringify([{ pool: POOL, state: 'reduce', capUsd: 1000.5, auto: false }]), `policy body: ${JSON.stringify(policies)}`);
    assert((await policy.textContent()).includes('不自动调仓') && await save.isDisabled(), 'saved policy shown, draft clean');
    await policy.getByLabel('本池上限（美元）').fill('-3');
    await save.click();
    await page.getByText('本池上限须为正的美元金额', { exact: false }).waitFor();
    assert(policies.length === 1, 'an invalid cap is not sent');
    await policy.getByRole('button', { name: '放弃修改' }).click();
    assert(await policy.getByLabel('本池上限（美元）').inputValue() === '1000.5', 'discard restores the saved cap');

    // 2. 只减不加：加仓不能预览。
    const row = page.getByRole('row').filter({ hasText: '#11' });
    await row.getByRole('button', { name: '加仓…' }).click();
    await page.getByText('本池已设为「只减不加」', { exact: false }).first().waitFor();
    assert(await page.getByRole('button', { name: '预览', exact: true }).isDisabled(), 'reduce-only pool blocks the add preview');

    // 3. 减仓 25% 并换成 USDC。
    await row.getByRole('button', { name: '减仓/平仓…' }).click();
    const withdraw = page.getByRole('group', { name: '减仓 #11' });
    await withdraw.getByRole('button', { name: '25%' }).click();
    await withdraw.getByLabel('撤出后').selectOption({ label: '换成 USDC' });
    assert(await withdraw.getByLabel('撤出后').locator('option').count() === 2, 'only USDC has a whitelisted route from WETH');
    await withdraw.getByRole('button', { name: '减仓', exact: true }).click();
    await page.getByText('已开始减仓', { exact: false }).waitFor();
    assert(JSON.stringify(executes.at(-1)) === JSON.stringify({ action: 'reduce', params: { tokenId: '11', exitToken: USDC, shareBps: 2500 } }), `reduce body: ${JSON.stringify(executes.at(-1))}`);

    // 4. 停止本池：先设为已停止（保留上限与自动开关），再整池平仓换成 USDC。
    await policy.getByRole('button', { name: '停止本池…' }).click();
    const stop = page.getByRole('group', { name: '停止 WETH/USDC' });
    await stop.getByLabel('平仓后').selectOption({ label: '全部换成 USDC' });
    await stop.getByRole('button', { name: '确认停止' }).click();
    await page.getByText('已开始整池平仓', { exact: false }).waitFor();
    assert(JSON.stringify(policies.at(-1)) === JSON.stringify({ pool: POOL, state: 'stopped', capUsd: 1000.5, auto: false }), `stop policy: ${JSON.stringify(policies.at(-1))}`);
    assert(JSON.stringify(executes.at(-1)) === JSON.stringify({ action: 'exitPool', params: { pool: POOL, exitToken: USDC } }), `exitPool body: ${JSON.stringify(executes.at(-1))}`);
    assert((await policy.textContent()).includes('已停止'), 'stopped state shown');
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
    return 'aero pool policy browser fixture passed';
  } finally {
    await page.unroute('**/*', handler);
  }
}
