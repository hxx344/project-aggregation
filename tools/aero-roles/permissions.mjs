// 由策略配置生成角色权限：哪些合约、哪些函数、参数满足什么条件。Roles 默认拒绝，未列出的调用一律不能执行。
// 清单与理由见 docs/aero-safe-roles-permissions-2026-11-04.md 第 3–5 节；本文件是链上配置与本地签名前校验的唯一来源。
import { ZeroAddress, encodeBytes32String, getAddress, id, keccak256, toUtf8Bytes } from 'ethers';
import { AERO } from './addresses.mjs';
import { c, ExecutionOptions } from './conditions.mjs';

export const SIGNATURES = {
  mint: 'mint((address,address,int24,int24,int24,uint256,uint256,uint256,uint256,address,uint256,uint160))',
  decreaseLiquidity: 'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))',
  collect: 'collect((uint256,address,uint128,uint128))',
  burn: 'burn(uint256)',
  approve: 'approve(address,uint256)',
  deposit: 'deposit(uint256)',
  withdraw: 'withdraw(uint256)',
  emergencyWithdraw: 'emergencyWithdraw(uint256)',
  claimEmissions: 'claimEmissions(address,address)',
  claimEmissionsFor: 'claimEmissions(address,address,uint256[])',
  exactInputSingle: 'exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))',
};

export const selectorOf = (signature) => id(signature).slice(0, 10);
export const allowanceKey = (token) => keccak256(toUtf8Bytes(`aero-roles:turnover:${getAddress(token).toLowerCase()}`));
const DAY = 86400;

// config: { roleKey, pools: [{ name, token0, token1, tickSpacing, gauge }], swaps: [{ tokenIn, tokenOut, tickSpacing }],
//           allowances: [{ token, symbol, perDay }] }，perDay 为代币最小单位的十进制字符串。
// 地址一律 checksum，并拒绝零地址：Safe v1.5.0 的 MultiSendCallOnly 把内层 to = 0 当作调用 Safe 自身，
// 而 Roles 按 0x0 判权限；任何指向 0x0 的授权都会变成"以 Safe 身份调 Safe"（加 owner、启用模块）。
const addr = (value, where) => {
  const a = getAddress(value);
  if (a === ZeroAddress) throw new Error(`${where}: zero address is not allowed`);
  return a;
};

export function normalizeConfig(config) {
  const roleKey = String(config?.roleKey ?? '');
  if (!roleKey || toUtf8Bytes(roleKey).length > 31) throw new Error('roleKey must be 1–31 bytes');
  const pools = (config.pools ?? []).map((pool, i) => {
    const token0 = addr(pool.token0, `pools[${i}].token0`), token1 = addr(pool.token1, `pools[${i}].token1`);
    if (BigInt(token0) >= BigInt(token1)) throw new Error(`pools[${i}]: token0 must sort below token1`);
    return { name: String(pool.name ?? `pool${i}`), token0, token1, tickSpacing: spacing(pool.tickSpacing, `pools[${i}]`), gauge: addr(pool.gauge, `pools[${i}].gauge`) };
  });
  if (pools.length === 0) throw new Error('at least one pool is required');
  const swaps = (config.swaps ?? []).map((swap, i) => {
    const tokenIn = addr(swap.tokenIn, `swaps[${i}].tokenIn`), tokenOut = addr(swap.tokenOut, `swaps[${i}].tokenOut`);
    if (tokenIn === tokenOut) throw new Error(`swaps[${i}]: tokenIn equals tokenOut`);
    return { tokenIn, tokenOut, tickSpacing: spacing(swap.tickSpacing, `swaps[${i}]`) };
  });
  const allowances = new Map();
  for (const [i, entry] of (config.allowances ?? []).entries()) {
    const token = addr(entry.token, `allowances[${i}].token`);
    if (allowances.has(token)) throw new Error(`allowances[${i}]: duplicate token ${token}`);
    // 必须是字符串：JSON 数字超过 2^53 会先丢精度再通过格式检查。
    if (typeof entry.perDay !== 'string' || !/^[1-9]\d*$/.test(entry.perDay)) throw new Error(`allowances[${i}]: perDay must be a positive integer string`);
    const perDay = BigInt(entry.perDay);
    if (perDay >= 1n << 128n) throw new Error(`allowances[${i}]: perDay exceeds uint128`);
    allowances.set(token, { token, symbol: String(entry.symbol ?? token.slice(0, 8)), perDay, key: allowanceKey(token) });
  }
  // 每个会被花出去的代币都必须有额度：没有额度的代币不能出现在 mint 或 swap 的输入端。
  const spent = new Set([...pools.flatMap((p) => [p.token0, p.token1]), ...swaps.map((s) => s.tokenIn)]);
  for (const token of spent) if (!allowances.has(token)) throw new Error(`token ${token} is spent by a pool or swap but has no allowance`);
  unique(pools.map((p) => p.gauge), 'gauge');
  unique(pools.map((p) => `${p.token0}/${p.token1}/${p.tickSpacing}`), 'pool');
  unique(swaps.map((s) => `${s.tokenIn}/${s.tokenOut}/${s.tickSpacing}`), 'swap');
  return { roleKey, roleKeyBytes: encodeBytes32String(roleKey), pools, swaps, allowances: [...allowances.values()] };
}

