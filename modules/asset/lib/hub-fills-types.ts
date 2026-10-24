import type { PositionsStatus } from './positions-types.ts';

/** Fixed perpetual bases per arbitrage market; each market is read, cached and replayed separately. */
export const FILL_MARKETS = { oil: ['CL', 'BZ'], hynix: ['SKHY', 'SKHYNIX'] } as const;
export type FillMarket = keyof typeof FILL_MARKETS;
export type FillBase = (typeof FILL_MARKETS)[FillMarket][number];
export type Fill = {
  id: string; symbol: string; base: FillBase; time: string; side: 'buy' | 'sell';
  positionSide: 'long' | 'short' | 'net'; quantity: string; quantityUnit: string;
  price: string; priceCurrency: 'USDT' | 'USDC';
  fee: string | null; feeCurrency: string | null; realizedPnl: string | null;
  positionBefore: string | null; positionAfter: string | null;
};
/** Internal replay evidence is never serialized into the public response. */
export type ReadFill = Omit<Fill, 'positionBefore' | 'positionAfter'> & { sizeAfter?: string | null; order?: number };
export type FillsScope = {
  id: string; label: string; status: PositionsStatus; refreshing: boolean; fetchedAt: string | null;
  coverageStart: string | null; coverageEnd: string | null; truncated: boolean; error: string | null; fills: Fill[];
};
export type HubFills = {
  schemaVersion: 1; generatedAt: string; lookbackStart: string;
  exchanges: { id: string; name: string; accounts: {
    id: string; name: string; configured: boolean; revision: string | null; scopes: FillsScope[];
  }[] }[];
};
