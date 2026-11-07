import type { HubPositionItem } from './hub-bridge.ts';
import type { PairTotals, RealizedStatus } from './related-pairs.ts';

export type PositionTotals = PairTotals & { currency: string | null; count: number };
const amount = (value: string | null | undefined) => {
  if (value == null || value.trim() === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};
const sum = (values: (string | null | undefined)[]) => {
  const numbers = values.map(amount);
  if (numbers.some(value => value === null)) return null;
  const result = (numbers as number[]).reduce((total, value) => total + value, 0);
  return Number.isFinite(result) ? result : null;
};

/** Related open positions and their current cycles, not a lifetime account PnL. */
export function relatedPositionTotals(items: readonly HubPositionItem[], incomplete = false): PositionTotals[] {
  const groups = new Map<string | null, HubPositionItem[]>();
  for (const item of items) {
    const currency = item.pnlCurrency || null;
    const group = groups.get(currency) ?? [];
    group.push(item); groups.set(currency, group);
  }
  return [...groups].map(([currency, group]) => {
    // An unknown settlement currency is not inferred from a symbol or venue.
    const unrealized = currency ? sum(group.map(item => item.unrealizedPnl)) : null;
    const cycles = group.map(item => item.cycle);
    const realizedStatus: RealizedStatus = cycles.some(cycle => !cycle || cycle.status === 'unavailable') ? 'unavailable'
      : cycles.some(cycle => cycle?.status === 'loading') ? 'loading'
        : !currency || cycles.some(cycle => cycle?.currency !== currency) ? 'mixed-currency'
          : cycles.some(cycle => cycle?.status === 'partial') ? 'partial' : 'complete';
    const known = realizedStatus === 'complete' || realizedStatus === 'partial';
    const field = (key: 'realizedPnl' | 'fees' | 'funding' | 'net') => known ? sum(cycles.map(cycle => cycle?.[key])) : null;
    const net = field('net');
    const total = !incomplete && realizedStatus === 'complete' && unrealized !== null && net !== null ? unrealized + net : null;
    return { currency, count: group.length, unrealized, unrealizedCurrency: currency, unrealizedStale: group.some(item => item.stale),
      realizedStatus, realizedCurrency: known ? currency : null, realized: field('realizedPnl'), fees: field('fees'), funding: field('funding'), net,
      total: total !== null && Number.isFinite(total) ? total : null };
  });
}
