import { groupTradeEvents } from '../modules/oil/trades.mjs';
import { ANTHROPIC_CANDLE_MS } from '../modules/anthropic/market.mjs';
import { spreadTradeMarkers, type TradeEvent, type SpreadTradeMarker } from './hynix-trades.ts';
import type { HubFillsView } from './hub-fills-contract.ts';
import type { Point } from './market.ts';
import type { AnthropicComparisonLeg } from './anthropic-history.ts';

// Only one native contract is read per venue. It cannot establish a two-leg
// execution premium, and OKX's native price has a different share-count basis.
const singleLeg = { left: 'ANTHROPIC', right: '', spread: () => null, priceUnit: '', short: 'ANT 空头', long: 'ANT 多头' };
const contract = { rh: { exchange: 'rh-lighter', symbol: 'ANTHROPIC', name: 'Lighter RH' },
  xyz: { exchange: 'hyperliquid', symbol: 'xyz:ANT', name: 'xyz:ANT' }, io: { exchange: 'hyperliquid', symbol: 'io:ANTH', name: 'io:ANTH' } } as const;
const belongs = (fill: HubFillsView['items'][number], leg: AnthropicComparisonLeg) =>
  fill.exchangeId === contract[leg].exchange && fill.symbol === contract[leg].symbol;
const unassigned = (fill: HubFillsView['items'][number]) => fill.base === 'ANTHROPIC' && (
    fill.exchangeId === 'binance' && fill.symbol === 'ANTHROPICUSDT'
    || fill.exchangeId === 'okx' && fill.symbol === 'ANTHROPIC-USDT-SWAP'
  );

/** Verified task/batch evidence routes CEX fills; proximity or current holdings never establishes a pair. */
export function anthropicTradeEvents(items: HubFillsView['items'], leg: AnthropicComparisonLeg): TradeEvent[] {
  const groups = new Map<string, HubFillsView['items']>();
  for (const fill of items) {
    const link = fill.execution;
    if (link ? link.comparisonLeg !== leg : !belongs(fill, leg) && !unassigned(fill)) continue;
    const key = link ? JSON.stringify([link.jobId, link.phase, link.batch]) : belongs(fill, leg) ? 'native' : 'unknown';
    const group = groups.get(key) ?? []; group.push(fill); groups.set(key, group);
  }
  return [...groups.values()].flatMap(group => groupTradeEvents(group, singleLeg)).sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
}

/** Plot real fill times against the selected chart's closed bar, never an order price. */
export const anthropicTradeMarkers = (events: TradeEvent[], points: Point[], leg: AnthropicComparisonLeg): SpreadTradeMarker[] =>
  spreadTradeMarkers(events, points, { intervalMs: ANTHROPIC_CANDLE_MS, rightPerUnit: 1,
    tradedBasis: '成交溢价率', chartBasis: `${contract[leg].name} 成交时图表溢价率` }).map(marker =>
    marker.event.fills.every((fill: HubFillsView['items'][number]) => fill.execution?.comparisonLeg === leg)
      ? { ...marker, venueLabel: `${marker.event.fills[0].execution.cex === 'binance' ? 'Binance' : 'OKX'} ↔ ${contract[leg].name}（工作台组合）`, basis: '已关联组合 · 图表溢价率' }
      : marker.event.fills.every((fill: HubFillsView['items'][number]) => belongs(fill, leg))
        ? { ...marker, venueLabel: contract[leg].name }
        : { ...marker, value: null, usd: null, chartSpread: null, venueLabel: 'CEX（组合关联未知）', basis: '仅成交明细，不绘制标记' });
