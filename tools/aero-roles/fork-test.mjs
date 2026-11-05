#!/usr/bin/env node
// Base 分叉验收：本机 anvil（只监听 127.0.0.1）分叉 Base 主网，建 1/1 Safe，执行 plan 生成的同一份部署批次，
// 再以 bot 身份跑正向流程与 docs/aero-safe-roles-permissions-2026-11-04.md 第 8 节的反向用例。
// 每个用例同时用本地 checkTransactions 判一次，本地与链上结论必须一致；反向用例要求链上由 Roles 权限拒绝，
// 而不是下游合约自身失败（否则用例不能证明权限生效）。
// 用法：node tools/aero-roles/fork-test.mjs [--fork-url https://mainnet.base.org] [--fork-block <n>]；需要 anvil 在 PATH（或 ANVIL_BIN）。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Contract, Interface, JsonRpcProvider, JsonRpcSigner, MaxUint256, Network, Wallet, ZeroAddress, getAddress, parseEther, parseUnits, solidityPacked, toBeHex } from 'ethers';
import { AERO, SAFE } from './addresses.mjs';
import { verifyOnChain } from './cli.mjs';
import { buildPermissions } from './permissions.mjs';
import { checkTransactions } from './policy.mjs';
import { ROLES_ABI, SAFE_ABI, buildSetupBatch, encodeMultiSend, encodeRoleExecution, predictRolesAddress, prevalidatedSignature, toTransactionBuilderJson } from './roles-calls.mjs';

const opts = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) => (i % 2 === 0 ? [...acc, [v.replace(/^--/, ''), all[i + 1]]] : acc), []));
const FORK_URL = opts['fork-url'] ?? 'https://mainnet.base.org';
const PORT = 20000 + Math.floor(Math.random() * 20000);
const config = JSON.parse(readFileSync(new URL('./config.example.json', import.meta.url), 'utf8'));

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RSGP = '0x44B63aF715D5ef02CC3646a6CE96875e11d69E85';
const AERO_TOKEN = '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee';
const RSGP_POOL = getAddress('0x8e859b6cf564c4ac2b848693c85c496e81dbf6c8');
const AERO_USDC_POOL = '0xD0Acf293547457Fb4fE9eE32CA93e89497626816';
const GAUGE = getAddress(config.pools[0].gauge);

const NPM_I = new Interface([
  'function mint((address token0,address token1,int24 tickSpacing,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline,uint160 sqrtPriceX96))',
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline))',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max))',
  'function burn(uint256 tokenId)',
  'function approve(address to, uint256 tokenId)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function setApprovalForAll(address operator, bool approved)',
  'function multicall(bytes[] data)',
  'function sweepToken(address token, uint256 amountMinimum, address recipient)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96,address,address,address,int24,int24,int24,uint128 liquidity,uint256,uint256,uint128,uint128)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);
