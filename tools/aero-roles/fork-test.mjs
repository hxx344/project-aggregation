#!/usr/bin/env node
// Base 分叉验收：本机 anvil（只监听 127.0.0.1）分叉 Base 主网，建 1/1 Safe，执行 plan 生成的同一份部署批次，
// 再以 bot 身份跑正向流程与 docs/aero-safe-roles-permissions-2026-11-04.md 第 8 节的反向用例。
// 每个用例同时用本地 checkTransactions 判一次，本地与链上结论必须一致；反向用例要求链上由 Roles 权限拒绝，
// 而不是下游合约自身失败（否则用例不能证明权限生效）。
// 用法：node tools/aero-roles/fork-test.mjs [--fork-url https://mainnet.base.org] [--fork-block <n>]；需要 anvil 在 PATH（或 ANVIL_BIN）。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Contract, Interface, JsonRpcProvider, JsonRpcSigner, MaxUint256, Network, Wallet, ZeroAddress, getAddress, parseEther, parseUnits, solidityPacked, toBeHex, zeroPadValue } from 'ethers';
import { AERO, ROLES, SAFE } from './addresses.mjs';
import { verifyOnChain } from './cli.mjs';
import { buildPermissions } from './permissions.mjs';
import { accruedAllowance, checkTransactions } from './policy.mjs';
import { GUARD_SLOT, MODULE_GUARD_SLOT, MODULES_SENTINEL, ROLES_ABI, SAFE_ABI, buildSetupBatch, encodeMultiSend, encodeRoleExecution, predictRolesAddress, prevalidatedSignature, toTransactionBuilderJson } from './roles-calls.mjs';

