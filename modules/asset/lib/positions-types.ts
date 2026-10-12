/** Decimal strings preserve exchange precision; quantities are absolute. */
export type Position = {
  id: string;
  symbol: string;
  instrumentId: string;
  side: 'long' | 'short';
  quantity: string;
  quantityUnit: string;
  contractSize: string | null;
  entryPrice: string | null;
  markPrice: string | null;
  notional: string | null;
  unrealizedPnl: string | null;
  leverage: string | null;
  liquidationPrice: string | null;
  priceCurrency: string | null;
  notionalCurrency: string | null;
  pnlCurrency: string | null;
  marginMode: string | null;
  sourceUpdatedAt: string | null;
};

export type PositionsStatus = 'unconfigured' | 'loading' | 'live' | 'stale' | 'error' | 'unsupported';
export type PositionsScope = {
  id: string;
  label: string;
  status: PositionsStatus;
  refreshing: boolean;
  fetchedAt: string | null;
  error: string | null;
  positions: Position[];
};
export type PositionsAccount = {
  id: string;
  name: string;
  configured: boolean;
  revision: string | null;
  scopes: PositionsScope[];
};
export type PositionsExchange = { id: string; name: string; accounts: PositionsAccount[] };
export type HubPositions = { schemaVersion: 1; generatedAt: string; exchanges: PositionsExchange[] };