// 返回 [{ target, label, functions: [{ label, signature, selector, condition | null, options }] }]；
// condition 为 null 表示该函数不需要参数条件（合约自身已限定为 msg.sender，即 Safe）。
export function buildPermissions(config) {
  const normalized = normalizeConfig(config);
  const { pools, swaps, allowances } = normalized;
  const keyOf = (token) => allowances.find((a) => a.token === token).key;
  const fn = (label, signature, condition) => ({ label, signature, selector: selectorOf(signature), condition, options: ExecutionOptions.None });

  const mintBranch = (pool) => c.tuple(
    c.address(pool.token0), c.address(pool.token1), c.equal('int24', pool.tickSpacing),
    c.pass(), c.pass(), // tickLower, tickUpper
    c.allowance(keyOf(pool.token0)), c.allowance(keyOf(pool.token1)), // amount0Desired, amount1Desired
    c.pass(), c.pass(), // amount0Min, amount1Min
    c.avatar(), c.pass(), // recipient, deadline
    c.equal('uint160', 0n), // sqrtPriceX96 非 0 会顺带创建新池
  );
  const nft = {
    target: AERO.nft, label: 'NonfungiblePositionManager',
    functions: [
      fn('mint', SIGNATURES.mint, c.calldata(c.oneOf(pools.map(mintBranch)))),
      fn('decreaseLiquidity', SIGNATURES.decreaseLiquidity, c.calldata(c.tuple(c.ownedByAvatar(), c.pass(), c.pass(), c.pass(), c.pass()))),
      fn('collect', SIGNATURES.collect, c.calldata(c.tuple(c.ownedByAvatar(), c.avatar(), c.pass(), c.pass()))),
      fn('burn', SIGNATURES.burn, c.calldata(c.ownedByAvatar())),
      fn('approve', SIGNATURES.approve, c.calldata(c.oneOf(pools.map((p) => c.address(p.gauge))), c.ownedByAvatar())),
    ],
  };
  const gauges = pools.map((pool) => ({
    target: pool.gauge, label: `CLGauge ${pool.name}`,
    functions: [
      fn('deposit', SIGNATURES.deposit, null),
      fn('withdraw', SIGNATURES.withdraw, null),
      fn('emergencyWithdraw', SIGNATURES.emergencyWithdraw, null),
      fn('claimEmissions', SIGNATURES.claimEmissions, c.calldata(c.avatar(), c.avatar())),
      fn('claimEmissions(tokenIds)', SIGNATURES.claimEmissionsFor, c.calldata(c.avatar(), c.avatar(), c.array(c.pass()))),
    ],
  }));
  const router = swaps.length === 0 ? [] : [{
    target: AERO.swapRouter, label: 'SwapRouter',
    functions: [fn('exactInputSingle', SIGNATURES.exactInputSingle, c.calldata(c.oneOf(swaps.map((s) => c.tuple(
      c.address(s.tokenIn), c.address(s.tokenOut), c.equal('int24', s.tickSpacing),
      c.avatar(), c.pass(), // recipient, deadline
      c.allowance(keyOf(s.tokenIn)), c.pass(), c.pass(), // amountIn, amountOutMinimum, sqrtPriceLimitX96
    )))))],
  }];
  // 代币只能授权给 NPM（做市代币）或 Router（兑换输入币）；授权额度本身不构成转出路径，不加限制。
  const spenders = new Map();
  const addSpender = (token, spender) => spenders.set(token, new Set([...(spenders.get(token) ?? []), spender]));
  for (const p of pools) { addSpender(p.token0, AERO.nft); addSpender(p.token1, AERO.nft); }
  for (const s of swaps) addSpender(s.tokenIn, AERO.swapRouter);
  const tokens = [...spenders].map(([token, set]) => ({
    target: token, label: `ERC20 ${allowances.find((a) => a.token === token).symbol}`,
    functions: [fn('approve', SIGNATURES.approve, c.calldata(c.oneOf([...set].map((s) => c.address(s))), c.pass()))],
  }));
  return { ...normalized, targets: [nft, ...gauges, ...router, ...tokens], allowancePeriod: DAY };
}

function spacing(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 16384) throw new Error(`${label}: invalid tickSpacing`);
  return n;
}

function unique(values, label) {
  const seen = new Set();
  for (const v of values) { if (seen.has(v)) throw new Error(`duplicate ${label} ${v}`); seen.add(v); }
}
