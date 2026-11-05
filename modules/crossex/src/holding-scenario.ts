import Decimal from 'decimal.js';
import type { FundingLeg, FundingOpportunity } from './funding-opportunities';
import type { State } from './types';

const D = Decimal.clone({ precision: 100 });
type Dec = InstanceType<typeof D>;

export const HOLDING_HOURS = [1, 4, 8, 24, 72, 168] as const;
export const DEFAULT_HOLDING_HOURS = 24;
const FUNDING_RATE_TTL_MS = 300_000, PRICE_TTL_MS = 10_000, FX_TTL_MS = 180_000, FEE_TTL_MS = 300_000, CLOCK_SKEW_MS = 5_000, LEG_SKEW_MS = 5_000;

// These entry-only reasons are assigned after the server's data checks. Unknown
// reasons still block the scenario. A missing Monitor policy is not exempt: its
// earlier check can mask an offline venue or invalid funding timestamps.
const ENTRY_ONLY_REASONS = new Set([
  '新开仓已暂停，平仓仍可使用',
  'Monitor 新仓筛选策略无效，等待重新核验',
  '该币种已被 Monitor 屏蔽，停止新仓',
  '双边现货、共同网络或双向充提证据缺失、无效或已过期',
  '双边现货与充提证据缺失或已过期',
]);
export type HoldingScenarioFunding = Pick<FundingOpportunity, 'long' | 'short' | 'expiresAt' | 'eligible' | 'reason'>;

export interface HoldingLegInput {
  exchange: string; symbol: string; quoteCurrency: string; settlementCurrency?: string | null;
  /** Entry reference price in the leg's own quote currency: ask for the long leg, bid for the short leg. */
  price: string | null | undefined; priceAt: number | null | undefined; priceLive: boolean;
  funding: FundingLeg | null;
  /** Account taker rate as a ratio, e.g. "0.0005". */
  takerRate: string | null | undefined;
}
export interface HoldingScenarioInput {
  quantity: string; holdingHours: number; now: number;
  long: HoldingLegInput; short: HoldingLegInput;
  /** Deadline of the funding opportunity row that supplied both legs' funding data. */
  fundingExpiresAt: number | null | undefined; monitorStale: boolean;
  fundingStatus: Pick<FundingOpportunity, 'eligible' | 'reason'> | null;
  feesAsOf: number | null | undefined; feesError?: string | null; slippageBps: number | null | undefined;
  fx: State['fx'] | undefined;
}
export interface HoldingScenarioLeg {
  currency: string; notional: string | null;
  rate: number | null; intervalHours: number | null;
  settlements: number | null; nextFundingAt: number | null; lastFundingAt: number | null;
  /** Signed funding cash flow over the holding period; positive is income. */
  funding: string | null;
  /** Entry plus exit taker fee, a positive cost. */
  fee: string | null;
  /** Entry plus exit slippage budget, a positive cost. */
  slippage: string | null;
}
export interface HoldingScenarioTotals {
  currency: string; converted: boolean;
  fundingIncome: string | null; fundingExpense: string | null; fundingNet: string | null;
  fee: string | null; slippage: string | null; net: string | null;
}
export interface HoldingScenario {
  holdingHours: number; exitAt: number | null;
  long: HoldingScenarioLeg; short: HoldingScenarioLeg; totals: HoldingScenarioTotals;
  complete: boolean; reasons: string[]; notices: string[]; assumptions: string[];
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const fresh = (at: unknown, now: number, age: number) => finite(at) && at > 0 && at <= now + CLOCK_SKEW_MS && now - at <= age;
function decimal(value: unknown): Dec | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  try { const parsed = new D(value.trim()); return parsed.isFinite() ? parsed : null; } catch { return null; }
}

/** Funding data for the exact selected contracts, from the row listing both of them in either direction. */
export function fundingLegsFor(rows: FundingOpportunity[], long: { exchange: string; symbol: string }, short: { exchange: string; symbol: string }): HoldingScenarioFunding | null {
  const same = (leg: FundingLeg, target: { exchange: string; symbol: string }) => leg.exchange === target.exchange && leg.symbol === target.symbol;
  for (const row of rows) {
    const status = { expiresAt: row.expiresAt, eligible: row.eligible, reason: row.reason };
    if (same(row.long, long) && same(row.short, short)) return { long: row.long, short: row.short, ...status };
    if (same(row.short, long) && same(row.long, short)) return { long: row.short, short: row.long, ...status };
  }
  return null;
}

