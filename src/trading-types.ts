export type TradingExchange = 'binance' | 'bybit';
export type TradingAccountMode = 'standard' | 'portfolio-margin' | 'unified';
export type OilSymbol = 'CLUSDT' | 'BZUSDT';
export type TradingReadState = 'unconfigured' | 'loading' | 'live' | 'stale' | 'error';
export type TradingImportSource = {
  projectId: string; name: string; projectRevision: string;
  status: 'ready' | 'unavailable' | 'unconfigured'; error: string | null;
  connections: {
    exchange: TradingExchange; configured: boolean; revision: string | null;
    label: string | null; updatedAt: string | null; supported: boolean; reason: string | null;
  }[];
};
export type TradingImportSelection = { projectId: string; projectRevision: string; sourceRevision: string };
export type TradingPosition = {
  id: string; exchange: TradingExchange; symbol: OilSymbol;
  side: 'long' | 'short'; mode: 'one-way' | 'hedge';
  quantity: string; entryPrice: string | null; markPrice: string | null;
  notional: string | null; unrealizedPnl: string | null;
  leverage: string | null; liquidationPrice: string | null;
  sourceUpdatedAt: string | null;
};
export type FundingReceipt = {
  id: string; exchange: TradingExchange; symbol: OilSymbol;
  time: string; amount: string; currency: 'USDT';
};
export type TradingAccount = {
  exchange: TradingExchange; name: string; connected: boolean; revision: number; accountMode: TradingAccountMode;
  verifiedAt: string | null; refreshing: boolean;
  positions: { state: TradingReadState; fetchedAt: string | null; error: string | null };
  funding: { state: TradingReadState; fetchedAt: string | null; error: string | null;
    coverageStart: string | null; coverageEnd: string | null; complete: boolean };
};
export type TradingLeg = {
  id: string; exchange: TradingExchange; symbol: OilSymbol; name: string;
  state: TradingReadState; fetchedAt: string | null; positions: TradingPosition[];
  grossNotional: string | null; netNotional: string | null; unrealizedPnl: string | null;
  fundingNet: string | null; fundingComplete: boolean;
};
export type TradingPnlPoint = { time: number; unrealizedPnl: string | null; fundingPnl: string | null; totalPnl: string | null };
export type TradingPnl = {
  currency: 'USDT'; intervalMs: number; cumulativeStart: number; end: number; recordingStartedAt: number | null;
  pointCount: number; points: TradingPnlPoint[]; latest: TradingPnlPoint | null;
  status: 'ready' | 'collecting' | 'incomplete';
};
export type TradingState = {
  mode: 'read-only'; strategy: { id: 'oil-four-leg'; name: string };
  generatedAt: string; period: { days: 7 | 30; start: string; end: string };
  accounts: TradingAccount[]; legs: TradingLeg[];
  pnl: TradingPnl;
  structure: { state: 'unknown' | 'incomplete' | 'opposed' | 'same-direction' | 'mixed'; message: string };
  funding: {
    complete: boolean; income: string | null; expense: string | null; net: string | null;
    currency: 'USDT'; events: FundingReceipt[];
    daily: { date: string; income: string | null; expense: string | null; net: string | null; complete: boolean }[];
  };
};
