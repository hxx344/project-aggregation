// Aero 实盘自动调仓的判定（纯函数，不访问链）：已质押头寸连续出区间满 triggerMinutes 后，平仓并把收回的币以现价为中心、按原宽度重开并质押。
// 执行与持久化在 aero-safe.mjs；这里只决定"现在该不该动、动哪一个、为什么不动"。
import { balanceSwap } from '../../tools/aero-roles/executor.mjs';
import { HttpError } from '../http-common.mjs';

export const AUTO_DEFAULTS = Object.freeze({ enabled: false, triggerMinutes: 5, cooldownMinutes: 30, maxPerDay: 6, acceptPenalty: false, twapSeconds: 300, maxTwapDeviationBps: 100 });
export const AUTO_HISTORY_LIMIT = 50;
const DAY_MS = 86_400_000;
// 额度预估留 10% 余量：卖出 AERO 换来的币也会投入，配平兑换按现价估算。
const BUDGET_MARGIN_BPS = 11_000n;

const int = (value, label, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(400, `${label}须为 ${min} 到 ${max} 的整数`);
  return value;
};
export function strictAutoConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '自动调仓配置须为对象');
  for (const key of Object.keys(value)) if (!(key in AUTO_DEFAULTS)) throw new HttpError(400, `未知自动调仓配置项 ${key}`);
  const v = { ...AUTO_DEFAULTS, ...value };
  if (typeof v.enabled !== 'boolean' || typeof v.acceptPenalty !== 'boolean') throw new HttpError(400, '开关须为布尔值');
  return {
    enabled: v.enabled, acceptPenalty: v.acceptPenalty,
    triggerMinutes: int(v.triggerMinutes, '出区间等待（分钟）', 1, 1440),
    cooldownMinutes: int(v.cooldownMinutes, '同池冷却（分钟）', 0, 1440),
    maxPerDay: int(v.maxPerDay, '每日最多调仓次数', 1, 48),
    twapSeconds: int(v.twapSeconds, 'TWAP 窗口（秒）', 60, 1800),
    maxTwapDeviationBps: int(v.maxTwapDeviationBps, '现价偏离 TWAP 上限（基点）', 10, 1000),
  };
}

// cells 格宽、对齐 tickSpacing 的区间：当前 tick 所在格之下包含 below 格，使当前价两侧的 tick 距离最接近（与 src/aero-market-math.ts centeredRange 相同）。
export function centeredRange(tick, tickSpacing, cells) {
  const s = tickSpacing, cell = Math.floor(tick / s);
  const below = Math.min(Math.max(Math.round((cell * s - tick + (cells * s) / 2) / s), 0), cells - 1);
  return [(cell - below) * s, (cell - below + cells) * s];
}
export const inRange = (tick, p) => p.tickLower <= tick && tick < p.tickUpper;
// 现价相对 TWAP 的价格偏离（基点）。
export const deviationBps = (tick, twap) => Math.round((1.0001 ** Math.abs(tick - twap) - 1) * 10_000);

// 平仓收回 amount0/amount1 后在新区间重开要消耗的 Roles 额度（原始单位）：兑换的卖出量与 mint 的 desired 共用卖出币的额度键，
// 买入币按兑换所得计入 mint。只是估算，用于"额度不够就不平仓"，真正的拦截在 Roles 与本地校验。
export function reopenBudget({ sqrtPriceX96, feePips, tickLower, tickUpper, amount0, amount1 }) {
  const plan = balanceSwap({ sqrtPriceX96, tickLower, tickUpper, amount0, amount1, feePips });
  const p = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  let need0 = amount0, need1 = amount1;
  if (plan?.zeroForOne) need1 += BigInt(Math.floor(Number(plan.amountIn) * p));
  else if (plan) need0 += BigInt(Math.floor(Number(plan.amountIn) / p));
  return { need0: (need0 * BUDGET_MARGIN_BPS) / 10_000n, need1: (need1 * BUDGET_MARGIN_BPS) / 10_000n };
}

