import type { State } from './types';
import type { LiveConfig } from './SettingsForm';

export type LivePosition = {
  id: string; symbol: string; exchange: string; side: string;
  quantity: string; baseQuantity: string | null; baseCurrency: string; quoteCurrency: string;
  entryPrice: string | null; markPrice: string | null; unrealizedPnl: string | null; pnlCurrency: string;
  margin: string | null; marginCurrency: string; liquidationPrice: string | null;
  external: boolean; updatedAt: number | null;
  signedQuantity?: string | null; notional?: string | null; positionValue?: string | null; realizedPnl?: string | null;
  fundingFee?: string | null; fee?: string | null; leverage?: string | null;
  maxLeverage?: string | null; riskLimit?: string | null; maintenanceMargin?: string | null; directionSource?: string;
  crossExAdlRank?: string | number | null; exchangeAdlRank?: string | number | null; sourceAt?: number | null;
};
export type LiveOrder = {
  id: string; orderId?: string | null; text?: string; exchange?: string; symbol: string; side: string;
  quantity: string; filledQuantity: string | null; status: string; reduceOnly: boolean;
  updatedAt: number | null; canCancel: boolean;
};
export type LiveExecution = {
  id: string; requestId?: string; kind: string; state: string; createdAt?: number; updatedAt?: number;
  error?: string; legs: { exchange?: string; symbol?: string; side?: string; state?: string; status?: string; orderId?: string; quantity?: string; filledQuantity?: string | null; error?: string }[];
};
export type LivePreview = {
  id: string; kind: 'open' | 'close'; createdAt: number; expiresAt: number; connectionVersion: string | number;
  accountUid: string | null; warnings: string[]; canConfirm: boolean; source?: string;
  risk?: { requiredMargin: string; availableMargin: string; marginCurrency: string; reserveFactor: string; accountMode?: string; asOf?: number; legs: { symbol: string; leverage: string; requiredMargin: string; maxPositionNotional: string; projectedNotional: string; quoteCurrency: string }[] } | null;
  feeEstimate?: { asOf: number | null; error?: string | null; legs: { symbol: string; makerRate: string | null; takerRate: string | null; assumedRate: string | null; estimatedFee: string | null; currency: string; source: string }[] } | null;
  legs: { exchange: string; symbol: string; side: string; positionSide: string; quantity: string; price?: string | null; referencePrice?: string | null; notionalUSDT?: string | null; singleLegBudgetUSDT?: string; budgetPrice?: string; budgetFxRate?: string; orderType: string; timeInForce: string; reduceOnly: boolean; base?: string; baseCurrency?: string; quoteCurrency?: string }[];
};
export type LiveView = {
  connection: {
    configured: boolean; connected: boolean; status: string; accountId: string | null; keySuffix: string | null;
    version: string | number; positionMode: string | null;
    permissions: { read: string; trade: string }; lastVerifiedAt: number | null; error: string | null;
  };
  status: string; freshnessState: string; stale: boolean; partial: boolean; asOf: number | null;
  tradingAllowed: boolean; reasons: string[]; account: Record<string, unknown> | null;
  balances: Record<string, unknown>[]; positions: LivePosition[]; orders: LiveOrder[];
  executions: LiveExecution[]; alerts: (string | { message?: string; reason?: string })[];
  recentTrades?: Record<string, unknown>[]; accountBook?: Record<string, unknown>[]; fees?: Record<string, unknown>[];
  recentTradesAsOf?: number | null; recentTradesError?: string | null;
  accountBookAsOf?: number | null; accountBookError?: string | null; feesAsOf?: number | null; feesError?: string | null;
};
export type LiveState = Pick<State, 'now' | 'csrfToken' | 'venues' | 'fx' | 'source' | 'catalog' | 'opportunities'> & {
  mode: 'live'; config: LiveConfig; live: LiveView;
};
export type LiveBootstrap = { now: number; config: LiveConfig; connection: LiveView['connection']; csrfToken: string };

export type CloseLeg = { positionId: string; quantity?: string; positionSide?: 'LONG' | 'SHORT' };
export type PreviewInput = { kind: 'open'; signalId: string }
  | { kind: 'open'; order: { symbol: string; side: 'BUY' | 'SELL'; quantity: string; orderType: 'LIMIT' | 'MARKET'; price?: string; timeInForce: 'GTC' | 'IOC' | 'FOK' | 'POC' } }
  | { kind: 'open'; pair: { longSymbol: string; shortSymbol: string; quantity: string } }
  | ({ kind: 'close' } & CloseLeg) | { kind: 'close'; positions: CloseLeg[] };

export type Instrument = {
  symbol: string; exchange: string; base: string; quoteCurrency: string; settlementCurrency: string;
  lot_size: string; tick_size: string; min_size: string; min_notional?: string | null;
  max_limit_size?: string | null; max_market_size?: string | null; contract_size?: string | null; state?: string;
};
export type MarketData = {
  symbol: string; exchange: string; base: string; quoteCurrency: string;
  status: 'live' | 'stale' | 'unavailable' | 'connecting'; asOf: number | null; error?: string | null; tradingAvailable?: boolean; tradingReason?: string | null;
  ticker: { lastPrice: string | null; bidPrice: string | null; askPrice: string | null; markPrice?: string | null; markPriceAt?: number | null; change24h?: string | null; fundingRate?: string | null; nextFundingAt?: number | null; volume24h?: string | null } | null;
  book: { bids: [string, string][]; asks: [string, string][]; at: number | null; quantityUnit: 'base' | 'contracts' } | null;
  candles: { time: number; open: string; high: string; low: string; close: string; volume: string }[];
  trades: { id: string; price: string; quantity: string; side: string; at: number; quantityUnit?: 'base' | 'contracts' }[]; interval: string;
  candleError?: string | null; candleAsOf?: number | null;
};
