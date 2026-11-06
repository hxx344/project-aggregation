// 签名前本地校验：与链上 Roles 使用同一份权限，逐笔检查目标、函数、ETH 数量与参数条件。
// 它是第二道防线，不替代链上校验：本地通过但链上拒绝时交易回滚，本地拒绝时不签名。
import { Interface, getAddress } from 'ethers';
import { evaluate } from './conditions.mjs';

// transactions: [{ to, value?, data }]；ctx: { avatar, ownerOf(to, tokenId), allowance(key) }（见 conditions.mjs evaluate）。
// 同一批次各笔的额度消耗累计计算，与链上 MultiSend 拆包后的校验一致。返回 { ok: true } 或 { ok: false, index, reason }。
export async function checkTransactions(permissions, transactions, ctx) {
  if (!Array.isArray(transactions) || transactions.length === 0) return { ok: false, index: -1, reason: 'no transactions' };
  const spent = new Map();
  for (const [index, tx] of transactions.entries()) {
    const result = await checkOne(permissions, tx, { ...ctx, spent });
    if (!result.ok) return { ok: false, index, reason: result.reason };
    for (const [key, amount] of result.consumed ?? []) spent.set(key, (spent.get(key) ?? 0n) + amount);
  }
  return { ok: true };
}

// 链上当前可用额度：与 Roles AllowanceTracker._accruedAllowance 相同，每满一个 period 补 refill，最多补到 maxRefill。
// allowance 为 Roles.allowances(key) 的读数，now 为区块时间（秒），均为 bigint。
export function accruedAllowance(allowance, now) {
  return accrue(allowance, now).balance;
}

// 同一规则下的余额与本期起点：满一个 period 后 timestamp 前进整数个 period（余额已达 maxRefill 时也前进）。
export function accrue({ refill, maxRefill, period, balance, timestamp }, now) {
  if (period === 0n || now < timestamp + period) return { balance, timestamp };
  const elapsed = (now - timestamp) / period;
  const start = timestamp + elapsed * period;
  if (balance >= maxRefill) return { balance, timestamp: start };
  const refilled = balance + refill * elapsed;
  return { balance: refilled < maxRefill ? refilled : maxRefill, timestamp: start };
}

async function checkOne(permissions, tx, ctx) {
  let to;
  try { to = getAddress(tx.to); } catch { return { ok: false, reason: 'invalid target address' }; }
  if (BigInt(tx.value ?? 0) !== 0n) return { ok: false, reason: 'sending ETH is not allowed' };
  const data = String(tx.data ?? '0x');
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length < 10) return { ok: false, reason: 'calldata missing function selector' };
  const target = permissions.targets.find((t) => t.target === to);
  if (!target) return { ok: false, reason: `target ${to} is not allowed` };
  const selector = data.slice(0, 10).toLowerCase();
  const fn = target.functions.find((f) => f.selector === selector);
  if (!fn) return { ok: false, reason: `function ${selector} is not allowed on ${target.label}` };
  if (!fn.condition) return { ok: true, consumed: [] };
  let args;
  try { args = new Interface([`function ${fn.signature}`]).decodeFunctionData(fn.signature.slice(0, fn.signature.indexOf('(')), data); } catch (error) {
    return { ok: false, reason: `calldata does not decode as ${fn.signature}: ${error.shortMessage || error.message}` };
  }
  const result = await evaluate(fn.condition, args, ctx, to);
  return result.ok ? result : { ok: false, reason: `${target.label}.${fn.label}: ${result.reason}` };
}
