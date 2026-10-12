import type { Asset, Ledger } from './types';

export function assetExpiresAt(asset: Asset): number {
  if (asset.error || asset.mode === 'manual') return NaN;
  const ttl = asset.status.includes('同步') ? 300_000 : asset.mode === 'market' ? 900_000 : NaN;
  return Date.parse(asset.updatedAt) + ttl + 1;
}
export function nextLedgerExpiry(ledger: Pick<Ledger, 'assets' | 'fxStatus'>, now: number): number | null {
  const times = ledger.assets.map(assetExpiresAt);
  if (!ledger.fxStatus.error && ledger.fxStatus.fetchedAt) times.push(Date.parse(ledger.fxStatus.fetchedAt) + 300_001);
  const next = Math.min(...times.filter(at => at > now));
  return Number.isFinite(next) ? next : null;
}
