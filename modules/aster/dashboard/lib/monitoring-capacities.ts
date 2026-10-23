import type { Listing, Listings, MonitoredSymbol } from './desk-types';
import { computeSymbolView } from './monitoring-status.ts';
import type { SymbolMonitorStatus } from './monitoring-status';

export const monitoredCapacityTiers = ['10', '20', '50'] as const;
export type MonitoredCapacityTier = (typeof monitoredCapacityTiers)[number];
export type MonitoredCapacityStatus = SymbolMonitorStatus | 'waiting';
export type MonitoredCapacitySortKey =
  | 'symbol'
  | MonitoredCapacityTier
  | 'sampleTime';
export type MonitoredCapacitySort = {
  key: MonitoredCapacitySortKey;
  direction: 'ascending' | 'descending';
};

type ViewOptions = Parameters<typeof computeSymbolView>[4];

function capacitySortValue(value: string | null | undefined) {
  if (typeof value !== 'string' || !Number.isFinite(Number(value))) return null;
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(
    value.trim(),
  );
  if (!match) return null;
  const fraction = match[3] ?? match[4] ?? '';
  const digits = ((match[2] ?? '') + fraction).replace(/^0+/, '');
  if (!digits) return { digits: '0', order: BigInt(0) };
  if (match[1] === '-') return null;
  // Number above only checks the existing display range. Decimal digits and
  // magnitude keep large amounts and scientific notation ordered exactly.
  return {
    digits: digits.replace(/0+$/, ''),
    order:
      BigInt(match[5] ?? '0') - BigInt(fraction.length) + BigInt(digits.length),
  };
}

function compareCapacityValues(
  a: NonNullable<ReturnType<typeof capacitySortValue>>,
  b: NonNullable<ReturnType<typeof capacitySortValue>>,
) {
  if (a.digits === '0' || b.digits === '0')
    return a.digits === b.digits ? 0 : a.digits === '0' ? -1 : 1;
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  const length = Math.max(a.digits.length, b.digits.length);
  const left = a.digits.padEnd(length, '0');
  const right = b.digits.padEnd(length, '0');
  return left < right ? -1 : left > right ? 1 : 0;
}

export function computeMonitoredCapacityView(
  symbol: Partial<Pick<MonitoredSymbol, 'monitor_enabled'>>,
  listing: Listing | undefined,
  listings: Listings | undefined,
  now: number,
  options: ViewOptions = {},
) {
  // Fixed tiers have their own source clocks and error. The maximum tier may
  // be missing or invalid while these three tiers were sampled successfully.
  const tierListing = listing
    ? {
        ...listing,
        checked_at: listing.tier_checked_at,
        brackets_checked_at: listing.tier_brackets_checked_at ?? undefined,
        error: listing.tier_error,
      }
    : undefined;
  const view = computeSymbolView(symbol, tierListing, listings, now, options);
  const hasSample = Boolean(
    listing?.tier_capacities &&
    typeof listing.tier_capacities === 'object' &&
    !Array.isArray(listing.tier_capacities),
  );
  const status: MonitoredCapacityStatus =
    !hasSample &&
    (view.status === 'active' || view.status === 'stale') &&
    !options.connectionError
      ? 'waiting'
      : view.status;
  const capacities = Object.fromEntries(
    monitoredCapacityTiers.map((tier) => {
      const value = listing?.tier_capacities?.[tier];
      return [tier, capacitySortValue(value) !== null ? value : null];
    }),
  ) as Record<MonitoredCapacityTier, string | null>;
  return {
    ...view,
    status,
    capacities,
    hasSample,
    dataAvailable: hasSample && view.dataAvailable,
  };
}

export function monitoredCapacityRows(
  symbols: readonly MonitoredSymbol[],
  listings: Listings | undefined,
  now: number,
  options: ViewOptions = {},
) {
  return symbols
    .filter((symbol) => symbol.monitor_enabled === true)
    .map((symbol) => {
      const listing = listings?.rows[symbol.symbol];
      return {
        symbol: symbol.symbol,
        listing,
        view: computeMonitoredCapacityView(
          symbol,
          listing,
          listings,
          now,
          options,
        ),
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function nextMonitoredCapacitySort(
  current: MonitoredCapacitySort,
  key: MonitoredCapacitySortKey,
): MonitoredCapacitySort {
  return {
    key,
    direction:
      current.key === key
        ? current.direction === 'ascending'
          ? 'descending'
          : 'ascending'
        : key === 'symbol'
          ? 'ascending'
          : 'descending',
  };
}

export function sortMonitoredCapacityRows(
  rows: readonly ReturnType<typeof monitoredCapacityRows>[number][],
  sort: MonitoredCapacitySort,
) {
  const direction = sort.direction === 'ascending' ? 1 : -1;
  return rows
    .map((row) => {
      const timestamp = row.view.hasSample
        ? row.listing?.tier_checked_at
        : null;
      return {
        row,
        amount:
          sort.key === 'symbol' || sort.key === 'sampleTime'
            ? null
            : capacitySortValue(row.view.capacities[sort.key]),
        timestamp:
          typeof timestamp === 'number' &&
          Number.isFinite(timestamp) &&
          timestamp > 0
            ? timestamp
            : null,
      };
    })
    .sort((a, b) => {
      const symbolOrder = a.row.symbol.localeCompare(b.row.symbol);
      if (sort.key === 'symbol') return direction * symbolOrder;
      const left = sort.key === 'sampleTime' ? a.timestamp : a.amount;
      const right = sort.key === 'sampleTime' ? b.timestamp : b.amount;
      if (left === null || right === null)
        return left === right ? symbolOrder : left === null ? 1 : -1;
      const order =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : compareCapacityValues(a.amount!, b.amount!);
      return direction * order || symbolOrder;
    })
    .map(({ row }) => row);
}
