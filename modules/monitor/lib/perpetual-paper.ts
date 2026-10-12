import type { PerpetualQuote } from './perpetual-types.ts';
import type { TakerFeeOverrides } from './perpetual-fees.ts';
import { perpetualExitIdentity, validatePerpetualExitPosition } from './perpetual-exit.ts';

export const PERPETUAL_PAPER_LIMITS = { active: 20, closed: 100, samples: 288, closedSamples: 12, closedRetentionMs: 30 * 86_400_000, sampleIntervalMs: 5 * 60_000, observationIntervalMs: 60_000, quoteFreshMs: 30_000, fileBytes: 1_000_000 } as const;
export interface PerpetualPaperEntry {
  quantity: number;
  entryLongPrice: number;
  entryShortPrice: number;
  entryFeePaid: number;
  /** User-recorded net funding: received is positive, paid is negative. */
  settledFunding: number;
  capital?: number | null;
}
export interface PerpetualPaperPnl {
  longProfit: number; shortProfit: number; grossProfit: number;
  entryFeePaid: number; closeFeePaid: number; settledFunding: number; netProfit: number;
  longEntryNotional: number; totalEntryNotional: number;
  returnOnLongNotionalPercent: number; returnOnCapitalPercent: number | null;
}
export interface PerpetualPaperObservation {
  at: number; valid: boolean; reason: string;
  sourceAt: number | null; longBid: number | null; shortAsk: number | null;
  pnl: PerpetualPaperPnl | null;
  fundingNeedsReview: boolean;
}
export interface PerpetualPaperClose {
  kind: 'realized' | 'stop'; closedAt: number;
  exitLongPrice: number | null; exitShortPrice: number | null;
  closeFeePaid: number | null; settledFunding: number;
  /** A user-entered journal result; never confirmation from an exchange. */
  pnl: PerpetualPaperPnl | null;
}
export interface PerpetualPaperPosition extends PerpetualPaperEntry {
  id: string; mode: 'paper' | 'manual'; status: 'active' | 'closed' | 'stopped';
  /** Optional idempotent registration key; older records have neither field. */
  requestId?: string; requestFingerprint?: string;
  base: string; longKey: string; shortKey: string; identity: string; note: string;
  openedAt: number; createdAt: number; updatedAt: number;
  takerOverrides: TakerFeeOverrides;
  targetNetProfit: number | null; maxHoldingHours: number | null;
  fundingUpdatedAt: number; nextFundingAt: number | null;
  lastObservation: PerpetualPaperObservation | null;
  worstObservedNetProfit: number | null; targetReachedAt: number | null; timedOutAt: number | null;
  observations: number; validObservations: number; samples: [number, number | null][];
  close: PerpetualPaperClose | null;
  /** Computed from the current quote cache on GET; not another persistent history. */
  currentObservation?: PerpetualPaperObservation | null;
  holdingHours?: number;
}
export interface PerpetualPaperState { version: 1; revision: number; positions: PerpetualPaperPosition[] }
export interface PerpetualPaperView {
  available: boolean; generatedAt: number; revision: number; running: boolean; error: string;
  limits: typeof PERPETUAL_PAPER_LIMITS; positions: PerpetualPaperPosition[];
}
export type PerpetualPaperCreate = Pick<PerpetualPaperPosition, 'base' | 'longKey' | 'shortKey' | 'identity' | 'quantity' | 'entryLongPrice' | 'entryShortPrice' | 'entryFeePaid' | 'settledFunding' | 'openedAt'> & Partial<Pick<PerpetualPaperPosition, 'mode' | 'capital' | 'note' | 'takerOverrides' | 'targetNetProfit' | 'maxHoldingHours' | 'requestId'>>;

/** Contract prices and quantities are normalized per underlying token in the feed. */
export function perpetualPaperIdentity(long: PerpetualQuote, short: PerpetualQuote): string {
  return perpetualExitIdentity(long, short);
}

/** Linear USDT pairs only. Recorded funding is not inferred from displayed rates. */
export function calculatePerpetualPaperPnl(entry: PerpetualPaperEntry, exit: { exitLongPrice: number; exitShortPrice: number; closeFeePaid: number }): PerpetualPaperPnl | null {
  try { validatePerpetualExitPosition({ ...entry, capital: entry.capital ?? null }); } catch { return null; }
  if (![entry.quantity, entry.entryLongPrice, entry.entryShortPrice, exit.exitLongPrice, exit.exitShortPrice].every(value => Number.isFinite(value) && value > 0)
    || ![entry.entryFeePaid, exit.closeFeePaid].every(value => Number.isFinite(value) && value >= 0) || !Number.isFinite(entry.settledFunding)
    || (entry.capital != null && (!Number.isFinite(entry.capital) || entry.capital <= 0))) return null;
  const longProfit = entry.quantity * (exit.exitLongPrice - entry.entryLongPrice), shortProfit = entry.quantity * (entry.entryShortPrice - exit.exitShortPrice);
  const grossProfit = longProfit + shortProfit, netProfit = grossProfit - entry.entryFeePaid - exit.closeFeePaid + entry.settledFunding;
  const longEntryNotional = entry.quantity * entry.entryLongPrice, totalEntryNotional = entry.quantity * (entry.entryLongPrice + entry.entryShortPrice);
  const returnOnLongNotionalPercent = netProfit / longEntryNotional * 100, returnOnCapitalPercent = entry.capital ? netProfit / entry.capital * 100 : null;
  if (![longProfit, shortProfit, grossProfit, netProfit, longEntryNotional, totalEntryNotional, returnOnLongNotionalPercent].every(Number.isFinite) || returnOnCapitalPercent !== null && !Number.isFinite(returnOnCapitalPercent)) return null;
  return { longProfit, shortProfit, grossProfit, entryFeePaid: entry.entryFeePaid, closeFeePaid: exit.closeFeePaid, settledFunding: entry.settledFunding, netProfit, longEntryNotional, totalEntryNotional, returnOnLongNotionalPercent, returnOnCapitalPercent };
}