const raw = (v) => { try { return v == null ? null : BigInt(String(v).split('.')[0]); } catch { return null; } };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// 根据链上快照（aero-safe.mjs serialize 的结构）判定。outSince：tokenId → 首次看到出区间的时间；history：已发起的调仓（新的在后）。
// 返回 { outSince（新表）, watch（每个受管头寸的状态）, due（要执行的调仓或 null）, note（不执行时的总体原因） }。
// 平仓后尚未重开（reopen）时优先重开，不受冷却与次数限制（那一次已经计数）；平仓中断（closing）时什么都不做，等人工核对。
export function evaluateAuto({ config, chain, outSince, history, reopen, closing = null, now }) {
  const next = new Map();
  const watch = [];
  if (closing) return { outSince: next, watch, due: null, note: `上次调仓在平仓 #${closing.tokenId} 时中断，需人工核对` };
  if (reopen) return { outSince: next, watch, due: { kind: 'reopen', pool: reopen.pool }, note: null };
  const recent = history.filter((h) => now - h.at < DAY_MS);
  let due = null;
  for (const pool of chain.pools) {
    const lastHere = [...history].reverse().find((h) => same(h.pool, pool.address));
    for (const p of pool.positions) {
      if (!p.staked || !(raw(p.liquidity) > 0n)) continue;
      const item = { tokenId: p.tokenId, pool: pool.address, outSince: null, dueAt: null, blocked: null };
      watch.push(item);
      if (inRange(pool.tick, p)) continue;
      const since = outSince.get(p.tokenId) ?? now;
      next.set(p.tokenId, since);
      item.outSince = since; item.dueAt = since + config.triggerMinutes * 60_000;
      if (now < item.dueAt) continue;
      const penaltyUntil = raw(p.penaltyUntilBlock);
      if (!config.acceptPenalty && penaltyUntil !== null && BigInt(chain.blockNumber) < penaltyUntil) { item.blocked = `提前解押罚没期内（到区块 ${penaltyUntil}）`; continue; }
      if (lastHere && now - lastHere.at < config.cooldownMinutes * 60_000) { item.blocked = `同池冷却中（${new Date(lastHere.at + config.cooldownMinutes * 60_000).toLocaleTimeString('zh-CN', { hour12: false })} 后）`; continue; }
      if (recent.length >= config.maxPerDay) { item.blocked = `24 小时内已调仓 ${recent.length} 次，达到上限 ${config.maxPerDay}`; continue; }
      const cells = Math.round((p.tickUpper - p.tickLower) / pool.tickSpacing);
      const [tickLower, tickUpper] = centeredRange(pool.tick, pool.tickSpacing, cells);
      const amount0 = BigInt(Math.floor(Number(p.amount0 ?? 0))) + (raw(p.tokensOwed0) ?? 0n), amount1 = BigInt(Math.floor(Number(p.amount1 ?? 0))) + (raw(p.tokensOwed1) ?? 0n);
      const { need0, need1 } = reopenBudget({ sqrtPriceX96: pool.sqrtPriceX96, feePips: pool.feePips, tickLower, tickUpper, amount0, amount1 });
      const short = [[pool.token0, need0], [pool.token1, need1]].map(([token, need]) => {
        const a = chain.allowances.find((x) => same(x.token, token));
        const left = raw(a?.remaining);
        return need > 0n && (left === null || left < need) ? `${a?.symbol ?? token} 需约 ${need}，剩 ${left ?? '无额度'}` : null;
      }).filter(Boolean);
      if (short.length) { item.blocked = `今日额度不足（${short.join('；')}），等额度补充`; continue; }
      if (!due) due = { kind: 'rebalance', pool: pool.address, tokenId: p.tokenId, cells };
    }
  }
  const note = due ? null : watch.length === 0 ? '没有已质押的头寸' : watch.find((w) => w.blocked)?.blocked ?? null;
  return { outSince: next, watch, due, note };
}

// 自动调仓的持久状态（auto.json）：配置、已发起的调仓记录、停用原因，以及进行中调仓的进度：
//   closing：已决定平仓 tokenId、平仓尚未完成（中断后不能自动续做，链上可能已解押或已平仓）；
//   reopen：已平仓、待重开的数量；swap 确认后改为兑换后的数量；inflight 是已签名、结果未落定的兑换或开仓；minted 是已开出、待质押的新头寸。
const ID = /^\d{1,78}$/;
export function readAutoState(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const config = strictAutoConfig(v.config ?? {});
  const history = Array.isArray(v.history) ? v.history.filter((h) => h && Number.isFinite(h.at) && typeof h.pool === 'string').slice(-AUTO_HISTORY_LIMIT) : [];
  if (v.halted != null && (typeof v.halted !== 'object' || typeof v.halted.reason !== 'string')) throw new Error('停用记录无效');
  const halted = v.halted ? { at: Number(v.halted.at) || 0, reason: v.halted.reason } : null;
  const r = v.reopen;
  const reopen = r && typeof r.pool === 'string' && Number.isInteger(r.cells) && r.cells > 0 && ID.test(r.amount0 ?? '') && ID.test(r.amount1 ?? '')
    && (r.minted == null || ID.test(r.minted)) && (r.inflight == null || r.inflight === 'swap' || r.inflight === 'mint')
    ? { pool: r.pool, cells: r.cells, amount0: r.amount0, amount1: r.amount1, closed: typeof r.closed === 'string' ? r.closed : null, at: Number(r.at) || 0, minted: r.minted ?? null, inflight: r.inflight ?? null } : null;
  if (r && !reopen) throw new Error('待重开记录无效');
  const c = v.closing;
  const closing = c && typeof c.pool === 'string' && ID.test(c.tokenId ?? '') && Number.isInteger(c.cells) && c.cells > 0 ? { pool: c.pool, tokenId: c.tokenId, cells: c.cells, at: Number(c.at) || 0 } : null;
  if (c && !closing) throw new Error('平仓中记录无效');
  if (closing && reopen) throw new Error('平仓中与待重开记录不能同时存在');
  return { config, history, halted, reopen, closing };
}
// 需要人工核对、不能自动续做的进度：平仓中断，或兑换/开仓已签名但结果没落定。
export function stuckReason(auto) {
  if (auto.closing) return `上次调仓在平仓 #${auto.closing.tokenId} 时中断，链上可能已解押或已平仓。请在仓位表核对 #${auto.closing.tokenId}（未质押的可手动平仓），收回的币留在 Safe；核对后在「配置」放弃这条记录`;
  if (auto.reopen?.inflight) return `上次重开的${auto.reopen.inflight === 'swap' ? '配平兑换' : '开仓'}交易已签名但结果未确认。请核对 Safe 余额与头寸（已开出的新头寸可手动质押），核对后在「配置」放弃待重开记录`;
  return null;
}
