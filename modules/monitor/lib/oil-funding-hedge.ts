import { validateExchangeFundingHistory, HISTORY_WINDOW_MS, type ExchangeFundingHistory } from './exchange-funding-history.ts';
import { validateOilHedgePrices, HEDGE_HOUR_MS, type OilHedgePrices, type HedgeExchange, type HedgeSymbol } from './oil-hedge-prices.ts';

export type HedgeDirection = 'bybit-long' | 'bybit-short';
export type HedgePoint = { time: number; funding: number | null; fundingNet: number | null; makerCost: number | null; pricePnl: number | null; netPnl: number | null };
export type HedgeLegResult = {
  id: string; exchange: HedgeExchange; symbol: HedgeSymbol; side: 'long' | 'short';
  entryPrice: number | null; entryNotional: number | null; openingFee: number | null;
  closingFee: number | null; funding: number | null; knownFunding: number; settlements: number; pricePnl: number | null;
};
export type OilFundingHedgeResult = {
  status: 'complete' | 'partial' | 'unavailable'; warnings: string[]; from: number; to: number;
  quantity: number | null; openingNotional: number | null; openingFee: number | null;
  entry: { bybitSpreadPct: number; binanceSpreadPct: number; spreadDifferencePp: number; bzCrossPct: number; clCrossPct: number; hedgeEntryValue: number } | null;
  legs: HedgeLegResult[]; points: HedgePoint[]; final: HedgePoint | null; returnPct: number | null;
};
export type OilFundingHedgeInput = {
  prices: OilHedgePrices; bybit: ExchangeFundingHistory; binance: ExchangeFundingHistory;
  from: number; to: number; notional: number; bybitMakerRate: number; binanceMakerRate: number; direction: HedgeDirection;
};

/** Fixed, equal-barrel four-leg replay. All marks are the opening mark of the
 * event's hour, never a later close or a price carried across a missing hour.
 * Entry occurs after funding at `from`; exit occurs after funding at `to`.
 */
