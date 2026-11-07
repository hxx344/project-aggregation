import { TRADE_PAIRS, tradeVenueKey, tradeDate } from "../modules/oil/trades.mjs";
import { decimal, decimalText, add, multiply, divide, compare, absolute } from "../modules/oil/trade-decimal.mjs";
import type { HubFillItem } from "./hub-fills-contract.ts";
import type { TradeEvent } from "./hynix-trades.ts";

type Total = ReturnType<typeof decimal>;
type Leg = { key: string; symbol: string; base: string; side: string; positionSide: string; quantityUnit: string; quantity: Total; notional: Total };
type Group = { key: string; source: string; exchange: string; account: string; scope: string; currency: string | null; direction: string; stale: boolean; legs: Map<string, Leg> };

const positionKey = (fill: HubFillItem) => JSON.stringify([tradeVenueKey(fill), fill.scope, fill.symbol, fill.base, fill.positionSide, fill.quantityUnit, fill.priceCurrency]);

/** A consecutive same-day position segment, not an inferred order or strategy execution ID. */
export function summarizeTradeEvents(events: TradeEvent[], market: keyof typeof TRADE_PAIRS) {
  const pair = TRADE_PAIRS[market];
  const directionFor = (fill: HubFillItem, type: string) => {
    const short = (fill.base === pair.left ? fill.side === "sell" : fill.side === "buy") === (type === "entry");
    return short ? pair.short : pair.long;
  };
  const batches: { type: "entry" | "exit"; events: TradeEvent[]; date: string; identity: string; positions: Map<string, string | null>; continuous: boolean }[] = [];
  let current: (typeof batches)[number] | undefined;
  for (const event of [...events].sort((a, b) => a.time - b.time || a.key.localeCompare(b.key))) {
    if (event.type !== "entry" && event.type !== "exit") { current = undefined; continue; }
    const fills = event.fills as HubFillItem[], date = tradeDate(fills[0].time);
    const identity = JSON.stringify([...new Set(fills.map(fill => JSON.stringify([tradeVenueKey(fill), fill.scope, fill.priceCurrency, directionFor(fill, event.type)])))].sort());
    const firstPositions = new Map<string, string | null>(), lastPositions = new Map<string, string | null>();
    const positions = new Map<string, HubFillItem[]>();
    for (const fill of fills) {
      const key = positionKey(fill);
      const parts = positions.get(key) ?? []; parts.push(fill); positions.set(key, parts);
    }
    let internallyContinuous = new Set(fills.map(fill => directionFor(fill, event.type))).size === 1;
    for (const [key, parts] of positions) {
      // Reconstruct same-millisecond fills by their monotonic position chain,
      // rather than lexicographic IDs (which put 10 before 9).
      parts.sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || (a.positionBefore !== null && b.positionBefore !== null
        ? compare(absolute(decimal(a.positionBefore)), absolute(decimal(b.positionBefore))) * (event.type === "entry" ? 1 : -1) : a.key.localeCompare(b.key)));
      firstPositions.set(key, parts[0].positionBefore);
      for (const fill of parts) {
        const previous = lastPositions.get(key);
        if (fill.positionBefore === null || fill.positionAfter === null || previous !== undefined && (previous === null || compare(decimal(previous), decimal(fill.positionBefore)) !== 0)) internallyContinuous = false;
        lastPositions.set(key, fill.positionAfter);
      }
    }
    let shared = false, continuous = current?.continuous && internallyContinuous && current.positions.size === firstPositions.size;
    for (const [key, before] of firstPositions) if (current?.positions.has(key)) {
      shared = true;
      const after = current.positions.get(key);
      if (before == null || after == null || compare(decimal(before), decimal(after)) !== 0 || compare(decimal(after), decimal("0")) === 0) continuous = false;
    } else continuous = false;
    if (!current || current.type !== event.type || current.date !== date || current.identity !== identity || !shared || !continuous) {
      current = { type: event.type as "entry" | "exit", events: [], date, identity, positions: new Map(), continuous: internallyContinuous }; batches.push(current);
    }
    current.events.push(event);
    for (const [key, after] of lastPositions) current.positions.set(key, after);
  }
  return batches.map(batch => {
    const { type, events: matching } = batch;
    const groups = new Map<string, Group>();
    for (const event of matching) for (const fill of event.fills as HubFillItem[]) {
      if (fill.base !== pair.left && fill.base !== pair.right) continue;
      const direction = directionFor(fill, type);
      const key = JSON.stringify([tradeVenueKey(fill), fill.scope, fill.priceCurrency, direction]);
      const group = groups.get(key) ?? { key, source: fill.source, exchange: fill.exchange, account: fill.account, scope: fill.scope, currency: fill.priceCurrency, direction, stale: false, legs: new Map<string, Leg>() };
      const legKey = JSON.stringify([fill.symbol, fill.base, fill.side, fill.positionSide, fill.quantityUnit]);
      const leg = group.legs.get(legKey) ?? { key: legKey, symbol: fill.symbol, base: fill.base, side: fill.side, positionSide: fill.positionSide, quantityUnit: fill.quantityUnit, quantity: decimal("0"), notional: decimal("0") };
      leg.quantity = add(leg.quantity, decimal(fill.quantity));
      leg.notional = add(leg.notional, multiply(decimal(fill.quantity), decimal(fill.price)));
      group.stale ||= fill.stale;
      group.legs.set(legKey, leg); groups.set(key, group);
    }
    return { key: matching[0].key, type, eventKeys: matching.map(event => event.key), eventCount: matching.length, fillCount: matching.reduce((sum, event) => sum + event.fills.length, 0),
      start: Math.min(...matching.map(event => event.time)), end: Math.max(...matching.map(event => event.end)),
      groups: [...groups.values()].map(group => {
        // The bridge accepts only strictly positive fill quantities, so each populated leg has a nonzero divisor.
        const legs = [...group.legs.values()].map(leg => ({ ...leg, quantity: decimalText(leg.quantity), price: decimalText(divide(leg.notional, leg.quantity)!) }));
        const left = legs.filter(leg => leg.base === pair.left), right = legs.filter(leg => leg.base === pair.right);
        const spread = left.length === 1 && right.length === 1 ? pair.spread(Number(left[0].price), Number(right[0].price)) : null;
        return { ...group, legs, spread };
      }),
    };
  });
}