function settlementCount(funding: FundingLeg, now: number, exitAt: number) {
  if (!finite(funding.rate) || !fresh(funding.fundingAt, now, FUNDING_RATE_TTL_MS)) return { reason: '资金费率缺失或超过 5 分钟未更新' };
  if (!finite(funding.intervalHours) || funding.intervalHours <= 0 || funding.intervalHours > 168) return { reason: '资金费结算周期缺失或无效' };
  // An old next-settlement timestamp does not prove that the next interval is unchanged.
  if (!finite(funding.nextFundingAt) || funding.nextFundingAt <= now) return { reason: '下次结算时间缺失或已过，等待交易所更新' };
  const intervalMs = funding.intervalHours * 3_600_000;
  if (funding.nextFundingAt - now > intervalMs + CLOCK_SKEW_MS) return { reason: '下次结算时间与当前周期不一致' };
  const settlements = funding.nextFundingAt > exitAt ? 0 : Math.floor((exitAt - funding.nextFundingAt) / intervalMs) + 1;
  return { settlements, nextFundingAt: funding.nextFundingAt, lastFundingAt: settlements ? funding.nextFundingAt + (settlements - 1) * intervalMs : null };
}

/** USDT per one unit of currency; USDT itself is the conversion base. */
function usdtRate(currency: string, fx: State['fx'] | undefined, now: number) {
  if (currency === 'USDT') return { bid: new D(1), ask: new D(1) };
  const row = fx?.find(item => item.currency === currency);
  if (!row || row.state !== 'live' || !finite(row.bid) || !finite(row.ask) || row.bid <= 0 || row.ask < row.bid || !fresh(row.at, now, FX_TTL_MS)) return null;
  return { bid: new D(row.bid), ask: new D(row.ask) };
}

/**
 * Read-only holding-period scenario for an equal base-quantity hedge. Each leg
 * is valued in its own quote currency; the combined result is only produced
 * when every input is present and current. Missing data is never filled with zero.
 */
