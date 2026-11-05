#!/usr/bin/env node
// 自动调仓分叉演练：本机 anvil（只监听 127.0.0.1）分叉 Base，建 1/1 Safe 并执行部署批次，WETH/USDC ts100 池；
// 用工作台服务端（server/automation/aero-safe.mjs，真实执行器与 Roles）手动开一个窄区间并质押，外部地址把价格推出区间，
// 先验证现价偏离 TWAP 时不动，再推进链上时间让 TWAP 追上后验证自动调仓：旧头寸销毁、按原宽度居中重开并质押、只投入平仓收回的币。
// 用法：node tools/aero-roles/fork-rebalance.mjs [--fork-url https://mainnet.base.org] [--fork-block <n>]；需要 anvil 在 PATH（或 ANVIL_BIN）。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Interface, JsonRpcProvider, Network, Wallet, ZeroAddress, getAddress, parseEther, toBeHex } from 'ethers';
import { AERO, SAFE } from './addresses.mjs';
import { buildPermissions } from './permissions.mjs';
import { SAFE_ABI, buildSetupBatch, encodeMultiSend, prevalidatedSignature, toTransactionBuilderJson } from './roles-calls.mjs';
import { createAeroSafe } from '../../server/automation/aero-safe.mjs';

const opts = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) => (i % 2 === 0 ? [...acc, [v.replace(/^--/, ''), all[i + 1]]] : acc), []));
const FORK_URL = opts['fork-url'] ?? 'https://mainnet.base.org';
const PORT = 20000 + Math.floor(Math.random() * 20000);
const WETH = getAddress('0x4200000000000000000000000000000000000006'), USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), AERO_TOKEN = getAddress('0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee');
const TS = 100;

