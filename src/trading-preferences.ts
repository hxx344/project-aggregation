import type { AnthropicShares, ExecutionAction, ExecutionMarket, ExecutionOrderType, ExecutionPreset, ExecutionSymbol } from './trading-execution-types';
import type { TradingExchange, TradingPair } from './trading-types';
import { normalizeTradingPair } from './trading-cache';
import { ANTHROPIC_CONTRACTS, DEFAULT_SHARES, findContract, sharesProblem } from './trading-anthropic';
import { preferenceChoice as choice, preferenceObject as object, readPreference, writePreference } from './ui-preferences';

export const EXECUTION_PREFERENCES_KEY = 'workbench:execution-preferences:v1';
export const SHARES_PREFERENCES_KEY = 'workbench:anthropic-shares:v1';
export const PAIR_PREFERENCE_KEY = 'workbench:trading-pair:v1';
export const DAYS_PREFERENCE_KEY = 'workbench:trading-days:v1';
export const TRADING_PAIRS: readonly TradingPair[] = ['binance,bybit', 'binance,okx', 'bybit,okx'];
const markets = ['oil', 'hynix', 'anthropic'] as const;
const symbols: Record<ExecutionMarket, readonly ExecutionSymbol[]> = { oil: ['CLUSDT', 'BZUSDT'], hynix: ['SKHYUSDT', 'SKHYNIXUSDT'], anthropic: ['ANTHROPICUSDT'] };
const defaultContracts: [string, string] = ['hyperliquid:io:ANTH', 'binance:ANTHROPICUSDT'];

export type ExecutionPreferences = {
  action: ExecutionAction; preset: ExecutionPreset; selectedExchange: TradingExchange; selectedSymbol: ExecutionSymbol;
  anthropicKeys: [string, string]; sizeMode: 'equal' | 'per-leg'; orientation: '' | 'forward' | 'reverse'; pair: TradingPair;
  orderTypes: Record<string, ExecutionOrderType>;
  batchCount: string; batchInterval: string; repriceInterval: string; timeout: string; advanced: boolean;
};
export type TradingPreferences = { market: ExecutionMarket; profiles: Record<ExecutionMarket, ExecutionPreferences> };
const seconds = (value: unknown, fallback: string, min: number, max: number, integer = false) => typeof value === 'string' && value.length <= 12 && /^\d+(?:\.\d{1,3})?$/.test(value) && Number(value) >= min && Number(value) <= max && (!integer || Number.isInteger(Number(value))) ? value : fallback;

/** Only UI choices are durable: quantities, prices, connections, previews and request IDs are intentionally absent. */
export function normalizeTradingPreferences(value: unknown): TradingPreferences {
  const root = object(value), profiles = object(root.profiles);
  return {
    market: choice(root.market, markets, 'oil'),
    profiles: Object.fromEntries(markets.map(market => {
      const source = object(profiles[market]);
      const keys = source.anthropicKeys;
      const validKeys = Array.isArray(keys) && keys.length === 2 && keys.every(key => typeof key === 'string' && findContract(key)) && keys[0] !== keys[1];
      const anthropicKeys: [string, string] = validKeys ? [keys[0], keys[1]] : [...defaultContracts];
      const selectedSymbol = choice(source.selectedSymbol, symbols[market], symbols[market][0]);
      const orderTypes: Record<string, ExecutionOrderType> = {};
      const allowedLegs = market === 'anthropic' ? ANTHROPIC_CONTRACTS.map(contract => `${contract.exchange}-${contract.symbol}`) : ['binance', 'bybit', 'okx'].flatMap(exchange => symbols[market].map(symbol => `${exchange}-${symbol}`));
      const storedTypes = object(source.orderTypes);
      for (const key of allowedLegs) if (storedTypes[key] === 'chase' || storedTypes[key] === 'market') orderTypes[key] = storedTypes[key];
      // Invalid/obsolete contract identities must not revive an old direction.
      const structureValid = (source.action === 'open' || source.action === 'close') && (market === 'anthropic' ? validKeys : source.selectedSymbol === selectedSymbol
        && ['binance', 'bybit', 'okx'].includes(source.selectedExchange as string)
        && ['same-exchange', 'four-leg', 'cross-exchange'].includes(source.preset as string)
        && (source.preset === 'same-exchange' || TRADING_PAIRS.includes(source.pair as TradingPair)));
      const profile: ExecutionPreferences = {
        action: choice(source.action, ['open', 'close'], 'open'),
        preset: choice(source.preset, ['same-exchange', 'four-leg', 'cross-exchange'], 'same-exchange'),
        selectedExchange: choice(source.selectedExchange, ['binance', 'bybit', 'okx'], 'binance'), selectedSymbol, anthropicKeys,
        sizeMode: choice(source.sizeMode, ['equal', 'per-leg'], 'equal'),
        orientation: structureValid ? choice(source.orientation, ['', 'forward', 'reverse'], '') : '',
        pair: choice(source.pair, TRADING_PAIRS, 'binance,bybit'), orderTypes,
        batchCount: seconds(source.batchCount, '1', 1, 200, true), batchInterval: seconds(source.batchInterval, '1', 0, 600),
        repriceInterval: seconds(source.repriceInterval, '5', 1, 60), timeout: seconds(source.timeout, '300', 30, 3600), advanced: source.advanced === true,
      };
      return [market, profile];
    })) as Record<ExecutionMarket, ExecutionPreferences>,
  };
}
export function readTradingPreferences(pair: TradingPair): TradingPreferences {
  const preferences = normalizeTradingPreferences(readPreference(EXECUTION_PREFERENCES_KEY));
  for (const market of ['oil', 'hynix'] as const) {
    const profile = preferences.profiles[market];
    if (profile.preset !== 'same-exchange' && profile.pair !== pair) profile.orientation = '';
  }
  return preferences;
}
export const saveTradingPreferences = (value: TradingPreferences) => writePreference(EXECUTION_PREFERENCES_KEY, normalizeTradingPreferences(value));
export function normalizeShares(value: unknown): AnthropicShares {
  const source = object(value);
  const shares = { outstanding: source.outstanding, diluted: source.diluted };
  return typeof shares.outstanding === 'string' && shares.outstanding.length <= 24 && typeof shares.diluted === 'string' && shares.diluted.length <= 24 && !sharesProblem(shares as AnthropicShares) ? shares as AnthropicShares : { ...DEFAULT_SHARES };
}
export const readShares = () => normalizeShares(readPreference(SHARES_PREFERENCES_KEY));
export const readTradingPair = (search: string) => {
  const value = new URLSearchParams(search).get('tradingPair') ?? readPreference(PAIR_PREFERENCE_KEY);
  return normalizeTradingPair(typeof value === 'string' ? value : null);
};
export const readTradingDays = (search: string): 7 | 30 => {
  const parameter = new URLSearchParams(search).get('tradingDays');
  return (parameter === null ? readPreference(DAYS_PREFERENCE_KEY) === 30 : parameter === '30') ? 30 : 7;
};