const GAUGE_I = new Interface([
  'function deposit(uint256 tokenId)', 'function withdraw(uint256 tokenId)',
  'function depositFor(uint256 tokenId, address owner)', 'function withdrawFrom(uint256 tokenId, address account)',
  'function approve(address operator, uint256 tokenId)', 'function setApprovalForAll(address operator, bool approved)',
  'function approveForClaim(address operator, bool approved)', 'function claimEmissions(address account, address recipient)',
  'function claimReferralEmissions(address referral, address recipient)', 'function stakedContains(address depositor, uint256 tokenId) view returns (bool)',
]);
const ERC20_I = new Interface(['function transfer(address to, uint256 amount) returns (bool)', 'function approve(address spender, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const ROUTER_I = new Interface(['function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256)']);
const POOL_I = new Interface(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)']);
const SAFE_SETUP_I = new Interface(['function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)', 'function addOwnerWithThreshold(address owner, uint256 threshold)']);
const PROXY_FACTORY_I = new Interface(['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)']);
const ROLES_ERRORS = new Interface(['error ConditionViolation(uint8 status, bytes32 info)', 'error NoMembership()', 'error ModuleTransactionFailed()', 'error FunctionSignatureTooShort()', 'error MalformedMultiEntrypoint()', 'error NotAuthorized(address sender)']);
const ROLES_VIEW = new Interface(['function allowances(bytes32) view returns (uint128 refill, uint128 maxRefill, uint64 period, uint128 balance, uint64 timestamp)']);
const STATUS = ['Ok', 'DelegateCallNotAllowed', 'TargetAddressNotAllowed', 'FunctionNotAllowed', 'SendNotAllowed', 'OrViolation', 'NorViolation', 'ParameterNotAllowed', 'ParameterLessThanAllowed', 'ParameterGreaterThanAllowed', 'ParameterNotAMatch', 'NotEveryArrayElementPasses', 'NoArrayElementPasses', 'ParameterNotSubsetOfAllowed', 'BitmaskOverflow', 'BitmaskNotAllowed', 'CustomConditionViolation', 'AllowanceExceeded', 'CallAllowanceExceeded', 'EtherAllowanceExceeded'];

const results = [];
const record = (kind, name, ok, detail) => { results.push({ kind, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} [${kind}] ${name}${detail ? ` — ${detail}` : ''}`); };

async function startAnvil() {
  const bin = process.env.ANVIL_BIN || 'anvil';
  const args = ['--fork-url', FORK_URL, '--host', '127.0.0.1', '--port', String(PORT), '--silent'];
  if (opts['fork-block']) args.push('--fork-block-number', opts['fork-block']);
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const rpc = new JsonRpcProvider(`http://127.0.0.1:${PORT}`, Network.from(8453), { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 }); // 关闭请求缓存，否则连续发送会拿到旧 nonce
  rpc.pollingInterval = 100;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`anvil exited: ${stderr.slice(-500)}`);
    try { await rpc.send('eth_blockNumber', []); return { child, rpc }; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  child.kill();
  throw new Error('anvil did not start within 60s');
}

async function main() {
  const { child, rpc } = await startAnvil();
  try { await run(rpc); } finally { rpc.destroy(); child.kill(); }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

async function run(rpc) {
  const block = await rpc.getBlock('latest');
  console.log(`fork Base block ${block.number}, anvil 127.0.0.1:${PORT}`);
  const [owner, bot, outsider] = [Wallet.createRandom(rpc), Wallet.createRandom(rpc), Wallet.createRandom(rpc)];
  for (const w of [owner, bot, outsider]) await rpc.send('anvil_setBalance', [w.address, toBeHex(parseEther('10'))]);
  const send = async (signer, to, data, value = 0n) => (await signer.sendTransaction({ to, data, value })).wait();

  // 1/1 Safe（owner 代表硬件钱包），带 CompatibilityFallbackHandler；另建一个不带 handler 的 Safe 验证 plan 会拒绝。
  const createSafe = async (handler, salt) => {
    const init = SAFE_SETUP_I.encodeFunctionData('setup', [[owner.address], 1, ZeroAddress, '0x', handler, ZeroAddress, 0, ZeroAddress]);
    const data = PROXY_FACTORY_I.encodeFunctionData('createProxyWithNonce', [SAFE.singletonL2, init, salt]);
    const [addr] = PROXY_FACTORY_I.decodeFunctionResult('createProxyWithNonce', await rpc.call({ from: owner.address, to: SAFE.proxyFactory, data }));
    await send(owner, SAFE.proxyFactory, data);
    return getAddress(addr);
  };
  const safe = await createSafe(SAFE.fallbackHandler, BigInt(Date.now()));
  const bareSafe = await createSafe(ZeroAddress, BigInt(Date.now()) + 1n);
  const permissions = buildPermissions(config);
  const roleKey = permissions.roleKeyBytes;
  const saltNonce = 1n;
  const { roles, transactions } = buildSetupBatch({ permissions, safe, bot: bot.address, saltNonce });

  try {
    const lines = await verifyOnChain(rpc, { permissions, safe, bot: bot.address, roles });
    record('plan', 'plan 链上核对通过（真实 Safe、池子、gauge、代币）', true, `${lines.length} 行摘要`);
  } catch (error) { record('plan', 'plan 链上核对通过', false, error.message); }
  try {
    await verifyOnChain(rpc, { permissions, safe: bareSafe, bot: bot.address, roles: predictRolesAddress(bareSafe, saltNonce) });
    record('plan', 'plan 拒绝没有 fallback handler 的 Safe', false, '未报错');
  } catch (error) { record('plan', 'plan 拒绝没有 fallback handler 的 Safe', /fallback handler/.test(error.message), error.message.split('\n')[1]); }

  // 与 Safe{Wallet} 执行 Transaction Builder 批次相同：导出 JSON → MultiSendCallOnly delegatecall。
  const batch = toTransactionBuilderJson({ safe, transactions, name: 'fork', description: 'fork' });
  const execSafe = (to, data, operation = 0) => send(owner, safe, SAFE_ABI.encodeFunctionData('execTransaction', [to, 0, data, operation, 0, 0, 0, ZeroAddress, ZeroAddress, prevalidatedSignature(owner.address)]));
  const setupReceipt = await execSafe(SAFE.multiSendCallOnly, encodeMultiSend(batch.transactions), 1);
  const rolesContract = new Contract(roles, [...ROLES_ABI.fragments, ...ROLES_VIEW.fragments], rpc);
  const safeContract = new Contract(safe, SAFE_ABI, rpc);
  const [code, rOwner, rAvatar, rTarget, enabled] = await Promise.all([rpc.getCode(roles), rolesContract.owner(), rolesContract.avatar(), rolesContract.getFunction('target')(), safeContract.isModuleEnabled(roles)]);
  record('setup', `部署批次 ${transactions.length} 笔一次执行（gas ${setupReceipt.gasUsed}）`, setupReceipt.status === 1);
  record('setup', 'Roles 实际地址 = plan 预测地址', code !== '0x', roles);
  record('setup', 'Roles owner/avatar/target = Safe，模块已启用', [rOwner, rAvatar, rTarget].every((a) => getAddress(a) === safe) && enabled);

  // 资金：从池子地址冒领少量代币给 Safe（仅分叉环境）。
  const fund = async (token, from, amount) => {
    await rpc.send('anvil_impersonateAccount', [from]);
    await rpc.send('anvil_setBalance', [from, toBeHex(parseEther('1'))]);
    await send(new JsonRpcSigner(rpc, from), token, ERC20_I.encodeFunctionData('transfer', [safe, amount]));
    await rpc.send('anvil_stopImpersonatingAccount', [from]);
  };
  await fund(RSGP, RSGP_POOL, parseUnits('200000', 18));
  await fund(USDC, RSGP_POOL, parseUnits('2000', 6));
  await fund(AERO_TOKEN, AERO_USDC_POOL, parseUnits('100', 18));
  const balanceOf = async (token, who = safe) => ERC20_I.decodeFunctionResult('balanceOf', await rpc.call({ to: token, data: ERC20_I.encodeFunctionData('balanceOf', [who]) }))[0];
  const ownerOf = async (to, tokenId) => { try { return getAddress(NPM_I.decodeFunctionResult('ownerOf', await rpc.call({ to, data: NPM_I.encodeFunctionData('ownerOf', [tokenId]) }))[0]); } catch { return ZeroAddress; } };
  const allowanceOf = async (key) => (await rolesContract.allowances(key)).balance;
  const ctx = { avatar: safe, ownerOf, allowance: allowanceOf };

  // 本地与链上各判一次。txs 为 null 的用例只能在链上表达（操作类型），本地不参与。
  const roleCall = (txs) => encodeRoleExecution(roleKey, txs);
  async function allowed(name, txs) {
    const local = await checkTransactions(permissions, txs, ctx);
    if (!local.ok) return record('allow', name, false, `本地拒绝：${local.reason}`), null;
    try {
      const data = roleCall(txs);
      const estimate = await rpc.estimateGas({ from: bot.address, to: roles, data });
      const receipt = await (await bot.sendTransaction({ to: roles, data, gasLimit: estimate * 13n / 10n })).wait();
      record('allow', name, receipt.status === 1, `gas ${receipt.gasUsed}，估算 ${estimate}`);
      return receipt;
    } catch (error) {
      // 逐笔以 Safe 身份模拟，区分是 Roles 拒绝还是下游合约自身失败。
      const causes = [];
      for (const t of txs) {
        try { await rpc.call({ from: safe, to: t.to, data: t.data }); } catch (inner) { causes.push(`${t.to.slice(0, 10)}: ${inner.shortMessage || inner.message} ${inner.data ?? ''}`.trim()); }
      }
      record('allow', name, false, `链上失败：${error.shortMessage || error.message}${causes.length ? `；Safe 直接调用：${causes.join('；')}` : '；Safe 直接调用均成功'}`);
      return null;
    }
  }
  async function denied(name, txs, data = roleCall(txs), from = bot.address) {
    if (txs) {
      const local = await checkTransactions(permissions, txs, ctx);
      if (local.ok) return record('deny', name, false, '本地放行');
    }
    try {
      await rpc.call({ from, to: roles, data });
      record('deny', name, false, '链上放行');
    } catch (error) {
      const parsed = error.data ? ROLES_ERRORS.parseError(error.data) : null;
      if (!parsed && error.data) error.shortMessage = `${error.shortMessage} ${error.data}`;
      const isPermission = parsed && (['NoMembership', 'NotAuthorized', 'ConditionViolation'].includes(parsed.name));
      const label = parsed?.name === 'ConditionViolation' ? `ConditionViolation(${STATUS[Number(parsed.args.status)]})` : parsed?.name ?? (error.shortMessage || error.message);
      record('deny', name, Boolean(isPermission), isPermission ? label : `不是权限拒绝：${label}`);
    }
  }
  const now = async () => BigInt((await rpc.getBlock('latest')).timestamp) + 3600n;
  const tx = (to, iface, fn, args, value) => ({ to, data: iface.encodeFunctionData(fn, args), ...(value ? { value } : {}) });
  const raw = (to, value, data, operation) => ROLES_ABI.encodeFunctionData('execTransactionWithRole', [to, value, data, operation, roleKey, true]);

  await denied('非成员地址调用', null, roleCall([tx(RSGP, ERC20_I, 'approve', [AERO.nft, 1n])]), outsider.address);

  // ---- 授权 ----
  await denied('USDC transfer 给外部地址', [tx(USDC, ERC20_I, 'transfer', [outsider.address, 1n])]);
  await denied('AERO transfer 给外部地址', [tx(AERO_TOKEN, ERC20_I, 'transfer', [outsider.address, 1n])]);
  await denied('USDC approve 给外部地址', [tx(USDC, ERC20_I, 'approve', [outsider.address, MaxUint256])]);
  await denied('AERO approve 给 NPM（AERO 不是做市币）', [tx(AERO_TOKEN, ERC20_I, 'approve', [AERO.nft, MaxUint256])]);
  await allowed('approve RSGP/USDC→NPM、AERO→Router（MultiSend）', [
    tx(RSGP, ERC20_I, 'approve', [AERO.nft, MaxUint256]), tx(USDC, ERC20_I, 'approve', [AERO.nft, MaxUint256]), tx(AERO_TOKEN, ERC20_I, 'approve', [AERO.swapRouter, MaxUint256]),
  ]);

  // ---- 建仓 ----
  const [, tick] = POOL_I.decodeFunctionResult('slot0', await rpc.call({ to: RSGP_POOL, data: POOL_I.encodeFunctionData('slot0') }));
  const lower = Math.floor(Number(tick) / 100) * 100 - 2000;
  const mintParams = async (overrides = {}) => ({
    token0: RSGP, token1: USDC, tickSpacing: 100, tickLower: lower, tickUpper: lower + 4000,
    amount0Desired: parseUnits('100000', 18), amount1Desired: parseUnits('500', 6), amount0Min: 0n, amount1Min: 0n,
    recipient: safe, deadline: await now(), sqrtPriceX96: 0n, ...overrides,
  });
  const mint = async (o) => tx(AERO.nft, NPM_I, 'mint', [await mintParams(o)]);
  await denied('mint recipient 填外部地址', [await mint({ recipient: outsider.address })]);
  await denied('mint sqrtPriceX96 ≠ 0（顺带建池）', [await mint({ sqrtPriceX96: 1n << 96n })]);
  await denied('mint 非白名单池（AERO/USDC ts200）', [await mint({ token0: AERO_TOKEN, token1: USDC, tickSpacing: 200 })]);
  await denied('mint USDC 超日额度', [await mint({ amount1Desired: BigInt(config.allowances[0].perDay) + 1n })]);
  const mintTx = await mint();
  await denied('mint 附带 value > 0', [{ ...mintTx, value: 1n }], raw(mintTx.to, 1n, mintTx.data, 0));
  const usdcBefore = await allowanceOf(permissions.allowances.find((a) => a.token === USDC).key);
  const mintReceipt = await allowed('mint 白名单池，recipient = Safe', [mintTx]);
  if (!mintReceipt) throw new Error('mint failed, cannot continue');
  const tokenId = mintReceipt.logs.map((l) => (getAddress(l.address) === AERO.nft ? NPM_I.parseLog(l) : null)).find((e) => e?.name === 'Transfer' && getAddress(e.args.to) === safe).args.tokenId;
  const usdcAfter = await allowanceOf(permissions.allowances.find((a) => a.token === USDC).key);
  record('allow', `mint 扣减 USDC 额度 = amount1Desired（tokenId ${tokenId}）`, usdcBefore - usdcAfter === parseUnits('500', 6), `${usdcBefore} → ${usdcAfter}`);

  // 找一个不属于 Safe 的现存 tokenId。
  let foreign = tokenId - 1n;
  while ((await ownerOf(AERO.nft, foreign)) === ZeroAddress) foreign -= 1n;

  // ---- NFT 转出路径 ----
  await denied('NPM transferFrom 给外部地址', [tx(AERO.nft, NPM_I, 'transferFrom', [safe, outsider.address, tokenId])]);
  await denied('NPM safeTransferFrom 给外部地址', [tx(AERO.nft, NPM_I, 'safeTransferFrom', [safe, outsider.address, tokenId])]);
  await denied('NPM setApprovalForAll', [tx(AERO.nft, NPM_I, 'setApprovalForAll', [outsider.address, true])]);
  await denied('NPM approve 给非白名单地址', [tx(AERO.nft, NPM_I, 'approve', [outsider.address, tokenId])]);
  await denied('NPM multicall', [tx(AERO.nft, NPM_I, 'multicall', [[NPM_I.encodeFunctionData('burn', [tokenId])]])]);
  await denied('NPM sweepToken', [tx(AERO.nft, NPM_I, 'sweepToken', [USDC, 0n, outsider.address])]);
  await denied('collect recipient 填外部地址', [tx(AERO.nft, NPM_I, 'collect', [{ tokenId, recipient: outsider.address, amount0Max: (1n << 128n) - 1n, amount1Max: (1n << 128n) - 1n }])]);
  await denied(`decreaseLiquidity 非 Safe 的 tokenId ${foreign}`, [tx(AERO.nft, NPM_I, 'decreaseLiquidity', [{ tokenId: foreign, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: await now() }])]);
  await denied(`collect 非 Safe 的 tokenId ${foreign}`, [tx(AERO.nft, NPM_I, 'collect', [{ tokenId: foreign, recipient: safe, amount0Max: 1n, amount1Max: 1n }])]);

  // ---- 质押 ----
  await allowed('NPM.approve(gauge) + gauge.deposit（MultiSend）', [tx(AERO.nft, NPM_I, 'approve', [GAUGE, tokenId]), tx(GAUGE, GAUGE_I, 'deposit', [tokenId])]);
  const staked = GAUGE_I.decodeFunctionResult('stakedContains', await rpc.call({ to: GAUGE, data: GAUGE_I.encodeFunctionData('stakedContains', [safe, tokenId]) }))[0];
  record('allow', 'gauge 记录 Safe 质押了该 tokenId', staked);
  await denied('decreaseLiquidity 已质押（NFT 在 gauge）的 tokenId', [tx(AERO.nft, NPM_I, 'decreaseLiquidity', [{ tokenId, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: await now() }])]);
  await denied('gauge depositFor', [tx(GAUGE, GAUGE_I, 'depositFor', [tokenId, outsider.address])]);
  await denied('gauge withdrawFrom', [tx(GAUGE, GAUGE_I, 'withdrawFrom', [tokenId, outsider.address])]);
  await denied('gauge approve', [tx(GAUGE, GAUGE_I, 'approve', [outsider.address, tokenId])]);
  await denied('gauge setApprovalForAll', [tx(GAUGE, GAUGE_I, 'setApprovalForAll', [outsider.address, true])]);
  await denied('gauge approveForClaim', [tx(GAUGE, GAUGE_I, 'approveForClaim', [outsider.address, true])]);
  await denied('claimEmissions recipient 填外部地址', [tx(GAUGE, GAUGE_I, 'claimEmissions', [safe, outsider.address])]);
  await denied('claimEmissions account 填外部地址', [tx(GAUGE, GAUGE_I, 'claimEmissions', [outsider.address, safe])]);
  await denied('gauge claimReferralEmissions', [tx(GAUGE, GAUGE_I, 'claimReferralEmissions', [safe, outsider.address])]);

  await rpc.send('evm_increaseTime', [3600]);
  await rpc.send('evm_mine', []);
  const aeroBefore = await balanceOf(AERO_TOKEN);
  await allowed('claimEmissions(Safe, Safe)', [tx(GAUGE, GAUGE_I, 'claimEmissions', [safe, safe])]);
  console.log(`  领取 AERO：${(await balanceOf(AERO_TOKEN)) - aeroBefore}（最小单位；gauge 无排放时为 0）`);
  await allowed('gauge.withdraw（NFT 经 safeTransferFrom 回到 Safe）', [tx(GAUGE, GAUGE_I, 'withdraw', [tokenId])]);
  record('allow', '解押后 NFT 归 Safe 所有', (await ownerOf(AERO.nft, tokenId)) === safe);

  // ---- 平仓 ----
  const { liquidity } = NPM_I.decodeFunctionResult('positions', await rpc.call({ to: AERO.nft, data: NPM_I.encodeFunctionData('positions', [tokenId]) }));
  const [rsgp0, usdc0] = [await balanceOf(RSGP), await balanceOf(USDC)];
  await allowed('decreaseLiquidity + collect + burn（MultiSend）', [
    tx(AERO.nft, NPM_I, 'decreaseLiquidity', [{ tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline: await now() }]),
    tx(AERO.nft, NPM_I, 'collect', [{ tokenId, recipient: safe, amount0Max: (1n << 128n) - 1n, amount1Max: (1n << 128n) - 1n }]),
    tx(AERO.nft, NPM_I, 'burn', [tokenId]),
  ]);
  record('allow', '平仓资金回到 Safe', (await balanceOf(RSGP)) > rsgp0 || (await balanceOf(USDC)) > usdc0);

  // ---- 兑换 ----
  const swap = async (o = {}) => tx(AERO.swapRouter, ROUTER_I, 'exactInputSingle', [{ tokenIn: AERO_TOKEN, tokenOut: USDC, tickSpacing: 200, recipient: safe, deadline: await now(), amountIn: parseUnits('10', 18), amountOutMinimum: 0n, sqrtPriceLimitX96: 0n, ...o }]);
  await denied('exactInputSingle recipient 填外部地址', [await swap({ recipient: outsider.address })]);
  await denied('swap 非白名单方向（USDC→AERO）', [await swap({ tokenIn: USDC, tokenOut: AERO_TOKEN, amountIn: 1_000_000n })]);
  await denied('swap 非白名单 tickSpacing（AERO→USDC ts100）', [await swap({ tickSpacing: 100 })]);
  await denied('swap AERO 超日额度', [await swap({ amountIn: BigInt(config.allowances[2].perDay) + 1n })]);
  const usdcSwap0 = await balanceOf(USDC);
  await allowed('exactInputSingle AERO→USDC，recipient = Safe', [await swap()]);
  record('allow', '兑换所得 USDC 到 Safe', (await balanceOf(USDC)) > usdcSwap0);

  // ---- 操作类型与组合 ----
  const approveNpm = tx(USDC, ERC20_I, 'approve', [AERO.nft, 0n]);
  await denied('delegatecall 到 MultiSend 以外的地址', null, raw(approveNpm.to, 0n, approveNpm.data, 1));
  const innerDelegate = solidityPacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [1, approveNpm.to, 0, (approveNpm.data.length - 2) / 2, approveNpm.data]);
  await denied('MultiSend 内层 delegatecall', null, raw(SAFE.multiSendCallOnly, 0n, new Interface(['function multiSend(bytes)']).encodeFunctionData('multiSend', [innerDelegate]), 1));
  await denied('MultiSend 夹带一笔禁止调用', [approveNpm, tx(USDC, ERC20_I, 'transfer', [outsider.address, 1n])]);
  await denied('经角色调用 Safe.addOwnerWithThreshold', [tx(safe, SAFE_SETUP_I, 'addOwnerWithThreshold', [outsider.address, 1n])]);
  await denied('经角色调用 Safe.enableModule', [tx(safe, SAFE_ABI, 'enableModule', [outsider.address])]);
  await denied('经角色调用 Roles.assignRoles', [tx(roles, ROLES_ABI, 'assignRoles', [outsider.address, [roleKey], [true]])]);

  // ---- 撤销 ----
  await execSafe(roles, ROLES_ABI.encodeFunctionData('assignRoles', [bot.address, [roleKey], [false]]));
  await denied('撤销角色后 bot 的原本允许调用', null, roleCall([approveNpm]));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