export function calculateOilFundingHedge(input: OilFundingHedgeInput): OilFundingHedgeResult {
  const { from, to, notional, bybitMakerRate, binanceMakerRate, direction } = input;
  if (![from, to].every(time => Number.isSafeInteger(time) && time >= Date.UTC(2020, 0, 1) && time % HEDGE_HOUR_MS === 0) || from >= to || to - from > HISTORY_WINDOW_MS) throw Error('请选择整小时的有效区间，最长 60 天。');
  if (!Number.isFinite(notional) || notional <= 0 || notional > 1e9) throw Error('四腿总名义须大于 0 且不超过 10 亿 USDT。');
  if (![bybitMakerRate, binanceMakerRate].every(rate => Number.isFinite(rate) && rate >= -0.001 && rate <= 0.01)) throw Error('maker 费率须在 -0.1% 至 1% 之间。');
  if (!['bybit-long', 'bybit-short'].includes(direction)) throw Error('请选择有效的对冲方向。');
  const prices = validateOilHedgePrices(input.prices);
  const histories = { bybit: validateExchangeFundingHistory(input.bybit, 'bybit'), binance: validateExchangeFundingHistory(input.binance, 'binance') };
  const warnings = new Set<string>();
  const priceLegs = (['bybit', 'binance'] as const).flatMap(exchange => (['BZUSDT', 'CLUSDT'] as const).map(symbol => prices.legs.find(leg => leg.exchange === exchange && leg.symbol === symbol)!));
  const marks = priceLegs.map(leg => new Map(leg.rows.map(row => [row.time, row.price])));
  const sides = [1, -1, -1, 1].map(side => side * (direction === 'bybit-long' ? 1 : -1));
  const entryPrices = marks.map(map => map.get(from) ?? null);
  const legs: HedgeLegResult[] = priceLegs.map((leg, i) => ({ id: `${leg.exchange}-${leg.symbol}`, exchange: leg.exchange, symbol: leg.symbol, side: sides[i] === 1 ? 'long' : 'short', entryPrice: entryPrices[i], entryNotional: null, openingFee: null, closingFee: null, funding: null, knownFunding: 0, settlements: 0, pricePnl: null }));
  const base: OilFundingHedgeResult = { status: 'unavailable', warnings: [], from, to, quantity: null, openingNotional: null, openingFee: null, entry: null, legs, points: [], final: null, returnPct: null };
  if (entryPrices.some(price => price === null)) return { ...base, warnings: ['开仓时刻缺少四腿完整标记价，请缩短区间或等待历史数据补齐；未用当前价回填。'] };
  const entry = entryPrices as number[];
  const quantity = notional / entry.reduce((sum, price) => sum + price, 0);
  const feeRates = [bybitMakerRate, bybitMakerRate, binanceMakerRate, binanceMakerRate];
  for (let i = 0; i < legs.length; i++) {
    legs[i].entryNotional = quantity * entry[i];
    legs[i].openingFee = legs[i].entryNotional! * feeRates[i];
  }
  const openingFee = legs.reduce((sum, leg) => sum + leg.openingFee!, 0);
  const bybitSpreadPct = (entry[0] / entry[1] - 1) * 100, binanceSpreadPct = (entry[2] / entry[3] - 1) * 100;
  const metadata = { bybitSpreadPct, binanceSpreadPct, spreadDifferencePp: bybitSpreadPct - binanceSpreadPct, bzCrossPct: (entry[2] / entry[0] - 1) * 100, clCrossPct: (entry[3] / entry[1] - 1) * 100, hedgeEntryValue: entry.reduce((sum, price, i) => sum - sides[i] * quantity * price, 0) };
  const fundingEnds = priceLegs.map(leg => histories[leg.exchange][leg.symbol === 'BZUSDT' ? 'left' : 'right'].coverage?.to ?? 0);
  const fundingComplete = priceLegs.map((leg, i) => {
    const history = histories[leg.exchange], side = leg.symbol === 'BZUSDT' ? 'left' : 'right';
    const fundingLeg = history[side], coverage = fundingLeg.coverage;
    if (prices.status === 'snapshot' || leg.error || history.status === 'snapshot' || fundingLeg.error) warnings.add('部分来源保留上次记录；请结合各腿采集时间查看。');
    if (!leg.coverage || leg.coverage.from > from || leg.coverage.to < to) warnings.add(`${leg.exchange} ${leg.symbol} 价格查询未覆盖整个区间。`);
    if (!coverage || coverage.from > from || coverage.to < to) {
      warnings.add(`${leg.exchange} ${leg.symbol} 结算查询未覆盖整个区间，完整累计收益不可用。`);
      if (!coverage || coverage.from > from) return false;
    }
    const hasSettlement = history.rows.some(row => row.time > from && row.time <= to && row[`${side}Rate`] !== null);
    // A successful but empty history is not evidence of zero funding (new or
    // delisted instruments and upstream gaps have no historical schedule here).
    if (!hasSettlement) {
      warnings.add(`${legs[i].exchange} ${legs[i].symbol} 区间内没有结算记录，不能按零收益计算。`);
      return false;
    }
    return true;
  });
  const events = new Map<number, Array<{ leg: number; rate: number }>>();
  for (let i = 0; i < legs.length; i++) {
    const side = legs[i].symbol === 'BZUSDT' ? 'left' : 'right';
    for (const row of histories[legs[i].exchange].rows) {
      const rate = row[`${side}Rate`];
      if (row.time <= from || row.time > to || rate === null) continue;
      const at = events.get(row.time) ?? [];
      at.push({ leg: i, rate }); events.set(row.time, at);
    }
  }
  const times = new Set<number>(events.keys());
  for (let time = from; time <= to; time += HEDGE_HOUR_MS) times.add(time);
  const totals = [0, 0, 0, 0];
  const points: HedgePoint[] = [];
  let missingMark = false;
  for (const time of [...times].sort((a, b) => a - b)) {
    // Retain the valid prefix when one source is merely behind the others.
    for (let i = 0; i < fundingComplete.length; i++) if (time > fundingEnds[i]) fundingComplete[i] = false;
    const hour = Math.floor(time / HEDGE_HOUR_MS) * HEDGE_HOUR_MS;
    const currentMarks = marks.map(map => map.get(hour) ?? null);
    for (const event of events.get(time) ?? []) {
      const mark = currentMarks[event.leg];
      legs[event.leg].settlements++;
      if (mark === null) {
        fundingComplete[event.leg] = false;
        warnings.add(`${legs[event.leg].exchange} ${legs[event.leg].symbol} 结算时缺标记价，此后的完整资金费累计不可用。`);
      } else totals[event.leg] += -sides[event.leg] * quantity * mark * event.rate;
    }
    const valued = currentMarks.every(price => price !== null);
    if (!valued) missingMark = true;
    const current = currentMarks as number[];
    const funding = fundingComplete.every(Boolean) ? totals.reduce((sum, value) => sum + value, 0) : null;
    const pricePnl = valued ? current.reduce((sum, price, i) => sum + sides[i] * quantity * (price - entry[i]), 0) : null;
    const makerCost = valued ? openingFee + current.reduce((sum, price, i) => sum + quantity * price * feeRates[i], 0) : null;
    const point = { time, funding, fundingNet: funding === null ? null : funding - openingFee, makerCost, pricePnl, netPnl: funding !== null && pricePnl !== null && makerCost !== null ? funding + pricePnl - makerCost : null };
    points.push(point);
    if (time === to) for (let i = 0; i < legs.length; i++) {
      legs[i].knownFunding = totals[i]; legs[i].funding = fundingComplete[i] ? totals[i] : null;
      legs[i].closingFee = currentMarks[i] === null ? null : quantity * current[i] * feeRates[i];
      legs[i].pricePnl = currentMarks[i] === null ? null : sides[i] * quantity * (current[i] - entry[i]);
    }
  }
  if (missingMark) warnings.add('部分小时标记价缺失，对应估值曲线断开；未跨缺口沿用价格。');
  const final = points.at(-1)!;
  return { ...base, status: final.netPnl === null || missingMark || warnings.size ? 'partial' : 'complete', warnings: [...warnings], quantity, openingNotional: notional, openingFee, entry: metadata, points, final, returnPct: final.netPnl === null ? null : final.netPnl / notional * 100 };
}
