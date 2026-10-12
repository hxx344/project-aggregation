/** Prices of one quote-currency unit in USDT. Bid/ask preserve conversion costs. */
export interface PerpetualFxRate {
  bid: number;
  ask: number;
  at: number;
  source: string;
}
export interface PerpetualFxSnapshot {
  baseCurrency: "USDT";
  generatedAt: number;
  staleAfterMs: number;
  rates: Record<string, PerpetualFxRate>;
  reasons?: Record<string, string>;
}

export function quoteCurrencyFx(currency: string, snapshot: PerpetualFxSnapshot | null | undefined, now: number): PerpetualFxRate | null {
  if (currency === "USDT") return { bid: 1, ask: 1, at: now, source: "USDT 计价基准" };
  if (!snapshot || snapshot.baseCurrency !== "USDT" || !Number.isFinite(now)) return null;
  const rate = Object.hasOwn(snapshot.rates, currency) ? snapshot.rates[currency] : null;
  const maxAge = Math.min(180_000, snapshot.staleAfterMs);
  if (!rate || !Number.isFinite(maxAge) || maxAge <= 0 || !Number.isFinite(rate.at) || rate.at <= 0 || rate.at > now + 5_000 || now - rate.at > maxAge
    || !Number.isFinite(rate.bid) || !Number.isFinite(rate.ask) || rate.bid <= 0 || rate.ask < rate.bid) return null;
  return rate;
}
