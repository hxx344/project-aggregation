import type { Listing, Listings, MonitoredSymbol } from './desk-types';

export type SymbolMonitorStatus =
  | 'active'
  | 'stale'
  | 'paused'
  | 'unavailable'
  | 'error';

export type Freshness = {
  status: 'fresh' | 'aging' | 'stale';
  timestamp: number | null;
  ageSeconds: number | null;
  thresholdSeconds: number;
};

const positiveNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export function computeFreshness(
  timestamp: unknown,
  now: number,
  threshold = 180,
): Freshness {
  const thresholdSeconds = positiveNumber(threshold) ? threshold : 180;
  if (
    !positiveNumber(timestamp) ||
    !positiveNumber(now) ||
    now - timestamp < -1
  ) {
    return {
      status: 'stale',
      timestamp: null,
      ageSeconds: null,
      thresholdSeconds,
    };
  }
  const ageSeconds = Math.max(0, now - timestamp);
  return {
    status:
      ageSeconds < thresholdSeconds / 2
        ? 'fresh'
        : ageSeconds < thresholdSeconds
          ? 'aging'
          : 'stale',
    timestamp,
    ageSeconds,
    thresholdSeconds,
  };
}

// The client re-evaluates source clocks as now advances, even if polling stops.
// These display states never replace the server's trading/notification checks.
export function computeSymbolView(
  symbol: Partial<Pick<MonitoredSymbol, 'monitor_enabled'>>,
  listing: Listing | undefined,
  listings: Listings | undefined,
  now: number,
  options: {
    monitoringEnabled?: boolean;
    demo?: boolean;
    connectionError?: boolean;
  } = {},
): {
  status: SymbolMonitorStatus;
  freshness: Freshness;
  dataAvailable: boolean;
} {
  const discovery = listings?.discovery_enabled !== false;
  const stamps = [listing?.checked_at, listing?.brackets_checked_at];
  if (discovery) stamps.push(listings?.checked_at);
  const samples = stamps.map((stamp) =>
    computeFreshness(stamp, now, listings?.stale_seconds),
  );
  const freshness =
    samples.find((sample) => sample.timestamp === null) ??
    samples.reduce((oldest, sample) =>
      sample.timestamp! < oldest.timestamp! ? sample : oldest,
    );
  let status: SymbolMonitorStatus;
  if (
    options.demo ||
    options.monitoringEnabled === false ||
    symbol.monitor_enabled !== true
  ) {
    status = 'paused';
  } else if (listing?.error || (discovery && listings?.error)) {
    status = 'error';
  } else if (listing?.status && listing.status !== 'TRADING') {
    status = 'unavailable';
  } else if (
    options.connectionError ||
    listing?.status !== 'TRADING' ||
    !listings?.initialized ||
    freshness.status === 'stale'
  ) {
    status = 'stale';
  } else {
    status = 'active';
  }
  return { status, freshness, dataAvailable: status === 'active' };
}
