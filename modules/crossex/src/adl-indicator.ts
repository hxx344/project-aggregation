export type AdlRank = string | number | null | undefined;

// Gate CrossEx REST contract, checked 2026-10-14:
// https://www.gate.com/docs/developers/crossex/en/#query-adl-position-reduction-ranking
// Each result is a red-light count, not a probability or a combined ADL score.
// Five-level queues use 1..5 lights; OKX/Bybit also expose a lower, zero rank.
const exchangeLevels: Record<string, readonly number[]> = {
  binance: [0, 1, 2, 3, 4],
  gate: [5, 4, 3, 2, 1],
  kraken: [100, 80, 60, 40, 20],
  okx: [0, 1, 2, 3, 4, 5],
  bybit: [0, 1, 2, 3, 4, 5],
};

function integerRank(rank: AdlRank): number | null {
  if (typeof rank !== 'number' && (typeof rank !== 'string' || !/^\d+$/.test(rank.trim()))) return null;
  const value = Number(rank);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function adlRedLights(rank: AdlRank, source: 'crossex' | 'exchange', exchange = ''): number | null {
  const value = integerRank(rank);
  if (value === null) return null;
  if (source === 'crossex') return value >= 1 && value <= 5 ? value : null;
  const key = exchange.trim().toLowerCase();
  const levels = Object.hasOwn(exchangeLevels, key) ? exchangeLevels[key] : undefined;
  if (!levels) return null;
  const index = levels.indexOf(value);
  return index < 0 ? null : index + (levels.length === 5 ? 1 : 0);
}
