#!/usr/bin/env node
// 加池分叉演练：本机 anvil（只监听 127.0.0.1）分叉 Base，建 1/1 Safe 与只含 WETH/USDC ts100 的 Roles，
// 用工作台服务端（server/automation/aero-safe.mjs，真实执行器）把 WETH/cbBTC ts1 加入待加池、顺带调 USDC 每日额度，合成一份 Safe 批次：
// 拒绝没有 gauge 的池子与非池子地址；批次未执行或只执行一部分时核对不通过、配置不变；Safe 执行完整批次后核对通过并入配置，
// 按美元上限预览，再在新池开仓（经新兑换路径配平）、质押到新 gauge、平仓。
// 用法：node tools/aero-roles/fork-add-pool.mjs [--fork-url https://mainnet.base.org] [--fork-block <n>]；需要 anvil 在 PATH（或 ANVIL_BIN）。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Interface, JsonRpcProvider, Network, Wallet, ZeroAddress, getAddress, parseEther, toBeHex } from 'ethers';
import { AERO, SAFE } from './addresses.mjs';
import { buildPermissions } from './permissions.mjs';
import { SAFE_ABI, buildSetupBatch, encodeMultiSend, prevalidatedSignature } from './roles-calls.mjs';
import { createAeroSafe } from '../../server/automation/aero-safe.mjs';

const opts = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) => (i % 2 === 0 ? [...acc, [v.replace(/^--/, ''), all[i + 1]]] : acc), []));
const FORK_URL = opts['fork-url'] ?? 'https://mainnet.base.org';
const PORT = 20000 + Math.floor(Math.random() * 20000);
const WETH = getAddress('0x4200000000000000000000000000000000000006'), USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const CBBTC = getAddress('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'), AERO_TOKEN = getAddress('0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee');