const ERC20_I = new Interface(['function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function deposit() payable']);
const ROUTER_I = new Interface(['function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256)']);
const POOL_I = new Interface(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)']);
const FACTORY_I = new Interface(['function getPool(address,address,int24) view returns (address)']);
const POOL_GAUGE_I = new Interface(['function gauge() view returns (address)']);
const GAUGE_I = new Interface(['function stakedValues(address) view returns (uint256[])']);
const NPM_I = new Interface(['function ownerOf(uint256) view returns (address)']);
const GF_I = new Interface(['function effectivePenaltyConfig(address) view returns (uint256 minStakeBlocks, uint256 penaltyRate)']);

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
  const [owner, outsider] = [Wallet.createRandom(rpc), Wallet.createRandom(rpc)];
  const bot = Wallet.createRandom(rpc);
  for (const w of [owner, bot]) await rpc.send('anvil_setBalance', [w.address, toBeHex(parseEther('10'))]);
  await rpc.send('anvil_setBalance', [outsider.address, toBeHex(parseEther('100000'))]);
  const send = async (signer, to, data, value = 0n) => (await signer.sendTransaction({ to, data, value, gasLimit: 8_000_000n })).wait();

  const [pool] = await view(FACTORY_I, AERO.clFactory, 'getPool', [WETH, USDC, TS]);
  const [gauge] = await view(POOL_GAUGE_I, pool, 'gauge');
  console.log(`fork Base block ${await rpc.getBlockNumber()}，池子 ${pool}，gauge ${gauge}`);
  const permissionsConfig = {
    roleKey: 'aero-market-bot',
    pools: [{ name: 'WETH/USDC ts100', token0: WETH, token1: USDC, tickSpacing: TS, gauge: getAddress(gauge) }],
    swaps: [{ tokenIn: WETH, tokenOut: USDC, tickSpacing: TS }, { tokenIn: USDC, tokenOut: WETH, tickSpacing: TS }, { tokenIn: AERO_TOKEN, tokenOut: USDC, tickSpacing: 200 }],
    allowances: [{ token: USDC, symbol: 'USDC', perDay: '1000000000000' }, { token: WETH, symbol: 'WETH', perDay: '1000000000000000000000' }, { token: AERO_TOKEN, symbol: 'AERO', perDay: '1000000000000000000000000' }],
  };

  // 1/1 Safe + Roles 部署批次（与 fork-test.mjs 相同的路径）。
  const init = new Interface(['function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)']).encodeFunctionData('setup', [[owner.address], 1, ZeroAddress, '0x', SAFE.fallbackHandler, ZeroAddress, 0, ZeroAddress]);
  const factory = new Interface(['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)']);
  const createData = factory.encodeFunctionData('createProxyWithNonce', [SAFE.singletonL2, init, BigInt(Date.now())]);
  const [safe] = factory.decodeFunctionResult('createProxyWithNonce', await rpc.call({ from: owner.address, to: SAFE.proxyFactory, data: createData }));
  await send(owner, SAFE.proxyFactory, createData);
  const permissions = buildPermissions(permissionsConfig);
  const { roles, transactions } = buildSetupBatch({ permissions, safe, bot: bot.address, saltNonce: 1n });
  const batch = toTransactionBuilderJson({ safe, transactions, name: 'fork', description: 'fork' });
  const setup = await send(owner, safe, SAFE_ABI.encodeFunctionData('execTransaction', [SAFE.multiSendCallOnly, 0, encodeMultiSend(batch.transactions), 1, 0, 0, 0, ZeroAddress, ZeroAddress, prevalidatedSignature(owner.address)]));
  check('Safe + Roles 部署批次执行', setup.status === 1);

  // 外部地址换出 WETH 与 USDC，转一部分给 Safe。
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 3600) + 10n ** 6n;
  await send(outsider, WETH, ERC20_I.encodeFunctionData('deposit'), parseEther('30000'));
  await send(outsider, WETH, ERC20_I.encodeFunctionData('approve', [AERO.swapRouter, 2n ** 255n]));
  await send(outsider, USDC, ERC20_I.encodeFunctionData('approve', [AERO.swapRouter, 2n ** 255n]));
  const swapOut = async (tokenIn, tokenOut, amountIn, sqrtPriceLimitX96 = 0n) => {
    const data = ROUTER_I.encodeFunctionData('exactInputSingle', [{ tokenIn, tokenOut, tickSpacing: TS, recipient: outsider.address, deadline: deadline(), amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96 }]);
    try { await rpc.call({ from: outsider.address, to: AERO.swapRouter, data }); } catch (error) { throw new Error(`外部兑换预演失败：${error.shortMessage ?? error.message} ${error.data ?? ''}`); }
    return send(outsider, AERO.swapRouter, data);
  };
  await swapOut(WETH, USDC, parseEther('2'));
  const [usdcHeld] = await view(ERC20_I, USDC, 'balanceOf', [outsider.address]);
  await send(outsider, WETH, ERC20_I.encodeFunctionData('transfer', [safe, parseEther('2')]));
  await send(outsider, USDC, ERC20_I.encodeFunctionData('transfer', [safe, usdcHeld]));

  // 工作台服务端，RPC 指向分叉；时钟可拨快以跳过出区间等待。
  let offset = 0;
  const directory = mkdtempSync(join(tmpdir(), 'aero-rebalance-'));
  const manager = createAeroSafe({ dataDir: directory, encrypt: (v) => v, decrypt: (v) => v, log: { info() {}, warn: (...a) => console.log('warn', ...a.slice(1)), error() {}, debug() {} },
    makeProvider: () => rpc, now: () => Date.now() + offset });
  const settle = async (label) => {
    for (let i = 0; i < 1800; i++) { const s = manager.state(); if (s.job?.status !== 'running' && !s.refreshing) return s; await sleep(100); }
    throw new Error(`${label} 未结束`);
  };
  try {
    await manager.initialize();
    await manager.save({ rpcUrl: `http://127.0.0.1:${PORT}`, safe, roles, permissions: permissionsConfig, autoSellRewards: true, minRewardSell: '0' });
    await manager.setKey(bot.privateKey);
    await settle('读取');

    // 手动开一个 2 格窄区间，只投入一半余额，另一半留在 Safe 验证调仓不会动用。
    const [, tick0] = await view(POOL_I, pool, 'slot0');
    const cell = Math.floor(Number(tick0) / TS) * TS;
    const range = [cell - TS, cell + TS];
    const preview = await manager.preview({ pool, tickLower: range[0], tickUpper: range[1], shareBps: 5000 });
    await manager.execute('open', { pool, tickLower: range[0], tickUpper: range[1], shareBps: 5000, expect: { previewedAt: preview.previewedAt, amount0: String(preview.amount0), amount1: String(preview.amount1), swapIn: preview.swap ? String(preview.swap.amountIn) : null, swapTokenIn: preview.swap?.tokenIn ?? null } });
    let s = await settle('开仓');
    check('手动开仓并质押', s.job.status === 'done', s.job.error ?? `#${s.job.result?.tokenId}`);
    const first = String(s.job.result.tokenId);
    const [leftWeth] = await view(ERC20_I, WETH, 'balanceOf', [safe]);
    const [leftUsdc] = await view(ERC20_I, USDC, 'balanceOf', [safe]);

    // 越过质押罚没期（若有），再启用自动调仓（出区间等待 1 分钟）。
    const [penalty] = [await view(GF_I, AERO.gaugeFactory, 'effectivePenaltyConfig', [gauge])];
    console.log(`罚没期 ${penalty.minStakeBlocks} 块，费率 ${penalty.penaltyRate}`);
    if (penalty.penaltyRate > 0n) await rpc.send('anvil_mine', [toBeHex(penalty.minStakeBlocks + 1n)]);
    s = await manager.setAuto({ enabled: true, triggerMinutes: 1 });
    await manager.tickAuto(); await settle('检查');
    check('区间内不调仓', manager.state().job.action === 'open' && manager.state().auto.watch.length === 1, manager.state().auto.note ?? '');

    // 卖出大量 WETH，把价格压到区间下沿之下 1.5 格（sqrtPriceLimit 限住位置）。
    const target = range[0] - Math.round(TS * 1.5);
    const limit = BigInt(Math.floor(Math.sqrt(1.0001 ** target) * 2 ** 96));
    await swapOut(WETH, USDC, parseEther('20000'), limit);
    const [, tick1] = await view(POOL_I, pool, 'slot0');
    check('价格已推出区间', Number(tick1) < range[0], `tick ${tick0} → ${tick1}`);

    await manager.tickAuto(); await settle('检查');
    offset += 2 * 60_000;
    await manager.tickAuto(); await settle('检查');
    s = manager.state();
    check('现价刚被拉开、偏离 TWAP 时不调仓', s.job.action === 'open' && /TWAP/.test(s.auto.note ?? '') && s.auto.history.length === 0, s.auto.note ?? '');

    // 推进链上时间让 TWAP 追上现价。
    await rpc.send('evm_increaseTime', [900]); await rpc.send('evm_mine', []);
    offset += 15 * 60_000;
    await manager.tickAuto(); await settle('调仓');
    s = manager.state();
    check('自动调仓完成', s.job?.action === 'rebalance' && s.job.status === 'done', s.job?.error ?? JSON.stringify(s.job?.result));
    const result = s.job?.result ?? {};
    const second = String(result.opened ?? '');
    const [, tick2] = await view(POOL_I, pool, 'slot0');
    let burned = false;
    try { await view(NPM_I, AERO.nft, 'ownerOf', [BigInt(first)]); } catch { burned = true; }
    check(`旧头寸 #${first} 已销毁`, burned);
    const [staked] = await view(GAUGE_I, gauge, 'stakedValues', [safe]);
    check(`新头寸 #${second} 已质押`, staked.map(String).includes(second) && !staked.map(String).includes(first));
    check('新区间与原宽度相同且包含现价', result.tickUpper - result.tickLower === range[1] - range[0] && result.tickLower <= Number(tick2) && Number(tick2) < result.tickUpper, `[${result.tickLower}, ${result.tickUpper}) tick ${tick2}`);
    await manager.refresh?.(); await settle('读取');
    const opened = manager.state().chain?.pools?.flatMap((x) => x.positions).find((x) => String(x.tokenId) === second);
    console.log(`新头寸数量 WETH ${opened?.amount0} USDC ${opened?.amount1}`);
    const [afterWeth] = await view(ERC20_I, WETH, 'balanceOf', [safe]);
    const [afterUsdc] = await view(ERC20_I, USDC, 'balanceOf', [safe]);
    check('Safe 原有的另一半余额没被投入', afterWeth >= leftWeth && afterUsdc >= leftUsdc, `WETH ${leftWeth} → ${afterWeth}，USDC ${leftUsdc} → ${afterUsdc}`);
    const saved = JSON.parse(readFileSync(join(directory, 'aero-safe/auto.json'), 'utf8'));
    check('调仓记录已落盘、无待重开', saved.reopen === null && saved.history.length === 1 && saved.history[0].opened === second);
    const txs = readFileSync(join(directory, 'aero-safe/txs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    console.log(`交易：${txs.map((t) => `${t.label}(${t.status})`).join('，')}`);
    check('所有交易都已确认', txs.every((t) => t.status === 'confirmed'));

    await manager.tickAuto(); await settle('检查');
    check('新头寸在区间内，不再调仓', manager.state().job.id === s.job.id);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
}

const { child, rpc } = await startAnvil();
try { await run(rpc); } catch (error) { check('演练异常', false, error.stack); } finally { rpc.destroy(); child.kill(); }
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
if (results.some((ok) => !ok)) process.exitCode = 1;
