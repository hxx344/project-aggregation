import { groupTradeEvents } from '../modules/oil/trades.mjs';
import { ANTHROPIC_CANDLE_MS } from '../modules/anthropic/market.mjs';
import { spreadTradeMarkers, type TradeEvent, type SpreadTradeMarker } from './hynix-trades.ts';
import type { HubFillsView } from './hub-fills-contract.ts';
import type { Point } from './market.ts';

// Only one native contract is read per venue. It cannot establish a two-leg
// execution premium, and OKX's native price has a different share-count basis.
const singleLeg = { left: 'ANTHROPIC', right: '', spread: () => null, priceUnit: '', short: 'ANT 空头', long: 'ANT 多头' };
export const anthropicTradeEvents = (items: HubFillsView['items']): TradeEvent[] =>
  groupTradeEvents(items.filter(fill => fill.base === 'ANTHROPIC' && (
    fill.exchangeId === 'binance' && fill.symbol === 'ANTHROPICUSDT'
    || fill.exchangeId === 'okx' && fill.symbol === 'ANTHROPIC-USDT-SWAP'
  )), singleLeg);

/** Plot real fill times against the selected chart's closed bar, never an order price. */
export const anthropicTradeMarkers = (events: TradeEvent[], points: Point[]): SpreadTradeMarker[] =>
  spreadTradeMarkers(events, points, { intervalMs: ANTHROPIC_CANDLE_MS, rightPerUnit: 1,
    tradedBasis: '成交溢价率', chartBasis: '图表溢价率（非成交价差）' });
