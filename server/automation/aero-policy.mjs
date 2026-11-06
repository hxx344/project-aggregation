// Aero 实盘的仓位策略（policy.json）：每个池子一条，管"还能不能往里加、最多放多少、要不要自动调仓"。
// 链上 Roles 每日额度只防 bot 私钥泄露、限制每天能花多少；仓位多少由这里决定，改动立即生效，不需要 Safe 签名。
//   state：active 运行（可开仓、加仓）；reduce 只减不加（不能开仓、加仓，已有头寸照常调仓、减仓）；stopped 已停止（再加自动调仓也跳过本池）。
//   capUsd：本池全部头寸的美元上限（按「行情」美元价估值），null 为不限；手动开仓、加仓与自动重开都按它核对。
//   auto：本池是否参与自动调仓（总开关在自动调仓设置里）。
import { getAddress } from 'ethers';
import { HttpError } from '../http-common.mjs';

export const POOL_STATES = Object.freeze(['active', 'reduce', 'stopped']);
export const POOL_STATE_LABELS = Object.freeze({ active: '运行', reduce: '只减不加', stopped: '已停止' });
export const POOL_POLICY_DEFAULT = Object.freeze({ state: 'active', capUsd: null, auto: true });
export const POLICY_POOL_LIMIT = 100;
const CAP_MAX_USD = 1e12;

// 页面提交的一条策略：{ pool, state, capUsd, auto }。capUsd 为正数（美元，最多两位小数）或 null。
export function strictPoolPolicy(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!v) throw new HttpError(400, '仓位策略须为对象');
  for (const key of Object.keys(v)) if (!['pool', 'state', 'capUsd', 'auto'].includes(key)) throw new HttpError(400, `未知仓位策略项 ${key}`);
  let pool;
  try { pool = getAddress(String(v.pool ?? '')).toLowerCase(); } catch { throw new HttpError(400, '池子地址无效'); }
  return { pool, ...rule(v, (message) => new HttpError(400, message)) };
}

function rule(v, fail) {
  if (!POOL_STATES.includes(v.state)) throw fail('池子状态须为 运行、只减不加 或 已停止');
  if (typeof v.auto !== 'boolean') throw fail('自动调仓开关须为布尔值');
  const cap = v.capUsd;
  if (cap !== null && (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0 || cap > CAP_MAX_USD || Math.round(cap * 100) !== cap * 100)) {
    throw fail('单池上限须为正的美元金额（最多两位小数），留空即不限');
  }
  return { state: v.state, capUsd: cap, auto: v.auto };
}

// policy.json → { pools: { 小写池子地址: { state, capUsd, auto } } }。任何一条不合规都整体报错：读不准时不能当作"没有限制"。
export function readPolicy(saved) {
  if (!saved || typeof saved !== 'object' || saved.schema !== 1 || !saved.pools || typeof saved.pools !== 'object' || Array.isArray(saved.pools)) throw new Error('格式不符');
  const entries = Object.entries(saved.pools);
  if (entries.length > POLICY_POOL_LIMIT) throw new Error(`池子超过 ${POLICY_POOL_LIMIT} 个`);
  const pools = {};
  for (const [key, value] of entries) {
    if (!/^0x[0-9a-f]{40}$/.test(key)) throw new Error(`池子地址无效：${key.slice(0, 50)}`);
    pools[key] = rule(value && typeof value === 'object' ? value : {}, (message) => new Error(`${key}：${message}`));
  }
  return { pools };
}

// 设回默认值的池子不写入文件。
export function withPoolPolicy(policy, { pool, ...next }) {
  const pools = { ...policy.pools };
  const isDefault = next.state === POOL_POLICY_DEFAULT.state && next.capUsd === POOL_POLICY_DEFAULT.capUsd && next.auto === POOL_POLICY_DEFAULT.auto;
  if (isDefault) delete pools[pool]; else pools[pool] = next;
  if (Object.keys(pools).length > POLICY_POOL_LIMIT) throw new HttpError(400, `仓位策略最多设置 ${POLICY_POOL_LIMIT} 个池子`);
  return { pools };
}

export const policyOf = (policy, pool) => policy?.pools?.[String(pool).toLowerCase()] ?? POOL_POLICY_DEFAULT;

// 手动开仓、加仓前的状态核对；可以加仓时为 null。
export function addBlockedReason(policy, pool) {
  if (policy?.corrupt) return policy.corrupt;
  const { state } = policyOf(policy, pool);
  return state === 'active' ? null : `本池已设为「${POOL_STATE_LABELS[state]}」，不能开仓或加仓；在「仓位」把本池改回「运行」后再开`;
}