const opts = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) => (i % 2 === 0 ? [...acc, [v.replace(/^--/, ''), all[i + 1]]] : acc), []));
const FORK_URL = opts['fork-url'] ?? 'https://mainnet.base.org';
const PORT = 20000 + Math.floor(Math.random() * 20000);
// 示例配置再加一个 AERO/USDC 池：mint 与 NPM.approve 的条件变成多分支 Or，正式配置加池后走的就是这条路径。
// 再加一条只用于兑换的 WETH→USDC：验证不做市的代币只能授权给 Router、不能授权给 NPM。
const example = JSON.parse(readFileSync(new URL('./config.example.json', import.meta.url), 'utf8'));
const WETH = '0x4200000000000000000000000000000000000006';
const config = {
  ...example,
  pools: [...example.pools, { name: 'AERO/USDC ts200', token0: '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee', token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', tickSpacing: 200, gauge: '0x4A3B6A77B545584d870D4A6de446AAc4610c60D5' }],
  swaps: [...example.swaps, { tokenIn: WETH, tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', tickSpacing: 100 }],
  allowances: [...example.allowances, { token: WETH, symbol: 'WETH', perDay: '1000000000000000000' }],
};

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RSGP = '0x44B63aF715D5ef02CC3646a6CE96875e11d69E85';
const AERO_TOKEN = '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee';
const RSGP_POOL = getAddress('0x8e859b6cf564c4ac2b848693c85c496e81dbf6c8');
const AERO_USDC_POOL = '0xD0Acf293547457Fb4fE9eE32CA93e89497626816';
const SAFE_NON_L2 = '0xFf51A5898e281Db6DfC7855790607438dF2ca44b'; // Safe 1.5.0 非 L2 singleton（safe-deployments 规范地址）
const GAUGE = getAddress(config.pools[0].gauge);
const GAUGE2 = getAddress(config.pools[1].gauge);

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
  'function approveForClaim(address operator, bool approved)', 'function claimEmissions(address account, address recipient)', 'function claimEmissions(address account, address recipient, uint256[] tokenIds)',
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
  const execSafe = (to, data, operation = 0) => send(owner, safe, SAFE_ABI.encodeFunctionData('execTransaction', [to, 0, data, operation, 0, 0, 0, ZeroAddress, ZeroAddress, prevalidatedSignature(owner.address)]));

  const planCase = async (name, args, pattern) => {
    try {
      const lines = await verifyOnChain(rpc, { permissions, owner: owner.address, bot: bot.address, ...args });
      record('plan', name, !pattern, pattern ? '未报错' : `${lines.length} 行摘要`);
    } catch (error) {
      record('plan', name, Boolean(pattern?.test(error.message)), error.message.split('\n').slice(1).join(' '));
    }
  };
  await planCase('plan 链上核对通过（真实 Safe、池子、gauge、代币、固定合约字节码）', { safe, roles });
  await planCase('plan 拒绝没有 fallback handler 的 Safe', { safe: bareSafe, roles: predictRolesAddress(bareSafe, saltNonce) }, /fallback handler/);
  await planCase('plan 拒绝 owner 不是指定硬件钱包的 Safe', { safe, roles, owner: outsider.address }, /唯一 owner/);
  await execSafe(safe, SAFE_ABI.encodeFunctionData('enableModule', [outsider.address]));
  await planCase('plan 拒绝已启用其他模块的 Safe', { safe, roles }, /已启用模块/);
  await execSafe(safe, SAFE_ABI.encodeFunctionData('disableModule', [MODULES_SENTINEL, outsider.address]));
  // 以下直接改分叉状态模拟异常 Safe / 被替换的固定合约，每项改完立即复原。
  const word = (a) => zeroPadValue(a, 32);
  const tamper = async (name, pattern, change, restore) => { await change(); try { await planCase(name, { safe, roles }, pattern); } finally { await restore(); } };
  await tamper('plan 拒绝设置了 guard 的 Safe', /设置了 guard/,
    () => rpc.send('anvil_setStorageAt', [safe, GUARD_SLOT, word(outsider.address)]), () => rpc.send('anvil_setStorageAt', [safe, GUARD_SLOT, word(ZeroAddress)]));
  await tamper('plan 拒绝设置了 module guard 的 Safe', /设置了 module guard/,
    () => rpc.send('anvil_setStorageAt', [safe, MODULE_GUARD_SLOT, word(outsider.address)]), () => rpc.send('anvil_setStorageAt', [safe, MODULE_GUARD_SLOT, word(ZeroAddress)]));
  await tamper(`plan 拒绝 singleton 不是 SafeL2 的 Safe（非 L2 版 ${SAFE.version}）`, /不是 v1\.5\.0 SafeL2/,
    () => rpc.send('anvil_setStorageAt', [safe, '0x0', word(SAFE_NON_L2)]), () => rpc.send('anvil_setStorageAt', [safe, '0x0', word(SAFE.singletonL2)]));
  const proxyCode = await rpc.getCode(safe);
  await tamper('plan 拒绝非标准代理（字节码多 1 字节，读数照常）', /标准 SafeProxy/,
    () => rpc.send('anvil_setCode', [safe, proxyCode + '00']), () => rpc.send('anvil_setCode', [safe, proxyCode]));
  const unwrapperCode = await rpc.getCode(ROLES.multiSendUnwrapper);
  await tamper('plan 拒绝固定合约字节码被替换（MultiSendUnwrapper）', /字节码与固定哈希不符/,
    () => rpc.send('anvil_setCode', [ROLES.multiSendUnwrapper, '0x00']), () => rpc.send('anvil_setCode', [ROLES.multiSendUnwrapper, unwrapperCode]));
  await planCase('plan 复原后再次通过', { safe, roles });

  // 与 Safe{Wallet} 执行 Transaction Builder 批次相同：导出 JSON → MultiSendCallOnly delegatecall。
  const batch = toTransactionBuilderJson({ safe, transactions, name: 'fork', description: 'fork' });
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
  const allowanceOf = async (key) => accruedAllowance(await rolesContract.allowances(key), BigInt((await rpc.getBlock('latest')).timestamp));
  const keyOf = (token) => permissions.allowances.find((a) => a.token === token).key;
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
  // expect：期望的拒绝原因（ConditionViolation 的 status 名，或 NoMembership / NotAuthorized），防止换了原因仍误判为通过。
  // localIndex / localReason：额外断言本地在第几笔、因什么拒绝（多分支 Or 下链上只报 OrViolation，分辨不出原因）。
  async function denied(name, expect, txs, { data = roleCall(txs), from = bot.address, localIndex, localReason } = {}) {
    if (txs) {
      const local = await checkTransactions(permissions, txs, ctx);
      if (local.ok) return record('deny', name, false, '本地放行');
      if ((localIndex != null && local.index !== localIndex) || (localReason && !localReason.test(local.reason))) return record('deny', name, false, `本地拒绝位置或原因不符：第 ${local.index} 笔，${local.reason}`);
    }
    try {
      await rpc.call({ from, to: roles, data });
      record('deny', name, false, '链上放行');
    } catch (error) {
      const parsed = error.data ? ROLES_ERRORS.parseError(error.data) : null;
      const reason = parsed?.name === 'ConditionViolation' ? STATUS[Number(parsed.args.status)] : parsed?.name;
      record('deny', name, reason === expect, reason === expect ? reason : `期望 ${expect}，实际 ${reason ?? `${error.shortMessage || error.message} ${error.data ?? ''}`}`);
    }
  }
  const now = async () => BigInt((await rpc.getBlock('latest')).timestamp) + 3600n;
  const tx = (to, iface, fn, args, value) => ({ to, data: iface.encodeFunctionData(fn, args), ...(value ? { value } : {}) });
  // 只模拟不发送：本地与链上都必须放行。
  async function passes(name, txs) {
    const local = await checkTransactions(permissions, txs, ctx);
    if (!local.ok) return record('allow', name, false, `本地拒绝：${local.reason}`);
    try { await rpc.call({ from: bot.address, to: roles, data: roleCall(txs) }); record('allow', name, true, 'eth_call 通过'); } catch (error) { record('allow', name, false, `链上拒绝：${error.shortMessage || error.message}`); }
  }
  const OVER = /exceeds remaining allowance/;
  const raw = (to, value, data, operation) => ROLES_ABI.encodeFunctionData('execTransactionWithRole', [to, value, data, operation, roleKey, true]);
  const CLAIM2 = 'claimEmissions(address,address)', CLAIM3 = 'claimEmissions(address,address,uint256[])';

  await denied('非成员地址调用', 'NotAuthorized', null, { data: roleCall([tx(RSGP, ERC20_I, 'approve', [AERO.nft, 1n])]), from: outsider.address });

  // ---- 授权 ----
  await denied('USDC transfer 给外部地址', 'FunctionNotAllowed', [tx(USDC, ERC20_I, 'transfer', [outsider.address, 1n])]);
  await denied('AERO transfer 给外部地址', 'FunctionNotAllowed', [tx(AERO_TOKEN, ERC20_I, 'transfer', [outsider.address, 1n])]);
  await denied('USDC approve 给外部地址', 'OrViolation', [tx(USDC, ERC20_I, 'approve', [outsider.address, MaxUint256])]);
  await denied('RSGP approve 给 gauge（非 NPM / Router）', 'OrViolation', [tx(RSGP, ERC20_I, 'approve', [GAUGE, MaxUint256])]);
  await denied('只用于兑换的 WETH approve 给 NPM', 'ParameterNotAllowed', [tx(WETH, ERC20_I, 'approve', [AERO.nft, MaxUint256])]);
  await allowed('approve RSGP/USDC/AERO→NPM、AERO/WETH→Router（MultiSend）', [
    tx(RSGP, ERC20_I, 'approve', [AERO.nft, MaxUint256]), tx(USDC, ERC20_I, 'approve', [AERO.nft, MaxUint256]),
    tx(AERO_TOKEN, ERC20_I, 'approve', [AERO.nft, MaxUint256]), tx(AERO_TOKEN, ERC20_I, 'approve', [AERO.swapRouter, MaxUint256]),
    tx(WETH, ERC20_I, 'approve', [AERO.swapRouter, MaxUint256]),
  ]);

  // ---- 建仓（两个白名单池，mint 条件是两个分支的 Or）----
  const rangeOf = async (pool, spacing) => {
    const [, tick] = POOL_I.decodeFunctionResult('slot0', await rpc.call({ to: pool, data: POOL_I.encodeFunctionData('slot0') }));
    const lower = Math.floor(Number(tick) / spacing) * spacing - spacing * 20;
    return { tickLower: lower, tickUpper: lower + spacing * 40 };
  };
  const rsgpRange = await rangeOf(RSGP_POOL, 100);
  const mint = async (o = {}) => tx(AERO.nft, NPM_I, 'mint', [{
    token0: RSGP, token1: USDC, tickSpacing: 100, ...rsgpRange,
    amount0Desired: parseUnits('100000', 18), amount1Desired: parseUnits('500', 6), amount0Min: 0n, amount1Min: 0n,
    recipient: safe, deadline: await now(), sqrtPriceX96: 0n, ...o,
  }]);
  const mintedId = (receipt) => receipt.logs.map((l) => (getAddress(l.address) === AERO.nft ? NPM_I.parseLog(l) : null)).find((e) => e?.name === 'Transfer' && getAddress(e.args.to) === safe).args.tokenId;
  await denied('mint recipient 填外部地址', 'OrViolation', [await mint({ recipient: outsider.address })]);
  await denied('mint sqrtPriceX96 ≠ 0（顺带建池）', 'OrViolation', [await mint({ sqrtPriceX96: 1n << 96n })]);
  await denied('mint 非白名单池（AERO/USDC ts100）', 'OrViolation', [await mint({ token0: AERO_TOKEN, token1: USDC, tickSpacing: 100 })]);
  await denied('mint USDC 超日额度', 'OrViolation', [await mint({ amount1Desired: BigInt(config.allowances[0].perDay) + 1n })], { localIndex: 0, localReason: OVER });
  const mintTx = await mint();
  await denied('mint 附带 value > 0', 'SendNotAllowed', [{ ...mintTx, value: 1n }], { data: raw(mintTx.to, 1n, mintTx.data, 0) });
  const usdcBefore = await allowanceOf(keyOf(USDC));
  const mintReceipt = await allowed('mint RSGP/USDC，recipient = Safe', [mintTx]);
  if (!mintReceipt) throw new Error('mint failed, cannot continue');
  const tokenId = mintedId(mintReceipt);
  const usdcAfter = await allowanceOf(keyOf(USDC));
  record('allow', `mint 扣减 USDC 额度 = amount1Desired（tokenId ${tokenId}）`, usdcBefore - usdcAfter === parseUnits('500', 6), `${usdcBefore} → ${usdcAfter}`);
  // 剩余 500 USDC：单笔 300 都在额度内，同批两笔合计 600 超额，链上与本地都必须按合计拒绝。
  const mint300 = await mint({ amount1Desired: parseUnits('300', 6) });
  await passes('单笔 mint 300 USDC 在剩余额度内（只模拟）', [mint300]);
  await denied('MultiSend 两笔 mint 合计超日额度', 'OrViolation', [mint300, mint300], { localIndex: 1, localReason: OVER });

  const aeroRange = await rangeOf(AERO_USDC_POOL, 200);
  const mint2Receipt = await allowed('mint AERO/USDC（Or 第二分支），recipient = Safe', [await mint({ token0: AERO_TOKEN, token1: USDC, tickSpacing: 200, ...aeroRange, amount0Desired: parseUnits('20', 18), amount1Desired: parseUnits('50', 6) })]);
  const tokenId2 = mint2Receipt ? mintedId(mint2Receipt) : null;

  // 找一个不属于 Safe 的现存 tokenId。
  let foreign = tokenId - 1n;
  while ((await ownerOf(AERO.nft, foreign)) === ZeroAddress) foreign -= 1n;

  // ---- NFT 转出路径 ----
  await denied('NPM transferFrom 给外部地址', 'FunctionNotAllowed', [tx(AERO.nft, NPM_I, 'transferFrom', [safe, outsider.address, tokenId])]);
  await denied('NPM safeTransferFrom 给外部地址', 'FunctionNotAllowed', [tx(AERO.nft, NPM_I, 'safeTransferFrom', [safe, outsider.address, tokenId])]);
  await denied('NPM setApprovalForAll', 'FunctionNotAllowed', [tx(AERO.nft, NPM_I, 'setApprovalForAll', [outsider.address, true])]);
  await denied('NPM approve 给非白名单地址', 'OrViolation', [tx(AERO.nft, NPM_I, 'approve', [outsider.address, tokenId])]);
  await denied('NPM multicall', 'FunctionNotAllowed', [tx(AERO.nft, NPM_I, 'multicall', [[NPM_I.encodeFunctionData('burn', [tokenId])]])]);
  await denied('NPM sweepToken', 'FunctionNotAllowed', [tx(AERO.nft, NPM_I, 'sweepToken', [USDC, 0n, outsider.address])]);
  await denied('collect recipient 填外部地址', 'ParameterNotAllowed', [tx(AERO.nft, NPM_I, 'collect', [{ tokenId, recipient: outsider.address, amount0Max: (1n << 128n) - 1n, amount1Max: (1n << 128n) - 1n }])]);
  await denied(`decreaseLiquidity 非 Safe 的 tokenId ${foreign}`, 'CustomConditionViolation', [tx(AERO.nft, NPM_I, 'decreaseLiquidity', [{ tokenId: foreign, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: await now() }])]);
  await denied(`collect 非 Safe 的 tokenId ${foreign}`, 'CustomConditionViolation', [tx(AERO.nft, NPM_I, 'collect', [{ tokenId: foreign, recipient: safe, amount0Max: 1n, amount1Max: 1n }])]);

  // ---- 质押（两个 gauge，NPM.approve 的 spender 是两个 gauge 的 Or）----
  await allowed('NPM.approve(gauge) + gauge.deposit（MultiSend）', [tx(AERO.nft, NPM_I, 'approve', [GAUGE, tokenId]), tx(GAUGE, GAUGE_I, 'deposit', [tokenId])]);
  if (tokenId2) await allowed('NPM.approve(gauge2) + gauge2.deposit（Or 第二分支）', [tx(AERO.nft, NPM_I, 'approve', [GAUGE2, tokenId2]), tx(GAUGE2, GAUGE_I, 'deposit', [tokenId2])]);
  const staked = GAUGE_I.decodeFunctionResult('stakedContains', await rpc.call({ to: GAUGE, data: GAUGE_I.encodeFunctionData('stakedContains', [safe, tokenId]) }))[0];
  record('allow', 'gauge 记录 Safe 质押了该 tokenId', staked);
  await denied('decreaseLiquidity 已质押（NFT 在 gauge）的 tokenId', 'CustomConditionViolation', [tx(AERO.nft, NPM_I, 'decreaseLiquidity', [{ tokenId, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: await now() }])]);
  await denied('gauge depositFor', 'FunctionNotAllowed', [tx(GAUGE, GAUGE_I, 'depositFor', [tokenId, outsider.address])]);
  await denied('gauge withdrawFrom', 'FunctionNotAllowed', [tx(GAUGE, GAUGE_I, 'withdrawFrom', [tokenId, outsider.address])]);
  await denied('gauge approve', 'FunctionNotAllowed', [tx(GAUGE, GAUGE_I, 'approve', [outsider.address, tokenId])]);
  await denied('gauge setApprovalForAll', 'FunctionNotAllowed', [tx(GAUGE, GAUGE_I, 'setApprovalForAll', [outsider.address, true])]);
  await denied('gauge approveForClaim', 'FunctionNotAllowed', [tx(GAUGE, GAUGE_I, 'approveForClaim', [outsider.address, true])]);
  await denied('claimEmissions recipient 填外部地址', 'ParameterNotAllowed', [tx(GAUGE, GAUGE_I, CLAIM2, [safe, outsider.address])]);
  await denied('claimEmissions account 填外部地址', 'ParameterNotAllowed', [tx(GAUGE, GAUGE_I, CLAIM2, [outsider.address, safe])]);
  await denied('claimEmissions(tokenIds) recipient 填外部地址', 'ParameterNotAllowed', [tx(GAUGE, GAUGE_I, CLAIM3, [safe, outsider.address, [tokenId]])]);
  await denied('gauge claimReferralEmissions', 'FunctionNotAllowed', [tx(GAUGE, GAUGE_I, 'claimReferralEmissions', [safe, outsider.address])]);

  await rpc.send('evm_increaseTime', [3600]);
  await rpc.send('evm_mine', []);
  const aeroBefore = await balanceOf(AERO_TOKEN);
  await allowed('claimEmissions(Safe, Safe)', [tx(GAUGE, GAUGE_I, CLAIM2, [safe, safe])]);
  if (tokenId2) await allowed('claimEmissions(Safe, Safe, [tokenId2])', [tx(GAUGE2, GAUGE_I, CLAIM3, [safe, safe, [tokenId2]])]);
  console.log(`  领取 AERO：${(await balanceOf(AERO_TOKEN)) - aeroBefore}（最小单位；gauge 无排放时为 0）`);
  await allowed('gauge.withdraw（NFT 经 safeTransferFrom 回到 Safe）', [tx(GAUGE, GAUGE_I, 'withdraw', [tokenId])]);
  if (tokenId2) await allowed('gauge2.withdraw', [tx(GAUGE2, GAUGE_I, 'withdraw', [tokenId2])]);
  record('allow', '解押后 NFT 归 Safe 所有', (await ownerOf(AERO.nft, tokenId)) === safe && (!tokenId2 || (await ownerOf(AERO.nft, tokenId2)) === safe));

  // ---- 平仓 ----
  const close = async (id) => {
    const { liquidity } = NPM_I.decodeFunctionResult('positions', await rpc.call({ to: AERO.nft, data: NPM_I.encodeFunctionData('positions', [id]) }));
    return [
      tx(AERO.nft, NPM_I, 'decreaseLiquidity', [{ tokenId: id, liquidity, amount0Min: 0n, amount1Min: 0n, deadline: await now() }]),
      tx(AERO.nft, NPM_I, 'collect', [{ tokenId: id, recipient: safe, amount0Max: (1n << 128n) - 1n, amount1Max: (1n << 128n) - 1n }]),
      tx(AERO.nft, NPM_I, 'burn', [id]),
    ];
  };
  const [rsgp0, usdc0] = [await balanceOf(RSGP), await balanceOf(USDC)];
  await allowed('decreaseLiquidity + collect + burn（MultiSend，两个仓位）', [...(await close(tokenId)), ...(tokenId2 ? await close(tokenId2) : [])]);
  record('allow', '平仓资金回到 Safe', (await balanceOf(RSGP)) > rsgp0 || (await balanceOf(USDC)) > usdc0);

  // ---- 兑换 ----
  const swap = async (o = {}) => tx(AERO.swapRouter, ROUTER_I, 'exactInputSingle', [{ tokenIn: AERO_TOKEN, tokenOut: USDC, tickSpacing: 200, recipient: safe, deadline: await now(), amountIn: parseUnits('10', 18), amountOutMinimum: 0n, sqrtPriceLimitX96: 0n, ...o }]);
  await denied('exactInputSingle recipient 填外部地址', 'OrViolation', [await swap({ recipient: outsider.address })]);
  await denied('swap 非白名单方向（USDC→AERO）', 'OrViolation', [await swap({ tokenIn: USDC, tokenOut: AERO_TOKEN, amountIn: 1_000_000n })]);
  await denied('swap 非白名单 tickSpacing（AERO→USDC ts100）', 'OrViolation', [await swap({ tickSpacing: 100 })]);
  await denied('swap AERO 超日额度', 'OrViolation', [await swap({ amountIn: BigInt(config.allowances[2].perDay) + 1n })], { localIndex: 0, localReason: OVER });
  const usdcSwap0 = await balanceOf(USDC);
  await allowed('exactInputSingle AERO→USDC，recipient = Safe', [await swap()]);
  record('allow', '兑换所得 USDC 到 Safe', (await balanceOf(USDC)) > usdcSwap0);

  // ---- 操作类型与组合 ----
  const approveNpm = tx(USDC, ERC20_I, 'approve', [AERO.nft, 0n]);
  await denied('delegatecall 到 MultiSend 以外的地址', 'DelegateCallNotAllowed', null, { data: raw(approveNpm.to, 0n, approveNpm.data, 1) });
  const innerDelegate = solidityPacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [1, approveNpm.to, 0, (approveNpm.data.length - 2) / 2, approveNpm.data]);
  await denied('MultiSend 内层 delegatecall', 'DelegateCallNotAllowed', null, { data: raw(SAFE.multiSendCallOnly, 0n, new Interface(['function multiSend(bytes)']).encodeFunctionData('multiSend', [innerDelegate]), 1) });
  // v1.5.0 MultiSendCallOnly 把内层 to = 0 改写为 Safe 自身；必须由 Roles 拒绝（只模拟；本角色既未授权 0x0 也未授权 Safe，用例证明拒绝，不区分 Roles 按哪个地址判）。
  const selfCall = solidityPacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, ZeroAddress, 0, (SAFE_ABI.encodeFunctionData('enableModule', [outsider.address]).length - 2) / 2, SAFE_ABI.encodeFunctionData('enableModule', [outsider.address])]);
  await denied('MultiSend 内层 to = 0（1.5.0 改写为调用 Safe 自身）', 'TargetAddressNotAllowed', null, { data: raw(SAFE.multiSendCallOnly, 0n, new Interface(['function multiSend(bytes)']).encodeFunctionData('multiSend', [selfCall]), 1) });
  await denied('MultiSend 夹带一笔禁止调用', 'FunctionNotAllowed', [approveNpm, tx(USDC, ERC20_I, 'transfer', [outsider.address, 1n])]);
  await denied('经角色调用 Safe.addOwnerWithThreshold', 'TargetAddressNotAllowed', [tx(safe, SAFE_SETUP_I, 'addOwnerWithThreshold', [outsider.address, 1n])]);
  await denied('经角色调用 Safe.enableModule', 'TargetAddressNotAllowed', [tx(safe, SAFE_ABI, 'enableModule', [outsider.address])]);
  await denied('经角色调用 Roles.assignRoles', 'TargetAddressNotAllowed', [tx(roles, ROLES_ABI, 'assignRoles', [outsider.address, [roleKey], [true]])]);

  // ---- 撤销 ----
  await execSafe(roles, ROLES_ABI.encodeFunctionData('assignRoles', [bot.address, [roleKey], [false]]));
  await denied('撤销角色后 bot 的原本允许调用', 'NoMembership', null, { data: roleCall([approveNpm]) });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
