// Run against the production workbench preview on port 4180:
// playwright-cli -s=aero-safe-changes run-code --filename tests/aero-safe-changes.browser.mjs
// Every API is an isolated fixture; nothing reaches an RPC, the Safe or Roles.
// Covers 配置 → 白名单变更: unsaved allowance inputs survive state reads while one token's decimals flip between unknown and known
// (only that row is flagged and revalidated, untouched rows follow the server), and the frozen batch is shown apart from the
// draft's additions and withdrawals for both pools and allowances, the execution deadline once it has passed, plus the stale reason and the persistence error.
async (page) => {
  const origin = 'http://127.0.0.1:4180', root = '/api/automation/aero-safe';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const WETH = '0x4200000000000000000000000000000000000006', USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
  // Fixture server model.
  let usdcDecimals = 6, cbbtcPerDay = '1000000', batch = null, persistError = null, reads = 0;
  const posts = [], errors = [];
  const allowances = () => [{ token: WETH, symbol: 'WETH', perDay: '1000000000000000000' }, { token: USDC, symbol: 'USDC', perDay: '1000000000' }, { token: CBBTC, symbol: 'cbBTC', perDay: cbbtcPerDay }];
  const state = () => ({
    schema: 1, configured: true, configError: null, defaults: { rpcUrl: '', slippageBps: 50, autoSellRewards: false, minRewardSell: '0' },
    config: { schema: 1, rpcUrl: '', safe: '0x0000000000000000000000000000000000000def', roles: '0x0000000000000000000000000000000000000fed',
      permissions: { roleKey: 'aero-lp-bot', swaps: [], allowances: allowances(), pools: [] }, slippageBps: 50, autoSellRewards: false, minRewardSell: '0' },
    wallet: '0x0000000000000000000000000000000000000b07', paused: false, pauseReason: null, pending: null, job: null, chainAt: Date.now(), chainError: null, refreshing: false,
    chain: { blockNumber: 1, timestamp: Math.floor(Date.now() / 1000), bot: null, botEth: '1', inflight: false,
      tokens: [{ address: WETH, symbol: 'WETH', decimals: 18, balance: '0' }, ...(usdcDecimals === null ? [] : [{ address: USDC, symbol: 'USDC', decimals: usdcDecimals, balance: '0' }]),
        { address: CBBTC, symbol: 'cbBTC', decimals: 8, balance: '0' }],
      allowances: [], pools: [] },
    events: [], ledger: [], serverNow: Date.now(),
    changes: { pools: [], allowances: [], preview: { transactions: 0, usage: [], error: null }, persistError, batch },
  });
  const handler = async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'aero-safe-changes-fixture' });
    if (url.pathname === '/api/overview') return send({ projects: [], generatedAt: new Date().toISOString() });
    if (url.pathname === root && method === 'GET') { reads += 1; return send(state()); }
    if (url.pathname === `${root}/changes/allowances` && method === 'POST') { posts.push(request.postDataJSON()); return send(state()); }
    return send({ error: 'isolated fixture' }, 404);
  };
  // The page re-reads its state when it becomes visible: a deterministic stand-in for the 15 s poll.
  const poll = async () => {
    const before = reads;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    for (let i = 0; i < 100 && reads === before; i++) await page.waitForTimeout(20);
    assert(reads > before, 'state was read again');
    await page.waitForTimeout(100);
  };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?view=aero&tab=config`);
    const weth = page.getByLabel('WETH 新每日额度'), usdc = page.getByLabel('USDC 新每日额度'), cbbtc = page.getByLabel('cbBTC 新每日额度');
    await usdc.waitFor();
    assert(await usdc.inputValue() === '1000' && await weth.inputValue() === '1', 'inputs start at the configured values');
    const record = page.getByRole('button', { name: '记为待改额度' });

    // 1. 两行有未提交的输入；USDC 精度在轮询之间读不到 → 读到 → 变了。
    await weth.fill('2');
    await usdc.fill('750.125');
    usdcDecimals = null; cbbtcPerDay = '2000000';
    await poll();
    assert(await weth.inputValue() === '2', `the other row keeps its unsaved input: ${await weth.inputValue()}`);
    assert(await usdc.inputValue() === '750.125' && await usdc.isDisabled(), 'the row without decimals keeps its input, disabled');
    await page.getByText('代币精度暂时读不到，已保留未提交的输入', { exact: false }).waitFor();
    assert(await cbbtc.inputValue() === '0.02', `an untouched row follows the server: ${await cbbtc.inputValue()}`);
    assert(await record.isEnabled(), 'the WETH edit can still be recorded');

    usdcDecimals = 6;
    await poll();
    assert(await usdc.inputValue() === '750.125' && await usdc.isEnabled(), 'decimals back: the input is still the user\'s');
    await page.getByText('代币精度已变化（现为 6 位），已保留未提交的输入，请核对', { exact: false }).waitFor();
    assert(await weth.inputValue() === '2', 'the other row is still kept');

    usdcDecimals = 2;
    await poll();
    await page.getByText('代币精度已变化（现为 2 位），已保留未提交的输入，请核对：最多 2 位小数', { exact: false }).waitFor();
    assert(await record.isDisabled(), 'the changed row is revalidated against the new decimals');
    await usdc.fill('750.12');
    assert(await page.getByText('代币精度已变化', { exact: false }).count() === 0, 'editing the row clears the notice');
    await record.click();
    await page.waitForTimeout(200);
    assert(JSON.stringify(posts) === JSON.stringify([{ allowances: { [WETH]: '2', [USDC]: '750.12' } }]), `both unsaved rows are sent: ${JSON.stringify(posts)}`);

    // 2. 冻结批次与最新草稿：撤回加池与额度、草稿新增，分别展示。
    batch = { createdAt: Date.now(), transactions: 4, pools: ['WETH/cbBTC ts1'], allowances: [{ symbol: 'USDC', perDay: '500000000', decimals: 6 }], stale: false, staleReason: null, behind: true,
      added: { pools: ['AERO/USDC ts200'], allowances: [{ symbol: 'USDC', perDay: '600000000', decimals: 6 }] },
      withdrawn: { pools: ['WETH/cbBTC ts1'], allowances: [{ symbol: 'USDC', perDay: '500000000', decimals: 6 }] } };
    await poll();
    await page.getByText('生成的批次（4 笔）：加池 WETH/cbBTC ts1；额度 USDC 500', { exact: false }).waitFor();
    const withdrawn = page.getByRole('status').filter({ hasText: '生成批次之后已从草稿撤回或改了值：加池 WETH/cbBTC ts1；额度 USDC 500' });
    await withdrawn.waitFor();
    assert(/已生成的批次文件仍包含这些操作，在 Safe 执行仍会生效/.test(await withdrawn.innerText()), 'withdrawn items still run from the old file');
    await page.getByText('生成批次之后新增，未包含在这份批次里：加池 AERO/USDC ts200；额度 USDC 600', { exact: false }).waitFor();

    // 只撤回额度：不出现「继续保留」的说法。
    batch = { ...batch, added: { pools: [], allowances: [] }, withdrawn: { pools: [], allowances: [{ symbol: 'USDC', perDay: '500000000', decimals: 6 }] } };
    await poll();
    await page.getByText('生成批次之后已从草稿撤回或改了值：额度 USDC 500', { exact: false }).waitFor();
    assert(await page.getByText('继续保留', { exact: false }).count() === 0, 'a withdrawal is not described as kept for later');
    assert(await page.getByRole('button', { name: '已执行，核对并启用' }).isVisible(), 'the frozen batch can still be applied');

    // 过了执行期限：警示未执行的不要再执行、请重新生成；已在期限前执行的仍可核对启用。
    const deadline = Date.now() - 60_000;
    batch = { ...batch, executeBefore: deadline, expired: true };
    await poll();
    const expired = page.getByRole('alert').filter({ hasText: '这份批次已过执行期限' });
    await expired.waitFor();
    const expiredText = await expired.innerText();
    assert(expiredText.includes(`${new Date(deadline).toISOString().slice(0, 16).replace('T', ' ')} UTC`) && /不要再执行这份文件/.test(expiredText) && /已在期限前执行的，可以核对启用/.test(expiredText), `expired notice: ${expiredText}`);
    assert(await page.getByRole('button', { name: '已执行，核对并启用' }).isVisible(), 'a batch executed in time can still be applied after the deadline');

    // 3. 失效原因与写盘失败照原文显示；失效批次不能核对。
    batch = { ...batch, stale: true, staleReason: '这份批次来自旧版本，没有记录 Safe 与 Roles 地址，不能再核对，请重新生成' };
    persistError = '批次已核对启用并写入配置，但待变更文件 aero-safe/changes.json 写入失败；重启后会按配置认出这份已启用的批次，不需要重新签名。请检查数据目录权限';
    await poll();
    await page.getByText('这份批次来自旧版本，没有记录 Safe 与 Roles 地址', { exact: false }).waitFor();
    assert(await page.getByRole('button', { name: '已执行，核对并启用' }).count() === 0, 'a stale batch has no apply button');
    await page.getByRole('alert').filter({ hasText: 'changes.json 写入失败' }).waitFor();
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
    return 'aero safe changes browser fixture passed';
  } finally {
    await page.unroute('**/*', handler);
  }
}
