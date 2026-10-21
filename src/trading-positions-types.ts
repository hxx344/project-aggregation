export type PositionScopeStatus = 'unconfigured' | 'loading' | 'live' | 'stale' | 'error' | 'unsupported';

export interface AssetPosition {
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
  /** Realized results since the position last opened from zero; older Asset versions omit it. */
  cycle?: PositionCycle | null;
}

/** Signed cash flows in `currency`; `net` = realizedPnl + fees + funding and is null when any part is unknown. */
export interface PositionCycle {
  status: 'loading' | 'complete' | 'partial' | 'unavailable';
  since: string | null;
  closedQuantity: string | null;
  closePrice: string | null;
  realizedPnl: string | null;
  fees: string | null;
  funding: string | null;
  net: string | null;
  currency: string | null;
  note: string | null;
  updatedAt: string | null;
}

export interface PositionScope {
  id: string;
  label: string;
  status: PositionScopeStatus;
  refreshing: boolean;
  fetchedAt: string | null;
  error: string | null;
  positions: AssetPosition[];
}

export interface PositionAccount {
  id: string;
  name: string;
  configured: boolean;
  revision: string | null;
  scopes: PositionScope[];
}

export interface PositionExchange {
  id: string;
  name: string;
  accounts: PositionAccount[];
}

export interface PositionsResponse {
  schemaVersion: 1;
  generatedAt: string;
  exchanges: PositionExchange[];
}

export interface PositionSource {
  projectId: string;
  name: string;
  status: 'ready' | 'unconfigured' | 'unavailable' | 'stale';
  error: string | null;
  checkedAt: string | null;
  data: PositionsResponse | null;
}

export interface TradingPositionsResponse {
  generatedAt: string;
  sources: PositionSource[];
}
