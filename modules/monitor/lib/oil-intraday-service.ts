import archive from '../public/oil/data/binance-15m.json' with { type: 'json' };
import { fetchIntradaySnapshot, validateIntradaySnapshot } from '../modules/oil/intraday.mjs';

let latest = validateIntradaySnapshot(archive);
export async function loadOilIntraday() {
  try { latest = await fetchIntradaySnapshot(latest); return latest; }
  catch { return { ...latest, status: 'snapshot' as const }; }
}
