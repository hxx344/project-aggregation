import { HISTORY_WINDOW_MS, type ExchangeFundingHistory, type FundingHistoryRange, type SettledFundingRecord } from './exchange-funding-history.ts';

const BEIJING_OFFSET_MS = 8 * 3_600_000;
/** Native datetime-local values always represent Beijing time, regardless of browser timezone. */
export function fundingRangeInput(time: number): string {
  return new Date(time + BEIJING_OFFSET_MS).toISOString().slice(0, 16);
}
export function parseFundingRangeInput(input: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input)) return null;
  const time = Date.parse(`${input}:00+08:00`);
  return Number.isFinite(time) && fundingRangeInput(time) === input ? time : null;
}

export type FundingRangeLeg = {
  records: SettledFundingRecord[];
  count: number;
  rawRate: number | null;
  positionRate: number | null;
  coverage: 'queried' | 'partial' | 'unknown';
  fetchedAt: string | null;
  error: string;
};

/** Simple sums of all actual settlements in [from,to), not compounding or annualization.
 * Each leg retains its own notional denominator. Historical prices are unavailable,
 * so these sums must not be presented as the equal-barrel spread's historical P&L.
 */
export function analyzeFundingRange(history: ExchangeFundingHistory, range: FundingHistoryRange, direction: 'short' | 'long'): { left: FundingRangeLeg; right: FundingRangeLeg } {
  if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from >= range.to || range.to - range.from > HISTORY_WINDOW_MS || !['short', 'long'].includes(direction)) throw new Error('请选择有效的起止时间，区间不能超过 60 天。');
  const leg = (side: 'left' | 'right'): FundingRangeLeg => {
    const metadata = history[side];
    const records = history.rows.flatMap(row => {
      const rate = row[`${side}Rate`];
      return rate !== null && row.time >= range.from && row.time < range.to ? [{ time: row.time, rate }] : [];
    }).sort((a, b) => b.time - a.time);
    // Compensated summation avoids accumulated rounding error over many tiny rates.
    let sum = 0, compensation = 0;
    for (const { rate } of records) {
      const adjusted = rate - compensation, next = sum + adjusted;
      compensation = next - sum - adjusted; sum = next;
    }
    const rawRate = records.length ? (sum === 0 ? 0 : sum) : null;
    const short = side === 'left' ? direction === 'short' : direction === 'long';
    const positionRate = rawRate === null ? null : rawRate === 0 ? 0 : short ? rawRate : -rawRate;
    const queried = metadata.coverage;
    return { records, count: records.length, rawRate, positionRate, coverage: !queried ? 'unknown' : range.from >= queried.from && range.to - 1 <= queried.to ? 'queried' : 'partial', fetchedAt: metadata.fetchedAt, error: metadata.error };
  };
  return { left: leg('left'), right: leg('right') };
}