const ERC20_I = new Interface(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function deposit() payable']);
const POOL_I = new Interface(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)', 'function gauge() view returns (address)']);
const FACTORY_I = new Interface(['function getPool(address,address,int24) view returns (address)']);
const GAUGE_I = new Interface(['function stakedValues(address) view returns (uint256[])']);

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startAnvil() {
  const args = ['--fork-url', FORK_URL, '--host', '127.0.0.1', '--port', String(PORT), '--silent'];
  if (opts['fork-block']) args.push('--fork-block-number', opts['fork-block']);
  const child = spawn(process.env.ANVIL_BIN || 'anvil', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
  const rpc = new JsonRpcProvider(`http://127.0.0.1:${PORT}`, Network.from(8453), { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  rpc.pollingInterval = 100;
  for (const end = Date.now() + 60_000; Date.now() < end;) {
    if (child.exitCode !== null) throw new Error(`anvil exited: ${stderr.slice(-500)}`);
    try { await rpc.send('eth_blockNumber', []); return { child, rpc }; } catch { await sleep(500); }
  }
  child.kill(); throw new Error('anvil did not start within 60s');
}

async function run(rpc) {
  const view = async (iface, to, fn, args = []) => iface.decodeFunctionResult(fn, await rpc.call({ to, data: iface.encodeFunctionData(fn, args) }));
  const [owner, bot, outsider] = [Wallet.createRandom(rpc), Wallet.createRandom(rpc), Wallet.createRandom(rpc)];
  for (const w of [owner, bot]) await rpc.send('anvil_setBalance', [w.address, toBeHex(parseEther('10'))]);
  await rpc.send('anvil_setBalance', [outsider.address, toBeHex(parseEther('100'))]);
  const send = async (signer, to, data, value = 0n) => (await signer.sendTransaction({ to, data, value, gasLimit: 12_000_000n })).wait();

  const [basePool] = await view(FACTORY_I, AERO.clFactory, 'getPool', [WETH, USDC, 100]);
  const [baseGauge] = await view(POOL_I, basePool, 'gauge');
  const [newPool] = await view(FACTORY_I, AERO.clFactory, 'getPool', [WETH, CBBTC, 1]);
  const [noGaugePool] = await view(FACTORY_I, AERO.clFactory, 'getPool', [WETH, CBBTC, 50]);
  const [newGauge] = await view(POOL_I, newPool, 'gauge');
  console.log(`fork Base block ${await rpc.getBlockNumber()}，新池 WETH/cbBTC ts1 ${newPool}，gauge ${newGauge}`);
  const permissionsConfig = {
    roleKey: 'aero-market-bot',
    pools: [{ name: 'WETH/USDC ts100', token0: WETH, token1: USDC, tickSpacing: 100, gauge: getAddress(baseGauge) }],
    swaps: [{ tokenIn: WETH, tokenOut: USDC, tickSpacing: 100 }, { tokenIn: USDC, tokenOut: WETH, tickSpacing: 100 }, { tokenIn: AERO_TOKEN, tokenOut: USDC, tickSpacing: 200 }],
    allowances: [{ token: USDC, symbol: 'USDC', perDay: '1000000000000' }, { token: WETH, symbol: 'WETH', perDay: '1000000000000000000000' }, { token: AERO_TOKEN, symbol: 'AERO', perDay: '1000000000000000000000000' }],
  };

  // 1/1 Safe + Roles 部署批次（与 fork-test.mjs 相同的路径）。
  const init = new Interface(['function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)']).encodeFunctionData('setup', [[owner.address], 1, ZeroAddress, '0x', SAFE.fallbackHandler, ZeroAddress, 0, ZeroAddress]);
  const factory = new Interface(['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)']);
  const createData = factory.encodeFunctionData('createProxyWithNonce', [SAFE.singletonL2, init, BigInt(Date.now())]);
  const [safe] = factory.decodeFunctionResult('createProxyWithNonce', await rpc.call({ from: owner.address, to: SAFE.proxyFactory, data: createData }));
  await send(owner, SAFE.proxyFactory, createData);
  const { roles, transactions } = buildSetupBatch({ permissions: buildPermissions(permissionsConfig), safe, bot: bot.address, saltNonce: 1n });
  // 硬件钱包在 Safe{Wallet} 执行 Transaction Builder 批次：MultiSendCallOnly delegatecall。
  const execBatch = (txs) => send(owner, safe, SAFE_ABI.encodeFunctionData('execTransaction', [SAFE.multiSendCallOnly, 0, encodeMultiSend(txs), 1, 0, 0, 0, ZeroAddress, ZeroAddress, prevalidatedSignature(owner.address)]));
  check('Safe + Roles 部署批次执行', (await execBatch(transactions)).status === 1);

  const directory = mkdtempSync(join(tmpdir(), 'aero-add-pool-'));
  const manager = createAeroSafe({ dataDir: directory, encrypt: (v) => v, decrypt: (v) => v, log: { info() {}, warn: (...a) => console.log('warn', ...a.slice(1)), error() {}, debug() {} }, makeProvider: () => rpc });
  const settle = async (label) => {
    for (let i = 0; i < 1800; i++) { const s = manager.state(); if (s.job?.status !== 'running' && !s.refreshing) return s; await sleep(100); }
    throw new Error(`${label} 未结束`);
  };
  const rejects = async (name, fn, pattern) => {
    try { await fn(); check(name, false, '未报错'); } catch (error) { check(name, pattern.test(error.message), error.message); }
  };
  try {
    await manager.initialize();
    await manager.save({ rpcUrl: `http://127.0.0.1:${PORT}`, safe, roles, permissions: permissionsConfig, autoSellRewards: false });
    await manager.setKey(bot.privateKey);
    await settle('读取');

    await rejects('拒绝没有 gauge 的池子（WETH/cbBTC ts50）', () => manager.addPoolChange({ pool: noGaugePool, allowances: { [CBBTC]: '1' } }), /没有 gauge/);
    await rejects('拒绝不是池子的地址（USDC 合约）', () => manager.addPoolChange({ pool: USDC, allowances: {} }), /失败|不是/);
    await rejects('新代币必须填写每日额度', () => manager.addPoolChange({ pool: newPool }), /cbBTC 的每日额度/);
    await manager.addPoolChange({ pool: newPool, allowances: { [CBBTC]: '0.5' } });
    // 同一批次顺带把 USDC 每日额度从 100 万调到 5000。
    await manager.setAllowanceChanges({ [USDC]: '5000' });
    const plan = await manager.buildChangeBatch();
    console.log(plan.transactions.map((t, i) => `  ${String(i + 1).padStart(2)}. ${t.description}`).join('\n'));
    console.log(`  条件节点：${plan.usage.map((u) => `${u.label} ${u.nodes}`).join('，')}`);
    const usdcAt = plan.transactions.findIndex((t) => t.description.startsWith('调整额度 USDC'));
    check('生成白名单变更批次', plan.builder.transactions.length > 0 && plan.state.changes.batch.pools[0] === 'WETH/cbBTC ts1' && usdcAt >= 0, `${plan.builder.transactions.length} 笔`);

    await rejects('批次未执行时核对不通过、配置不变', () => manager.applyChangeBatch(), /尚未在链上生效/);
    // 只执行除 USDC 调额度以外的部分：仍须拒绝。
    const builderTxs = plan.builder.transactions;
    check('部分批次执行', (await execBatch(builderTxs.filter((_, i) => i !== usdcAt))).status === 1);
    await rejects('USDC 额度未调整时核对不通过', () => manager.applyChangeBatch(), /额度 USDC/);
    check('配置仍只有原池子', manager.state().config.permissions.pools.length === 1);
    check('补执行剩余一笔', (await execBatch([builderTxs[usdcAt]])).status === 1);
    const applied = await manager.applyChangeBatch();
    check('核对通过并入配置', applied.config.permissions.pools.length === 2 && applied.changes.batch === null && applied.changes.pools.length === 0
      && applied.config.permissions.allowances.find((x) => x.token === USDC).perDay === '5000000000');
    await settle('读取');
    const chainPool = manager.state().chain?.pools.find((p) => p.address === getAddress(newPool));
    check('刷新后读到新池', Boolean(chainPool), manager.state().chainError ?? '');

    // Safe 只有 WETH：开仓时经新路径 WETH → cbBTC 配平。
    await send(outsider, WETH, ERC20_I.encodeFunctionData('deposit'), parseEther('0.2'));
    await send(outsider, WETH, ERC20_I.encodeFunctionData('transfer', [safe, parseEther('0.2')]));
    manager.refresh(); await settle('读取');
    const [, tick] = await view(POOL_I, newPool, 'slot0');
    const range = [Number(tick) - 40, Number(tick) + 40];
    const preview = await manager.preview({ pool: newPool, tickLower: range[0], tickUpper: range[1], shareBps: 10_000 });
    check('预览需要配平兑换 WETH → cbBTC', preview.swap?.tokenIn === WETH, JSON.stringify(preview.swap));
    const capped = await manager.preview({ pool: newPool, tickLower: range[0], tickUpper: range[1], shareBps: 10_000, cap: { usd: 100, usd0: 2000, usd1: 1 } });
    check('投入上限 $100（WETH 按 $2000 计）只投 0.05 WETH', capped.capped === true && BigInt(capped.amount0) === parseEther('0.05'), `${capped.amount0}`);
    await manager.execute('open', { pool: newPool, tickLower: range[0], tickUpper: range[1], shareBps: 10_000, expect: { previewedAt: preview.previewedAt, amount0: String(preview.amount0), amount1: String(preview.amount1), swapIn: preview.swap ? String(preview.swap.amountIn) : null, swapTokenIn: preview.swap?.tokenIn ?? null } });
    let s = await settle('开仓');
    check('新池开仓并质押', s.job.status === 'done', s.job.error ?? `#${s.job.result?.tokenId}`);
    const tokenId = String(s.job.result?.tokenId ?? '');
    const [staked] = await view(GAUGE_I, newGauge, 'stakedValues', [safe]);
    check('头寸质押在新 gauge', staked.map(String).includes(tokenId));
    manager.refresh(); await settle('读取');
    await manager.execute('close', { tokenId, acceptPenalty: true });
    s = await settle('平仓');
    check('新池平仓', s.job.status === 'done', s.job.error ?? '');
    const [cbbtc] = await view(ERC20_I, CBBTC, 'balanceOf', [safe]);
    check('cbBTC 回到 Safe', cbbtc > 0n, String(cbbtc));
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
}

const { child, rpc } = await startAnvil();
try { await run(rpc); } catch (error) { check('演练异常', false, error.stack); } finally { rpc.destroy(); child.kill(); }
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
if (results.some((ok) => !ok)) process.exitCode = 1;