export function estimateHoldingScenario(input: HoldingScenarioInput): HoldingScenario {
  const { now } = input, reasons: string[] = [], notices: string[] = [];
  const add = (reason: string) => { if (!reasons.includes(reason)) reasons.push(reason); };
  const quantity = decimal(input.quantity);
  if (!quantity || quantity.lte(0)) add('请填写每腿基础币数量');
  const validTime = finite(now) && finite(input.holdingHours) && input.holdingHours > 0 && input.holdingHours <= 168;
  const exitAt = validTime ? now + input.holdingHours * 3_600_000 : null;
  if (!validTime) add('持有时间需大于 0 且不超过 168 小时');
  const fundingRowFresh = !input.monitorStale && finite(input.fundingExpiresAt) && now < input.fundingExpiresAt;
  if (input.monitorStale) add('Monitor 行情待更新，资金费数据暂不可用');
  else if (!input.long.funding || !input.short.funding) add('资金费机会中暂无该组合的当前费率与周期');
  else if (!fundingRowFresh) add('资金费机会数据已过期，等待更新');
  const status = input.fundingStatus;
  const entryOnly = status?.eligible === false && ENTRY_ONLY_REASONS.has(status.reason);
  const fundingRowValid = status?.eligible === true || entryOnly;
  if (entryOnly) notices.push(status.reason);
  else if (!fundingRowValid && input.long.funding && input.short.funding) add(status?.reason || '资金费机会数据有效性待核实');
  // Same freshness rule as the position action dialog, so one page never disagrees on the fee table.
  const feesFresh = !input.feesError && fresh(input.feesAsOf, now, FEE_TTL_MS);
  if (!feesFresh) add(input.feesError ? '账户手续费率读取失败' : input.feesAsOf ? '账户手续费率超过 5 分钟未更新' : '账户手续费率尚未读取');
  const slippageBps = finite(input.slippageBps) && input.slippageBps >= 0 && input.slippageBps <= 100 ? new D(input.slippageBps) : null;
  if (!slippageBps) add('滑点预算无效');

  const leg = (side: 'long' | 'short'): HoldingScenarioLeg => {
    const source = input[side], label = side === 'long' ? '做多腿' : '做空腿';
    const result: HoldingScenarioLeg = { currency: source.quoteCurrency, notional: null, rate: null, intervalHours: null,
      settlements: null, nextFundingAt: null, lastFundingAt: null, funding: null, fee: null, slippage: null };
    if (source.settlementCurrency && source.settlementCurrency !== source.quoteCurrency) add(`${label}：结算币与计价币不同，暂不估算金额`);
    const price = decimal(source.price);
    const notional = quantity && quantity.gt(0) && price && price.gt(0) && source.priceLive && fresh(source.priceAt, now, PRICE_TTL_MS) ? quantity.mul(price) : null;
    if (!notional && quantity && quantity.gt(0)) add(`${label}：盘口价格缺失或超过 10 秒未更新`);
    result.notional = notional?.toFixed() ?? null;
    if (source.funding) {
      result.rate = finite(source.funding.rate) ? source.funding.rate : null;
      result.intervalHours = finite(source.funding.intervalHours) ? source.funding.intervalHours : null;
      result.nextFundingAt = finite(source.funding.nextFundingAt) ? source.funding.nextFundingAt : null;
    }
    if (source.funding && fundingRowFresh && fundingRowValid && exitAt !== null) {
      const count = settlementCount(source.funding, now, exitAt);
      if ('reason' in count) add(`${label}：${count.reason}`);
      else {
        Object.assign(result, count);
        // Positive funding rates are paid by longs and received by shorts.
        if (notional) result.funding = notional.mul(source.funding.rate).mul(count.settlements).mul(side === 'long' ? -1 : 1).toFixed();
      }
    }
    const taker = decimal(source.takerRate);
    if (feesFresh && (!taker || taker.gte(1))) add(`${label}：账户 taker 费率缺失`);
    else if (feesFresh && notional) result.fee = notional.mul(taker!).mul(2).toFixed();
    if (notional && slippageBps) result.slippage = notional.mul(slippageBps).div(10000).mul(2).toFixed();
    return result;
  };
  const long = leg('long'), short = leg('short');
  const { priceAt: longAt } = input.long, { priceAt: shortAt } = input.short;
  if (finite(longAt) && finite(shortAt) && Math.abs(longAt - shortAt) > LEG_SKEW_MS) add('两腿盘口时间相差超过 5 秒');

  const converted = long.currency !== short.currency, currency = converted ? 'USDT' : long.currency;
  const rates = converted ? [long, short].map(item => {
    const rate = usdtRate(item.currency, input.fx, now);
    if (!rate) add(`${item.currency} / USDT 汇率缺失或过期`);
    return rate;
  }) : [{ bid: new D(1), ask: new D(1) }, { bid: new D(1), ask: new D(1) }];
  // Income converts at the bid and costs at the ask, so FX never flatters the result.
  const signed = (value: string | null, index: number) => {
    const rate = rates[index];
    if (value === null || !rate) return null;
    const amount = new D(value);
    return amount.mul(amount.gte(0) ? rate.bid : rate.ask);
  };
  const cost = (value: string | null, index: number) => value === null || !rates[index] ? null : new D(value).mul(rates[index]!.ask);
  const both = (values: (Dec | null)[]) => values.every((value): value is Dec => value !== null) ? values : null;
  const funding = both([signed(long.funding, 0), signed(short.funding, 1)]);
  const fees = both([cost(long.fee, 0), cost(short.fee, 1)]), slippage = both([cost(long.slippage, 0), cost(short.slippage, 1)]);
  const sum = (values: Dec[]) => values.reduce((total, value) => total.add(value), new D(0));
  const fundingNet = funding ? sum(funding) : null, feeTotal = fees ? sum(fees) : null, slippageTotal = slippage ? sum(slippage) : null;
  const complete = !reasons.length && fundingNet !== null && feeTotal !== null && slippageTotal !== null;
  const totals: HoldingScenarioTotals = {
    currency, converted,
    fundingIncome: funding ? sum(funding.filter(value => value.gt(0))).toFixed() : null,
    fundingExpense: funding ? sum(funding.filter(value => value.lt(0))).toFixed() : null,
    fundingNet: fundingNet?.toFixed() ?? null, fee: feeTotal?.toFixed() ?? null, slippage: slippageTotal?.toFixed() ?? null,
    net: complete ? fundingNet!.sub(feeTotal!).sub(slippageTotal!).toFixed() : null,
  };
  return {
    holdingHours: input.holdingHours, exitAt, long, short, totals, complete, reasons, notices,
    assumptions: [
      '假设结果：未来资金费率、结算周期、账户 taker 费率和滑点预算维持当前值；非保证收益。',
      '假设退出时两腿价差与入场相同（价差收敛按 0 计）；两腿按输入的同一基础币数量 × 各自入场参考价（多腿卖一、空腿买一）计算名义额并保持不变，交易所实际按结算时标记价计费。',
      '持有区间为当前时刻之后至退出时刻（含）；两腿按各自下次结算时间与周期分别计数，正费率由多头支付、空头收取。',
      '往返手续费 = 每腿名义额 × 账户 taker 费率 × 2；滑点预算 = 每腿名义额 × 价格偏离上限 × 2。未计借币利息、换汇手续费、清算或平仓价格路径。',
      ...(converted ? ['两腿计价币不同，合计按 USDT 汇率折算：收入按买价、支出与成本按卖价。'] : []),
    ],
  };
}
