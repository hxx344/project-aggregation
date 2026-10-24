import { oilSpreadPercent } from './spread.mjs';
import { decimal, decimalText, add, negate, absolute, compare, multiply, divide } from './trade-decimal.mjs';

export const TRADE_GAP_MS = 10 * 60_000;
/** left/right are the paired bases; spread is the market's chart metric in percent from fill prices. */
export const TRADE_PAIRS = {
  oil: { left: 'BZ', right: 'CL', spread: oilSpreadPercent, priceUnit: '/桶',
    short: '做空价差（空布伦特 / 多 WTI）', long: '做多价差（多布伦特 / 空 WTI）' },
  // One ordinary share equals ten ADRs, matching the chart's ADR premium.
  hynix: { left: 'SKHY', right: 'SKHYNIX', priceUnit: '',
    spread: (adr, ordinary) => adr > 0 && ordinary > 0 && Number.isFinite(adr / ordinary) ? (adr / (ordinary / 10) - 1) * 100 : null,
    short: '做空溢价（空 ADR / 多正股）', long: '做多溢价（多 ADR / 空正股）' },
};
export const TRADE_TYPES = { entry: { label: '入场', symbol: '▲' }, exit: { label: '出场', symbol: '▼' }, rebalance: { label: '调仓', symbol: '◆' }, trade: { label: '成交', symbol: '●' } };
const zero = () => decimal('0');
export const tradeVenueKey = item => JSON.stringify([item.sourceId, item.exchangeId, item.accountId]);
/** Split cross-zero fills without allocating the fill's fees or realized PnL twice. */
export function classifyFill(fill) {
  const unknown = () => [{ effect: 'unknown', quantity: fill.quantity }];
  if (fill.positionBefore === null || fill.positionAfter === null) return unknown();
  const before = decimal(fill.positionBefore), after = decimal(fill.positionAfter), quantity = decimal(fill.quantity);
  const delta = fill.side === 'buy' ? quantity : negate(quantity);
  if (compare(add(before, delta), after) !== 0) return unknown();
  if (fill.positionSide === 'long' && (before.n < 0n || after.n < 0n) || fill.positionSide === 'short' && (before.n > 0n || after.n > 0n)) return unknown();
  if (before.n * after.n < 0n) return [
    { effect: 'close', quantity: decimalText(absolute(before)) },
    { effect: 'open', quantity: decimalText(absolute(after)) },
  ];
  if (before.n === 0n || compare(absolute(after), absolute(before)) > 0) return [{ effect: 'open', quantity: fill.quantity }];
  if (after.n === 0n || compare(absolute(after), absolute(before)) < 0) return [{ effect: 'close', quantity: fill.quantity }];
  return unknown();
}
function cashTotals(fills, field, currencyField) {
  const currencies = new Map();
  for (const fill of fills) {
    const currency = fill[currencyField] ?? '未知币种';
    const item = currencies.get(currency) ?? { known: zero(), knownCount: 0, unknown: false };
    if (fill[field] === null || fill[currencyField] === null) item.unknown = true;
    else { item.known = add(item.known, decimal(fill[field])); item.knownCount++; }
    currencies.set(currency, item);
  }
  return [...currencies].map(([currency, item]) => ({ currency, amount: item.unknown ? null : decimalText(item.known), known: item.knownCount ? decimalText(item.known) : null, unknown: item.unknown }));
}
function summarizeVenue(fills, pair) {
  const first = fills[0], groups = new Map();
  for (const fill of fills) {
    const key = JSON.stringify([fill.base, fill.quantityUnit, fill.priceCurrency]);
    const leg = groups.get(key) ?? { base: fill.base, quantityUnit: fill.quantityUnit, currency: fill.priceCurrency, quantity: zero(), notional: zero(), sides: new Set(), scopes: new Set() };
    leg.quantity = add(leg.quantity, decimal(fill.quantity));
    leg.notional = add(leg.notional, multiply(decimal(fill.quantity), decimal(fill.price)));
    leg.sides.add(fill.side); leg.scopes.add(fill.scope);
    groups.set(key, leg);
  }
  const legs = [...groups.values()].map(leg => ({
    base: leg.base, quantityUnit: leg.quantityUnit, currency: leg.currency, quantity: decimalText(leg.quantity),
    price: decimalText(divide(leg.notional, leg.quantity)), sides: [...leg.sides], scopes: [...leg.scopes],
  }));
  const left = legs.filter(leg => leg.base === pair.left), right = legs.filter(leg => leg.base === pair.right);
  const paired = left.length === 1 && right.length === 1 && left[0].currency === right[0].currency;
  const side = list => { const sides = new Set(list.flatMap(leg => leg.sides)); return sides.size === 1 ? [...sides][0] : null; };
  const leftSide = side(left), rightSide = side(right);
  const direction = !left.length || !right.length ? '单腿' : leftSide === 'sell' && rightSide === 'buy' ? pair.short
    : leftSide === 'buy' && rightSide === 'sell' ? pair.long : '双向或同向成交';
  return {
    key: tradeVenueKey(first), sourceId: first.sourceId, source: first.source, exchangeId: first.exchangeId, exchange: first.exchange, accountId: first.accountId, account: first.account,
    legs, direction, spread: paired ? pair.spread(Number(left[0].price), Number(right[0].price)) : null,
    prices: paired ? { left: Number(left[0].price), right: Number(right[0].price) } : null,
    currency: paired ? left[0].currency : null,
    fees: cashTotals(fills, 'fee', 'feeCurrency'), realizedPnl: cashTotals(fills, 'realizedPnl', 'priceCurrency'),
  };
}
function summarizeEvent(fills, pair) {
  const effects = fills.flatMap(fill => classifyFill(fill).map(part => ({ ...part, key: fill.key })));
  const kinds = new Set(effects.map(part => part.effect));
  const type = kinds.has('unknown') ? 'trade' : kinds.size > 1 ? 'rebalance' : kinds.has('open') ? 'entry' : 'exit';
  const groups = new Map();
  for (const fill of fills) {
    const key = tradeVenueKey(fill);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fill);
  }
  const venues = [...groups.values()].map(group => summarizeVenue(group, pair));
  const preferred = venues.find(venue => venue.exchangeId === 'binance' && venue.spread !== null) ?? venues.find(venue => venue.spread !== null);
  return {
    key: fills[0].key, time: Date.parse(fills[0].time), end: Date.parse(fills.at(-1).time), type,
    fills, effects, venues, spread: preferred?.spread ?? null, spreadVenue: preferred ?? null,
    fees: cashTotals(fills, 'fee', 'feeCurrency'), realizedPnl: cashTotals(fills, 'realizedPnl', 'priceCurrency'),
    stale: fills.some(fill => fill.stale),
  };
}
/** Cluster by adjacent fill times across all accounts; never sum quantities across venues. */
export function groupTradeEvents(items, pair = TRADE_PAIRS.oil) {
  const ordered = [...items].sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || a.key.localeCompare(b.key));
  const groups = [];
  for (const fill of ordered) {
    const previous = groups.at(-1);
    if (!previous || Date.parse(fill.time) - Date.parse(previous.at(-1).time) > TRADE_GAP_MS) groups.push([fill]);
    else previous.push(fill);
  }
  return groups.map(group => summarizeEvent(group, pair));
}
