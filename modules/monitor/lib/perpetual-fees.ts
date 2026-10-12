import type { PerpetualQuote } from './perpetual-types.ts';

/** Percentage points throughout this module; quote metadata uses decimal rates. */
export const takerFeeVenues = [
  { id: 'binance', name: 'Binance' }, { id: 'bybit', name: 'Bybit' },
  { id: 'okx', name: 'OKX' }, { id: 'bitget', name: 'Bitget' }, { id: 'gate', name: 'Gate' },
  { id: 'hyperliquid', name: 'Hyperliquid' }, { id: 'lighter', name: 'Lighter' },
  { id: 'aster', name: 'Aster' }, { id: 'rh-lighter', name: 'rh-Lighter' }, { id: 'entropy', name: 'Entropy' },
] as const;
export type TakerFeeVenue = typeof takerFeeVenues[number]['id'];
export type TakerFeeOverrides = Partial<Record<TakerFeeVenue, number>>;
export interface QualityBudget { takerOverrides: TakerFeeOverrides; slippagePercent: number }
export const defaultQualityBudget: QualityBudget = { takerOverrides: {}, slippagePercent: 0.10 };
export interface TakerFee {
  percent: number | null;
  basis: 'account' | 'public' | 'missing';
  detail: string;
  source: string | null;
  checkedAt: number | null;
}
export interface PairTakerFees { long: TakerFee; short: TakerFee; roundTripPercent: number | null }
export const publicFeeCheckedAt = Date.UTC(2026, 8, 21);
export const contractFeeMaxAgeMs = 15 * 60_000;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const validFeePercent = (value: unknown): value is number => finite(value) && value >= 0 && value <= 10;
const venueIds = new Set<string>(takerFeeVenues.map(venue => venue.id));
const missing = (detail: string, source: string | null = null): TakerFee => ({ percent: null, basis: 'missing', detail, source, checkedAt: null });
const published = (percent: number, detail: string, source: string): TakerFee => ({ percent, basis: 'public', detail, source, checkedAt: publicFeeCheckedAt });
const metadataSources: Record<string, { source: string; detail: string; url: string }> = {
  bitget: { source: 'bitget-contract', detail: '合约目录公开 taker 费率 · 未计账户优惠', url: 'https://www.bitget.com/api-doc/classic/contract/market/Get-All-Symbols-Contracts' },
  bybit: { source: 'bybit-standard', detail: '合约分组对应普通账户 taker · 未计账户优惠', url: 'https://www.bybit.com/en/help-center/article/Trading-Fee-Structure' },
  okx: { source: 'okx-standard', detail: '普通账户合约分组 taker · 未计账户优惠', url: 'https://www.okx.com/fees' },
  lighter: { source: 'lighter-standard', detail: 'Standard 账户 · Premium / Plus 请填写账户费率', url: 'https://docs.lighter.xyz/trading/trading-fees' },
  'rh-lighter': { source: 'rh-lighter-standard', detail: 'Standard 账户 · Premium / Plus 请填写账户费率', url: 'https://apidocs.rh.lighter.xyz/docs/account-types' },
  aster: { source: 'aster-standard', detail: '按结算币与合约类别选择基础档 · 未计账户优惠', url: 'https://docs.asterdex.com/trading/perpetuals/fees-and-specs/fees' },
  entropy: { source: 'entropy-standard', detail: 'io 市场基础档 · 含部署方与 Growth 调整；入口附加费如有请覆盖', url: 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees' },
};

export function parseQualityBudget(value: string | null): QualityBudget {
  try {
    const input = value ? JSON.parse(value) : null;
    if (input?.version !== 1 && input?.version !== 2) return { ...defaultQualityBudget, takerOverrides: {} };
    const takerOverrides: TakerFeeOverrides = {};
    // Migrate only slippage. A legacy four-fill budget is not a per-venue taker rate.
    if (input.version === 2 && input.takerOverrides && typeof input.takerOverrides === 'object' && !Array.isArray(input.takerOverrides)) {
      for (const venue of takerFeeVenues) {
        if (Object.hasOwn(input.takerOverrides, venue.id) && validFeePercent(input.takerOverrides[venue.id])) takerOverrides[venue.id] = input.takerOverrides[venue.id];
      }
    }
    return { takerOverrides, slippagePercent: validFeePercent(input.slippagePercent) ? input.slippagePercent : defaultQualityBudget.slippagePercent };
  } catch { return { ...defaultQualityBudget, takerOverrides: {} }; }
}

/** Public ordinary-account rates are distinct from account-specific commissions. */
export function resolveTakerFee(quote: PerpetualQuote, overrides: TakerFeeOverrides, now: number): TakerFee {
  const override = venueIds.has(quote.exchange) && Object.hasOwn(overrides, quote.exchange) ? overrides[quote.exchange as TakerFeeVenue] : undefined;
  if (override !== undefined) return validFeePercent(override)
    ? { percent: override, basis: 'account', detail: '手动填写的账户费率 · 适用于该平台全部合约', source: null, checkedAt: null }
    : missing('账户费率无效，请重新填写');
  const metadata = Object.hasOwn(metadataSources, quote.exchange) ? metadataSources[quote.exchange] : undefined;
  if (metadata) {
    if (quote.takerFeeSource !== metadata.source || !finite(quote.takerFeeRate) || !validFeePercent(quote.takerFeeRate * 100)) return missing('该合约公开 taker 费率待核实，可填写账户费率', metadata.url);
    if (!finite(quote.takerFeeAt) || quote.takerFeeAt <= 0 || quote.takerFeeAt > now + 5_000 || now - quote.takerFeeAt > contractFeeMaxAgeMs) return missing('合约费率超过 15 分钟未核对，等待更新或填写账户费率', metadata.url);
    return { percent: quote.takerFeeRate * 100, basis: 'public', detail: metadata.detail, source: metadata.url, checkedAt: quote.takerFeeAt };
  }
  if (quote.exchange === 'binance') {
    if (quote.base.includes(':')) return missing('独立合约费率待核实，可填写账户费率');
    if (quote.quoteCurrency === 'USDT') return published(0.05, '普通账户 USDT 永续 · 未计 BNB / VIP 优惠', 'https://www.binance.com/en/support/faq/detail/360033544231');
    if (quote.quoteCurrency === 'USDC') return published(0.04, 'USDC 永续公开活动费率 · 未计账户优惠', 'https://www.binance.com/en/support/announcement/detail/03180947641b414ebcb9a6c407fe80e2');
  }
  if (quote.exchange === 'gate' && !quote.base.includes(':') && quote.quoteCurrency === 'USDT') return published(0.05, 'VIP 0 · 不使用点卡；目录点卡费率不作普通账户费率', 'https://www.gate.com/futures');
  // The existing adapter uses the oracle quote currency for native markets
  // (USDT for most, USDC for HYPE/PURR); all settle in USDC at the same base tier.
  if (quote.exchange === 'hyperliquid' && !quote.symbol.includes(':') && ['USDT', 'USDC'].includes(quote.quoteCurrency)) return published(0.045, '原生永续基础档 · 未计质押、推荐或账户优惠', 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees');
  return missing(quote.exchange === 'entropy' ? 'Entropy 独立市场及入口附加费待核实，请填写合计 taker 费率' : '该平台或合约类别费率待核实，可填写账户费率');
}

/** Four taker fills, on equal per-leg notional; exit prices are still unknown. */
export function pairTakerFees(row: { long: PerpetualQuote; short: PerpetualQuote }, overrides: TakerFeeOverrides, now: number): PairTakerFees {
  const long = resolveTakerFee(row.long, overrides, now), short = resolveTakerFee(row.short, overrides, now);
  return { long, short, roundTripPercent: long.percent === null || short.percent === null ? null : 2 * (long.percent + short.percent) };
}
