import type { Listing, Listings, MonitoredSymbol } from './desk-types';
import { computeSymbolView } from './monitoring-status.ts';
import type { SymbolMonitorStatus } from './monitoring-status';

export const monitoredCapacityTiers = ['10', '20', '50'] as const;
export type MonitoredCapacityTier = (typeof monitoredCapacityTiers)[number];
export type MonitoredCapacityStatus = SymbolMonitorStatus | 'waiting';
type ViewOptions = Parameters<typeof computeSymbolView>[4];

export function computeMonitoredCapacityView(
  symbol: Pick<MonitoredSymbol, 'monitor_enabled'>,
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
      return [
        tier,
        typeof value === 'string' &&
        value.trim() !== '' &&
        Number.isFinite(Number(value)) &&
        Number(value) >= 0
          ? value
          : null,
      ];
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
    .filter((symbol) => symbol.monitor_enabled)
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
